import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryKey, classifySales, parseRevenueUpdate, parseSalesGroups, revenueGroupIds, salesAccessVersion } from '../src/revenue.js';
import type { RevenueConfiguration } from '../src/revenue.js';
import type { AuthenticatedUser } from '../src/types.js';

const config: RevenueConfiguration = {
  targetEntity: 'agritehnica', enabled: true, revision: 1, defaultGroupId: 'piese',
  groups: revenueGroupIds.map(id => ({ id, name: id })),
  rules: [{ category: 'Utilaje', groupId: 'utilaje' }, { category: 'Irigații', groupId: 'irigatii' },
    { category: 'Alte materiale consumabile', groupId: 'other' }, { category: 'Cheltuieli Diverse', groupId: 'other' },
    { category: 'Manipulare', groupId: 'manopera' }],
};

test('categories, including labor and returns, receive exactly the configured revenue group', () => {
  const categories = ['Utilaje', ' IRIGATII ', 'Irigaţii', 'Alte  materiale consumabile', 'cheltuieli diverse', 'Manipulare', 'Filtre', null, 'Utilaje speciale'];
  const raw = categories.map((grupa, index) => ({ grupa, miscareId: index, depozit: 'Utilaje', valoareNet: -100, revenueGroupId: 'spoofed' }));
  const result = classifySales(raw, config);
  assert.deepEqual(result.map(line => line.revenueGroupId), ['utilaje', 'irigatii', 'irigatii', 'other', 'other', 'manopera', 'piese', 'piese', 'piese']);
  assert.equal(result.reduce((sum, line) => sum + Number(line.valoareNet), 0), -900);
  assert.ok(raw.every(line => line.revenueGroupId === 'spoofed'));
  assert.equal(classifySales(raw, { ...config, enabled: false })[0]?.revenueGroupId, null);
  assert.equal(categoryKey(' IRIGAȚII '), categoryKey('irigatii'));
});

test('configuration rejects conflicting names, unsupported groups and malformed input', () => {
  const input = { enabled: true, revision: 1, defaultGroupId: 'piese', rules: config.rules };
  assert.deepEqual(parseRevenueUpdate(input), input);
  for (const patch of [
    { revision: 0 }, { revision: 1.1 }, { enabled: undefined }, { enabled: 'true' }, { defaultGroupId: 'unknown' },
    { rules: null }, { rules: [{ category: '', groupId: 'other' }] }, { rules: [{ category: 'x', groupId: 'unknown' }] },
    { rules: [{ category: 'Irigații', groupId: 'irigatii' }, { category: ' IRIGATII ', groupId: 'piese' }] },
    { rules: [{ category: 'x', groupId: 'piese', extra: true }] }, { extra: true },
  ]) assert.throws(() => parseRevenueUpdate({ ...input, ...patch }), { status: 400 });
  assert.deepEqual(parseSalesGroups(undefined), []);
  assert.deepEqual(parseSalesGroups(['utilaje']), ['utilaje']);
  assert.equal(parseSalesGroups(null), null);
  for (const groups of ['utilaje', ['unknown'], ['utilaje', 'utilaje'], [null]]) assert.throws(() => parseSalesGroups(groups), { status: 400 });
});

test('BORG discount allocations receive their affected revenue groups and preserve signed money', () => {
  for (const sign of [-1, 1]) {
    const raw = [{
      miscareId: 77, tipLinie: 'discount', grupa: 'Discount', cantitate: -sign,
      valoareNet: sign * 100, valoareSalvata: sign * 100, valoareTVA: sign * 21,
      valoareTotal: sign * 121, costTotal: 0, costUnitar: 0, marja: sign * 100,
      alocareDiscount: { sursa: 'document', grupe: [
        { grupa: 'UTILAJE', valoareNet: sign * 80 },
        { grupa: 'Horsch', valoareNet: sign * 15 },
        { grupa: 'Filtre', valoareNet: sign * 5 },
      ] },
    }];
    const result = classifySales(raw, config);
    assert.deepEqual(result.map(line => line.revenueGroupId), ['utilaje', 'piese']);
    assert.deepEqual(result.map(line => line.valoareNet), [sign * 80, sign * 20]);
    assert.deepEqual(result.map(line => line.valoareTVA), [sign * 16.8, sign * 4.2]);
    assert.deepEqual(result.map(line => line.valoareTotal), [sign * 96.8, sign * 24.2]);
    assert.deepEqual(result.map(line => line.miscareId), ['77:discount:utilaje', '77:discount:piese']);
    assert.ok(result.every(line => line.sourceMiscareId === 77 && line.discountAllocation === true));
    assert.equal(raw[0]?.valoareNet, sign * 100);
    assert.equal(classifySales(raw, { ...config, enabled: false })[0]?.valoareNet, sign * 100);
  }
  const oneGroup = classifySales([{ tipLinie: 'discount', grupa: 'Discount', valoareNet: -10,
    alocareDiscount: { sursa: 'grup', grupe: [{ grupa: 'UTILAJE', valoareNet: -10 }] } }], config);
  assert.equal(oneGroup[0]?.revenueGroupId, 'utilaje');
  const standalone = classifySales([{ tipLinie: 'discount', grupa: 'Discount', valoareNet: -10,
    alocareDiscount: { sursa: 'nealocat', grupe: [] } }], config);
  assert.equal(standalone[0]?.revenueGroupId, 'piese');
});

