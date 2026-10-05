import { requestBorg } from './borg.js';
import type { BorgFetch } from './borg.js';
import { HttpError } from './errors.js';
import type { AppConfig, TargetEntity } from './types.js';
import { isRecord, isTargetEntity } from './validation.js';

export interface SalesQuery {
  targetEntity: TargetEntity;
  from: string;
  to: string;
  /** Borg document type (`tipDocument`), for example FF or EC. */
  docType?: string;
  /** Account code or prefix, matched by Borg against the debit and credit accounts. */
  account?: string;
  limit: number;
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

function code(value: unknown, pattern: RegExp, message: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) throw new HttpError(400, message);
  return value;
}

export function parseSalesQuery(query: Record<string, unknown>): SalesQuery {
  const allowed = ['targetEntity', 'from', 'to', 'docType', 'account', 'limit'];
  if (Object.keys(query).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unsupported sales query parameter.');
  const { targetEntity } = query;
  if (!isTargetEntity(targetEntity)) {
    throw new HttpError(400, 'targetEntity must be agritehnica, green, or babyhub.');
  }
  const from = date(query.from, 'from');
  const to = date(query.to, 'to');
  const days = (to.timestamp - from.timestamp) / 86_400_000 + 1;
  if (days < 1) throw new HttpError(400, 'from must be on or before to.');
  if (days > 30) throw new HttpError(400, 'Sales intervals may contain at most 30 days, including both from and to.');
  if (from.text.slice(0, 4) !== to.text.slice(0, 4)) throw new HttpError(400, 'Sales intervals must stay within one calendar year.');
  return {
    targetEntity, from: from.text, to: to.text,
    docType: code(query.docType, /^[A-Za-z0-9]{1,10}$/, 'docType must be 1–10 letters or digits.'),
    account: code(query.account, /^[A-Za-z0-9._-]{1,32}$/, 'account must be 1–32 letters, digits, dots, underscores, or hyphens.'),
    limit: query.limit === undefined ? 5000 : positiveInteger(query.limit, 'limit', 50000),
  };
}

export function createSalesClient(config: AppConfig['borg'], fetchBorg: BorgFetch = fetch) {
  return async (query: SalesQuery): Promise<unknown> => {
    // The envelope makes Borg report completeness in `meta.truncated`.
    const response = await requestBorg(config, fetchBorg, 'sales', {
      targetEntity: query.targetEntity, from: query.from, to: query.to,
      limit: String(query.limit), docType: query.docType, account: query.account,
      envelope: 'true',
    });
    // Borg owns this format and has changed it before: forward whatever JSON it
    // sends, rejecting only payloads that are neither an object nor an array.
    if (!isRecord(response) && !Array.isArray(response)) throw new HttpError(502, 'Borg returned an invalid sales response.');
    return response;
  };
 }
