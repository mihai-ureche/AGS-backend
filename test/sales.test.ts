import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { createSalesClient, parseSalesQuery } from '../src/sales.js';

const base = { targetEntity: 'babyhub', from: '2026-09-01', to: '2026-09-30' };
const borg = { baseUrl: 'https://borg.example/api2/borg', authorization: 'Bearer private-borg-token' };

// Shaped like a live Borg ledger entry; every value is invented.
const entry = {
  id: 1, dataInregistrare: '2026-09-01T00:00:00.000Z', tipDocument: 'FF', numarDocument: '10',
  gestiuneId: 1, contDebit: '371.G.06', contCredit: '401.G', suma: 120.5, sumaValuta: 120.5, curs: 1,
  tertCredit: 'EXAMPLE SRL', agentDebit: null, centruCostId: null,
};
const envelope = {
  meta: { targetEntity: 'agritehnica', from: base.from, to: base.to, account: null, docType: null, limit: 5000, entries: 1, truncated: false },
  entries: [entry],
};

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
  }
  for (const [from, to] of [
    ['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-10-01'],
    ['2026-12-31', '2027-01-01'], ['2026-09-30', '2026-09-01'],
    ['2026-02-29', '2026-03-01'], ['2026-04-31', '2026-05-01'],
    ['2026-9-01', '2026-09-30'], ['2026-09-01T00:00:00Z', '2026-09-30'],
    ['2026-00-01', '2026-01-01'], ['0000-01-01', '0000-01-01'],
  ]) assert.throws(() => parseSalesQuery({ ...base, from, to }), { status: 400 });
});

test('sales accepts any Borg document type and account code', () => {
  for (const docType of ['FF', 'ff', 'EC', 'FFA', 'AIMR', 'DP', 'BCD', 'FFBF', 'OPM', 'AIMT', 'BFD', 'AIM', 'AIMS']) {
    assert.equal(parseSalesQuery({ ...base, docType }).docType, docType);
  }
  for (const account of ['401', '401.G', '371.G.06', '5121.000', '4111.G', '707']) {
    assert.equal(parseSalesQuery({ ...base, account }).account, account);
  }
  const query = parseSalesQuery(base);
  assert.equal(query.docType, undefined);
  assert.equal(query.account, undefined);
});

test('sales rejects missing, repeated, unknown, removed, and invalid filters', () => {
  for (const patch of [
    { targetEntity: undefined }, { targetEntity: 'unknown' }, { targetEntity: ['babyhub', 'green'] },
    { from: undefined }, { to: undefined }, { from: ['2026-09-01'] }, { to: {} },
    { docType: '' }, { docType: ['FF', 'EC'] }, { docType: 'F F' }, { docType: 'FF;' }, { docType: 'ABCDEFGHIJK' },
    { account: '' }, { account: ['401', '371'] }, { account: '401 G' }, { account: '401!' }, { account: 'x'.repeat(33) },
    { limit: '0' }, { limit: '50001' }, { limit: ['5', '10'] }, { limit: '1.5' },
    // Borg no longer filters by these, so accepting them would silently return unfiltered data.
    { gestiune: '2' }, { includeTransfers: 'false' }, { revenueGroupId: 'piese' }, { responseFormat: 'grouped' },
    { url: 'https://other.example' }, { authorization: 'attacker-token' },
  ]) assert.throws(() => parseSalesQuery({ ...base, ...patch }), { status: 400 });
});

test('sales forwards every validated filter and only the server credential', async () => {
  for (const targetEntity of ['babyhub', 'agritehnica', 'green']) {
    const sales = createSalesClient(borg, async (address, init) => {
      const url = new URL(address);
      assert.equal(url.origin, 'https://borg.example');
      assert.equal(url.pathname, '/api2/borg/sales');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        targetEntity, from: base.from, to: base.to, docType: 'FF', account: '401.G', limit: '50000', envelope: 'true',
      });
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(new Headers(init.headers).get('Authorization'), borg.authorization);
      return Response.json(envelope);
    });
    assert.deepEqual(await sales(parseSalesQuery({ ...base, targetEntity, docType: 'FF', account: '401.G', limit: '50000' })), envelope);
  }
});

test('sales returns Borg JSON unchanged whatever its shape', async () => {
  for (const body of [
    envelope,
    { ...envelope, meta: { ...envelope.meta, truncated: true, warnings: ['kept'] }, extra: { nested: [1, 2] } },
    { meta: { truncated: false }, entries: [] },
    [entry], [],
    // Borg changed its format once already, so unknown shapes must not be rejected.
    { lines: [entry], meta: {} }, { something: 'new' }, {},
  ]) {
    const sales = createSalesClient(borg, async () => Response.json(body));
    assert.deepEqual(await sales(parseSalesQuery(base)), body);
  }
});

test('sales supports raw authorization values, defaults, and empty results', async () => {
  const empty = { meta: { ...envelope.meta, entries: 0 }, entries: [] };
  const sales = createSalesClient({ ...borg, authorization: 'raw-borg-token' }, async (address, init) => {
    const url = new URL(address);
    assert.equal(url.searchParams.get('limit'), '5000');
    assert.equal(url.searchParams.get('envelope'), 'true');
    assert.equal(url.searchParams.has('docType'), false);
    assert.equal(url.searchParams.has('account'), false);
    assert.equal(new Headers(init.headers).get('Authorization'), 'raw-borg-token');
    return Response.json(empty);
  });
  assert.deepEqual(await sales(parseSalesQuery(base)), empty);
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
  for (const response of [Response.json(null), Response.json(1), Response.json('private'), new Response('<html>private</html>')]) {
    await assert.rejects(createSalesClient(borg, async () => response)(query), { status: 502 });
  }
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
