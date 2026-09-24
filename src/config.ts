import type { AppConfig } from './types.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tenantId = env.MICROSOFT_TENANT_ID?.trim().toLowerCase();
  if (!tenantId || !UUID.test(tenantId)) throw new Error('MICROSOFT_TENANT_ID must be your directory tenant UUID.');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const origins = (env.FRONTEND_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length) throw new Error('FRONTEND_ORIGINS must contain your frontend origin.');
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('FRONTEND_ORIGINS must contain exact HTTP(S) origins without paths or trailing slashes.');
    }
  }
  const port = Number(env.PORT ?? 3000);
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) throw new Error('TRUST_PROXY_HOPS must be between 0 and 5.');
  const salesUrl = env.BORG_SALES_URL?.trim();
  const authorization = env.BORG_API_AUTHORIZATION?.trim();
  if (Boolean(salesUrl) !== Boolean(authorization)) {
    throw new Error('Set both BORG_SALES_URL and BORG_API_AUTHORIZATION, or leave both empty.');
  }
  let borg: AppConfig['borg'];
  if (salesUrl && authorization) {
    let url: URL;
    try { url = new URL(salesUrl); } catch { throw new Error('BORG_SALES_URL must be a full HTTP(S) sales endpoint URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('BORG_SALES_URL must be an HTTP(S) endpoint without credentials, query parameters, or a fragment.');
    }
    if (!/^[\x20-\x7e]+$/.test(authorization)) throw new Error('BORG_API_AUTHORIZATION must be a single printable ASCII header value.');
    borg = { salesUrl: url.toString(), authorization };
  }
  return { tenantId, databaseUrl: env.DATABASE_URL, origins, port, trustProxyHops, borg };
}
