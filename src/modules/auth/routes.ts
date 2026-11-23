import { Router, type Request, type Response } from 'express';
import { googleAuthRoutes } from './google-routes.js';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../../shared/errors.js';
import type { SessionVerifier } from '../../shared/authorization.js';
import type { AuthConfig, LocalAuthConfig } from './config.js';
import type { IdentityProvider, VerifiedIdentity } from './provider.js';
import type { SessionStore } from './store.js';
import { token, hash, csrf, validCsrf, seal, unseal, verifyLocalPassword } from './crypto.js';
import { validateBody } from '../../shared/validation.js';

function cookie(header: string | undefined, name: string) {
  const found = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  if (found.length !== 1) return null;
  const value = found[0]!.slice(name.length + 1); return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function authRoutes(config: AuthConfig, store: SessionStore, provider?: IdentityProvider, google?: IdentityProvider) {
  const router = Router(); const prefix = config.secure ? '__Host-' : 'dev_';
  const names = { session: prefix + 'ceda_session', csrf: prefix + 'ceda_csrf', attempt: prefix + 'ceda_oidc' };
  const options = { httpOnly: true, secure: config.secure, sameSite: 'lax' as const, path: '/' };
  const sessionToken = (req: Request) => cookie(req.headers.cookie, names.session);
  function requireCsrf(req: Request) {
    const origin = req.headers.origin;
    const raw = sessionToken(req) ?? cookie(req.headers.cookie, names.csrf);
    if (![config.frontendOrigin, config.apiOrigin].includes(origin ?? '') || !raw || !validCsrf(config.key, raw, String(req.headers['x-csrf-token'] ?? ''))) throw new HttpError(403, 'CSRF_FAILED', 'Request verification failed.');
  }
  // Bounded per-process safety limiter; not a distributed service or permission cache.
  const attempts = new Map<string, { count: number; until: number }>();
  router.use((req, _res, next) => {
    if (!['/login', '/local-login', '/callback', '/google', '/google/callback'].includes(req.path)) { next(); return; }
    const now = Date.now(); for (const [key, row] of attempts) if (row.until < now) attempts.delete(key);
    const key = req.ip ?? 'unknown'; const row = attempts.get(key) ?? { count: 0, until: now + 60000 };
    if ((attempts.size >= 10000 && !attempts.has(key)) || ++row.count > 20) throw new HttpError(429, 'RATE_LIMITED', 'Try again later.');
    attempts.set(key, row); next();
  });
  router.get('/csrf', (req, res) => {
    let raw = sessionToken(req) ?? cookie(req.headers.cookie, names.csrf);
    if (!raw) { raw = token(); res.cookie(names.csrf, raw, { ...options, maxAge: 600000 }); }
    res.json({ data: { csrfToken: csrf(config.key, raw) } });
  });
  async function startSession(req: Request, res: Response, identity: VerifiedIdentity) {
    const raw = token(); const previous = sessionToken(req);
    await store.create(identity, hash(raw), previous ? hash(previous) : null, config.idleSeconds, config.absoluteSeconds);
    res.cookie(names.session, raw, { ...options, maxAge: config.absoluteSeconds * 1000 });
    res.clearCookie(names.csrf, options);
  }
  router.use(googleAuthRoutes({ config, store, ...(google ? { google } : {}), requireCsrf, readCookie: cookie, startSession }));
  if (config.mode === 'cognito' && provider) {
    router.post('/login', validateBody(z.strictObject({}).optional()), async (req, res) => {
      requireCsrf(req);
      const attempt = { state: token(), nonce: token(), verifier: token() }; const browser = token();
      let redirect: string;
      try { redirect = await provider.begin(attempt); } catch { throw new HttpError(503, 'IDENTITY_UNAVAILABLE', 'Sign-in is unavailable.'); }
      await store.saveAttempt(hash(browser), seal(config.key, attempt), new Date(Date.now() + 300000));
      res.cookie(names.attempt, browser, { ...options, maxAge: 300000 });
      res.json({ data: { authorizationUrl: redirect } });
    });
    router.get('/callback', async (req, res) => {
      res.setHeader('Referrer-Policy', 'no-referrer');
      const browser = cookie(req.headers.cookie, names.attempt);
      res.clearCookie(names.attempt, options);
      if (!browser) throw new HttpError(401, 'LOGIN_FAILED', 'Sign-in could not be verified.');
      const payload = await store.consumeAttempt(hash(browser));
      if (!payload) throw new HttpError(401, 'LOGIN_FAILED', 'Sign-in could not be verified.');
      try {
        const attempt = z.object({ state: z.string(), nonce: z.string(), verifier: z.string() }).parse(unseal(config.key, payload));
        const query = z.strictObject({ code: z.string().min(1).max(4096), state: z.string().min(1).max(256), iss: z.string().optional() }).parse(req.query);
        if (query.state !== attempt.state) throw new Error('State mismatch');
        const callback = new URL(config.apiOrigin + '/api/v1/auth/callback');
        for (const [key, value] of Object.entries(query)) if (value !== undefined) callback.searchParams.set(key, value);
        const identity = await provider.complete(callback, attempt);
        await startSession(req, res, identity);
        res.redirect(303, config.frontendOrigin + '/workspace');
      } catch { throw new HttpError(401, 'LOGIN_FAILED', 'Sign-in could not be verified.'); }
    });
  }
  if (config.mode === 'local') {
    const localConfig: LocalAuthConfig = config;
    router.post('/local-login', validateBody(z.strictObject({ email: z.string().email().max(254), password: z.string().min(1).max(1024) })), async (req, res) => {
      requireCsrf(req);
      const email = String(req.body.email).toLowerCase();
      // An unknown email still costs one password check, so response time does not reveal accounts.
      const account = localConfig.accounts?.find(item => item.email === email) ?? localConfig;
      const passwordValid = verifyLocalPassword(String(req.body.password), account.passwordHash);
      const emailBytes = Buffer.from(email); const expectedEmailBytes = Buffer.from(account.email);
      const emailValid = emailBytes.length === expectedEmailBytes.length && timingSafeEqual(emailBytes, expectedEmailBytes);
      if (!passwordValid || !emailValid) throw new HttpError(401, 'LOGIN_FAILED', 'Sign-in could not be verified.');
      const identity = { issuer: 'urn:ceda:local-development', subject: account.email, email: account.email, name: account.name };
      await startSession(req, res, identity);
      res.json({ data: { authenticated: true } });
    });
  }
  router.get('/session', async (req, res) => {
    const raw = sessionToken(req); const session = raw ? await store.find(hash(raw), config.idleSeconds) : null;
    if (!session) { res.clearCookie(names.session, options); throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.'); }
    // Grant persistence/adapters are separate. New identities gain NO staff role.
    res.json({ data: { user: { id: session.userId, name: session.name, email: session.email, roles: [], role: null }, grants: [], expiresAt: session.expiresAt.toISOString() } });
  });
  router.post('/logout', validateBody(z.strictObject({}).optional()), async (req, res) => {
    requireCsrf(req); const raw = sessionToken(req);
    if (raw) await store.revoke(hash(raw));
    res.clearCookie(names.session, options); res.clearCookie(names.csrf, options); res.clearCookie(names.attempt, options); res.clearCookie(prefix + 'ceda_google', options); res.sendStatus(204);
  });
  const verifier: SessionVerifier = { async verify(header) {
    const raw = cookie(header, names.session); const session = raw ? await store.find(hash(raw), config.idleSeconds) : null;
    return session ? { userId: session.userId, sessionId: session.id, authnLevel: config.mode === 'local' ? 'local-development' : 'oidc' } : null;
  } };
  return { router, verifier, requireCsrf, startSession };
}