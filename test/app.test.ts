import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { permissionsFor } from '../src/permissions.js';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { BorgFetch } from '../src/borg.js';
import type { AppConfig, AuthenticatedUser, CreateRequestInput, GraphFetch, RequestPage, Role, Store, SupportRequest, UserAccess } from '../src/types.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';
const requestId = '33333333-3333-3333-3333-333333333333';
const config: AppConfig = { tenantId, origins: ['https://frontend.example'], trustProxyHops: 0, port: 3000, databaseUrl: 'postgresql://localhost/ags_test' };

interface SetupOptions {
  config?: Partial<AppConfig>;
  store?: Partial<Store>;
  fetchGraph?: GraphFetch;
  fetchBorg?: BorgFetch;
  tenantId?: string;
  rateLimitMax?: number;
  role?: Role;
  targetEntities?: UserAccess['targetEntities'];
}

const storedRequest: SupportRequest = {
  id: requestId, title: 'Help', description: 'Please help', priority: 'normal', status: 'open',
  ownerId: userId, ownerName: 'Test User', ownerEmail: 'user@example.com',
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function access(role: Role = 'user', targetEntities: UserAccess['targetEntities'] = []): UserAccess {
  return { role, permissions: permissionsFor(role), targetEntities, isActive: true, deletedAt: null };
}

function setup(options: SetupOptions = {}) {
  const calls: { user: AuthenticatedUser; input?: CreateRequestInput; page?: RequestPage }[] = [];
  const store: Store = {
    health: async () => {},
    getUserAccess: async () => access(options.role, options.targetEntities),
    createRole: async (user, role) => role,
    deleteRole: async () => false,
    updateUser: async () => undefined,
    deleteUser: async () => false,
    listRoles: async () => [{ name: 'user', description: 'Own requests', permissions: permissionsFor('user') }],
    listUsers: async () => [],
    updateUserRole: async () => undefined,
    createUser: async user => {
      calls.push({ user });
      return {
        id: requestId, microsoftUserId: user.id, tenantId: user.tenantId,
        displayName: user.displayName, email: user.email, role: options.role ?? 'user',
        targetEntities: [], isActive: true, deletedAt: null,
        createdAt: storedRequest.createdAt, updatedAt: storedRequest.updatedAt,
        lastSeenAt: storedRequest.updatedAt,
      };
    },
    create: async (user, input) => { calls.push({ user, input }); return { ...storedRequest, ...input }; },
    list: async (user, page) => { calls.push({ user, page }); return []; },
    get: async () => undefined,
    updateStatus: async (user, id, status) => ({ ...storedRequest, id, status }),
    ...options.store,
  };
  const graphCalls: { url: string; init: RequestInit }[] = [];
  const fetchGraph: GraphFetch = options.fetchGraph ?? (async (url, init) => {
    graphCalls.push({ url, init });
    return Response.json(url.includes('/me?')
      ? { id: userId, displayName: 'Test User', mail: 'user@example.com' }
      : { value: [{ id: options.tenantId ?? tenantId }] });
  });
  const app = createApp({ config: { ...config, ...options.config }, store, fetchGraph, fetchBorg: options.fetchBorg, rateLimitMax: options.rateLimitMax ?? 120 });
  return { client: request(app), calls, graphCalls };
}
const bearer = ['Authorization', 'Bearer opaque-graph-token'] as const;

test('createUser saves the verified Microsoft profile with no body or an empty object', async () => {
  const { client, calls } = setup();
  const first = await client.post('/api/users').set(...bearer).expect(200);
  const repeated = await client.post('/api/users').set(...bearer).send({}).expect(200);
  assert.deepEqual(first.body, repeated.body);
  assert.equal(first.body.user.id, requestId);
  assert.equal(first.body.user.microsoftUserId, userId);
  assert.equal(first.body.user.tenantId, tenantId);
  assert.equal(first.body.user.email, 'user@example.com');
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.user, {
    id: userId, tenantId, displayName: 'Test User', email: 'user@example.com', isAdmin: false, role: 'user',
    permissions: permissionsFor('user'), targetEntities: [], isActive: true,
  });
  assert.ok(!first.text.includes('opaque-graph-token'));
});

