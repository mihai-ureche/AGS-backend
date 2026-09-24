import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStockClient, parseStockQuery } from '../src/stock.js';

const base = { targetEntity: 'babyhub', code: '4063846331017' };
const borg = { baseUrl: 'https://borg.example/api2/borg', authorization: 'Bearer private-borg-token' };

test('stock accepts a product code and entity and rejects anything else', () => {
  assert.deepEqual(parseStockQuery(base), base);
  assert.deepEqual(parseStockQuery({ targetEntity: 'green', code: 'AB-12.x_3' }), { targetEntity: 'green', code: 'AB-12.x_3' });
  for (const patch of [
    { targetEntity: undefined }, { targetEntity: 'unknown' }, { targetEntity: ['babyhub', 'green'] },
    { code: undefined }, { code: '' }, { code: 'a'.repeat(65) }, { code: ['1', '2'] }, { code: '12 34' }, { code: '1&x=2' },
    { url: 'https://other.example' }, { authorization: 'attacker-token' },
  ]) assert.throws(() => parseStockQuery({ ...base, ...patch }), { status: 400 });
});

test('stock appends /stock to the base URL and forwards only the server credential', async () => {
  for (const body of [[{ gestiune: 2, cantitate: 5 }], { code: base.code, cantitate: 0 }, []]) {
    const stock = createStockClient(borg, async (address, init) => {
      const url = new URL(address);
      assert.equal(url.origin, 'https://borg.example');
      assert.equal(url.pathname, '/api2/borg/stock');
      assert.deepEqual(Object.fromEntries(url.searchParams), base);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(new Headers(init.headers).get('Authorization'), borg.authorization);
      return Response.json(body);
    });
    assert.deepEqual(await stock(parseStockQuery(base)), body);
  }
});

test('stock sanitizes upstream errors and malformed responses', async () => {
  const query = parseStockQuery(base);
  for (const [upstream, expected] of [[400, 400], [401, 502], [404, 502], [429, 503], [500, 502]]) {
    const stock = createStockClient(borg, async () => new Response('private upstream details', { status: upstream }));
    await assert.rejects(stock(query), (error: unknown) => {
      assert.ok(error instanceof Error && 'status' in error);
      assert.equal(error.status, expected);
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
  for (const response of [Response.json(null), Response.json([1]), Response.json('text'), new Response('<html>private</html>')]) {
    await assert.rejects(createStockClient(borg, async () => response)(query), { status: 502 });
  }
  await assert.rejects(createStockClient(borg, async () => { throw new DOMException('private timeout', 'TimeoutError'); })(query), { status: 504 });
  await assert.rejects(createStockClient(undefined, async () => { assert.fail('Unconfigured API called Borg'); })(query), { status: 503 });
});
