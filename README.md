# AGS backend

TypeScript / Node.js / Express API for support requests, ready for Render. Users sign in with Microsoft in your frontend and send a **Microsoft Graph access token** to this API. PostgreSQL stores requests across restarts and deployments.

## Local setup

Use Node.js 24 and PostgreSQL 14 or newer.

```sh
npm ci
cp .env.example .env
createdb ags
# Edit .env with your database URL, Microsoft tenant ID, and frontend origin.
npm run dev
```

The server listens on `http://localhost:3000`. Tables and indexes are created automatically at startup. The database must already exist. `createdb` uses your local PostgreSQL account; adjust `DATABASE_URL` to match it. Startup also applies the idempotent schema upgrades described below.

All application and test code is TypeScript with strict type checking. `npm run dev` runs `src/server.ts` with automatic reloads. Production runs compiled JavaScript:

```sh
npm run typecheck
npm run build
npm start
```

The build compiles `src/` into `dist/` and copies the SQL schema alongside the server. `dist/` is generated and ignored by Git. Local imports use `.js` extensions so emitted ES modules resolve correctly; TypeScript and the development runner resolve them to the corresponding `.ts` sources.

## Microsoft configuration

1. In Microsoft Entra, register your frontend as a **single-tenant** application (accounts in your organizational directory only).
2. Add a **Single-page application** redirect URI for your frontend, including its local development URL when needed.
3. Add Microsoft Graph **delegated** permission `User.Read`. Your tenant's consent policy may require administrator consent.
4. Use `https://login.microsoftonline.com/YOUR_TENANT_ID` as your frontend MSAL authority.
5. Set the backend's `MICROSOFT_TENANT_ID` to that directory's tenant UUID.

After login, acquire a Graph token and call the backend:

```ts
// msalInstance is your frontend's initialized MSAL PublicClientApplication.
// account is the account returned by your Microsoft login flow.
const result = await msalInstance.acquireTokenSilent({
  account,
  scopes: ['https://graph.microsoft.com/User.Read'],
});

const response = await fetch('https://YOUR-SERVICE.onrender.com/api/requests', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${result.accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    title: 'Cannot access my work email',
    description: 'Outlook shows an access denied message after signing in.',
    priority: 'normal',
  }),
});
const data = await response.json();
if (!response.ok) throw new Error(data.error);
console.log(data.request);
```

Handle MSAL interaction-required errors with your frontend's interactive login/token flow. Send `accessToken`, **not** `idToken`, and reacquire a token on `401`. The backend needs no Microsoft client secret.

The backend treats tokens as opaque. On every API request, it calls Graph `/me` and `/organization`, verifies the returned organization ID, and uses the returned user ID for ownership. It never trusts client-supplied identity, decoded JWT claims, email domains, or CORS as authentication. Tokens are not stored or logged. Personal accounts without a work-directory identity and other tenants are rejected; guest accounts in your configured directory can access the app.

This implements the requested Graph-token handoff. It accepts a valid delegated Graph token for the configured tenant regardless of which client application acquired it. If you need tokens issued specifically for this application, switch to a separately exposed API scope and API-audience access tokens. Graph outages or throttling temporarily prevent API access.