test('createUser rejects client-supplied identity and privilege fields before saving', async () => {
  const { client, calls } = setup();
  for (const body of [{ id: requestId }, { tenantId: requestId }, { email: 'other@example.com' },
    { displayName: 'Other' }, { role: 'admin' }, { isAdmin: true }, { token: 'token' }, []]) {
    await client.post('/api/users').set(...bearer).send(body).expect(400);
  }
  assert.equal(calls.length, 0);
});

test('createUser requires valid authentication and the configured organization', async () => {
  const missing = setup();
  await missing.client.post('/api/users').expect(401);
  assert.equal(missing.calls.length, 0);
  const invalid = setup({ fetchGraph: async () => new Response(null, { status: 401 }) });
  await invalid.client.post('/api/users').set(...bearer).expect(401);
  assert.equal(invalid.calls.length, 0);
  const foreign = setup({ tenantId: requestId });
  await foreign.client.post('/api/users').set(...bearer).expect(403);
  assert.equal(foreign.calls.length, 0);
});

test('createUser does not expose database errors', async () => {
  const { client } = setup({ store: { createUser: async () => { throw Error('private database details'); } } });
  await client.post('/api/users').set(...bearer).expect(500, { error: 'An unexpected server error occurred.' });
});

test('health checks database without authentication', async () => {
  const { client, graphCalls } = setup();
  await client.get('/health').expect(200, { status: 'ok' });
  assert.equal(graphCalls.length, 0);
  await setup({ store: { health: async () => { throw Error('private database details'); } } }).client.get('/health').expect(503, { status: 'unavailable' });
});

test('missing and malformed tokens never reach Graph', async () => {
  const { client, graphCalls } = setup();
  for (const header of ['', 'Basic abc', 'Bearer a b']) {
    const response = await client.get('/api/me').set('Authorization', header).expect(401);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
  }
  assert.equal(graphCalls.length, 0);
});

test('opaque tokens work through Graph with verified identity', async () => {
  const { client, graphCalls } = setup();
  const { body, headers } = await client.get('/api/me').set(...bearer).expect(200);
  assert.deepEqual(body.user, { id: userId, tenantId, displayName: 'Test User', email: 'user@example.com', isAdmin: false, role: 'user', permissions: ['requests:create', 'requests:read:own'], targetEntities: [], isActive: true });
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(graphCalls.length, 2);
  for (const call of graphCalls) {
    assert.equal(new Headers(call.init.headers).get('Authorization'), bearer[1]);
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.url.startsWith('https://graph.microsoft.com/v1.0/'));
  }
});

test('another tenant is denied before application data access', async () => {
  const { client, calls } = setup({ tenantId: requestId });
  await client.get('/api/requests').set(...bearer).expect(403);
  assert.equal(calls.length, 0);
});

test('accounts without an organization are rejected', async () => {
  const { client } = setup({ fetchGraph: async url => Response.json(url.includes('/me?') ? { id: userId } : { value: [] }) });
  await client.get('/api/me').set(...bearer).expect(403);
});

test('Graph failures return safe errors', async () => {
  for (const [upstream, expected] of [[401, 401], [403, 403], [400, 403], [429, 503], [500, 503]] as const) {
    const { client } = setup({ fetchGraph: async () => new Response('secret upstream details', { status: upstream }) });
    const response = await client.get('/api/me').set(...bearer).expect(expected);
    assert.ok(!response.text.includes('secret'));
  }
  await setup({ fetchGraph: async () => { throw Error('private network error'); } }).client.get('/api/me').set(...bearer).expect(503);
});

test('creation validates input and assigns verified ownership', async () => {
  const { client, calls } = setup();
  const result = await client.post('/api/requests').set(...bearer).send({ title: ' Help ', description: ' Email does not work ' }).expect(201);
  assert.equal(result.headers.location, `/api/requests/${requestId}`);
  assert.ok(calls[0]);
  assert.deepEqual(calls[0].input, { title: 'Help', description: 'Email does not work', priority: 'normal' });
  assert.equal(calls[0].user.id, userId);
  for (const body of [{ title: '', description: 'x' }, { title: 'x', description: 'x', ownerId: requestId }, { title: 'x', description: 'x', priority: 'urgent' }, []]) {
    await client.post('/api/requests').set(...bearer).send(body).expect(400);
  }
  assert.equal(calls.length, 1);
});