test('discount allocations preserve rounding and reject shares inconsistent with the source', () => {
  const line = { miscareId: 1, tipLinie: 'discount', valoareNet: -0.03, valoareTVA: -0.01,
    alocareDiscount: { sursa: 'document', grupe: [
      { grupa: 'Utilaje', valoareNet: -0.01 }, { grupa: 'Horsch', valoareNet: -0.02 },
    ] } };
  const result = classifySales([line], config);
  assert.equal(result.reduce((sum, row) => sum + Math.round(Number(row.valoareTVA) * 100), 0), -1);
  assert.equal(result.reduce((sum, row) => sum + Math.round(Number(row.valoareNet) * 100), 0), -3);
  for (const allocation of [
    { sursa: 'document', grupe: [{ grupa: 'Horsch', valoareNet: -0.02 }] },
    { sursa: 'document', grupe: [] },
    { sursa: 'document', grupe: [{ grupa: 1, valoareNet: -0.03 }] },
    { sursa: 'document', grupe: [{ grupa: 'Horsch', valoareNet: 'n/a' }] },
    { sursa: ['document'], grupe: [{ grupa: 'Horsch', valoareNet: -0.03 }] },
    { sursa: 'nealocat', grupe: [{ grupa: 'Horsch', valoareNet: -0.03 }] },
  ]) assert.throws(() => classifySales([{ ...line, alocareDiscount: allocation }], config), { status: 502 });
});

test('allocated gross and margins reconcile per row after half-cent rounding', () => {
  for (const sign of [-1, 1]) {
    const line = { miscareId: 1, tipLinie: 'discount', valoareNet: sign * 0.06,
      valoareTVA: sign * 0.03, valoareTotal: sign * 0.09, costTotal: sign * 0.03, marja: sign * 0.03,
      alocareDiscount: { sursa: 'document', grupe: [
        { grupa: 'Utilaje', valoareNet: sign * 0.03 }, { grupa: 'Horsch', valoareNet: sign * 0.03 },
      ] } };
    const rows = classifySales([line], config);
    const money = (value: unknown) => Math.round(Number(value) * 100);
    for (const row of rows) {
      assert.equal(money(row.valoareTotal), money(row.valoareNet) + money(row.valoareTVA));
      assert.equal(money(row.marja), money(row.valoareNet) - money(row.costTotal));
    }
    for (const field of ['valoareNet', 'valoareTVA', 'valoareTotal', 'costTotal', 'marja'] as const) {
      assert.equal(rows.reduce((sum, row) => sum + money(row[field]), 0), money(line[field]));
    }
  }
});

test('cache versions change with identity, entity grants, group scopes and classification revision', () => {
  const user: AuthenticatedUser = { id: 'u1', tenantId: 't1', displayName: null, email: null, isAdmin: false,
    role: 'reader', permissions: ['sales:read'], salesGroups: ['utilaje'], targetEntities: ['agritehnica'], isActive: true };
  const version = salesAccessVersion(user, config);
  for (const patch of [{ id: 'u2' }, { tenantId: 't2' }, { role: 'other-role' }, { salesGroups: null }, { salesGroups: [] }, { targetEntities: [] }]) {
    assert.notEqual(salesAccessVersion({ ...user, ...patch }, config), version);
  }
  assert.notEqual(salesAccessVersion(user, { ...config, revision: 2 }), version);
});
