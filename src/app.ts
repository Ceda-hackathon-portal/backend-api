import express, { type ErrorRequestHandler, type Router } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Config } from './config/env.js';
import type { DatabaseHealth } from './infrastructure/database.js';
import { HttpError } from './shared/errors.js';

export interface AppDependencies {
  database: DatabaseHealth;
  logger: Logger;
  isDraining?: () => boolean;
  apiRouter?: Router;
}

export function createApp(config: Config, dependencies: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', config.TRUST_PROXY.length ? config.TRUST_PROXY : false);
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-ID', res.locals.requestId as string);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null } } }));
  app.use((req, res, next) => {
    const started = performance.now();
    res.once('finish', () => dependencies.logger.info({ requestId: res.locals.requestId, method: req.method, status: res.statusCode, durationMs: Math.round(performance.now() - started) }, 'http_request'));
    // No raw URL, query, body, cookies, headers, driver error or user values logged.
    const origin = req.headers.origin;
    if (origin) {
      if (!config.ALLOWED_ORIGINS.includes(origin)) throw new HttpError(403, 'ORIGIN_DENIED', 'This origin is not permitted.');
      res.vary('Origin');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID');
    }
    if (req.method === 'OPTIONS') {
      if (!origin) throw new HttpError(403, 'ORIGIN_DENIED', 'This origin is not permitted.');
      const method = req.headers['access-control-request-method'];
      const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
      const headers = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (!method || !methods.includes(method) || headers.some(header => !['content-type', 'x-csrf-token', 'idempotency-key'].includes(header))) throw new HttpError(403, 'PREFLIGHT_DENIED', 'This request is not permitted.');
      res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Idempotency-Key');
      res.sendStatus(204);
      return;
    }
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
    const privateDocumentUpload = req.method === 'POST' && /^\/api\/v1\/applications\/[0-9a-f-]{36}\/documents$/.test(req.path) && req.is('application/octet-stream');
    if (hasBody && !req.is('application/json') && !privateDocumentUpload) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
    next();
  });
  app.use(express.json({ limit: config.JSON_LIMIT_BYTES, strict: true, inflate: false }));
  app.get('/health/live', (_req, res) => { res.json({ data: { status: 'ok' } }); });
  app.get('/health/ready', async (_req, res) => {
    if (dependencies.isDraining?.()) throw new HttpError(503, 'UNAVAILABLE', 'Service is not ready.');
    try { await dependencies.database.check(); }
    catch { throw new HttpError(503, 'UNAVAILABLE', 'Service is not ready.'); }
    res.json({ data: { status: 'ready' } });
  });
  if (dependencies.apiRouter) app.use('/api/v1', dependencies.apiRouter);
  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Resource not found.')));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    let safe = error instanceof HttpError ? error : new HttpError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
    const kind = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    if (kind === 'entity.parse.failed') safe = new HttpError(400, 'MALFORMED_JSON', 'Request body is not valid JSON.');
    if (kind === 'entity.too.large') safe = new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    if (kind === 'encoding.unsupported' || kind === 'charset.unsupported') safe = new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported request encoding.');
    if (safe.status >= 500) dependencies.logger.error({ requestId: res.locals.requestId, code: safe.code }, 'request_failed');
    res.status(safe.status).json({ error: { code: safe.code, message: safe.message, requestId: res.locals.requestId, ...(safe.details ? { details: safe.details } : {}) } });
  };
  app.use(errors);
  return app;
}
