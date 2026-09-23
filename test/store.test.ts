import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createStore } from '../src/store.js';
import type { CreateRequestInput } from '../src/types.js';

test('PostgreSQL persistence and user/staff/tenant isolation', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const schema = `ags_test_${randomUUID().replaceAll('-', '')}`;
  try {
    // Schema name is generated locally, never supplied by a request.
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    const ddl = await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8');
    await pool.query(ddl);
    await pool.query(ddl);
    const store = createStore(pool);
    const owner = { id: randomUUID(), tenantId: randomUUID(), displayName: 'Owner', email: 'owner@example.com', isAdmin: false };
    const other = { ...owner, id: randomUUID() };
    const staff = { ...other, isAdmin: true };
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
    await store.health();
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
