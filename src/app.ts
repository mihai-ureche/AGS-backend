import express from 'express';
import type { ErrorRequestHandler, Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { authenticatedUser, createAuthenticate } from './auth.js';
import { UUID } from './config.js';
import { HttpError } from './errors.js';
import type { AppConfig, GraphFetch, Store, TargetEntity, UserUpdate } from './types.js';
import { isRecord, isRequestPriority, isRequestStatus, isTargetEntity } from './validation.js';
import { assignablePermissions, isRoleName, permissionsFor, requirePermission } from './permissions.js';
import type { BorgFetch } from './borg.js';
import { createSalesClient, parseSalesQuery } from './sales.js';
import { createStockClient, parseStockQuery } from './stock.js';

interface AppOptions {
  config: AppConfig;
  store: Store;
  fetchGraph?: GraphFetch;
  fetchBorg?: BorgFetch;
  rateLimitMax?: number;
}

function bodyFields(body: unknown, allowed: string[]): asserts body is Record<string, unknown> {
  if (!isRecord(body)) throw new HttpError(400, 'Send a JSON object.');
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, 'Request contains unsupported fields.');
}

function textField(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, `${name} must contain between 1 and ${max} characters.`);
  }
  return value.trim();
}

function pageNumber(value: unknown, fallback: number, max: number, min = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new HttpError(400, 'Invalid pagination. Use limit 1–100 and offset 0–1000000.');
  }
  return Number(value);
}

function requireEntity(req: Request, entity: TargetEntity) {
  if (!authenticatedUser(req).targetEntities.includes(entity)) {
    throw new HttpError(403, 'Your account does not have access to this entity.');
  }
}

