import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import request from 'supertest';
import { readFile } from 'node:fs/promises';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createStore } from '../../src/store.js';
import { isRecord } from '../../src/validation.js';

interface ReportBaseline {
  period: string;
  from: string;
  to: string;
  warehouses: number[];
  expected: { salesBeforeDiscounts: number; discounts: number };
  byDocType: Record<string, { sales: number; discountsSigned: number }>;
  documents: [string, string, string][];
}

// Frozen references and exact totals from the supplied CSVs, independent of
// live BORG. Document references identify the export snapshot without guessing
// its creation-time cutoff or imposing a production client-exclusion rule.
const baseline: ReportBaseline = JSON.parse(await readFile(new URL('../fixtures/september2026.json', import.meta.url), 'utf8'));
const expected = baseline.expected;

function cents(value: unknown): bigint {
  assert.ok(typeof value === 'number' || typeof value === 'string', 'A sales row has no numeric valoareNet.');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  assert.ok(match, 'valoareNet must be a signed amount in lei with at most two decimal places.');
  const amount = BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -amount : amount;
}

test('live September 2026 Piese report snapshot matches the fixed CSV totals', { timeout: 60_000 }, async t => {
  const config = readConfig();
  assert.ok(config.borg, 'Configure BORG_API_AUTHORIZATION before running this live test.');
  const pool = new pg.Pool({
    connectionString: config.databaseUrl, max: 1,
    connectionTimeoutMillis: 5000, query_timeout: 6000,
  });
  try {
    const app = createApp({
      config,
      // Read the real saved revenue rules; supply a test identity for this local
      // app so no Microsoft login or user/database mutation is needed.
      store: {
        ...createStore(pool),
        getUserAccess: async () => ({
          role: 'september-test', permissions: ['sales:read'], targetEntities: ['agritehnica'],
          salesGroups: null, isActive: true, deletedAt: null,
        }),
      },
      fetchGraph: async url => Response.json(url.includes('/me?')
        ? { id: '11111111-1111-1111-1111-111111111111', displayName: 'September test' }
        : { value: [{ id: config.tenantId }] }),
      // Use the real BORG client/fetch: a fixture cannot detect source drift.
    });
    const response = await request(app).get('/api/borg/sales').query({
      targetEntity: 'agritehnica', from: baseline.from, to: baseline.to,
      limit: 50_000, includeTransfers: 'false', responseFormat: 'grouped',
    }).set('Authorization', 'Bearer september-test-identity')
      .timeout({ response: 45_000, deadline: 50_000 }).expect(200);

    const body: unknown = response.body;
    assert.ok(isRecord(body), 'Expected the grouped sales response.');
    assert.equal(body.possiblyTruncated, false, 'Cannot verify monthly totals from a possibly truncated response.');
    assert.ok(Array.isArray(body.lines) && body.lines.every(isRecord), 'Expected sales data rows.');
    assert.ok(body.lines.length > 0, 'September sales unexpectedly returned no rows.');

    // The report uses parts warehouses rather than the configurable category
    // groups. Sum all returned group shares of each included discount once.
    const documents = new Set(baseline.documents.map(document => JSON.stringify(document)));
    const documentKey = (line: Record<string, unknown>) => JSON.stringify([
      String(line.tipDocument).trim(), String(line.serie ?? '').trim(), String(line.numar).trim(),
    ]);
    const rows = body.lines.filter(line => documents.has(documentKey(line)) && baseline.warehouses.includes(Number(line.gestiuneId)));
    const found = new Set(rows.map(documentKey));
    const missingDocuments = [...documents].filter(document => !found.has(document));
    const missingByDocType = Object.fromEntries(Object.keys(baseline.byDocType).map(type => [
      type, missingDocuments.filter(document => (JSON.parse(document) as string[])[0] === type).length,
    ]));
    t.diagnostic(`Report snapshot: ${rows.length} rows; ${found.size}/${documents.size} documents present.`);
    assert.ok(rows.every(line => ['produs', 'discount', 'special'].includes(String(line.tipLinie))),
      'BORG 2.1 line types are missing or unavailable. Deploy the updated endpoint and verify the product-types export before comparing report totals.');

    let sales = 0n;
    let discounts = 0n;
    let unclassified = 0n;
    let special = 0n;
    const byDocType = new Map(Object.keys(baseline.byDocType).map(type => [type, { sales: 0n, discountsSigned: 0n }]));
    for (const line of rows) {
      assert.ok(typeof line.data === 'string' && line.data.slice(0, 7) === baseline.period, 'The September response includes an invalid or out-of-period date.');
      const amount = cents(line.valoareNet);
      const doc = byDocType.get(String(line.tipDocument));
      assert.ok(doc, 'The report snapshot includes an unexpected document type.');
      if (line.discountInclusInLinii === true) assert.equal(amount, 0n, 'BORG counted an embedded group discount twice.');
      switch (line.businessValueKind) {
        case 'sale': sales += amount; doc.sales += amount; break; // Product returns stay signed.
        case 'discount': discounts -= amount; doc.discountsSigned += amount; break; // Reversals reduce discounts.
        case 'special': special += amount; break;
        case 'unclassified': unclassified += amount; break;
        default: assert.fail('A sales row has an unsupported businessValueKind.');
      }
    }
    const actual = { salesBeforeDiscounts: Number(sales) / 100, discounts: Number(discounts) / 100 };
    t.diagnostic(JSON.stringify({
      period: baseline.period, scope: 'Piese CSV document snapshot', rows: rows.length, expected, actual,
      difference: {
        salesBeforeDiscounts: Number(sales - cents(expected.salesBeforeDiscounts)) / 100,
        discounts: Number(discounts - cents(expected.discounts)) / 100,
      },
      specialNet: Number(special) / 100, unclassifiedNet: Number(unclassified) / 100,
      missingByDocType,
    }, null, 2));
    assert.equal(missingDocuments.length, 0, 'BORG is missing documents from the report snapshot (including AIMS returns).');
    assert.deepEqual(actual, expected, 'September 2026 Piese amounts differ from the fixed report totals.');
    assert.deepEqual(Object.fromEntries([...byDocType].map(([type, amounts]) => [type, {
      sales: Number(amounts.sales) / 100, discountsSigned: Number(amounts.discountsSigned) / 100,
    }])), baseline.byDocType, 'AIM sales, AIMS returns, or discount reversals drifted from the report.');
  } finally {
    await pool.end();
  }
});