References: [Graph token validation](https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/troubleshooting-signature-validation-errors), [signed-in user](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0), [organization access with User.Read](https://learn.microsoft.com/en-us/graph/api/organization-list?view=graph-rest-1.0).

## API

Every `/api/*` request requires `Authorization: Bearer YOUR_GRAPH_ACCESS_TOKEN`.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health` | Public database health check; `200` healthy, `503` unavailable |
| GET | `/api/me` | `{ user: { id, tenantId, displayName, email, role, isAdmin, permissions, targetEntities, isActive } }` |
| POST | `/api/users` | Create or refresh your database user from Microsoft; returns `200` and `{ user }` |
| GET | `/api/users` | Admin only: list users in your organization with `limit` and `offset` |
| GET | `/api/roles` | Admin only: `{ roles, assignablePermissions }` |
| POST | `/api/roles` | Admin only: create `{ name, description, permissions? }`; returns `201` and `{ role }` |
| DELETE | `/api/roles/:name` | Admin only: delete an unassigned custom role; returns `204` |
| PATCH | `/api/users/:id/role` | Admin only: assign `{ "role": "existing-role-name" }` using the database user ID |
| PATCH | `/api/users/:id` | Admin only: replace `targetEntities` and/or set `isActive`; returns `{ user }` |
| DELETE | `/api/users/:id` | Admin only: soft-delete a user; returns `204` |
| POST | `/api/requests` | Create a request; returns `201` and `{ request }` |
| GET | `/api/requests` | List your requests; staff see all requests in the tenant |
| GET | `/api/requests/:id` | Retrieve your request; staff can retrieve any in the tenant |
| PATCH | `/api/requests/:id` | Staff only: update status with `{ "status": "in_progress" }` |
| GET | `/api/borg/sales` | Requires `sales:read` and an explicit grant for `targetEntity`; returns the plain product-line array |
| GET | `/api/borg/stock` | Requires `stock:read` and an explicit grant for `targetEntity`; returns Borg's stock JSON unchanged |

Create requires `title` (1–200 characters) and `description` (1–10,000 characters). Optional `priority` is `low`, `normal` (default), or `high`. New requests start as `open`. Unknown body fields are rejected, including attempts to set an owner or staff role.

Statuses: `open`, `in_progress`, `resolved`, `closed`. Users with `requests:update` (including `support` and `admin`) can move requests between any statuses, including reopening, within their organization.

List filters: `?status=open&limit=20&offset=0`. Limit defaults to 20, maximum 100; offset defaults to 0, maximum 1,000,000. Results are newest first and return `{ requests, limit, offset }`. Regular users receive `404` when requesting another user's request.

A request has `id`, `title`, `description`, `priority`, `status`, `ownerId`, `ownerName`, `ownerEmail`, `createdAt`, and `updatedAt`. Errors use `{ "error": "message" }` with an appropriate HTTP status. The API allows 120 requests per minute per IP per running instance; adjust for shared office networks or multiple instances. Attachments, comments, notifications, and support-request deletion are outside this starter's scope.

### Save the signed-in user

Call `POST /api/users` after Microsoft sign-in with a Microsoft Graph access token for delegated `User.Read`, using the same token acquisition shown above. No request body is needed; an empty JSON object is also accepted. Profile, identity, and role fields in a JSON body are rejected.

```ts
async function createUser(accessToken: string) {
  const response = await fetch('https://YOUR-SERVICE.onrender.com/api/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data.user;
}

const user = await createUser(result.accessToken);
```

The response contains `id` (the database user UUID), `microsoftUserId`, `tenantId`, `displayName`, `email`, `role`, `targetEntities`, `isActive`, `deletedAt`, `createdAt`, `updatedAt`, and `lastSeenAt`. Timestamps are ISO strings; name and email can be null. The database `id` is distinct from the Microsoft ID returned by `/api/me` and used for request ownership.

The backend verifies the Microsoft profile and organization before writing. A unique `(tenant_id, microsoft_user_id)` constraint makes repeat and concurrent calls safe: existing users keep their database ID and creation timestamp while their profile, update timestamp, and last-seen timestamp are refreshed. Profile refreshes preserve role, entity grants, and activation state. Inactive or deleted accounts receive `403` and cannot refresh or recreate their profile. No password or token is stored. `lastSeenAt` records the last successful call to this endpoint.

Restart the backend after updating: startup creates the `users` table if absent. Row-level security is enabled without public policies so profile access goes through this backend. Its database connection must use the table owner or a role with `BYPASSRLS`, as the current Supabase `postgres` connection does.

### Roles and permissions

The `roles` table stores permission arrays and has three protected built-in roles, referenced by `users.role`. Each user has one role:

| Role | Permissions |
| --- | --- |
| `user` | Create requests and view their own requests |
| `support` | User permissions plus view and update all requests in their organization |
| `admin` | Support permissions plus manage users/roles and read Borg sales and stock for explicitly assigned entities |

New users have the basic `user` role, `targetEntities: []`, and `isActive: true`: they can create/view their own support requests but cannot read any Borg entity data. Startup adds `users.target_entities` (PostgreSQL `TEXT[]`, empty by default), `is_active`, and `deleted_at`, and upgrades the former fixed-role constraint to allow custom roles. **Existing users, including admins, receive an empty entity list on upgrade.** Existing role assignments are preserved. Entity grants and custom roles survive restarts and profile refreshes.

Permissions for saved accounts come from `roles.permissions`. The built-in permission sets are maintained at startup; custom roles are left unchanged. The service uses one configured Microsoft tenant; role definitions belong to this backend installation.

After Microsoft authentication, the backend reads the role permissions, activation state, deletion state, and entity grants from PostgreSQL on every request. Accounts without a saved profile have only `user` access and no entity grants. Inactive and deleted accounts receive `403` on every authenticated endpoint. Database lookup failures deny access rather than trusting frontend data. `/api/me` returns `role`, `permissions`, `targetEntities`, `isActive`, and `isAdmin` (true only for `admin`). Use permission strings such as `requests:update` to show frontend controls; backend route checks and organization/ownership filters enforce access independently.

To assign the first administrator:

1. Start the updated backend once to initialize the role schema.
2. Sign in and call `POST /api/users`; copy `user.id` from the response (the internal database UUID).
3. Run this operator command locally with your database and tenant configured in `.env`:

```sh
npm run user:role -- YOUR_DATABASE_USER_UUID admin
```

The command only updates an existing user within `MICROSOFT_TENANT_ID`. It requires database credentials and is intended for initial setup or recovery. In a production installation without development dependencies, the equivalent after building is `node --env-file-if-exists=.env dist/set-user-role.js YOUR_DATABASE_USER_UUID admin`.

**Upgrade from environment-based staff access:** `SUPPORT_ADMIN_USER_IDS` is no longer used. Assign those existing staff accounts the `support` role using the operator command or an administrator. The new schema defaults everyone to `user`; no account is automatically promoted to administrator.

Once an administrator exists, use their Microsoft Graph token to assign roles:

```ts
const response = await fetch(`${API_URL}/api/users/${databaseUserId}/role`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${result.accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ role: 'support' }),
});
const data = await response.json();
if (!response.ok) throw new Error(data.error);
```

The endpoint returns `200` with `{ user }`. Non-admins receive `403`; unknown roles or unsupported fields return `400`; missing or cross-organization targets return `404`. Administrators cannot demote, deactivate, or delete their own account (`409`); the operator command supports recovery. Role changes take effect on the next API request without signing in again. Public Supabase Data API access to `roles` and `users` is blocked by row-level security without public policies; assignments go through this backend or a trusted database operator.

### Custom roles and user management

All management endpoints require an active administrator. Use the database user UUID from `POST /api/users` or `GET /api/users`, not the Microsoft user ID.

Create a role with `POST /api/roles`:

```json
{
  "name": "sales-reader",
  "description": "Read sales for assigned entities",
  "permissions": ["sales:read"]
}
```

Names must start with a lowercase letter and contain only lowercase letters, digits, `_`, or `-` (1–50 characters). Description is required (1–500 characters). Permissions default to `[]`; allowed values are returned as `assignablePermissions` by `GET /api/roles`: `requests:create`, `requests:read:own`, `requests:read:all`, `requests:update`, `sales:read`, and `stock:read`. `requests:read:all` includes reading one's own requests. Custom roles cannot grant user or role administration; assign the built-in `admin` role for that. Unknown or duplicate permissions return `400`.

Assign the role with `PATCH /api/users/:id/role` and `{ "role": "sales-reader" }`. Assigning `user` removes elevated role permissions. Role assignment does not change the user's entity grants. Delete a custom role with `DELETE /api/roles/:name`; built-in roles, duplicate role names, and deletion of assigned roles return `409`. Reassign all users of a custom role before deleting it. Missing roles return `404`.

Set entity grants with `PATCH /api/users/:id`:

```json
{ "targetEntities": ["agritehnica", "babyhub"] }
```

This replaces the complete entity list. Allowed entries are `agritehnica`, `green`, and `babyhub`; duplicates and unknown values are rejected. Send `{ "targetEntities": [] }` to revoke all entity access. Sales requires **both** `sales:read` and the requested entity in this list, including for admins. Users with only the basic `user` role need a sales-capable role as well as an entity grant. Support requests retain their existing organization/ownership rules and are not Borg entity data.

Use the same endpoint with `{ "isActive": false }` to deactivate or `{ "isActive": true }` to reactivate an account. Both fields can be updated together. Omitted fields remain unchanged; empty bodies and unsupported fields return `400`. Deactivation preserves role and entity grants for reactivation. Changes apply to the next API request; already-running requests are not cancelled.

`DELETE /api/users/:id` soft-deletes the account: it sets `deletedAt`, deactivates it, clears entity grants, and resets its role to `user`. The identity row and support history are retained so Microsoft sign-in cannot undo deletion. Deleted users cannot be reactivated or assigned roles through the API; use deactivation for temporary suspension. Missing, already-deleted, or cross-organization targets return `404`. `GET /api/users` includes inactive and deleted users with their state fields so the frontend can distinguish them. These endpoints affect backend access only, not the Microsoft directory account.

### Borg configuration

The backend calls Borg below one base URL, `https://borg.agritehnica.ro/api2/borg` by default, appending the endpoint: `/sales` and `/stock`. Configure the **backend-only** credential in `.env` locally and in the Render service's Environment settings:

