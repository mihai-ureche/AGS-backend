import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Store, StoredUser, SupportRequest } from './types.js';

const fields = `id, title, description, priority, status,
  owner_id AS "ownerId", owner_name AS "ownerName", owner_email AS "ownerEmail",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export function createStore(pool: Pool): Store {
  return {
    async health() { await pool.query('SELECT 1'); },
    async createUser(user) {
      const { rows } = await pool.query<StoredUser>(`INSERT INTO users
        (id, tenant_id, microsoft_user_id, display_name, email)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, microsoft_user_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          email = EXCLUDED.email,
          updated_at = NOW(),
          last_seen_at = NOW()
        RETURNING id, tenant_id AS "tenantId", microsoft_user_id AS "microsoftUserId",
          display_name AS "displayName", email, created_at AS "createdAt",
          updated_at AS "updatedAt", last_seen_at AS "lastSeenAt"`,
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
      [user.tenantId, user.isAdmin, user.id, status ?? null, limit, offset]);
      return rows;
    },
    async get(user, id) {
      const { rows } = await pool.query<SupportRequest>(`SELECT ${fields} FROM support_requests
        WHERE id = $1 AND tenant_id = $2 AND ($3::boolean OR owner_id = $4)`,
      [id, user.tenantId, user.isAdmin, user.id]);
      return rows[0];
    },
    async updateStatus(user, id, status) {
      const { rows } = await pool.query<SupportRequest>(`UPDATE support_requests SET status = $4, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND $3::boolean RETURNING ${fields}`,
      [id, user.tenantId, user.isAdmin, status]);
      return rows[0];
    },
  };
}
