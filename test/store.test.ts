import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { permissionsFor } from '../src/permissions.js';
import { createStore } from '../src/store.js';
import type { AuthenticatedUser, CreateRequestInput } from '../src/types.js';

test('PostgreSQL persistence and user/staff/tenant isolation', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `ags_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, options: `-c search_path=${schema}` });
  try {
    // Schema name is generated locally, never supplied by a request.
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    const ddl = await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8');
    await pool.query(ddl);
    await pool.query(ddl);
    const store = createStore(pool);
    const owner: AuthenticatedUser = { id: randomUUID(), tenantId: randomUUID(), displayName: 'Owner', email: 'owner@example.com', isAdmin: false, role: 'user', permissions: permissionsFor('user'), targetEntities: [], isActive: true };
    const other = { ...owner, id: randomUUID() };
    const staff: AuthenticatedUser = { ...other, isAdmin: false, role: 'support', permissions: permissionsFor('support') };
    const foreignStaff = { ...staff, tenantId: randomUUID() };
    const savedUser = await store.createUser(owner);
    assert.equal(savedUser.microsoftUserId, owner.id);
    assert.equal(savedUser.tenantId, owner.tenantId);
    assert.equal(savedUser.displayName, owner.displayName);
    assert.equal(savedUser.email, owner.email);
    assert.ok(savedUser.createdAt instanceof Date);
    const updatedUser = await createStore(pool).createUser({ ...owner, displayName: 'New name', email: 'new@example.com' });
    assert.equal(updatedUser.id, savedUser.id);
    assert.deepEqual(updatedUser.createdAt, savedUser.createdAt);
    assert.ok(updatedUser.lastSeenAt >= savedUser.lastSeenAt);
    assert.equal(updatedUser.displayName, 'New name');
    assert.equal(updatedUser.email, 'new@example.com');
    const sameEmailUser = await store.createUser({ ...other, email: updatedUser.email });
    assert.notEqual(sameEmailUser.id, savedUser.id);
    const foreignUser = await store.createUser({ ...owner, tenantId: foreignStaff.tenantId });
    assert.notEqual(foreignUser.id, savedUser.id);
    const withoutProfile = await store.createUser({ ...other, displayName: null, email: null });
    assert.equal(withoutProfile.id, sameEmailUser.id);
    assert.equal(withoutProfile.displayName, null);
    assert.equal(withoutProfile.email, null);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count, 3);
    assert.equal((await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'users'::regclass")).rows[0].relrowsecurity, true);
    // Separate connections exercise simultaneous first-login requests.
    const concurrentPool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`, max: 4,
    });
    try {
      const concurrentStore = createStore(concurrentPool);
      const newUser = { ...owner, id: randomUUID() };
      const saved = await Promise.all(Array.from({ length: 4 }, () => concurrentStore.createUser(newUser)));
      assert.equal(new Set(saved.map(user => user.id)).size, 1);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE microsoft_user_id = $1', [newUser.id])).rows[0].count, 1);
    } finally {
      await concurrentPool.end();
    }
    const input: CreateRequestInput = { title: "Email won't open; SELECT 1", description: 'Please help', priority: 'high' };
    const created = await store.create(owner, input);
    assert.equal(created.status, 'open');
    assert.equal(created.ownerId, owner.id);
    assert.equal(created.title, input.title);
    assert.equal((await createStore(pool).get(owner, created.id))?.id, created.id);
    assert.equal(await store.get(other, created.id), undefined);
    assert.equal(await store.get(foreignStaff, created.id), undefined);
    const page = { limit: 20, offset: 0 };
    assert.equal((await store.list(owner, page)).length, 1);
    assert.equal((await store.list(other, page)).length, 0);
    assert.equal((await store.list(staff, page)).length, 1);
    assert.equal((await store.list(foreignStaff, page)).length, 0);
    assert.equal(await store.updateStatus(owner, created.id, 'resolved'), undefined);
    assert.equal(await store.updateStatus(foreignStaff, created.id, 'resolved'), undefined);
    assert.equal((await store.updateStatus(staff, created.id, 'resolved'))?.status, 'resolved');
    assert.equal((await store.list(owner, { ...page, status: 'open' })).length, 0);
    assert.equal((await store.list(owner, { ...page, status: 'resolved' })).length, 1);
    assert.equal(savedUser.role, 'user');
    assert.equal((await store.getUserAccess(owner))?.role, 'user');
    assert.equal((await store.getUserAccess({ ...owner, tenantId: randomUUID() }))?.role, undefined);
    assert.deepEqual((await store.listRoles()).map(role => role.name), ['admin', 'support', 'user']);
    assert.equal((await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'roles'::regclass")).rows[0].relrowsecurity, true);
    // The operator bootstraps one admin; API assignments then use that database role.
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [savedUser.id]);
    const admin: AuthenticatedUser = { ...owner, role: 'admin', isAdmin: true, permissions: permissionsFor('admin') };
    const promoted = await store.updateUserRole(admin, sameEmailUser.id, 'support');
    assert.equal(promoted?.role, 'support');
    assert.equal((await store.createUser(other)).role, 'support');
    assert.equal((await store.getUserAccess(other))?.role, 'support');
    assert.equal((await store.listUsers(admin, page)).length, 3);
    assert.ok((await store.listUsers(admin, page)).every(user => user.tenantId === admin.tenantId));
    assert.equal(await store.updateUserRole(admin, foreignUser.id, 'admin'), undefined);
    assert.equal(await store.updateUserRole(admin, randomUUID(), 'support'), undefined);
    assert.equal((await store.getUserAccess({ ...owner, tenantId: foreignStaff.tenantId }))?.role, 'user');
    await assert.rejects(store.updateUserRole(staff, savedUser.id, 'admin'), { status: 403 });
    await assert.rejects(store.listUsers(staff, page), { status: 403 });
    await assert.rejects(store.updateUserRole(admin, savedUser.id, 'user'), { status: 409 });
    await assert.rejects(pool.query("UPDATE users SET role = 'owner' WHERE id = $1", [savedUser.id]), { code: '23503' });
    await assert.rejects(pool.query('UPDATE users SET role = NULL WHERE id = $1', [savedUser.id]), { code: '23502' });
    assert.deepEqual(savedUser.targetEntities, []);
    assert.equal(savedUser.isActive, true);
    assert.equal(savedUser.deletedAt, null);
    // Schema initialization and profile refresh must never reset assigned roles.
    await pool.query(ddl);
    assert.equal((await store.createUser(owner)).role, 'admin');
    assert.equal((await store.getUserAccess(other))?.role, 'support');
    await store.updateUserRole(admin, sameEmailUser.id, 'user');
    const demoted = { ...staff, ...(await store.getUserAccess(other))! };
    assert.equal(await store.updateStatus(demoted, created.id, 'closed'), undefined);
    assert.equal((await store.list(demoted, page)).length, 0);
    // A stale administrator role cannot authorize a role mutation after revocation.
    await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [savedUser.id]);
    await assert.rejects(store.updateUserRole(admin, sameEmailUser.id, 'admin'), { status: 403 });
    await store.health();
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});

