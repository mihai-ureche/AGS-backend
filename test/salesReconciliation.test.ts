import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReconciliation, parseCsv } from '../src/importSalesReconciliation.js';
import { classifySales, revenueGroupIds } from '../src/revenue.js';
import type { RevenueConfiguration } from '../src/revenue.js';
import { readSalesReconciliations, reconcileSales, reconciliationVersion } from '../src/salesReconciliation.js';
import type { SalesQuery } from '../src/sales.js';
import { report, salesCsv, discountCsv } from './reconciliationFixtures.js';

const config: RevenueConfiguration = { targetEntity: 'agritehnica', enabled: true, revision: 1,
  defaultGroupId: 'piese', rules: [{ category: 'Utilaje', groupId: 'utilaje' }],
  groups: revenueGroupIds.map(id => ({ id, name: id })) };
const query: SalesQuery = { targetEntity: 'agritehnica', from: '2026-09-01', to: '2026-09-30', limit: 50000, includeTransfers: false };
const total = (lines: Record<string, unknown>[]) => lines.reduce((sum, line) => sum + Math.round(Number(line.valoareNet) * 100), 0) / 100;

test('September markers retain credit notes and explicit rounding adjustments', () => {
  const result = report();
  assert.equal(result.csvSalesBeforeDiscounts, 5387882.17);
  assert.equal(result.csvDiscounts, 227735.06);
  assert.equal(total(result.lines), 5160147.07);
  assert.deepEqual(result.lines.filter(line => line.businessReconciliationAdjustment).map(line => line.valoareNet), [-0.1, 0.06]);
  assert.equal(result.lines.filter(line => line.tipDocument === 'AIMS').length, 2);
  assert.throws(() => buildReconciliation(salesCsv, discountCsv, { month: '2026-09', salesMarker: 7530375, discountMarker: 227735 }), /more than one leu/);
  assert.throws(() => buildReconciliation(salesCsv, discountCsv, { month: '2026-10', salesMarker: 5387882.07, discountMarker: 227735 }), /No sales/);
});

test('CSV handles quoted money, Unicode, multiline names and escaped quotes', () => {
  assert.deepEqual(parseCsv('\uFEFFA,B\r\n"șurub, \"\"mare\"\"", "x"\r\n'.replace(', "x"', ',"x"')), [{ A: 'șurub, "mare"', B: 'x' }]);
  assert.deepEqual(parseCsv('A,B\n"multi\nline",2\n'), [{ A: 'multi\nline', B: '2' }]);
  assert.throws(() => parseCsv('A,B\n"unterminated,2'), /Unterminated/);
  assert.throws(() => parseCsv('A,A\n1,2\n'), /duplicate/);
});

test('reconciliation replaces only the configured month and group, preserving live dimensions', () => {
  const raw = classifySales([
    { miscareId: 1, documentId: 10, serie: 'BR', numar: 1, tipDocument: 'AIM', data: '2026-09-01', produs: 'Filtru', grupa: 'Filtre', cantitate: 1, valoareNet: 7530375, gestiuneId: 4, clientId: 7 },
    { miscareId: 2, data: '2026-09-01', grupa: 'Utilaje', valoareNet: 100 },
    { miscareId: 3, data: '2026-08-31', grupa: 'Filtre', valoareNet: 200 },
  ], config);
  const result = reconcileSales(raw, query, config, [report()]);
  assert.equal(total(result.lines.filter(line => line.revenueGroupId === 'piese' && String(line.data).startsWith('2026-09'))), 5160147.07);
  assert.equal(result.lines.find(line => line.salesSource === 'business-report' && !line.businessReconciliationAdjustment)?.gestiuneId, 4);
  assert.ok(result.lines.some(line => line.miscareId === 2));
  assert.ok(result.lines.some(line => line.miscareId === 3));
  assert.equal(result.reports.length, 1);
  assert.equal(reconcileSales(raw, { ...query, from: '2026-08-01', to: '2026-08-30' }, config, [report()]).reports.length, 0);
  assert.equal(reconcileSales(raw, { ...query, targetEntity: 'green' }, config, [report()]).reports.length, 0);
  assert.deepEqual(reconcileSales(raw, { ...query, gestiune: 4 }, config, [report()]).lines, raw);
  assert.deepEqual(reconcileSales(raw, { ...query, includeTransfers: true }, config, [report()]).lines, raw);
  const partial = reconcileSales([], { ...query, to: '2026-09-01' }, config, [report()]);
  assert.equal(total(partial.lines), 5687585.16);
  assert.equal(partial.lines.length, 2);
});

test('private report loading rejects tampered totals and overlapping periods', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ags-reconciliation-test-'));
  const path = join(dir, 'report.local');
  try {
    await writeFile(path, JSON.stringify([report()]));
    assert.equal((await readSalesReconciliations(path))[0]?.salesBeforeDiscounts, 5387882.07);
    await writeFile(path, JSON.stringify([{ ...report(), salesBeforeDiscounts: 1 }]));
    await assert.rejects(readSalesReconciliations(path), /do not match/);
    await writeFile(path, JSON.stringify([report(), report()]));
    await assert.rejects(readSalesReconciliations(path), /Overlapping/);
    assert.notEqual(reconciliationVersion([report()], config), reconciliationVersion([{ ...report(), revision: 'changed' }], config));
    assert.equal(reconciliationVersion([report()], { ...config, enabled: false }), undefined);
  } finally { await rm(dir, { recursive: true }); }
});
