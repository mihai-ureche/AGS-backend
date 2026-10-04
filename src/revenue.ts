import { createHash } from 'node:crypto';
import { HttpError } from './errors.js';
import type { AuthenticatedUser, TargetEntity } from './types.js';
import { isRecord } from './validation.js';

export const revenueGroupIds = ['utilaje', 'irigatii', 'other', 'piese', 'manopera'] as const;
export type RevenueGroupId = typeof revenueGroupIds[number];
export interface RevenueGroup { id: RevenueGroupId; name: string }
export interface RevenueRule { category: string; groupId: RevenueGroupId }
export interface RevenueConfiguration {
  targetEntity: TargetEntity;
  enabled: boolean;
  revision: number;
  defaultGroupId: RevenueGroupId;
  rules: RevenueRule[];
  groups: RevenueGroup[];
}
export type RevenueUpdate = Pick<RevenueConfiguration, 'enabled' | 'revision' | 'defaultGroupId' | 'rules'>;

/** Exact category matching, tolerant of Romanian accents, case and whitespace. */
export function categoryKey(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isRevenueGroupId(value: unknown): value is RevenueGroupId {
  return typeof value === 'string' && revenueGroupIds.includes(value as RevenueGroupId);
}

export function parseSalesGroups(value: unknown): RevenueGroupId[] | null {
  if (value === null) return null; // Explicit access to all groups.
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isRevenueGroupId) || new Set(value).size !== value.length) {
    throw new HttpError(400, 'salesGroups must be null (all groups) or a unique array of supported revenue group IDs.');
  }
  return value;
}

export function parseRevenueUpdate(value: unknown): RevenueUpdate {
  if (!isRecord(value) || Object.keys(value).some(key => !['enabled', 'revision', 'defaultGroupId', 'rules'].includes(key))
    || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !isRevenueGroupId(value.defaultGroupId) || !Array.isArray(value.rules) || value.rules.length > 200) {
    throw new HttpError(400, 'Provide revision, defaultGroupId and up to 200 category rules.');
  }
  const seen = new Set<string>();
  const rules = value.rules.map(rule => {
    if (!isRecord(rule) || Object.keys(rule).some(key => !['category', 'groupId'].includes(key))
      || typeof rule.category !== 'string' || !rule.category.trim() || rule.category.length > 200
      || !isRevenueGroupId(rule.groupId)) throw new HttpError(400, 'Each rule needs a category and a supported groupId.');
    const key = categoryKey(rule.category);
    if (!key || seen.has(key)) throw new HttpError(400, 'Each category can belong to only one revenue group.');
    seen.add(key);
    return { category: rule.category.trim(), groupId: rule.groupId };
  });
  return { enabled: value.enabled, revision: value.revision as number, defaultGroupId: value.defaultGroupId, rules };
}

export type ClassifiedSalesLine = Record<string, unknown> & {
  revenueGroupId: RevenueGroupId | null;
  revenueGroupName: string | null;
};

function allocationCents(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^-?\d+(?:\.\d{1,2})?$/.test(String(value).trim())) {
    throw new HttpError(502, 'Borg returned an invalid discount allocation amount.');
  }
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents)) throw new HttpError(502, 'Borg returned an invalid discount allocation amount.');
  return cents;
}

/** Divide a source amount using BORG's net shares, preserving every cent. */
function splitAllocationAmount(value: unknown, shares: number[], total: number): number[] {
  const source = allocationCents(value);
  if (total === 0) {
    if (source !== 0 || shares.some(share => share !== 0)) throw new HttpError(502, 'Borg returned an inconsistent discount allocation.');
    return shares.map(() => 0);
  }
  let used = 0;
  return shares.map((share, index) => {
    const amount = index === shares.length - 1 ? source - used : Math.round(source * (share / total));
    used += amount;
    return amount / 100;
  });
}

