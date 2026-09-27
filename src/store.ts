import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RevenueConfiguration } from './revenue.js';
import type { AuthenticatedUser, Store, StoredRole, StoredUser, SupportRequest, UserAccess } from './types.js';
import { hasPermission, isRole } from './permissions.js';
import { HttpError } from './errors.js';

const userFields = `id, tenant_id AS "tenantId", microsoft_user_id AS "microsoftUserId",
  display_name AS "displayName", email, role, target_entities AS "targetEntities",
  is_active AS "isActive", deleted_at AS "deletedAt", created_at AS "createdAt",
  updated_at AS "updatedAt", last_seen_at AS "lastSeenAt"`;

const fields = `id, title, description, priority, status,
  owner_id AS "ownerId", owner_name AS "ownerName", owner_email AS "ownerEmail",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export function createStore(pool: Pool): Store {
  // Recheck and lock the actor during mutations so stale permissions cannot write.
  async function asAdmin<T>(user: AuthenticatedUser, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const actor = await client.query(`SELECT id FROM users WHERE tenant_id = $1
        AND microsoft_user_id = $2 AND role = 'admin' AND is_active AND deleted_at IS NULL FOR UPDATE`,
      [user.tenantId, user.id]);
      if (!actor.rowCount) throw new HttpError(403, 'Active administrator access is required.');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === '23505') throw new HttpError(409, 'Role already exists.');
        if (error.code === '23503') throw new HttpError(409, 'Role is assigned to users or no longer exists.');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  const roleFields = 'name, description, permissions, sales_groups AS "salesGroups"';
  async function revenueConfig(entity: string, client: Pool | PoolClient = pool): Promise<RevenueConfiguration> {
    const { rows } = await client.query<RevenueConfiguration>(`SELECT target_entity AS "targetEntity", enabled, revision,
      default_group_id AS "defaultGroupId", rules,
      (SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY position) FROM revenue_groups) AS groups
      FROM revenue_configurations WHERE target_entity = $1`, [entity]);
    if (!rows[0]) throw new HttpError(503, 'Revenue grouping configuration is unavailable.');
    return rows[0];
  }

  return {
    getRevenueConfiguration: revenueConfig,
    async updateRevenueConfiguration(user, entity, input) {
      return asAdmin(user, async client => {
        await client.query('SELECT target_entity FROM revenue_configurations WHERE target_entity = $1 FOR UPDATE', [entity]);
        const previous = await revenueConfig(entity, client);
        if (previous.revision !== input.revision) throw new HttpError(409, 'Grouping changed. Reload the configuration before saving.');
        await client.query(`UPDATE revenue_configurations SET enabled = $2, default_group_id = $3,
          rules = $4::jsonb, revision = revision + 1 WHERE target_entity = $1`,
        [entity, input.enabled, input.defaultGroupId, JSON.stringify(input.rules)]);
        const next = await revenueConfig(entity, client);
        await client.query(`INSERT INTO revenue_configuration_changes (target_entity, tenant_id, actor_id, previous, next)
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
        [entity, user.tenantId, user.id, JSON.stringify(previous), JSON.stringify(next)]);
        return next;
      });
    },
    async updateRoleSalesGroups(user, name, groups) {
      return asAdmin(user, async client => {
        if (isRole(name)) throw new HttpError(409, 'Built-in role access cannot be changed.');
        const { rows } = await client.query<StoredRole>(`UPDATE roles SET sales_groups = $2 WHERE name = $1 RETURNING ${roleFields}`, [name, groups]);
        return rows[0];
      });
    },
    async health() { await pool.query('SELECT 1'); },
    async getUserAccess(user) {
      const { rows } = await pool.query<UserAccess>(`SELECT u.role, r.permissions, r.sales_groups AS "salesGroups",
        u.target_entities AS "targetEntities", u.is_active AS "isActive", u.deleted_at AS "deletedAt"
        FROM users u JOIN roles r ON r.name = u.role
        WHERE u.tenant_id = $1 AND u.microsoft_user_id = $2`, [user.tenantId, user.id]);
      return rows[0];
    },
    async listRoles() {
      return (await pool.query<StoredRole>(`SELECT ${roleFields} FROM roles ORDER BY name`)).rows;
    },
    async createRole(user, input) {
      return asAdmin(user, async client => {
        if (isRole(input.name)) throw new HttpError(409, 'Built-in roles cannot be replaced.');
        const { rows } = await client.query<StoredRole>(`INSERT INTO roles (name, description, permissions, sales_groups)
          VALUES ($1, $2, $3, $4) RETURNING ${roleFields}`,
        [input.name, input.description, input.permissions, input.salesGroups === undefined ? [] : input.salesGroups]);
        return rows[0]!;
      });
    },
    async deleteRole(user, name) {
      return asAdmin(user, async client => {
        if (isRole(name)) throw new HttpError(409, 'Built-in roles cannot be deleted.');
        const result = await client.query('DELETE FROM roles WHERE name = $1', [name]);
        return result.rowCount === 1;
      });
    },
    async listUsers(user, { limit, offset }) {
      if (!hasPermission(user, 'users:read')) throw new HttpError(403, 'Only administrators can list users.');
      return (await pool.query<StoredUser>(`SELECT ${userFields} FROM users
        WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [user.tenantId, limit, offset])).rows;
    },
    async updateUserRole(user, id, role) {
      return asAdmin(user, async client => {
        const target = await client.query<{ microsoftUserId: string }>(
          `SELECT microsoft_user_id AS "microsoftUserId" FROM users
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`, [user.tenantId, id]);
        if (!target.rowCount) return undefined;
        if (target.rows[0]?.microsoftUserId === user.id && role !== 'admin') {
          throw new HttpError(409, 'Administrators cannot demote their own account.');
        }
        const existingRole = await client.query('SELECT name FROM roles WHERE name = $1 FOR KEY SHARE', [role]);
        if (!existingRole.rowCount) throw new HttpError(400, 'Unknown role.');
        const { rows } = await client.query<StoredUser>(`UPDATE users SET role = $3, updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2 RETURNING ${userFields}`, [user.tenantId, id, role]);
        return rows[0];
      });
    },
    async updateUser(user, id, input) {
      return asAdmin(user, async client => {
        const target = await client.query<{ microsoftUserId: string }>(
          `SELECT microsoft_user_id AS "microsoftUserId" FROM users
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`, [user.tenantId, id]);
        if (!target.rowCount) return undefined;
        if (target.rows[0]?.microsoftUserId === user.id && input.isActive === false) {
          throw new HttpError(409, 'Administrators cannot deactivate their own account.');
        }
        const { rows } = await client.query<StoredUser>(`UPDATE users SET
          target_entities = COALESCE($3::text[], target_entities),
          is_active = COALESCE($4::boolean, is_active), updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2 RETURNING ${userFields}`,
        [user.tenantId, id, input.targetEntities ?? null, input.isActive ?? null]);
        return rows[0];
      });
    },
    async deleteUser(user, id) {
      return asAdmin(user, async client => {
        const target = await client.query<{ microsoftUserId: string }>(
          `SELECT microsoft_user_id AS "microsoftUserId" FROM users
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`, [user.tenantId, id]);
        if (!target.rowCount) return false;
        if (target.rows[0]?.microsoftUserId === user.id) {
          throw new HttpError(409, 'Administrators cannot delete their own account.');
        }
        await client.query(`UPDATE users SET is_active = FALSE, deleted_at = NOW(),
          role = 'user', target_entities = '{}', updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2`, [user.tenantId, id]);
        return true;
      });
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
        WHERE users.is_active AND users.deleted_at IS NULL
        RETURNING ${userFields}`,
      [randomUUID(), user.tenantId, user.id, user.displayName, user.email]);
      const saved = rows[0];
      if (!saved) throw new HttpError(403, 'Your account is inactive or deleted.');
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
      [user.tenantId, hasPermission(user, 'requests:read:all'), user.id, status ?? null, limit, offset]);
      return rows;
    },
    async get(user, id) {
      const { rows } = await pool.query<SupportRequest>(`SELECT ${fields} FROM support_requests
        WHERE id = $1 AND tenant_id = $2 AND ($3::boolean OR owner_id = $4)`,
      [id, user.tenantId, hasPermission(user, 'requests:read:all'), user.id]);
      return rows[0];
    },
    async updateStatus(user, id, status) {
      const { rows } = await pool.query<SupportRequest>(`UPDATE support_requests SET status = $4, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND $3::boolean RETURNING ${fields}`,
      [id, user.tenantId, hasPermission(user, 'requests:update'), status]);
      return rows[0];
    },
  };
}
