import { HttpError } from './errors.js';
import type { AppConfig } from './types.js';

export type BorgFetch = (url: string, init: RequestInit) => Promise<Response>;

// Calls `${baseUrl}/${endpoint}` with only the server credential and returns the parsed JSON.
export async function requestBorg(config: AppConfig['borg'], fetchBorg: BorgFetch, endpoint: string,
  params: Record<string, string | undefined>): Promise<unknown> {
  if (!config) throw new HttpError(503, `Borg ${endpoint} is not configured. Contact an administrator.`);
  const url = new URL(`${config.baseUrl}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const signal = AbortSignal.timeout(30000);
  try {
    const response = await fetchBorg(url.toString(), {
      method: 'GET',
      headers: { Authorization: config.authorization, Accept: 'application/json' },
      redirect: 'error', signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 400) throw new HttpError(400, `Borg rejected the ${endpoint} filters.`);
      if (response.status === 429 || response.status === 503) throw new HttpError(503, `Borg ${endpoint} is temporarily unavailable. Try again later.`);
      throw new HttpError(502, `Borg could not complete the ${endpoint} request.`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
      throw new HttpError(504, `Borg ${endpoint} request timed out. Try a smaller request.`);
    }
    throw new HttpError(502, `Borg ${endpoint} could not be reached or returned an invalid response.`);
  }
}
