import type { RequestHandler } from 'express';
import { authenticatedUser } from './auth.js';
import { HttpError } from './errors.js';
import type { AuthenticatedUser, Role } from './types.js';

export type Permission = 'requests:create' | 'requests:read:own' | 'requests:read:all'
  | 'requests:update' | 'users:read' | 'users:roles:update' | 'roles:read' | 'sales:read';

const permissions: Record<string, readonly Permission[]> = {
  user: ['requests:create', 'requests:read:own'],
  support: ['requests:create', 'requests:read:own', 'requests:read:all', 'requests:update'],
  admin: ['requests:create', 'requests:read:own', 'requests:read:all', 'requests:update',
    'users:read', 'users:roles:update', 'roles:read', 'sales:read'],
};

export const assignablePermissions: readonly Permission[] = [
  'requests:create', 'requests:read:own', 'requests:read:all', 'requests:update', 'sales:read',
];

export function isRoleName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,49}$/.test(value);
}

export function isRole(value: unknown): value is 'user' | 'support' | 'admin' {
  return value === 'user' || value === 'support' || value === 'admin';
}

export function permissionsFor(role: Role): readonly Permission[] {
  return isRole(role) ? permissions[role]! : [];
}

export function hasPermission(user: AuthenticatedUser, permission: Permission): boolean {
  return user.permissions.includes(permission)
    || (permission === 'requests:read:own' && user.permissions.includes('requests:read:all'));
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, res, next) => {
    if (!hasPermission(authenticatedUser(req), permission)) {
      throw new HttpError(403, 'Your role does not allow this action.');
    }
    next();
  };
}