test('invalid JSON and oversized payloads are handled', async () => {
  const { client } = setup();
  await client.post('/api/requests').set(...bearer).set('Content-Type', 'application/json').send('{').expect(400);
  await client.post('/api/requests').set(...bearer).send({ title: 'x', description: 'a'.repeat(40000) }).expect(413);
});

test('listing uses verified identity and bounded pagination', async () => {
  const { client, calls } = setup();
  await client.get('/api/requests?status=open&limit=10&offset=20').set(...bearer).expect(200, { requests: [], limit: 10, offset: 20 });
  assert.ok(calls[0]);
  assert.deepEqual(calls[0].page, { status: 'open', limit: 10, offset: 20 });
  assert.equal(calls[0].user.isAdmin, false);
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'status=unknown', 'limit=1&limit=2']) {
    await client.get(`/api/requests?${query}`).set(...bearer).expect(400);
  }
});

test('missing requests are 404; malformed IDs are 400', async () => {
  const { client } = setup();
  await client.get(`/api/requests/${requestId}`).set(...bearer).expect(404);
  await client.get('/api/requests/not-a-uuid').set(...bearer).expect(400);
});

test('support can update status', async () => {
  await setup().client.patch(`/api/requests/${requestId}`).set(...bearer).send({ status: 'resolved' }).expect(403);
  const { client } = setup({ role: 'support' });
  const result = await client.patch(`/api/requests/${requestId}`).set(...bearer).send({ status: 'resolved' }).expect(200);
  assert.equal(result.body.request.id, requestId);
  assert.equal(result.body.request.status, 'resolved');
  await client.patch(`/api/requests/${requestId}`).set(...bearer).send({ status: 'invalid' }).expect(400);
  await client.patch(`/api/requests/${requestId}`).set(...bearer).send({ status: 'open', ownerId: userId }).expect(400);
});

test('CORS handles allowed preflights and rejects other origins', async () => {
  const { client, graphCalls } = setup();
  const origin = config.origins[0];
  assert.ok(origin);
  const response = await client.options('/api/requests').set('Origin', origin).set('Access-Control-Request-Method', 'POST').expect(204);
  assert.equal(response.headers['access-control-allow-origin'], config.origins[0]);
  await client.get('/api/me').set('Origin', 'https://other.example').set(...bearer).expect(403);
  assert.equal(graphCalls.length, 0);
});

test('rate limiting stops repeated Graph calls', async () => {
  const { client, graphCalls } = setup({ rateLimitMax: 1 });
  await client.get('/api/me').set(...bearer).expect(200);
  await client.get('/api/me').set(...bearer).expect(429);
  assert.equal(graphCalls.length, 2);
});

test('configuration rejects missing tenant and invalid origins', () => {
  const env = { MICROSOFT_TENANT_ID: tenantId, DATABASE_URL: 'postgresql://localhost/ags', FRONTEND_ORIGINS: 'https://frontend.example' };
  assert.equal(readConfig(env).tenantId, tenantId);
  assert.throws(() => readConfig({ ...env, MICROSOFT_TENANT_ID: '' }));
  assert.throws(() => readConfig({ ...env, FRONTEND_ORIGINS: '*' }));
  assert.throws(() => readConfig({ ...env, FRONTEND_ORIGINS: 'https://frontend.example/path' }));
});

test('me reports the current database role and permissions on every request', async () => {
  let role: Role = 'support';
  const { client } = setup({ store: { getUserAccess: async () => access(role, ['babyhub']) } });
  const support = await client.get('/api/me').set(...bearer).expect(200);
  assert.equal(support.body.user.role, 'support');
  assert.equal(support.body.user.isAdmin, false);
  assert.ok(support.body.user.permissions.includes('requests:update'));
  await client.patch(`/api/requests/${requestId}`).set(...bearer).send({ status: 'resolved' }).expect(200);
  role = 'user';
  await client.patch(`/api/requests/${requestId}`).set(...bearer).send({ status: 'resolved' }).expect(403);
  role = 'admin';
  const admin = await client.get('/api/me').set(...bearer).expect(200);
  assert.equal(admin.body.user.isAdmin, true);
  assert.ok(admin.body.user.permissions.includes('users:roles:update'));
});