export function classifySales(lines: Record<string, unknown>[], config: RevenueConfiguration): ClassifiedSalesLine[] {
  if (!config.enabled) return lines.map(line => ({ ...line, revenueGroupId: null, revenueGroupName: null }));
  const names = new Map(config.groups.map(group => [group.id, group.name]));
  const rules = new Map(config.rules.map(rule => [categoryKey(rule.category), rule.groupId]));
  // Corrupt/missing configuration must not silently return unclassified data.
  if (!names.has(config.defaultGroupId) || config.rules.some(rule => !names.has(rule.groupId))) {
    throw new HttpError(503, 'Revenue grouping configuration is unavailable.');
  }
  const groupFor = (category: unknown) => (typeof category === 'string' ? rules.get(categoryKey(category)) : undefined) ?? config.defaultGroupId;
  const classified = (line: Record<string, unknown>, id: RevenueGroupId): ClassifiedSalesLine =>
    ({ ...line, revenueGroupId: id, revenueGroupName: names.get(id)! });
  return lines.flatMap(line => {
    const allocation = line.alocareDiscount;
    if (line.tipLinie !== 'discount' || line.discountInclusInLinii === true || allocation == null) {
      return [classified(line, groupFor(line.grupa))];
    }
    if (!isRecord(allocation) || typeof allocation.sursa !== 'string' || !['grup', 'document', 'nealocat'].includes(allocation.sursa)
      || !Array.isArray(allocation.grupe)) throw new HttpError(502, 'Borg returned an invalid discount allocation.');
    if (allocation.sursa === 'nealocat') {
      if (allocation.grupe.length) throw new HttpError(502, 'Borg returned an invalid unallocated discount.');
      // Standalone later discounts still need the configured business scope.
      return [classified(line, groupFor(line.grupa))];
    }
    const buckets = new Map<RevenueGroupId, { cents: number; categories: Record<string, unknown>[] }>();
    for (const part of allocation.grupe) {
      if (!isRecord(part) || (part.grupa !== null && typeof part.grupa !== 'string')) throw new HttpError(502, 'Borg returned an invalid discount allocation.');
      const id = groupFor(part.grupa);
      const bucket = buckets.get(id) ?? { cents: 0, categories: [] };
      bucket.cents += allocationCents(part.valoareNet);
      if (!Number.isSafeInteger(bucket.cents)) throw new HttpError(502, 'Borg returned an invalid discount allocation amount.');
      bucket.categories.push({ grupa: part.grupa, valoareNet: part.valoareNet });
      buckets.set(id, bucket);
    }
    const entries = [...buckets];
    const total = allocationCents(line.valoareNet);
    if (!entries.length || entries.reduce((sum, [, bucket]) => sum + bucket.cents, 0) !== total) {
      throw new HttpError(502, 'Borg discount allocations do not match the line value.');
    }
    if (entries.length === 1) return [classified(line, entries[0]![0])];
    if (typeof line.miscareId !== 'number' && typeof line.miscareId !== 'string') throw new HttpError(502, 'Borg discount allocation has no movement ID.');
    const shares = entries.map(([, bucket]) => bucket.cents);
    const fields = new Map<string, number[]>();
    for (const field of ['valoareSalvata', 'valoareDiscountLinie', 'valoareTVA', 'valoareTotal', 'costTotal', 'marja']) {
      if (line[field] != null) fields.set(field, splitAllocationAmount(line[field], shares, total));
    }
    // Derive related amounts from the rounded shares when BORG's source obeys
    // these identities, keeping each row consistent as well as the totals.
    const vat = fields.get('valoareTVA');
    if (vat && fields.has('valoareTotal') && allocationCents(line.valoareTotal) === total + allocationCents(line.valoareTVA)) {
      fields.set('valoareTotal', shares.map((share, index) => (share + allocationCents(vat[index])) / 100));
    }
    const costs = fields.get('costTotal');
    if (costs && fields.has('marja') && allocationCents(line.marja) === total - allocationCents(line.costTotal)) {
      fields.set('marja', shares.map((share, index) => (share - allocationCents(costs[index])) / 100));
    }
    // Each returned row belongs to one revenue group. Filter these rows before
    // serving them, so a restricted role never sees another group's amount.
    return entries.map(([id, bucket], index) => {
      const amount = bucket.cents / 100;
      const values = Object.fromEntries([...fields].map(([field, parts]) => [field, parts[index]!]));
      const cost = fields.get('costTotal')?.[index];
      const margin = fields.get('marja')?.[index];
      return classified({
        ...line, ...values,
        miscareId: `${line.miscareId}:discount:${id}`, sourceMiscareId: line.miscareId, discountAllocation: true,
        cantitate: 1, pretUnitar: amount, pretUnitarNet: amount, valoareNet: amount,
        ...(cost === undefined ? {} : { costUnitar: cost }),
        ...(margin === undefined ? {} : { marjaProcent: amount === 0 ? null : Math.round(margin / amount * 10000) / 100 }),
        alocareDiscount: { sursa: allocation.sursa, grupe: bucket.categories },
      }, id);
    });
  });
}

export function visibleRevenueGroups(user: AuthenticatedUser, groups: RevenueGroup[]) {
  return groups.filter(group => user.salesGroups === null || user.salesGroups.includes(group.id));
}

/** Binds cached sales and multi-request datasets to the current identity and policy. */
export function salesAccessVersion(user: AuthenticatedUser, config: RevenueConfiguration): string {
  return createHash('sha256').update(JSON.stringify([
    'sales-grouping-v4', // Invalidate cached arrays when the grouping contract changes.
    user.tenantId, user.id, user.role, [...user.permissions].sort(), [...user.targetEntities].sort(),
    user.salesGroups === null ? null : [...user.salesGroups].sort(), config.targetEntity, config.revision,
  ])).digest('hex');
}
