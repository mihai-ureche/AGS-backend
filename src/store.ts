import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Role, Store, StoredRole, StoredUser, SupportRequest } from './types.js';
import { hasPermission } from './permissions.js';
import { HttpError } from './errors.js';

const userFields = `id, tenant_id AS "tenantId", microsoft_user_id AS "microsoftUserId",
  display_name AS "displayName", email, role, created_at AS "createdAt",
  updated_at AS "updatedAt", last_seen_at AS "lastSeenAt"`;

const fields = `id, title, description, priority, status,
  owner_id AS "ownerId", owner_name AS "ownerName", owner_email AS "ownerEmail",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export function createStore(pool: Pool): Store {
  return {
    async health() { await pool.query('SELECT 1'); },
    async getUserRole(user) {
      const { rows } = await pool.query<{ role: Role }>(
        'SELECT role FROM users WHERE tenant_id = $1 AND microsoft_user_id = $2',
        [user.tenantId, user.id]);
      return rows[0]?.role;
    },
    async listRoles() {
      return (await pool.query<StoredRole>('SELECT name, description FROM roles ORDER BY name')).rows;
    },
    async listUsers(user, { limit, offset }) {
      if (!hasPermission(user.role, 'users:read')) throw new HttpError(403, 'Only administrators can list users.');
      return (await pool.query<StoredUser>(`SELECT ${userFields} FROM users
        WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [user.tenantId, limit, offset])).rows;
    },
    async updateUserRole(user, id, role) {
      if (!hasPermission(user.role, 'users:roles:update')) throw new HttpError(403, 'Only administrators can assign roles.');
      const target = await pool.query<{ microsoftUserId: string }>(
        'SELECT microsoft_user_id AS "microsoftUserId" FROM users WHERE tenant_id = $1 AND id = $2',
        [user.tenantId, id]);
      if (target.rows[0]?.microsoftUserId === user.id && role !== 'admin') {
        throw new HttpError(409, 'Administrators cannot demote their own account.');
      }
      const { rows } = await pool.query<StoredUser>(`UPDATE users SET role = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2
          AND EXISTS (SELECT 1 FROM users AS actor
            WHERE actor.tenant_id = $1 AND actor.microsoft_user_id = $4 AND actor.role = 'admin')
        RETURNING ${userFields}`, [user.tenantId, id, role, user.id]);
      return rows[0];
    },
    async createUser(user) {
      const { rows } = await pool.query<StoredUser>(`INSERT INTO users
        (id, tenant_id, microsoft_user_id, display_name, email)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, microsoft_user_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          email = EXCLUDED.email,
          updated_at = NOW(),
          last_seen_at = NOW()
        RETURNING ${userFields}`,
      [randomUUID(), user.tenantId, user.id, user.displayName, user.email]);
      const saved = rows[0];
      if (!saved) throw new Error('Database did not return the saved user.');
      return saved;
    },
    async create(user, input) {
      const { rows } = await pool.query<SupportRequest>(`INSERT INTO support_requests
        (id, tenant_id, owner_id, owner_name, owner_email, title, description, priority)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${fields}`,
      [randomUUID(), user.tenantId, user.id, user.displayName, user.email, input.title, input.description, input.priority]);
      const created = rows[0];
      if (!created) throw new Error('Database did not return the created support request.');
      return created;
    },
    async list(user, { status, limit, offset }) {
      const { rows } = await pool.query<SupportRequest>(`SELECT ${fields} FROM support_requests
        WHERE tenant_id = $1 AND ($2::boolean OR owner_id = $3)
          AND ($4::text IS NULL OR status = $4)
        ORDER BY created_at DESC, id DESC LIMIT $5 OFFSET $6`,
      [user.tenantId, hasPermission(user.role, 'requests:read:all'), user.id, status ?? null, limit, offset]);
      return rows;
    },
    async get(user, id) {
      const { rows } = await pool.query<SupportRequest>(`SELECT ${fields} FROM support_requests
        WHERE id = $1 AND tenant_id = $2 AND ($3::boolean OR owner_id = $4)`,
      [id, user.tenantId, hasPermission(user.role, 'requests:read:all'), user.id]);
      return rows[0];
    },
    async updateStatus(user, id, status) {
      const { rows } = await pool.query<SupportRequest>(`UPDATE support_requests SET status = $4, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND $3::boolean RETURNING ${fields}`,
      [id, user.tenantId, hasPermission(user.role, 'requests:update'), status]);
      return rows[0];
    },
  };
}