test('missing users have basic access; empty custom roles and database failures fail closed', async () => {
  const missing = setup({ store: { getUserAccess: async () => undefined } });
  const { body } = await missing.client.get('/api/me').set(...bearer).expect(200);
  assert.equal(body.user.role, 'user');
  await missing.client.get('/api/users').set(...bearer).expect(403);
  const invalid = setup({ store: { getUserAccess: async () => access('empty-role') } });
  await invalid.client.get('/api/requests').set(...bearer).expect(403);
  const failure = setup({ store: { getUserAccess: async () => { throw Error('private database error'); } } });
  await failure.client.patch(`/api/requests/${requestId}`).set(...bearer).send({ status: 'resolved' }).expect(500);
});

test('only admins can list users, view roles, or assign roles', async () => {
  for (const role of ['user', 'support'] as const) {
    const { client } = setup({ role, store: {
      listUsers: async () => { assert.fail('Unauthorized user listing'); },
      listRoles: async () => { assert.fail('Unauthorized role listing'); },
      updateUserRole: async () => { assert.fail('Unauthorized role assignment'); },
    } });
    await client.get('/api/users').set(...bearer).expect(403);
    await client.get('/api/roles').set(...bearer).expect(403);
    await client.patch(`/api/users/${requestId}/role`).set(...bearer).send({ role: 'admin' }).expect(403);
  }
});

test('admin user listing validates pagination and passes verified organization', async () => {
  let count = 0;
  const { client } = setup({ role: 'admin', store: {
    listUsers: async (user, page) => {
      count++;
      assert.equal(user.tenantId, tenantId);
      assert.equal(user.role, 'admin');
      assert.deepEqual(page, { limit: 5, offset: 10 });
      return [];
    },
  } });
  await client.get('/api/users?limit=5&offset=10').set(...bearer).expect(200, { users: [], limit: 5, offset: 10 });
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=1000001']) {
    await client.get(`/api/users?${query}`).set(...bearer).expect(400);
  }
  assert.equal(count, 1);
  const { body } = await client.get('/api/roles').set(...bearer).expect(200);
  assert.deepEqual(body.roles[0].permissions, ['requests:create', 'requests:read:own']);
});

test('admin role assignment validates inputs and returns the saved role', async () => {
  let count = 0;
  const { client } = setup({ role: 'admin', store: {
    updateUserRole: async (actor, id, role) => {
      count++;
      assert.equal(actor.id, userId);
      assert.equal(actor.tenantId, tenantId);
      assert.equal(id, requestId);
      return {
        id, microsoftUserId: '44444444-4444-4444-4444-444444444444', tenantId,
        displayName: 'Other user', email: null, role, targetEntities: [], isActive: true, deletedAt: null,
        createdAt: storedRequest.createdAt, updatedAt: storedRequest.updatedAt, lastSeenAt: storedRequest.updatedAt,
      };
    },
  } });
  for (const role of ['user', 'support', 'admin']) {
    const { body } = await client.patch(`/api/users/${requestId}/role`).set(...bearer).send({ role }).expect(200);
    assert.equal(body.user.role, role);
  }
  for (const body of [{}, { role: 'Invalid Role' }, { role: null }, { role: 'admin', tenantId }, []]) {
    await client.patch(`/api/users/${requestId}/role`).set(...bearer).send(body).expect(400);
  }
  await client.patch('/api/users/not-a-uuid/role').set(...bearer).send({ role: 'user' }).expect(400);
  assert.equal(count, 3);
  await setup({ role: 'admin' }).client.patch(`/api/users/${requestId}/role`).set(...bearer).send({ role: 'user' }).expect(404);
});

test('role lookup never runs for invalid or foreign Microsoft identities', async () => {
  const store = { getUserAccess: async () => { assert.fail('Unverified identity reached the database'); } };
  await setup({ store }).client.get('/api/roles').expect(401);
  await setup({ store, tenantId: requestId }).client.get('/api/roles').set(...bearer).expect(403);
});

