import type { RequestHandler } from 'express';
import { authenticatedUser } from './auth.js';
import { HttpError } from './errors.js';
import type { Role } from './types.js';

export type Permission = 'requests:create' | 'requests:read:own' | 'requests:read:all'
  | 'requests:update' | 'users:read' | 'users:roles:update' | 'roles:read' | 'sales:read';

const permissions: Record<Role, readonly Permission[]> = {
  user: ['requests:create', 'requests:read:own'],
  support: ['requests:create', 'requests:read:own', 'requests:read:all', 'requests:update'],
  admin: ['requests:create', 'requests:read:own', 'requests:read:all', 'requests:update',
    'users:read', 'users:roles:update', 'roles:read', 'sales:read'],
};

export function isRole(value: unknown): value is Role {
  return value === 'user' || value === 'support' || value === 'admin';
}

export function permissionsFor(role: Role): readonly Permission[] {
  return isRole(role) ? permissions[role] : [];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, res, next) => {
    if (!hasPermission(authenticatedUser(req).role, permission)) {
      throw new HttpError(403, 'Your role does not allow this action.');
    }
    next();
  };
}
