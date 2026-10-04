import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySales, revenueGroupIds } from '../src/revenue.js';
import type { RevenueConfiguration } from '../src/revenue.js';
import { prepareSales, salesValueKind } from '../src/salesReporting.js';

const config: RevenueConfiguration = {
  targetEntity: 'agritehnica', enabled: true, revision: 1, defaultGroupId: 'piese', rules: [],
  groups: revenueGroupIds.map(id => ({ id, name: id })),
};

test('discount codes identify commercial discounts, independently of category and sign', () => {
  for (const code of ['~111', ' pt clienti 709 ', 'DCH']) {
    assert.equal(salesValueKind({ codProdus: code, grupa: 'Marfuri', valoareNet: 100 }, 'agritehnica'), 'discount');
  }
  for (const codProdus of ['PMC', 'AVANS CLIENT', '~541657', null]) {
    assert.equal(salesValueKind({ codProdus, grupa: ' DISCOUNT ', valoareNet: -100 }, 'agritehnica'), 'unclassified');
  }
  assert.equal(salesValueKind({ grupa: 'Horsch', valoareNet: -100 }, 'agritehnica'), 'sale');
  assert.equal(salesValueKind({ codProdus: '~111', grupa: 'Discount' }, 'babyhub'), 'sale');
});

test('BORG line types override legacy code and category guesses for every entity', () => {
  for (const entity of ['agritehnica', 'green', 'babyhub'] as const) {
    assert.equal(salesValueKind({ tipLinie: 'produs', codProdus: '~111', grupa: 'Discount' }, entity), 'sale');
    assert.equal(salesValueKind({ tipLinie: 'discount', codProdus: 'NEW-DISCOUNT', grupa: 'Horsch' }, entity), 'discount');
    assert.equal(salesValueKind({ tipLinie: 'special', grupa: 'Horsch' }, entity), 'special');
    assert.equal(salesValueKind({ tipLinie: null, codProdus: '~111' }, entity), 'unclassified');
    assert.equal(salesValueKind({ tipLinie: 'unknown' }, entity), 'unclassified');
  }
});

test('authoritative corrected amounts and embedded zero discount rows pass through unchanged', () => {
  const raw = [
    { tipLinie: 'produs', cantitate: 1, pretUnitar: 100, pretUnitarNet: 90, discountProcent: 0.1, discountEvidentiat: true, valoareNet: 90 },
    { tipLinie: 'produs', cantitate: -1, pretUnitarNet: 90, discountProcent: 0.1, discountEvidentiat: false, valoareNet: -90 },
    { tipLinie: 'discount', discountInclusInLinii: true, valoareSalvata: -10, valoareNet: 0 },
  ];
  const result = prepareSales(classifySales(raw, config), 'agritehnica');
  assert.deepEqual(result.map(line => line.valoareNet), [90, -90, 0]);
  assert.deepEqual(result.map(line => line.businessValueKind), ['sale', 'sale', 'discount']);
  assert.equal(result[2]?.valoareSalvata, -10);
});

test('sales grouping preserves original amounts for sales, returns, and discount reversals', () => {
  const raw = [
    { tipDocument: 'AIM', valoareNet: 5916626.47 },
    { tipDocument: 'AIMS', valoareNet: -528744.30 },
    { codProdus: '~111', valoareNet: -229041.31 },
    { codProdus: '~111', tipDocument: 'AIMS', valoareNet: 1306.25 },
    { codProdus: 'AVANS CLIENT', grupa: 'Discount', valoareNet: -100 },
  ];
  const prepared = prepareSales(classifySales(raw, config), 'agritehnica');
  assert.deepEqual(prepared.map(line => line.valoareNet), raw.map(line => line.valoareNet));
  assert.deepEqual(prepared.map(line => line.businessValueKind), ['sale', 'sale', 'discount', 'discount', 'unclassified']);
});
