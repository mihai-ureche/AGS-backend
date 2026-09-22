import { UUID } from './config.js';
import { HttpError } from './errors.js';
import type { Request, RequestHandler } from 'express';
import type { AppConfig, AuthenticatedUser, GraphFetch } from './types.js';
import { isRecord } from './validation.js';

export function authenticatedUser(req: Request): AuthenticatedUser {
  if (!req.user) throw new HttpError(401, 'Authentication is required.');
  return req.user;
}

// Graph owns these tokens. Never decode them to make authorization decisions.
export function createAuthenticate(config: AppConfig, fetchGraph: GraphFetch = fetch): RequestHandler {
  async function graph(path: string, token: string): Promise<unknown> {
    try {
      const response = await fetchGraph(`https://graph.microsoft.com/v1.0/${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      if (response.status === 401) throw new HttpError(401, 'Your Microsoft token is invalid or expired. Sign in again.');
      if ([400, 403].includes(response.status)) throw new HttpError(403, 'Use a Microsoft work account token with delegated User.Read permission.');
      if (response.status === 429 || response.status >= 500) throw new HttpError(503, 'Microsoft Graph is temporarily unavailable. Try again later.');
      if (!response.ok) throw new HttpError(502, 'Microsoft Graph could not verify your account.');
      return await response.json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'Microsoft Graph is temporarily unavailable. Try again later.');
    }
  }

  return async function authenticate(req, res, next) {
    const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(req.get('authorization') ?? '');
    const token = match?.[1];
    if (!token || token.length > 16000) throw new HttpError(401, 'Send a Microsoft Graph access token in the Authorization: Bearer header.');
    const profile = await graph('me?$select=id,displayName,mail,userPrincipalName', token);
    const organizations = await graph('organization?$select=id', token);
    if (!isRecord(organizations) || !Array.isArray(organizations.value) || organizations.value.length !== 1) {
      throw new HttpError(403, 'A work account from the configured organization is required.');
    }
    const organization: unknown = organizations.value[0];
    const tenantId = isRecord(organization) && typeof organization.id === 'string' ? organization.id.toLowerCase() : undefined;
    if (tenantId !== config.tenantId) throw new HttpError(403, 'Your organization is not allowed to access this application.');
    if (!isRecord(profile) || typeof profile.id !== 'string' || !UUID.test(profile.id)) throw new HttpError(502, 'Microsoft Graph returned an invalid user profile.');
    const id = profile.id.toLowerCase();
    req.user = {
      id,
      tenantId,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : null,
      email: typeof profile.mail === 'string' ? profile.mail : typeof profile.userPrincipalName === 'string' ? profile.userPrincipalName : null,
      isAdmin: config.adminUserIds.includes(id),
    };
    next();
  };
}
