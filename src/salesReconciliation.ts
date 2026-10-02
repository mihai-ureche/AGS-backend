import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ClassifiedSalesLine, RevenueConfiguration, RevenueGroupId } from './revenue.js';
import { isRevenueGroupId } from './revenue.js';
import type { SalesQuery } from './sales.js';
import type { TargetEntity } from './types.js';
import { isRecord, isTargetEntity } from './validation.js';

export interface SalesReconciliation {
  targetEntity: TargetEntity;
  groupId: RevenueGroupId;
  month: string;
  label: string;
  revision: string;
  salesBeforeDiscounts: number;
  discounts: number;
  csvSalesBeforeDiscounts: number;
  csvDiscounts: number;
  lines: Record<string, unknown>[];
}

const cents = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid reconciliation amount.');
  return Math.round(value * 100);
};

/** Private, operator-supplied report data; never served as a static asset. */
export async function readSalesReconciliations(path?: string): Promise<SalesReconciliation[]> {
  if (!path) return [];
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(data)) throw new Error('Expected an array of sales reconciliations.');
  const seen = new Set<string>();
  for (const report of data) {
    if (!isRecord(report) || !isTargetEntity(report.targetEntity) || !isRevenueGroupId(report.groupId)
      || typeof report.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(report.month)
      || typeof report.label !== 'string' || !report.label.trim() || typeof report.revision !== 'string'
      || !Array.isArray(report.lines) || !report.lines.length || !report.lines.every(isRecord)) {
      throw new Error('Invalid sales reconciliation report.');
    }
    const key = `${report.targetEntity}:${report.groupId}:${report.month}`;
    if (seen.has(key)) throw new Error('Overlapping sales reconciliation reports.');
    seen.add(key);
    let sales = 0;
    let discounts = 0;
    const ids = new Set<unknown>();
    for (const line of report.lines) {
      if (typeof line.data !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(line.data) || !line.data.startsWith(`${report.month}-`)
        || new Date(`${line.data}T00:00:00Z`).toISOString().slice(0, 10) !== line.data
        || typeof line.miscareId !== 'string' || ids.has(line.miscareId)
        || !['sale', 'discount'].includes(String(line.businessValueKind))) {
        throw new Error('Invalid reconciliation line date, ID or value kind.');
      }
      ids.add(line.miscareId);
      const value = cents(line.valoareNet);
      if (line.businessValueKind === 'discount') discounts -= value;
      else sales += value;
    }
    if (sales !== cents(report.salesBeforeDiscounts) || discounts !== cents(report.discounts)) {
      throw new Error('Reconciliation lines do not match the business markers.');
    }
    cents(report.csvSalesBeforeDiscounts);
    cents(report.csvDiscounts);
  }
  return data as SalesReconciliation[];
}

export function reconciliationVersion(reports: SalesReconciliation[], config: RevenueConfiguration) {
  if (!config.enabled) return undefined;
  const applicable = reports.filter(report => report.targetEntity === config.targetEntity);
  return applicable.length ? createHash('sha256').update(JSON.stringify(applicable)).digest('hex') : undefined;
}

function documentProductKey(line: Record<string, unknown>) {
  return JSON.stringify([String(line.tipDocument), String(line.serie).trim(), String(line.numar), String(line.produs).trim()]);
}

function documentKey(line: Record<string, unknown>) {
  return JSON.stringify([String(line.tipDocument), String(line.serie).trim(), String(line.numar)]);
}

/** Replace the reconciled group/month, before applying the caller's access scope. */
export function reconcileSales(
  raw: ClassifiedSalesLine[], query: SalesQuery, config: RevenueConfiguration, reports: SalesReconciliation[],
) {
  // The sales CSV has no warehouse identifiers and excludes internal transfers.
  // These narrower/different scopes must continue using the live source.
  const applicable = config.enabled && query.gestiune === undefined && !query.includeTransfers
    ? reports.filter(report => report.targetEntity === query.targetEntity
      && report.month <= query.to.slice(0, 7) && report.month >= query.from.slice(0, 7))
    : [];
  const keys = new Set(applicable.flatMap(report => report.lines.filter(line => !line.businessReconciliationAdjustment).map(documentProductKey)));
  const context = new Map<string, ClassifiedSalesLine>();
  const movements = new Map<string, ClassifiedSalesLine[]>();
  for (const line of raw) {
    context.set(documentKey(line), line);
    const key = documentProductKey(line);
    const bucket = movements.get(key) ?? [];
    bucket.push(line);
    movements.set(key, bucket);
  }
  const lines: ClassifiedSalesLine[] = raw.filter(line => !applicable.some(report =>
    String(line.data).startsWith(`${report.month}-`) && line.revenueGroupId === report.groupId)
    && !keys.has(documentProductKey(line)));
  for (const report of applicable) {
    const name = config.groups.find(group => group.id === report.groupId)?.name;
    if (!name) throw new Error('Reconciliation revenue group is unavailable.');
    for (const line of report.lines) {
      if (String(line.data) < query.from || String(line.data) > query.to || (query.docType && line.tipDocument !== query.docType)) continue;
      const candidates = movements.get(documentProductKey(line));
      const index = candidates?.findIndex(candidate => Number(candidate.cantitate) === Number(line.cantitate)) ?? -1;
      const movement = index >= 0 ? candidates?.splice(index, 1)[0] : undefined;
      const document = movement ?? context.get(documentKey(line));
      const enriched: Record<string, unknown> = {};
      // Preserve live identifiers and analysis dimensions, never its disputed amounts.
      for (const field of ['documentId', 'oraDocument', 'gestiuneId', 'depozit', 'clientId', 'clientCodFiscal',
        'operator', 'agent', 'facturaSerie', 'facturaNumar', 'facturaData']) {
        if (document?.[field] != null) enriched[field] = document[field];
      }
      if (movement?.codProdus != null) enriched.codProdus = movement.codProdus;
      lines.push({ ...line, ...enriched, revenueGroupId: report.groupId, revenueGroupName: name, salesSource: 'business-report' });
    }
  }
  return { lines, reports: applicable.map(({ lines: _lines, ...report }) => report) };
}