const salesPath = '/api/borg/sales?targetEntity=babyhub&from=2026-09-01&to=2026-09-30';
const borgConfig = { baseUrl: 'https://borg.example/api2/borg', authorization: 'Bearer private-borg-token' };

test('only verified admins can call Borg sales; role revocation takes effect on the next request', async () => {
  let count = 0;
  const fetchBorg: BorgFetch = async () => { count++; return Response.json([]); };
  for (const role of ['user', 'support'] as const) {
    await setup({ role, config: { borg: borgConfig }, fetchBorg }).client.get(salesPath).set(...bearer).expect(403);
  }
  await setup({ role: 'admin', targetEntities: ['babyhub'], config: { borg: borgConfig }, fetchBorg }).client.get(salesPath).expect(401);
  await setup({ role: 'admin', tenantId: requestId, config: { borg: borgConfig }, fetchBorg }).client.get(salesPath).set(...bearer).expect(403);
  assert.equal(count, 0);
  let role: Role = 'admin';
  const { client } = setup({ store: { getUserAccess: async () => access(role, ['babyhub']) }, config: { borg: borgConfig }, fetchBorg });
  await client.get(salesPath).set(...bearer).expect(200, []);
  role = 'support';
  await client.get(salesPath).set(...bearer).expect(403);
  assert.equal(count, 1);
});

test('Borg sales returns the plain array and keeps frontend and upstream credentials separate', async () => {
  const lines = [{ documentId: 2157, cantitate: -1, valoareTotal: -1332, facturaData: null }];
  const { client } = setup({ role: 'admin', targetEntities: ['babyhub'], config: { borg: borgConfig }, fetchBorg: async (url, init) => {
    assert.equal(new Headers(init.headers).get('Authorization'), borgConfig.authorization);
    assert.ok(!url.includes('opaque-graph-token'));
    return Response.json(lines);
  } });
  const response = await client.get(`${salesPath}&docType=BFD&gestiune=2`).set(...bearer).expect(200, lines);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(!response.text.includes('private-borg-token'));
  const me = await client.get('/api/me').set(...bearer).expect(200);
  assert.ok(me.body.user.permissions.includes('sales:read'));
});

test('invalid sales queries are rejected before calling Borg', async () => {
  const { client } = setup({ role: 'admin', targetEntities: ['babyhub'], config: { borg: borgConfig }, fetchBorg: async () => { assert.fail('Invalid query reached Borg'); } });
  for (const path of [
    '/api/borg/sales',
    '/api/borg/sales?targetEntity=babyhub&from=2026-08-01&to=2026-08-31',
    '/api/borg/sales?targetEntity=babyhub&from=2026-12-31&to=2027-01-01',
    `${salesPath}&targetEntity=green`, `${salesPath}&limit=50001`, `${salesPath}&from=2026-09-02`,
    `${salesPath}&includeTransfers=1`, `${salesPath}&url=https://attacker.example`,
  ]) await client.get(path).set(...bearer).expect(400);
});

test('unconfigured Borg and upstream failures return safe API errors', async () => {
  await setup({ role: 'admin', targetEntities: ['babyhub'] }).client.get(salesPath).set(...bearer).expect(503);
  const { client } = setup({ role: 'admin', targetEntities: ['babyhub'], config: { borg: borgConfig }, fetchBorg: async () => new Response('private-borg-token', { status: 401 }) });
  const response = await client.get(salesPath).set(...bearer).expect(502);
  assert.ok(!response.text.includes('private-borg-token'));
  assert.equal(response.headers['www-authenticate'], undefined);
});

test('sales requires an explicit entity grant even for admins and checks revocation each request', async () => {
  let grants: UserAccess['targetEntities'] = [];
  let calls = 0;
  const { client } = setup({ config: { borg: borgConfig }, store: {
    getUserAccess: async () => access('admin', grants),
  }, fetchBorg: async () => { calls++; return Response.json([]); } });
  await client.get(salesPath).set(...bearer).expect(403);
  grants = ['green'];
  await client.get(salesPath).set(...bearer).expect(403);
  grants = ['babyhub'];
  await client.get(salesPath).set(...bearer).expect(200);
  grants = [];
  await client.get(salesPath).set(...bearer).expect(403);
  assert.equal(calls, 1);
});

