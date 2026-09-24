import { HttpError } from './errors.js';
import type { AppConfig } from './types.js';
import { isRecord } from './validation.js';

export interface SalesQuery {
  targetEntity: 'agritehnica' | 'green' | 'babyhub';
  from: string;
  to: string;
  gestiune?: number;
  docType?: 'BFD' | 'AIM';
  limit: number;
  includeTransfers: boolean;
}

export type BorgFetch = (url: string, init: RequestInit) => Promise<Response>;

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
  if (targetEntity !== 'agritehnica' && targetEntity !== 'green' && targetEntity !== 'babyhub') {
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
    if (!config) throw new HttpError(503, 'Borg sales is not configured. Contact an administrator.');
    const url = new URL(config.salesUrl);
    url.searchParams.set('targetEntity', query.targetEntity);
    url.searchParams.set('from', query.from);
    url.searchParams.set('to', query.to);
    url.searchParams.set('limit', String(query.limit));
    url.searchParams.set('includeTransfers', String(query.includeTransfers));
    if (query.gestiune !== undefined) url.searchParams.set('gestiune', String(query.gestiune));
    if (query.docType !== undefined) url.searchParams.set('docType', query.docType);

    const signal = AbortSignal.timeout(30000);
    try {
      const response = await fetchBorg(url.toString(), {
        method: 'GET',
        headers: { Authorization: config.authorization, Accept: 'application/json' },
        redirect: 'error', signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 400) throw new HttpError(400, 'Borg rejected the sales filters.');
        if (response.status === 429 || response.status === 503) throw new HttpError(503, 'Borg sales is temporarily unavailable. Try again later.');
        throw new HttpError(502, 'Borg could not complete the sales request.');
      }
      const lines: unknown = await response.json();
      if (!Array.isArray(lines) || lines.length > query.limit || !lines.every(isRecord)) {
        throw new HttpError(502, 'Borg returned an invalid sales response.');
      }
      // Preserve raw values (including returns, nulls, costs, and margins).
      return lines;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new HttpError(504, 'Borg sales request timed out. Try a smaller interval.');
      }
      throw new HttpError(502, 'Borg sales could not be reached or returned an invalid response.');
    }
  };
}
