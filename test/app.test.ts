import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { AppConfig, AuthenticatedUser, CreateRequestInput, GraphFetch, RequestPage, Store, SupportRequest } from '../src/types.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';
const requestId = '33333333-3333-3333-3333-333333333333';
const config: AppConfig = { tenantId, adminUserIds: [], origins: ['https://frontend.example'], trustProxyHops: 0, port: 3000, databaseUrl: 'postgresql://localhost/ags_test' };

interface SetupOptions {
  config?: Partial<AppConfig>;
  store?: Partial<Store>;
  fetchGraph?: GraphFetch;
  tenantId?: string;
  rateLimitMax?: number;
}

const storedRequest: SupportRequest = {
  id: requestId, title: 'Help', description: 'Please help', priority: 'normal', status: 'open',
  ownerId: userId, ownerName: 'Test User', ownerEmail: 'user@example.com',
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function setup(options: SetupOptions = {}) {
  const calls: { user: AuthenticatedUser; input?: CreateRequestInput; page?: RequestPage }[] = [];
  const store: Store = {
    health: async () => {},
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
  const app = createApp({ config: { ...config, ...options.config }, store, fetchGraph, rateLimitMax: options.rateLimitMax ?? 120 });
  return { client: request(app), calls, graphCalls };
}
const bearer = ['Authorization', 'Bearer opaque-graph-token'] as const;

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
  assert.deepEqual(body.user, { id: userId, tenantId, displayName: 'Test User', email: 'user@example.com', isAdmin: false });
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

test('only configured staff can update status', async () => {
  await setup().client.patch(`/api/requests/${requestId}`).set(...bearer).send({ status: 'resolved' }).expect(403);
  const { client } = setup({ config: { adminUserIds: [userId] } });
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
  assert.throws(() => readConfig({ ...env, SUPPORT_ADMIN_USER_IDS: 'email@example.com' }));
});
