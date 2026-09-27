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

test('cache versions change with identity, entity grants, group scopes and classification revision', () => {
  const user: AuthenticatedUser = { id: 'u1', tenantId: 't1', displayName: null, email: null, isAdmin: false,
    role: 'reader', permissions: ['sales:read'], salesGroups: ['utilaje'], targetEntities: ['agritehnica'], isActive: true };
  const version = salesAccessVersion(user, config);
  for (const patch of [{ id: 'u2' }, { tenantId: 't2' }, { role: 'other-role' }, { salesGroups: null }, { salesGroups: [] }, { targetEntities: [] }]) {
    assert.notEqual(salesAccessVersion({ ...user, ...patch }, config), version);
  }
  assert.notEqual(salesAccessVersion(user, { ...config, revision: 2 }), version);
});