export function createApp({ config, store, fetchGraph, fetchBorg, rateLimitMax = 120 }: AppOptions) {
  const app = express();
  const fetchSales = createSalesClient(config.borg, fetchBorg);
  const fetchStock = createStockClient(config.borg, fetchBorg);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.origins.includes(origin)) return callback(null, true);
      callback(new HttpError(403, 'This frontend origin is not allowed.'));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  }));
  app.get('/', (req, res) => res.json({ service: 'AGS support API', health: '/health' }));
  app.get('/health', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await store.health();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  const api = express.Router();
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(rateLimit({
    windowMs: 60_000,
    limit: rateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Try again shortly.' },
  }));
  api.use(createAuthenticate(config, fetchGraph));
  api.use(async (req, res, next) => {
    const user = authenticatedUser(req);
    const access = await store.getUserAccess(user);
    if (access && (!access.isActive || access.deletedAt)) throw new HttpError(403, 'Your account is inactive or deleted.');
    user.role = access?.role ?? 'user';
    user.permissions = access?.permissions ?? permissionsFor('user');
    user.targetEntities = access?.targetEntities ?? [];
    user.isActive = access?.isActive ?? true;
    user.isAdmin = user.role === 'admin';
    next();
  });
  api.use(express.json({ limit: '32kb' }));
  api.get('/me', (req, res) => {
    const user = authenticatedUser(req);
    res.json({ user });
  });
  api.get('/borg/sales', requirePermission('sales:read'), async (req, res) => {
    const query = parseSalesQuery(req.query);
    requireEntity(req, query.targetEntity);
    res.json(await fetchSales(query));
  });
  api.get('/borg/stock', requirePermission('stock:read'), async (req, res) => {
    const query = parseStockQuery(req.query);
    requireEntity(req, query.targetEntity);
    res.json(await fetchStock(query));
  });
  api.get('/roles', requirePermission('roles:read'), async (req, res) => {
    const roles = await store.listRoles();
    res.json({ roles, assignablePermissions });
  });
  api.get('/users', requirePermission('users:read'), async (req, res) => {
    const limit = pageNumber(req.query.limit, 20, 100, 1);
    const offset = pageNumber(req.query.offset, 0, 1000000);
    const users = await store.listUsers(authenticatedUser(req), { limit, offset });
    res.json({ users, limit, offset });
  });
  api.patch<{ id: string }>('/users/:id/role', requirePermission('users:roles:update'), async (req, res) => {
    const body: unknown = req.body;
    bodyFields(body, ['role']);
    if (!isRoleName(body.role)) throw new HttpError(400, 'Invalid role name.');
    const user = await store.updateUserRole(authenticatedUser(req), req.params.id, body.role);
    if (!user) throw new HttpError(404, 'User not found.');
    res.json({ user });
  });
  api.post('/roles', requirePermission('users:roles:update'), async (req, res) => {
    const body: unknown = req.body;
    bodyFields(body, ['name', 'description', 'permissions']);
    if (!isRoleName(body.name)) throw new HttpError(400, 'Role name must be 1–50 lowercase letters, digits, underscores or hyphens, starting with a letter.');
    const description = textField(body.description, 'description', 500);
    const permissions = body.permissions === undefined ? [] : body.permissions;
    if (!Array.isArray(permissions) || !permissions.every(value => assignablePermissions.includes(value))
      || new Set(permissions).size !== permissions.length) {
      throw new HttpError(400, 'permissions must be a unique array of supported data permissions.');
    }
    const role = await store.createRole(authenticatedUser(req), { name: body.name, description, permissions });
    res.status(201).location(`/api/roles/${role.name}`).json({ role });
  });
  api.delete<{ name: string }>('/roles/:name', requirePermission('users:roles:update'), async (req, res) => {
    if (!isRoleName(req.params.name)) throw new HttpError(400, 'Invalid role name.');
    if (!await store.deleteRole(authenticatedUser(req), req.params.name)) throw new HttpError(404, 'Role not found.');
    res.status(204).end();
  });
  api.patch<{ id: string }>('/users/:id', requirePermission('users:roles:update'), async (req, res) => {
    const body: unknown = req.body;
    bodyFields(body, ['targetEntities', 'isActive']);
    if (!Object.keys(body).length) throw new HttpError(400, 'Provide targetEntities or isActive.');
    const input: UserUpdate = {};
    if ('targetEntities' in body) {
      if (!Array.isArray(body.targetEntities) || !body.targetEntities.every(isTargetEntity)
        || new Set(body.targetEntities).size !== body.targetEntities.length) {
        throw new HttpError(400, 'targetEntities must be a unique array containing agritehnica, green, or babyhub.');
      }
      input.targetEntities = body.targetEntities;
    }
    if ('isActive' in body) {
      if (typeof body.isActive !== 'boolean') throw new HttpError(400, 'isActive must be a boolean.');
      input.isActive = body.isActive;
    }
    const user = await store.updateUser(authenticatedUser(req), req.params.id, input);
    if (!user) throw new HttpError(404, 'User not found.');
    res.json({ user });
  });
  api.delete<{ id: string }>('/users/:id', requirePermission('users:roles:update'), async (req, res) => {
    if (!await store.deleteUser(authenticatedUser(req), req.params.id)) throw new HttpError(404, 'User not found.');
    res.status(204).end();
  });
  api.post('/users', async (req, res) => {
    // The bearer token is the only source of identity; no profile or role input.
    const body: unknown = req.body;
    if (body !== undefined) bodyFields(body, []);
    const user = await store.createUser(authenticatedUser(req));
    res.json({ user });
  });
  api.post('/requests', requirePermission('requests:create'), async (req, res) => {
    const body: unknown = req.body;
    bodyFields(body, ['title', 'description', 'priority']);
    const title = textField(body.title, 'title', 200);
    const description = textField(body.description, 'description', 10000);
    const priority = body.priority ?? 'normal';
    if (!isRequestPriority(priority)) throw new HttpError(400, 'priority must be low, normal, or high.');
    const request = await store.create(authenticatedUser(req), { title, description, priority });
    res.status(201).location(`/api/requests/${request.id}`).json({ request });
  });
  api.get('/requests', requirePermission('requests:read:own'), async (req, res) => {
    const { status } = req.query;
    if (status !== undefined && !isRequestStatus(status)) throw new HttpError(400, 'Invalid status filter.');
    const limit = pageNumber(req.query.limit, 20, 100, 1);
    const offset = pageNumber(req.query.offset, 0, 1000000);
    const requests = await store.list(authenticatedUser(req), { status, limit, offset });
    res.json({ requests, limit, offset });
  });
  api.param('id', (req, res, next, id: unknown) => {
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'ID must be a UUID.');
    next();
  });
  api.get<{ id: string }>('/requests/:id', requirePermission('requests:read:own'), async (req, res) => {
    const request = await store.get(authenticatedUser(req), req.params.id);
    if (!request) throw new HttpError(404, 'Support request not found.');
    res.json({ request });
  });
  api.patch<{ id: string }>('/requests/:id', requirePermission('requests:update'), async (req, res) => {
    const user = authenticatedUser(req);
    const body: unknown = req.body;
    bodyFields(body, ['status']);
    if (!isRequestStatus(body.status)) throw new HttpError(400, 'status must be open, in_progress, resolved, or closed.');
    const request = await store.updateStatus(user, req.params.id, body.status);
    if (!request) throw new HttpError(404, 'Support request not found.');
    res.json({ request });
  });
  app.use('/api', api);
  app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
  const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = 500;
    let message = 'An unexpected server error occurred.';
    if (error instanceof HttpError) { status = error.status; message = error.message; }
    else if (isRecord(error) && error.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON body.'; }
    else if (isRecord(error) && error.type === 'entity.too.large') { status = 413; message = 'JSON body is too large.'; }
    else if (isRecord(error) && typeof error.status === 'number' && error.status >= 400 && error.status < 500) { status = error.status; message = 'Invalid request body.'; }
    // Never log request headers, bearer tokens, bodies, or database error details.
    if (status === 500) console.error('Request failed with an internal server error.');
    if (status === 401) res.set('WWW-Authenticate', 'Bearer');
    res.status(status).json({ error: message });
  };
  app.use(errorHandler);
  return app;
}
