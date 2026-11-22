import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/shared/logging.js';
import { authConfig, type AuthConfig } from '../src/modules/auth/config.js';
import { authRoutes } from '../src/modules/auth/routes.js';
import type { SessionStore, SessionView } from '../src/modules/auth/store.js';
import { csrf, validCsrf, token, seal, unseal, localPasswordHash, verifyLocalPassword } from '../src/modules/auth/crypto.js';
import type { LoginAttempt } from '../src/modules/auth/provider.js';

const key = randomBytes(32).toString('hex');
const config: AuthConfig = { mode: 'cognito', issuer: 'https://cognito-idp.us-east-1.amazonaws.com/test', clientId: 'fixture', apiOrigin: 'https://api.example.test', frontendOrigin: 'https://frontend.example.test', key, secure: true, idleSeconds: 1800, absoluteSeconds: 28800 };
test('auth config disabled by default, requires key and HTTPS outside loopback development', () => {
  assert.equal(authConfig({}, 1800, 28800), null);
  assert.throws(() => authConfig({ AUTH_ENABLED: 'true' }, 1800, 28800));
});
test('local auth is development-only, loopback-only and requires explicit local mode plus a password hash', () => {
  const passwordHash = localPasswordHash('development-only credential with sufficient length');
  const base = { NODE_ENV: 'development', HOST: '127.0.0.1', AUTH_MODE: 'local', AUTH_API_ORIGIN: 'http://localhost:3001', AUTH_FRONTEND_ORIGIN: 'http://localhost:5173', ALLOWED_ORIGINS: 'http://localhost:5173', AUTH_ENCRYPTION_KEY: key, AUTH_LOCAL_EMAIL: 'local@example.test', AUTH_LOCAL_PASSWORD_HASH: passwordHash };
  assert.equal(authConfig(base, 1800, 28800)?.mode, 'local');
  assert.throws(() => authConfig({ ...base, NODE_ENV: 'production' }, 1800, 28800));
  assert.throws(() => authConfig({ ...base, NODE_ENV: 'test' }, 1800, 28800));
  assert.throws(() => authConfig({ ...base, HOST: '0.0.0.0' }, 1800, 28800));
  assert.throws(() => authConfig({ ...base, AUTH_ENABLED: 'true' }, 1800, 28800));
  assert.throws(() => authConfig({ ...base, AUTH_ENABLED: 'invalid' }, 1800, 28800));
  assert.throws(() => authConfig({ ...base, AUTH_API_ORIGIN: 'http://192.168.1.5:3001' }, 1800, 28800));
  assert.equal(verifyLocalPassword('development-only credential with sufficient length', passwordHash), true);
  assert.equal(verifyLocalPassword('wrong credential with sufficient length', passwordHash), false);
});
test('local login reuses CSRF, opaque session and logout with no role or grant elevation', async () => {
  const password = 'development-only credential with sufficient length'; const email = 'local@example.test';
  const local = authConfig({ NODE_ENV: 'development', HOST: '127.0.0.1', AUTH_MODE: 'local', AUTH_API_ORIGIN: 'http://localhost:3001', AUTH_FRONTEND_ORIGIN: 'http://localhost:5173', ALLOWED_ORIGINS: 'http://localhost:5173', AUTH_ENCRYPTION_KEY: key, AUTH_LOCAL_EMAIL: email, AUTH_LOCAL_PASSWORD_HASH: localPasswordHash(password) }, 1800, 28800)!;
  const sessions = new Map<string, SessionView>(); let identityIssuer = '';
  const store: SessionStore = {
    async saveAttempt() {}, async consumeAttempt() { return null; },
    async create(identity, h, old) { identityIssuer = identity.issuer; if (old) sessions.delete(old); sessions.set(h, { id: 'session', userId: 'local-user', name: identity.name, email: identity.email, expiresAt: new Date(Date.now() + 1800000) }); },
    async find(h) { return sessions.get(h) ?? null; }, async revoke(h) { sessions.delete(h); },
  };
  const auth = authRoutes(local, store);
  const c = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://fixture@localhost/test', ALLOWED_ORIGINS: local.frontendOrigin, LOG_LEVEL: 'silent' });
  const router = Router(); router.use('/auth', auth.router);
  const server = createServer(createApp(c, { logger: createLogger(c), database: { async check() {}, async close() {} }, apiRouter: router }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/auth`;
  const cookies = (r: Response) => r.headers.getSetCookie().map(v => v.split(';')[0]!).join('; ');
  try {
    const bootstrap = await fetch(base + '/csrf'); const anonymous = cookies(bootstrap); const anti = (await bootstrap.json()).data.csrfToken;
    const post = (body: object, csrfToken = anti, origin = local.frontendOrigin, cookie = anonymous) => fetch(base + '/local-login', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ email, password: 'incorrect credential with enough length' })).status, 401);
    assert.equal((await post({ email, password }, '', local.frontendOrigin)).status, 403);
    assert.equal((await post({ email, password }, anti, 'http://evil.example.test')).status, 403);
    assert.equal((await post({ email, password })).status, 200);
    assert.equal(identityIssuer, 'urn:ceda:local-development');
    const success = await post({ email, password });
    assert.equal(success.status, 200);
    const sessionCookie = success.headers.getSetCookie().find(v => v.startsWith('dev_ceda_session='))!.split(';')[0]!;
    assert.ok(success.headers.getSetCookie().every(v => v.includes('HttpOnly') && v.includes('SameSite=Lax') && !v.includes('Secure')));
    const restored = await fetch(base + '/session', { headers: { Cookie: sessionCookie } });
    assert.equal(restored.status, 200); const session = (await restored.json()).data; assert.deepEqual(session.user.roles, []); assert.equal(session.user.role, null); assert.deepEqual(session.grants, []); assert.equal(identityIssuer, 'urn:ceda:local-development');
    const csrfResponse = await fetch(base + '/csrf', { headers: { Cookie: sessionCookie } }); const sessionCsrf = (await csrfResponse.json()).data.csrfToken;
    assert.equal((await fetch(base + '/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: local.frontendOrigin, 'X-CSRF-Token': sessionCsrf } })).status, 204);
    assert.equal((await fetch(base + '/session', { headers: { Cookie: sessionCookie } })).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('encrypted attempt tampering, cookie binding and CSRF expiry reject', () => {
  const encrypted = seal(key, { verifier: 'secret' });
  assert.deepEqual(unseal(key, encrypted), { verifier: 'secret' });
  const tampered = Buffer.from(encrypted, 'base64url'); tampered[0] = tampered[0]! ^ 1;
  assert.throws(() => unseal(key, tampered.toString('base64url')));
  const raw = token(); const now = Date.now(); const value = csrf(key, raw, now);
  assert.equal(validCsrf(key, raw, value, now), true);
  assert.equal(validCsrf(key, token(), value, now), false);
  assert.equal(validCsrf(key, raw, value, now + 601000), false);
});
test('login requires CSRF; callback is browser-bound/single-use; session and logout replay', async () => {
  const attempts = new Map<string, string>(); const sessions = new Map<string, SessionView>();
  let current: LoginAttempt | undefined;
  let providerCalls = 0; let identityIssuer = '';
  const store: SessionStore = {
    async saveAttempt(h, payload) { attempts.set(h, payload); },
    async consumeAttempt(h) { const payload = attempts.get(h) ?? null; attempts.delete(h); return payload; },
    async create(identity, h, old) { identityIssuer = identity.issuer; if (old) sessions.delete(old); sessions.set(h, { id: 'session', userId: 'user', name: 'Applicant', email: 'fictional@example.test', expiresAt: new Date(Date.now() + 1800000) }); },
    async find(h) { return sessions.get(h) ?? null; }, async revoke(h) { sessions.delete(h); },
  };
  const auth = authRoutes(config, store, { async begin(attempt) { current = attempt; return 'https://id.example.test/authorize'; }, async complete(_url, attempt) { providerCalls++; assert.equal(attempt.state, current?.state); return { issuer: config.issuer, subject: 'subject', email: 'fictional@example.test', name: 'Applicant' }; } });
  const c = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://fixture@localhost/test', ALLOWED_ORIGINS: config.frontendOrigin, LOG_LEVEL: 'silent' });
  const router = Router(); router.use('/auth', auth.router);
  const server = createServer(createApp(c, { logger: createLogger(c), database: { async check() {}, async close() {} }, apiRouter: router }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/auth`;
  const cookies = (r: Response) => r.headers.getSetCookie().map(v => v.split(';')[0]!).join('; ');
  try {
    assert.equal((await fetch(base + '/login', { method: 'POST', headers: { Origin: config.frontendOrigin } })).status, 403);
    const bootstrap = await fetch(base + '/csrf'); const anonymous = cookies(bootstrap); const anti = (await bootstrap.json()).data.csrfToken;
    const login = await fetch(base + '/login', { method: 'POST', headers: { Origin: config.frontendOrigin, Cookie: anonymous, 'X-CSRF-Token': anti } });
    assert.equal(login.status, 200); const browser = cookies(login);
    assert.ok(login.headers.getSetCookie().every(value => value.includes('HttpOnly') && value.includes('Secure') && value.includes('SameSite=Lax')));
    assert.equal((await fetch(base + `/callback?code=example&state=${current!.state}`, { redirect: 'manual' })).status, 401);
    assert.equal(providerCalls, 0);
    const callback = await fetch(base + `/callback?code=example&state=${current!.state}`, { redirect: 'manual', headers: { Cookie: browser } });
    assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), config.frontendOrigin + '/workspace');
    const sessionCookie = callback.headers.getSetCookie().find(v => v.startsWith('__Host-ceda_session='))!.split(';')[0]!;
    assert.equal((await fetch(base + `/callback?code=example&state=${current!.state}`, { redirect: 'manual', headers: { Cookie: browser } })).status, 401);
    const restored = await fetch(base + '/session', { headers: { Cookie: sessionCookie } });
    assert.equal(restored.status, 200); assert.equal(restored.headers.get('cache-control'), 'no-store'); const session = (await restored.json()).data; assert.deepEqual(session.user.roles, []); assert.equal(session.user.role, null); assert.deepEqual(session.grants, []); assert.equal(identityIssuer, config.issuer);
    const csrfResponse = await fetch(base + '/csrf', { headers: { Cookie: sessionCookie } }); const sessionCsrf = (await csrfResponse.json()).data.csrfToken;
    assert.equal((await fetch(base + '/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: config.frontendOrigin, 'X-CSRF-Token': sessionCsrf } })).status, 204);
    assert.equal((await fetch(base + '/session', { headers: { Cookie: sessionCookie } })).status, 401);
    assert.equal(await auth.verifier.verify(sessionCookie), null);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