```dotenv
BORG_API_AUTHORIZATION="YOUR_EXACT_AUTHORIZATION_HEADER_VALUE"
# Optional: only to use a different Borg host. No endpoint path, query, or fragment.
# BORG_API_URL="https://borg.agritehnica.ro/api2/borg"
```

Set the authorization value exactly as Borg expects: `Bearer <token>` if it uses Bearer authentication, otherwise the raw token. In Render's value fields, omit the surrounding dotenv quotes. Leave `BORG_API_AUTHORIZATION` empty to disable the integration (`503`); setting `BORG_API_URL` without it is a configuration error. `BORG_SALES_URL` is no longer read. Restart/redeploy after changing these values.

### Borg stock

```ts
const query = new URLSearchParams({ code: '4063846331017', targetEntity: 'babyhub' });
const response = await fetch(`${API_URL}/api/borg/stock?${query}`, {
  headers: { Authorization: `Bearer ${result.accessToken}` },
});
const data = await response.json();
if (!response.ok) throw new Error(data.error);
```

`code` is required: 1–64 letters, digits, `.`, `_`, or `-`. `targetEntity` is required and must be in the user's entity grants; the user also needs `stock:read` (included in `admin`; add it to custom roles as needed). Borg's JSON object or array of objects is returned unchanged. Errors, timeouts, and credential handling match Borg sales below.