test('custom sales roles can access only assigned entities and cannot manage accounts', async () => {
  const { client } = setup({ config: { borg: borgConfig }, store: {
    getUserAccess: async () => ({ ...access('sales-reader', ['babyhub']), permissions: ['sales:read'] }),
  }, fetchBorg: async () => Response.json([]) });
  await client.get(salesPath).set(...bearer).expect(200);
  await client.get(salesPath.replace('babyhub', 'green')).set(...bearer).expect(403);
  await client.get('/api/users').set(...bearer).expect(403);
  await client.get('/api/requests').set(...bearer).expect(403);
});

const stockPath = '/api/borg/stock?code=4063846331017&targetEntity=babyhub';

test('Borg stock requires stock:read and an entity grant, and rejects invalid queries before calling Borg', async () => {
  const stock = [{ gestiune: 2, cantitate: 5 }];
  let calls = 0;
  let permissions: UserAccess['permissions'] = ['sales:read'];
  const { client } = setup({ config: { borg: borgConfig }, store: {
    getUserAccess: async () => ({ ...access('stock-reader', ['babyhub']), permissions }),
  }, fetchBorg: async (url, init) => {
    calls++;
    assert.equal(new URL(url).pathname, '/api2/borg/stock');
    assert.equal(new Headers(init.headers).get('Authorization'), borgConfig.authorization);
    return Response.json(stock);
  } });
  await client.get(stockPath).set(...bearer).expect(403);
  permissions = ['stock:read'];
  const response = await client.get(stockPath).set(...bearer).expect(200, stock);
  assert.equal(response.headers['cache-control'], 'no-store');
  await client.get(stockPath.replace('babyhub', 'green')).set(...bearer).expect(403);
  for (const path of ['/api/borg/stock', '/api/borg/stock?targetEntity=babyhub', `${stockPath}&code=1`, `${stockPath}&url=https://attacker.example`]) {
    await client.get(path).set(...bearer).expect(400);
  }
  assert.equal(calls, 1);
  assert.ok(access('admin').permissions.includes('stock:read'));
  assert.ok(!access('support').permissions.includes('stock:read'));
});

test('inactive and deleted accounts cannot use any authenticated endpoint or recreate themselves', async () => {
  for (const state of [{ isActive: false }, { deletedAt: new Date() }]) {
    const { client } = setup({ store: {
      getUserAccess: async () => ({ ...access('admin', ['babyhub']), ...state }),
      createUser: async () => { assert.fail('Blocked identity refreshed its profile'); },
    } });
    await client.get('/api/me').set(...bearer).expect(403);
    await client.get(salesPath).set(...bearer).expect(403);
    await client.post('/api/users').set(...bearer).expect(403);
    await client.patch(`/api/users/${requestId}`).set(...bearer).send({ isActive: true }).expect(403);
    await client.delete(`/api/users/${requestId}`).set(...bearer).expect(403);
  }
});

test('new user profile bodies cannot supply entity grants or account state', async () => {
  const { client, calls } = setup();
  for (const body of [{ targetEntities: ['babyhub'] }, { isActive: true }, { permissions: ['sales:read'] }, { deletedAt: null }]) {
    await client.post('/api/users').set(...bearer).send(body).expect(400);
  }
  assert.equal(calls.length, 0);
});

test('role creation validates permissions and allows roles with no permissions', async () => {
  const { client } = setup({ role: 'admin' });
  const role = { name: 'sales-reader', description: 'Read selected sales', permissions: ['sales:read'] };
  await client.post('/api/roles').set(...bearer).send(role).expect(201, { role });
  const empty = await client.post('/api/roles').set(...bearer).send({ name: 'empty', description: 'No access' }).expect(201);
  assert.deepEqual(empty.body.role.permissions, []);
  for (const patch of [{ name: 'Invalid' }, { name: 'a'.repeat(51) }, { description: '' },
    { permissions: ['users:roles:update'] }, { permissions: ['unknown'] }, { permissions: ['sales:read', 'sales:read'] },
    { permissions: 'sales:read' }, { permissions: null }, { permissions: [null] }, { extra: true }]) {
    await client.post('/api/roles').set(...bearer).send({ ...role, ...patch }).expect(400);
  }
  await client.delete('/api/roles/missing').set(...bearer).expect(404);
  await client.delete('/api/roles/Invalid').set(...bearer).expect(400);
});

