import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/shared/logging.js';
import { requireAccess, type AuthorizationPolicy, type SessionVerifier } from '../src/shared/authorization.js';
import { validateBody } from '../src/shared/validation.js';
import { databaseOptions } from '../src/infrastructure/database.js';
import { closeResources } from '../src/shared/shutdown.js';

const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:fictional@127.0.0.1:1/test', ALLOWED_ORIGINS: 'http://localhost:5173', LOG_LEVEL: 'silent' };
const config = loadConfig(env);

test('shutdown drains HTTP before closing the pool and enforces a deadline', async () => {
  let closed = false;
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  let responseFinished = false;
  const server = createServer((_req, res) => {
    requestStarted();
    res.once('finish', () => { responseFinished = true; });
    setTimeout(() => res.end('ok'), 30);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`).then(result => result.text());
  await started;
  await closeResources(server, { async check() {}, async close() { assert.equal(server.listening, false); assert.equal(responseFinished, true); closed = true; } }, 1000);
  assert.equal(await response, 'ok');
  assert.equal(closed, true);
  const stalled = createServer();
  await new Promise<void>(resolve => stalled.listen(0, '127.0.0.1', resolve));
  await assert.rejects(closeResources(stalled, { async check() {}, async close() { await new Promise(() => {}); } }, 20), /deadline exceeded/);
});
async function fixture(options: { unavailable?: boolean; draining?: boolean; router?: ReturnType<typeof Router> } = {}) {
  const app = createApp(config, {
    database: { async check() { if (options.unavailable) throw new Error('SECRET_DATABASE_URL'); }, async close() {} },
    logger: createLogger(config),
    isDraining: () => options.draining ?? false,
    ...(options.router ? { apiRouter: options.router } : {}),
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); },
  };
}

test('configuration rejects unsafe TLS overrides and secret-free diagnostics', () => {
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: 'postgresql://secret@localhost/test?sslmode=no-verify' }), error => error instanceof Error && !error.message.includes('secret') && error.message.includes('DATABASE_URL'));
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }), /DATABASE_SSL/);
  assert.throws(() => loadConfig({ ...env, DATABASE_SSL: 'yes' }), /DATABASE_SSL/);
  assert.throws(() => loadConfig({ ...env, TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  assert.throws(() => loadConfig({ ...env, ALLOWED_ORIGINS: '*' }), /ALLOWED_ORIGINS/);
  assert.throws(() => loadConfig({ ...env, SESSION_IDLE_SECONDS: '3600', SESSION_ABSOLUTE_SECONDS: '1800' }), /SESSION_IDLE_SECONDS/);
  const tls = databaseOptions(loadConfig({ ...env, DATABASE_SSL: 'true' })).ssl;
  assert.ok(typeof tls === 'object' && tls.rejectUnauthorized === true);
  assert.equal(databaseOptions(config).max, 5);
});

test('health and 404 responses have no-store, generated IDs and security headers', async () => {
  const f = await fixture();
  try {
    for (const [path, status] of [['/health/live', 200], ['/health/ready', 200], ['/api/v1/applications', 404]] as const) {
      const result = await fetch(f.url + path, { headers: { 'X-Request-ID': 'untrusted' } });
      assert.equal(result.status, status);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.match(result.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
      assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(result.headers.get('x-powered-by'), null);
      if (status === 404) {
        const body = await result.json();
        assert.equal(body.error.requestId, result.headers.get('x-request-id'));
      }
    }
  } finally { await f.close(); }
});

test('readiness fails closed on database outage and draining while liveness remains available', async () => {
  for (const options of [{ unavailable: true }, { draining: true }]) {
    const f = await fixture(options);
    try {
      const response = await fetch(f.url + '/health/ready');
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(!(await response.text()).includes('SECRET_DATABASE_URL'));
      assert.equal((await fetch(f.url + '/health/live')).status, 200);
    } finally { await f.close(); }
  }
});

test('credentialed CORS permits only exact origins and bounded preflight methods/headers', async () => {
  const f = await fixture();
  try {
    const allowed = await fetch(f.url + '/health/live', { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
    const denied = await fetch(f.url + '/health/live', { headers: { Origin: 'http://localhost:5173.evil.test' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const preflight = await fetch(f.url + '/api/v1/example', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' } });
    assert.equal(preflight.status, 204);
    assert.equal((await fetch(f.url + '/', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'TRACE' } })).status, 403);
  } finally { await f.close(); }
});

test('body parsing is bounded and errors do not echo private payloads', async () => {
  const router = Router();
  router.post('/example', validateBody(z.strictObject({ title: z.string().max(120) })), (_req, res) => { res.json({ data: { accepted: true } }); });
  const f = await fixture({ router });
  try {
    const send = (body: string, contentType = 'application/json') => fetch(f.url + '/api/v1/example', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    assert.equal((await send('{PRIVATE')).status, 400);
    assert.equal((await send('PRIVATE', 'text/plain')).status, 415);
    assert.equal((await send(JSON.stringify({ title: 'x'.repeat(70000) }))).status, 413);
    const unknown = await send(JSON.stringify({ title: 'ok', ownerId: 'PRIVATE_OWNER' }));
    assert.equal(unknown.status, 422);
    assert.ok(!(await unknown.text()).includes('PRIVATE_OWNER'));
    assert.equal((await send(JSON.stringify({ title: 'valid' }))).status, 200);
  } finally { await f.close(); }
});

test('unhandled async errors are sanitized by the common error envelope', async () => {
  const router = Router();
  router.get('/failure', async () => { throw new Error('SECRET_PASSWORD'); });
  const f = await fixture({ router });
  try {
    const response = await fetch(f.url + '/api/v1/failure');
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('SECRET_PASSWORD'));
  } finally { await f.close(); }
});

test('authorization defaults deny and adapters are rechecked on every request', async () => {
  const router = Router();
  let valid = true;
  let permitted = true;
  let checks = 0;
  const sessions: SessionVerifier = { async verify() { checks++; return valid ? { userId: 'fixture-user', sessionId: 'fixture-session', authnLevel: 'fixture' } : null; } };
  const policy: AuthorizationPolicy = { async allows() { return permitted; } };
  router.get('/default-deny', requireAccess({ permission: 'fixture.read' }), (_req, res) => { res.json({ data: 'unreachable' }); });
  router.get('/guarded', requireAccess({ permission: 'fixture.read', programmeId: 'fixture-programme' }, sessions, policy), (_req, res) => { res.json({ data: 'fictional' }); });
  const f = await fixture({ router });
  try {
    assert.equal((await fetch(f.url + '/api/v1/default-deny')).status, 401);
    assert.equal((await fetch(f.url + '/api/v1/guarded')).status, 200);
    permitted = false;
    assert.equal((await fetch(f.url + '/api/v1/guarded')).status, 403);
    valid = false;
    assert.equal((await fetch(f.url + '/api/v1/guarded')).status, 401);
    assert.equal(checks, 3);
  } finally { await f.close(); }
});