### Borg sales

The frontend sends its **Microsoft Graph access token** to this backend. The backend verifies the user's saved `sales:read` permission and explicit grant for the requested `targetEntity`, then uses the separate Borg credential for the upstream request. It never forwards the Microsoft token to Borg. An empty entity list denies all Borg data access, even for admins. The built-in `user` and `support` roles lack `sales:read`; create and assign a custom sales role when appropriate.

```ts
const query = new URLSearchParams({
  targetEntity: 'babyhub',
  from: '2026-09-01',
  to: '2026-09-30',
  docType: 'BFD',
  gestiune: '2',
  limit: '5000',
  includeTransfers: 'false',
});
const response = await fetch(`${API_URL}/api/borg/sales?${query}`, {
  headers: { Authorization: `Bearer ${result.accessToken}` },
});
const data = await response.json();
if (!response.ok) throw new Error(data.error);
const lines = data; // Plain array, including [] when no sales match.
```

| Query field | Validation/default |
| --- | --- |
| `targetEntity` | Required: `agritehnica`, `green`, or `babyhub` |
| `from`, `to` | Required, real `YYYY-MM-DD` dates; `from <= to` |
| `gestiune` | Optional positive safe integer warehouse ID |
| `docType` | Optional `BFD` or `AIM`; omit for both |
| `limit` | Integer 1–50000; default 5000 |
| `includeTransfers` | Literal `true` or `false`; default `false` |

