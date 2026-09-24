import { requestBorg } from './borg.js';
import type { BorgFetch } from './borg.js';
import { HttpError } from './errors.js';
import type { AppConfig, TargetEntity } from './types.js';
import { isRecord, isTargetEntity } from './validation.js';

export interface SalesQuery {
  targetEntity: TargetEntity;
  from: string;
  to: string;
  gestiune?: number;
  docType?: 'BFD' | 'AIM';
  limit: number;
  includeTransfers: boolean;
}

function date(value: unknown, field: string): { text: string; timestamp: number } {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) {
    throw new HttpError(400, `${field} must be a valid date in YYYY-MM-DD format.`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${field} must be a valid date in YYYY-MM-DD format.`);
  }
  return { text: value, timestamp };
}

function positiveInteger(value: unknown, field: string, max: number): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new HttpError(400, `${field} must be an integer between 1 and ${max}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new HttpError(400, `${field} must be an integer between 1 and ${max}.`);
  }
  return number;
}

export function parseSalesQuery(query: Record<string, unknown>): SalesQuery {
  const allowed = ['targetEntity', 'from', 'to', 'gestiune', 'docType', 'limit', 'includeTransfers'];
  if (Object.keys(query).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unsupported sales query parameter.');
  const { targetEntity, docType, includeTransfers } = query;
  if (!isTargetEntity(targetEntity)) {
    throw new HttpError(400, 'targetEntity must be agritehnica, green, or babyhub.');
  }
  const from = date(query.from, 'from');
  const to = date(query.to, 'to');
  const days = (to.timestamp - from.timestamp) / 86_400_000 + 1;
  if (days < 1) throw new HttpError(400, 'from must be on or before to.');
  if (days > 30) throw new HttpError(400, 'Sales intervals may contain at most 30 days, including both from and to.');
  if (from.text.slice(0, 4) !== to.text.slice(0, 4)) throw new HttpError(400, 'Sales intervals must stay within one calendar year.');
  if (docType !== undefined && docType !== 'BFD' && docType !== 'AIM') throw new HttpError(400, 'docType must be BFD or AIM.');
  if (includeTransfers !== undefined && includeTransfers !== 'true' && includeTransfers !== 'false') {
    throw new HttpError(400, 'includeTransfers must be true or false.');
  }
  return {
    targetEntity, from: from.text, to: to.text, docType,
    gestiune: query.gestiune === undefined ? undefined : positiveInteger(query.gestiune, 'gestiune', Number.MAX_SAFE_INTEGER),
    limit: query.limit === undefined ? 5000 : positiveInteger(query.limit, 'limit', 50000),
    includeTransfers: includeTransfers === 'true',
  };
}

export function createSalesClient(config: AppConfig['borg'], fetchBorg: BorgFetch = fetch) {
  return async (query: SalesQuery): Promise<Record<string, unknown>[]> => {
    const lines = await requestBorg(config, fetchBorg, 'sales', {
      targetEntity: query.targetEntity, from: query.from, to: query.to,
      limit: String(query.limit), includeTransfers: String(query.includeTransfers),
      gestiune: query.gestiune?.toString(), docType: query.docType,
    });
    if (!Array.isArray(lines) || lines.length > query.limit || !lines.every(isRecord)) {
      throw new HttpError(502, 'Borg returned an invalid sales response.');
    }
    // Preserve raw values (including returns, nulls, costs, and margins).
    return lines;
  };
}
