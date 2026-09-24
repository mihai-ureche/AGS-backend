import express from 'express';
import type { ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { authenticatedUser, createAuthenticate } from './auth.js';
import { UUID } from './config.js';
import { HttpError } from './errors.js';
import type { AppConfig, GraphFetch, Store } from './types.js';
import { isRecord, isRequestPriority, isRequestStatus } from './validation.js';
import { isRole, permissionsFor, requirePermission } from './permissions.js';
import { createSalesClient, parseSalesQuery } from './sales.js';
import type { BorgFetch } from './sales.js';

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

export function createApp({ config, store, fetchGraph, fetchBorg, rateLimitMax = 120 }: AppOptions) {
  const app = express();
  const fetchSales = createSalesClient(config.borg, fetchBorg);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.origins.includes(origin)) return callback(null, true);
      callback(new HttpError(403, 'This frontend origin is not allowed.'));
    },
    methods: ['GET', 'POST', 'PATCH'],
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
    const role = (await store.getUserRole(user)) ?? 'user';
    if (!isRole(role)) throw new HttpError(403, 'Your account has an unsupported role.');
    user.role = role;
    user.isAdmin = role === 'admin';
    next();
  });
  api.use(express.json({ limit: '32kb' }));
  api.get('/me', (req, res) => {
    const user = authenticatedUser(req);
    res.json({ user: { ...user, permissions: permissionsFor(user.role) } });
  });
  api.get('/borg/sales', requirePermission('sales:read'), async (req, res) => {
    const query = parseSalesQuery(req.query);
    res.json(await fetchSales(query));
  });
  api.get('/roles', requirePermission('roles:read'), async (req, res) => {
    const roles = await store.listRoles();
    res.json({ roles: roles.map(role => ({ ...role, permissions: permissionsFor(role.name) })) });
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
    if (!isRole(body.role)) throw new HttpError(400, 'role must be user, support, or admin.');
    const user = await store.updateUserRole(authenticatedUser(req), req.params.id, body.role);
    if (!user) throw new HttpError(404, 'User not found or administrator access was revoked.');
    res.json({ user });
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
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Request ID must be a UUID.');
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
