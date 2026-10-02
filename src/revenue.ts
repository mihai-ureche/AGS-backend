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
export function classifySales(lines: Record<string, unknown>[], config: RevenueConfiguration): ClassifiedSalesLine[] {
  if (!config.enabled) return lines.map(line => ({ ...line, revenueGroupId: null, revenueGroupName: null }));
  const names = new Map(config.groups.map(group => [group.id, group.name]));
  const rules = new Map(config.rules.map(rule => [categoryKey(rule.category), rule.groupId]));
  // Corrupt/missing configuration must not silently return unclassified data.
  if (!names.has(config.defaultGroupId) || config.rules.some(rule => !names.has(rule.groupId))) {
    throw new HttpError(503, 'Revenue grouping configuration is unavailable.');
  }
  return lines.map(line => {
    const id = (typeof line.grupa === 'string' ? rules.get(categoryKey(line.grupa)) : undefined) ?? config.defaultGroupId;
    return { ...line, revenueGroupId: id, revenueGroupName: names.get(id)! };
  });
}

export function visibleRevenueGroups(user: AuthenticatedUser, groups: RevenueGroup[]) {
  return groups.filter(group => user.salesGroups === null || user.salesGroups.includes(group.id));
}

/** Binds cached sales and multi-request datasets to the current identity and policy. */
export function salesAccessVersion(user: AuthenticatedUser, config: RevenueConfiguration, reportVersion?: string): string {
  return createHash('sha256').update(JSON.stringify([
    user.tenantId, user.id, user.role, [...user.permissions].sort(), [...user.targetEntities].sort(),
    user.salesGroups === null ? null : [...user.salesGroups].sort(), config.targetEntity, config.revision, reportVersion,
  ])).digest('hex');
}
