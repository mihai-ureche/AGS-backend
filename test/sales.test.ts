import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { createSalesClient, parseSalesQuery } from '../src/sales.js';

const base = { targetEntity: 'babyhub', from: '2026-09-01', to: '2026-09-30' };
const borg = { baseUrl: 'https://borg.example/api2/borg', authorization: 'Bearer private-borg-token' };

test('sales validates inclusive 30-day ranges, leap days, and cross-month intervals', () => {
  for (const [from, to] of [
    ['2026-09-01', '2026-09-30'], ['2026-09-23', '2026-09-23'],
    ['2026-02-01', '2026-02-28'], ['2024-02-01', '2024-02-29'],
    ['2024-02-29', '2024-03-29'], ['2026-03-15', '2026-04-13'],
  ]) {
    const query = parseSalesQuery({ ...base, from, to });
    assert.equal(query.from, from);
    assert.equal(query.to, to);
    assert.equal(query.limit, 5000);
    assert.equal(query.includeTransfers, false);
  }
  for (const [from, to] of [
    ['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-10-01'],
    ['2026-12-31', '2027-01-01'], ['2026-09-30', '2026-09-01'],
    ['2026-02-29', '2026-03-01'], ['2026-04-31', '2026-05-01'],
    ['2026-9-01', '2026-09-30'], ['2026-09-01T00:00:00Z', '2026-09-30'],
    ['2026-00-01', '2026-01-01'], ['0000-01-01', '0000-01-01'],
  ]) assert.throws(() => parseSalesQuery({ ...base, from, to }), { status: 400 });
});

test('sales rejects missing, repeated, unknown, and invalid filters', () => {
  for (const patch of [
    { targetEntity: undefined }, { targetEntity: 'unknown' }, { targetEntity: ['babyhub', 'green'] },
    { from: undefined }, { to: undefined }, { from: ['2026-09-01'] }, { to: {} },
    { docType: 'FC' }, { docType: ['BFD', 'AIM'] }, { docType: '' },
    { gestiune: '0' }, { gestiune: '-1' }, { gestiune: '1.5' }, { gestiune: '1e2' }, { gestiune: '9007199254740992' },
    { limit: '0' }, { limit: '50001' }, { limit: ['5', '10'] }, { limit: '1.5' },
    { includeTransfers: '1' }, { includeTransfers: true }, { includeTransfers: ['true', 'false'] },
    { url: 'https://other.example' }, { authorization: 'attacker-token' },
  ]) assert.throws(() => parseSalesQuery({ ...base, ...patch }), { status: 400 });
});

test('sales forwards every validated filter and only the server credential', async () => {
  const lines = [{ documentId: 2157, miscareId: 6936, cantitate: -1, valoareNet: -1100.83, marja: -308.27, facturaSerie: null }];
  for (const targetEntity of ['babyhub', 'agritehnica', 'green']) {
    const sales = createSalesClient(borg, async (address, init) => {
      const url = new URL(address);
      assert.equal(url.origin, 'https://borg.example');
      assert.equal(url.pathname, '/api2/borg/sales');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        targetEntity, from: base.from, to: base.to, gestiune: '2', docType: 'AIM', limit: '50000', includeTransfers: 'true',
      });
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(new Headers(init.headers).get('Authorization'), borg.authorization);
      return Response.json(lines);
    });
    assert.deepEqual(await sales(parseSalesQuery({ ...base, targetEntity, gestiune: '2', docType: 'AIM', limit: '50000', includeTransfers: 'true' })), lines);
  }
});

test('sales supports raw authorization values, defaults, and empty results', async () => {
  const sales = createSalesClient({ ...borg, authorization: 'raw-borg-token' }, async (address, init) => {
    const url = new URL(address);
    assert.equal(url.searchParams.get('limit'), '5000');
    assert.equal(url.searchParams.get('includeTransfers'), 'false');
    assert.equal(url.searchParams.has('gestiune'), false);
    assert.equal(url.searchParams.has('docType'), false);
    assert.equal(new Headers(init.headers).get('Authorization'), 'raw-borg-token');
    return Response.json([]);
  });
  assert.deepEqual(await sales(parseSalesQuery(base)), []);
});

test('sales sanitizes upstream errors, redirects, invalid JSON, and timeouts', async () => {
  const query = parseSalesQuery(base);
  for (const [upstream, expected] of [[400, 400], [401, 502], [403, 502], [429, 503], [500, 502], [503, 503], [302, 502]]) {
    const sales = createSalesClient(borg, async () => new Response('private upstream details and credentials', { status: upstream }));
    await assert.rejects(sales(query), (error: unknown) => {
      assert.ok(error instanceof Error && 'status' in error);
      assert.equal(error.status, expected);
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
  for (const response of [Response.json({ lines: [] }), Response.json([null]), Response.json([1]), new Response('<html>private</html>')]) {
    await assert.rejects(createSalesClient(borg, async () => response)(query), { status: 502 });
  }
  await assert.rejects(createSalesClient(borg, async () => Response.json([{}, {}]))({ ...query, limit: 1 }), { status: 502 });
  await assert.rejects(createSalesClient(borg, async () => { throw new TypeError('private DNS error'); })(query), { status: 502 });
  await assert.rejects(createSalesClient(borg, async () => { throw new DOMException('private timeout', 'TimeoutError'); })(query), { status: 504 });
  await assert.rejects(createSalesClient(undefined, async () => { assert.fail('Unconfigured API called Borg'); })(query), { status: 503 });
});

test('Borg is enabled by its credential, defaults to the Agritehnica base URL, and validates overrides', () => {
  const env = { MICROSOFT_TENANT_ID: '11111111-1111-1111-1111-111111111111', DATABASE_URL: 'postgresql://localhost/ags', FRONTEND_ORIGINS: 'http://localhost:5173' };
  assert.equal(readConfig(env).borg, undefined);
  assert.deepEqual(readConfig({ ...env, BORG_API_AUTHORIZATION: borg.authorization }).borg,
    { baseUrl: 'https://borg.agritehnica.ro/api2/borg', authorization: borg.authorization });
  for (const BORG_API_URL of ['https://borg.example/api2/borg', 'https://borg.example/api2/borg/', ' https://borg.example/api2/borg// ']) {
    assert.deepEqual(readConfig({ ...env, BORG_API_URL, BORG_API_AUTHORIZATION: borg.authorization }).borg, borg);
  }
  for (const patch of [
    { BORG_API_URL: borg.baseUrl },
    ...['not-a-url', 'ftp://borg.example/api2/borg', 'https://user:password@borg.example/api2/borg', 'https://borg.example/api2/borg?token=secret', 'https://borg.example/api2/borg#fragment'].map(BORG_API_URL => ({ BORG_API_URL, BORG_API_AUTHORIZATION: borg.authorization })),
    { BORG_API_AUTHORIZATION: 'token\r\nX-Injected: value' },
  ]) assert.throws(() => readConfig({ ...env, ...patch }));
});