test('user management validates updates, supports clearing grants, and returns deletion status', async () => {
  const updates: unknown[] = [];
  const { client } = setup({ role: 'admin', store: {
    updateUser: async (actor, id, input) => {
      assert.equal(actor.tenantId, tenantId);
      assert.equal(id, requestId);
      updates.push(input);
      return { id, microsoftUserId: userId, tenantId, displayName: null, email: null, role: 'user',
        targetEntities: [], isActive: true, deletedAt: null, ...input,
        createdAt: storedRequest.createdAt, updatedAt: storedRequest.updatedAt, lastSeenAt: storedRequest.updatedAt };
    },
    deleteUser: async (actor, id) => { assert.equal(actor.tenantId, tenantId); return id === requestId; },
    deleteRole: async (actor, name) => { assert.equal(actor.tenantId, tenantId); return name === 'sales-reader'; },
  } });
  for (const input of [{ targetEntities: ['green', 'babyhub'] }, { targetEntities: [] }, { isActive: false }, { isActive: true }]) {
    await client.patch(`/api/users/${requestId}`).set(...bearer).send(input).expect(200);
  }
  assert.equal(updates.length, 4);
  for (const input of [{}, { role: 'admin' }, { isActive: 'false' }, { isActive: null }, { targetEntities: null },
    { targetEntities: 'green' }, { targetEntities: ['unknown'] }, { targetEntities: ['green', 'green'] }, { targetEntities: [null] }]) {
    await client.patch(`/api/users/${requestId}`).set(...bearer).send(input).expect(400);
  }
  assert.equal(updates.length, 4);
  await client.patch('/api/users/invalid').set(...bearer).send({ isActive: true }).expect(400);
  await client.delete('/api/users/invalid').set(...bearer).expect(400);
  await client.delete(`/api/users/${requestId}`).set(...bearer).expect(204);
  await client.delete(`/api/users/${userId}`).set(...bearer).expect(404);
  await client.delete('/api/roles/sales-reader').set(...bearer).expect(204);
  const preflight = await client.options(`/api/users/${requestId}`).set('Origin', config.origins[0]!)
    .set('Access-Control-Request-Method', 'DELETE').expect(204);
  assert.ok(preflight.headers['access-control-allow-methods']?.includes('DELETE'));
});

test('non-admins cannot mutate users or roles', async () => {
  for (const role of ['user', 'support', 'sales-reader']) {
    const { client } = setup({ role, store: {
      createRole: async () => { assert.fail('Unauthorized role creation'); },
      deleteRole: async () => { assert.fail('Unauthorized role deletion'); },
      updateUser: async () => { assert.fail('Unauthorized user update'); },
      deleteUser: async () => { assert.fail('Unauthorized user deletion'); },
    } });
    await client.post('/api/roles').set(...bearer).send({ name: 'empty', description: 'None' }).expect(403);
    await client.delete('/api/roles/empty').set(...bearer).expect(403);
    await client.patch(`/api/users/${requestId}`).set(...bearer).send({ isActive: false }).expect(403);
    await client.delete(`/api/users/${requestId}`).set(...bearer).expect(403);
  }
});


test('custom read-all permission also permits reading own requests', async () => {
  const { client, calls } = setup({ store: {
    getUserAccess: async () => ({ ...access('request-reader'), permissions: ['requests:read:all'] }),
  } });
  await client.get('/api/requests').set(...bearer).expect(200);
  assert.equal(calls.length, 1);
  await client.get(`/api/requests/${requestId}`).set(...bearer).expect(404);
  await client.post('/api/requests').set(...bearer).send({ title: 'Help', description: 'Help' }).expect(403);
});
