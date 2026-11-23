import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/shared/logging.js';
import { authConfig, type AuthConfig } from '../src/modules/auth/config.js';
import { authRoutes } from '../src/modules/auth/routes.js';
import type { SessionStore, SessionView } from '../src/modules/auth/store.js';
import type { LoginAttempt } from '../src/modules/auth/provider.js';
import { GOOGLE_ISSUER } from '../src/modules/auth/google.js';

const key = randomBytes(32).toString('hex');
const config: AuthConfig = { mode: 'google', google: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'synthetic-test-only' },
  apiOrigin: 'http://localhost:3001', frontendOrigin: 'http://localhost:5189', key, secure: false, idleSeconds: 1800, absoluteSeconds: 28800 };

test('Google-only configuration requires paired server credentials, approved origins and production HTTPS', () => {
  const env = { NODE_ENV: 'development', AUTH_MODE: 'google', AUTH_ENABLED: 'true', AUTH_ENCRYPTION_KEY: key,
    AUTH_API_ORIGIN: config.apiOrigin, AUTH_FRONTEND_ORIGIN: config.frontendOrigin, ALLOWED_ORIGINS: config.frontendOrigin,
    GOOGLE_CLIENT_ID: config.google!.clientId, GOOGLE_CLIENT_SECRET: config.google!.clientSecret };
  assert.equal(authConfig(env, 1800, 28800)?.mode, 'google');
  for (const change of [{ GOOGLE_CLIENT_ID: '' }, { GOOGLE_CLIENT_SECRET: '' }, { GOOGLE_CLIENT_ID: 'not-google' },
    { AUTH_ENABLED: 'false' }, { AUTH_API_ORIGIN: 'http://evil.example' }, { ALLOWED_ORIGINS: '' }, { NODE_ENV: 'production' }])
    assert.throws(() => authConfig({ ...env, ...change }, 1800, 28800));
  assert.equal(authConfig({ ...env, NODE_ENV: 'production', AUTH_API_ORIGIN: 'https://ceda.example',
    AUTH_FRONTEND_ORIGIN: 'https://ceda.example', ALLOWED_ORIGINS: 'https://ceda.example' }, 1800, 28800)?.secure, true);
});

test('Google HTTP flow enforces CSRF, single-use browser binding, cancellation, session rotation and explicit linking', async () => {
  const attempts = new Map<string, string>(), sessions = new Map<string, SessionView>();
  let current: LoginAttempt;
  let completeCount = 0, linkCount = 0;
  const store: SessionStore = {
    async saveAttempt(hash, payload) { attempts.set(hash, payload); },
    async consumeAttempt(hash) { const row = attempts.get(hash) ?? null; attempts.delete(hash); return row; },
    async create(identity, hash, previous) {
      if (previous) sessions.delete(previous);
      sessions.set(hash, { id: 'session-' + hash, userId: 'applicant', name: identity.name, email: identity.email, expiresAt: new Date(Date.now() + 1800000) });
    },
    async find(hash) { return sessions.get(hash) ?? null; },
    async revoke(hash) { sessions.delete(hash); },
    async linkGoogle(_identity, hash) { assert.ok(sessions.has(hash)); linkCount++; },
  };
  const provider = {
    async begin(attempt: LoginAttempt) { current = attempt; return 'https://accounts.google.com/o/oauth2/v2/auth'; },
    async complete(url: URL, attempt: LoginAttempt) {
      completeCount++;
      assert.equal(url.origin + url.pathname, config.apiOrigin + '/api/v1/auth/google/callback');
      assert.equal(attempt.state, current.state);
      return { issuer: GOOGLE_ISSUER, subject: 'synthetic-google-subject', email: 'fictional@example.test', name: 'Fictional Applicant' };
    },
  };
  const auth = authRoutes(config, store, undefined, provider);
  const appConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://fixture@localhost/test', ALLOWED_ORIGINS: config.frontendOrigin, LOG_LEVEL: 'silent' });
  const api = Router(); api.use('/auth', auth.router);
  const server = createServer(createApp(appConfig, { logger: createLogger(appConfig), database: { async check() {}, async close() {} }, apiRouter: api }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/auth`;
  const cookies = (r: Response) => r.headers.getSetCookie().map(value => value.split(';')[0]!).join('; ');
  try {
    assert.equal((await (await fetch(base + '/providers')).json()).data.google, true);
    assert.equal((await fetch(base + '/google', { method: 'POST', headers: { Origin: config.frontendOrigin } })).status, 403);
    async function begin(session = '', link = false) {
      const bootstrap = await fetch(base + '/csrf', { headers: { Cookie: session } });
      const token = (await bootstrap.json()).data.csrfToken;
      const response = await fetch(base + '/google', { method: 'POST', headers: { Origin: config.frontendOrigin,
        Cookie: session || cookies(bootstrap), 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ link }) });
      return { response, cookie: cookies(response), state: current?.state };
    }
    assert.equal((await begin('', true)).response.status, 401);
    let started = await begin();
    assert.equal(started.response.status, 200);
    assert.ok(started.response.headers.getSetCookie().every(value => value.includes('HttpOnly') && value.includes('SameSite=Lax')));
    const callback = (query: string, cookie = started.cookie) => fetch(base + '/google/callback?' + query,
      { redirect: 'manual', headers: { Cookie: cookie } });
    assert.match((await callback('code=test&state=' + started.state, '')).headers.get('location')!, /error=google/);
    assert.equal(completeCount, 0);
    assert.match((await callback('code=test&state=forged')).headers.get('location')!, /error=google/);
    assert.match((await callback('code=test&state=' + started.state)).headers.get('location')!, /error=google/);
    assert.equal(completeCount, 0, 'tampered callback must consume the browser attempt');
    started = await begin();
    assert.match((await callback('error=access_denied&state=' + started.state)).headers.get('location')!, /reason=cancelled/);
    started = await begin();
    const success = await callback('code=test&state=' + started.state + '&scope=openid%20email&authuser=0&prompt=select_account');
    assert.equal(success.headers.get('location'), config.frontendOrigin + '/login?signedIn=google');
    const session = success.headers.getSetCookie().find(value => value.startsWith('dev_ceda_session='))!.split(';')[0]!;
    assert.equal((await callback('code=test&state=' + started.state)).headers.get('location')?.includes('error=google'), true);
    const restored = await fetch(base + '/session', { headers: { Cookie: session } });
    const body = (await restored.json()).data;
    assert.deepEqual(body.grants, []);
    assert.deepEqual(body.user.roles, []);
    assert.equal(body.user.role, null);
    started = await begin(session, true);
    assert.equal(started.response.status, 200);
    const linked = await callback('code=test&state=' + started.state, started.cookie + '; ' + session);
    assert.equal(linked.headers.get('location'), config.frontendOrigin + '/login?signedIn=google');
    assert.equal(linkCount, 1);
    assert.equal((await fetch(base + '/session', { headers: { Cookie: session } })).status, 401, 'linking rotates the previous session');
    const newest = linked.headers.getSetCookie().find(value => value.startsWith('dev_ceda_session='))!.split(';')[0]!;
    started = await begin(newest, true);
    assert.match((await callback('code=test&state=' + started.state)).headers.get('location')!, /error=google/);
    assert.equal(linkCount, 1, 'a linking callback needs the same authenticated browser session');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