The interval may include **at most 30 calendar days, counting both endpoints**, and must stay in one calendar year. September 1–30 is valid; August 1–31 is not. Ranges can cross month boundaries within the same year if they still fit within 30 days. Split longer ranges into non-overlapping requests. Invalid, repeated, or unknown query parameters return `400` before contacting Borg.

Product lines, negative return quantities/values, nullable invoice fields, costs, and margins are passed through without aggregation or database storage. The response has no wrapper, totals, or truncation flag. If `lines.length === limit`, treat the result as potentially truncated and raise the limit or narrow the interval before computing dashboard totals. Requests are not automatically retried or paginated, and responses have `Cache-Control: no-store`.

The upstream call times out after 30 seconds (`504`) and does not follow redirects. An upstream `400` becomes a sanitized `400`; throttling or temporary unavailability becomes `503`; other upstream HTTP, connection, or malformed-response failures become `502`. Upstream error bodies and credentials are never returned to the frontend. `401`/`403` from Borg become `502` because they indicate a backend integration problem, not a failed Microsoft login.

## Deploy on Render

1. Push this repository to your Git provider.
2. Create a Render PostgreSQL database in the same region as your web service. Choose a database plan with the retention you need.
3. Create a **Blueprint** from this repository using `render.yaml`, or create a Node web service manually with build command `npm ci --include=dev && npm run build && npm prune --omit=dev`, start command `npm start`, and health check `/health`. Development dependencies are needed to compile TypeScript and are removed after the build.
4. Set the variables below. For a manual web service, also set `NODE_ENV=production` and `TRUST_PROXY_HOPS=1`.
5. Deploy, open `/health`, and point your frontend at the service's HTTPS URL.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Render Postgres **internal** database URL for the same region/workspace |
| `MICROSOFT_TENANT_ID` | Your directory's tenant UUID |
| `FRONTEND_ORIGINS` | Exact frontend origin, e.g. `https://help.example.com`; comma-separated for multiple origins, no trailing slash |
| `BORG_API_AUTHORIZATION` | Optional secret: exact upstream Authorization header value; enables Borg |
| `BORG_API_URL` | Optional Borg base URL; defaults to `https://borg.agritehnica.ro/api2/borg` |
| `TRUST_PROXY_HOPS` | `1` behind Render's proxy; `0` locally; match your actual proxy topology |
| `PORT` | Provided by Render; defaults to `3000` locally |

The Blueprint creates only a web service; you supply an existing database URL. It selects Render's free web service plan. `.node-version` selects Node 24. The server binds to `0.0.0.0`, checks the database on `/health`, and handles shutdown signals. For external PostgreSQL, use your provider's documented TLS connection string; the app does not disable certificate verification.

References: [Render Node deployment](https://render.com/docs/deploy-node-express-app), [Render PostgreSQL connections](https://render.com/docs/postgresql-creating-connecting).

## Tests

```sh
npm run typecheck
npm test
# Optional real-PostgreSQL tests: use a dedicated, disposable database.
TEST_DATABASE_URL=postgresql://localhost/ags_test npm test
```

The default suite mocks Microsoft Graph and tests authentication, tenant restrictions, validation, staff permissions, CORS, errors, and pagination. The database suite uses a temporary schema to verify persistence and tenant/user isolation and removes that schema afterward. Live Microsoft login requires your own tenant and frontend registration.