test('roles upgrade backfills existing users without replacing profiles', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `ags_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    const ddl = await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8');
    // Reproduce the users table from the preceding release (without roles).
    const oldUsers = ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS users'), ddl.indexOf('-- Also upgrades'));
    await pool.query("CREATE TABLE roles (name TEXT PRIMARY KEY CHECK (name IN ('user', 'support', 'admin')), description TEXT NOT NULL)");
    await pool.query(oldUsers);
    const id = randomUUID();
    await pool.query('INSERT INTO users (id, tenant_id, microsoft_user_id, display_name) VALUES ($1, $2, $3, $4)',
      [id, randomUUID(), randomUUID(), 'Existing user']);
    await pool.query(ddl);
    await pool.query(ddl);
    assert.deepEqual((await pool.query('SELECT id, display_name, role, target_entities, is_active, deleted_at FROM users')).rows,
      [{ id, display_name: 'Existing user', role: 'user', target_entities: [], is_active: true, deleted_at: null }]);
    await pool.query("INSERT INTO roles (name, description) VALUES ('sales-reader', 'Custom role after upgrade')");
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});

test('user lifecycle, entity grants, and custom roles persist with administrator and tenant protection', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `ags_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const ddl = await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8');
    await pool.query(ddl);
    const store = createStore(pool);
    const admin: AuthenticatedUser = { id: randomUUID(), tenantId: randomUUID(), displayName: 'Admin', email: null,
      role: 'admin', isAdmin: true, permissions: permissionsFor('admin'), targetEntities: [], isActive: true };
    const reader = { ...admin, id: randomUUID() };
    const foreign = { ...reader, tenantId: randomUUID() };
    const savedAdmin = await store.createUser(admin);
    const savedReader = await store.createUser(reader);
    const savedForeign = await store.createUser(foreign);
    assert.equal(savedAdmin.role, 'user'); // Caller-supplied privileges never provision access.
    assert.deepEqual(savedReader.targetEntities, []);
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [savedAdmin.id]);

    const role = { name: 'sales-reader', description: 'Selected sales only', permissions: ['sales:read'] as const };
    assert.deepEqual(await store.createRole(admin, role), role);
    await assert.rejects(store.createRole(admin, role), { status: 409 });
    await assert.rejects(store.createRole(admin, { ...role, name: 'admin' }), { status: 409 });
    for (const name of ['user', 'support', 'admin']) await assert.rejects(store.deleteRole(admin, name), { status: 409 });
    assert.equal(await store.deleteRole(admin, 'missing'), false);
    await assert.rejects(store.updateUserRole(admin, savedReader.id, 'missing'), { status: 400 });
    assert.equal((await store.updateUserRole(admin, savedReader.id, role.name))?.role, role.name);
    await assert.rejects(store.deleteRole(admin, role.name), { status: 409 });
    assert.equal(await store.updateUser(admin, savedForeign.id, { targetEntities: ['green'] }), undefined);
    assert.equal(await store.deleteUser(admin, savedForeign.id), false);
    assert.equal(await store.updateUser(admin, randomUUID(), { isActive: true }), undefined);
    await assert.rejects(store.updateUser(admin, savedAdmin.id, { isActive: false }), { status: 409 });
    await assert.rejects(store.deleteUser(admin, savedAdmin.id), { status: 409 });
    await assert.rejects(store.updateUserRole(admin, savedAdmin.id, 'sales-reader'), { status: 409 });

    await store.updateUser(admin, savedReader.id, { targetEntities: ['green', 'babyhub'] });
    assert.deepEqual((await store.getUserAccess(reader))?.permissions, ['sales:read']);
    assert.deepEqual((await store.createUser(reader)).targetEntities, ['green', 'babyhub']);
    await pool.query(ddl);
    assert.deepEqual((await store.getUserAccess(reader))?.targetEntities, ['green', 'babyhub']);
    assert.deepEqual((await store.listRoles()).find(item => item.name === role.name), role);
    await store.updateUser(admin, savedReader.id, { targetEntities: [] });
    assert.deepEqual((await store.getUserAccess(reader))?.targetEntities, []);
    await assert.rejects(pool.query("UPDATE users SET target_entities = ARRAY['unknown'] WHERE id = $1", [savedReader.id]), { code: '23514' });
    await assert.rejects(pool.query('UPDATE users SET target_entities = ARRAY[NULL]::text[] WHERE id = $1', [savedReader.id]), { code: '23514' });
    await assert.rejects(pool.query('UPDATE users SET target_entities = NULL WHERE id = $1', [savedReader.id]), { code: '23502' });

    await store.updateUser(admin, savedReader.id, { isActive: false });
    assert.equal((await store.getUserAccess(reader))?.isActive, false);
    await assert.rejects(store.createUser(reader), { status: 403 });
    await store.updateUser(admin, savedReader.id, { isActive: true });
    assert.equal((await store.createUser(reader)).role, role.name);
    assert.equal(await store.deleteUser(admin, savedReader.id), true);
    const deleted = await store.getUserAccess(reader);
    assert.equal(deleted?.isActive, false);
    assert.ok(deleted?.deletedAt instanceof Date);
    assert.equal(deleted?.role, 'user');
    assert.deepEqual(deleted?.targetEntities, []);
    await assert.rejects(store.createUser(reader), { status: 403 });
    assert.equal(await store.deleteUser(admin, savedReader.id), false);
    assert.equal(await store.updateUser(admin, savedReader.id, { isActive: true }), undefined);
    assert.equal(await store.updateUserRole(admin, savedReader.id, 'admin'), undefined);
    assert.equal(await store.deleteRole(admin, role.name), true);
    await pool.query(ddl);
    await assert.rejects(store.createUser(reader), { status: 403 });

    // Mutation checks use current database state even if a caller holds stale access.
    await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [savedAdmin.id]);
    await assert.rejects(store.createRole(admin, role), { status: 403 });
    await assert.rejects(store.deleteRole(admin, role.name), { status: 403 });
    await assert.rejects(store.updateUser(admin, savedReader.id, { isActive: true }), { status: 403 });
    await assert.rejects(store.deleteUser(admin, savedReader.id), { status: 403 });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
