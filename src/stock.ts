import { requestBorg } from './borg.js';
import type { BorgFetch } from './borg.js';
import { HttpError } from './errors.js';
import type { AppConfig, TargetEntity } from './types.js';
import { isRecord, isTargetEntity } from './validation.js';

export interface StockQuery {
  targetEntity: TargetEntity;
  code: string;
}

export function parseStockQuery(query: Record<string, unknown>): StockQuery {
  if (Object.keys(query).some(key => key !== 'targetEntity' && key !== 'code')) {
    throw new HttpError(400, 'Unsupported stock query parameter.');
  }
  const { targetEntity, code } = query;
  if (!isTargetEntity(targetEntity)) {
    throw new HttpError(400, 'targetEntity must be agritehnica, green, or babyhub.');
  }
  if (typeof code !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(code)) {
    throw new HttpError(400, 'code must be 1–64 letters, digits, dots, underscores, or hyphens.');
  }
  return { targetEntity, code };
}

export function createStockClient(config: AppConfig['borg'], fetchBorg: BorgFetch = fetch) {
  return async (query: StockQuery): Promise<Record<string, unknown> | Record<string, unknown>[]> => {
    const stock = await requestBorg(config, fetchBorg, 'stock', { code: query.code, targetEntity: query.targetEntity });
    // Borg's stock shape is passed through unchanged; only reject non-JSON-object payloads.
    if (Array.isArray(stock) && stock.every(isRecord)) return stock;
    if (isRecord(stock)) return stock;
    throw new HttpError(502, 'Borg returned an invalid stock response.');
  };
}
