import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../../shared/errors.js';
import { validateBody } from '../../shared/validation.js';
import type { AuthConfig } from './config.js';
import type { IdentityProvider, VerifiedIdentity } from './provider.js';
import type { SessionStore } from './store.js';
import { token, hash, seal, unseal } from './crypto.js';
import { GOOGLE_ISSUER } from './google.js';

interface GoogleRoutesOptions {
  config: AuthConfig;
  store: SessionStore;
  google?: IdentityProvider;
  requireCsrf: (req: Request) => void;
  readCookie: (header: string | undefined, name: string) => string | null;
  startSession: (req: Request, res: Response, identity: VerifiedIdentity) => Promise<void>;
}

export function googleAuthRoutes({ config, store, google, requireCsrf, readCookie, startSession }: GoogleRoutesOptions) {
  const router = Router();
  const prefix = config.secure ? '__Host-' : 'dev_';
  const attemptName = prefix + 'ceda_google';
  const options = { httpOnly: true, secure: config.secure, sameSite: 'lax' as const, path: '/' };
  const sessionHash = (req: Request) => {
    const raw = readCookie(req.headers.cookie, prefix + 'ceda_session');
    return raw ? hash(raw) : null;
  };
  router.get('/providers', (_req, res) => res.json({ data: {
    google: Boolean(google), cognito: config.mode === 'cognito', password: config.mode === 'local',
  } }));

  router.post('/google', validateBody(z.strictObject({ link: z.boolean().optional() }).optional()), async (req, res) => {
    requireCsrf(req);
    if (!google) throw new HttpError(503, 'GOOGLE_UNAVAILABLE', 'Google sign-in is currently unavailable.');
    const previous = sessionHash(req);
    const linking = req.body?.link === true;
    const session = linking && previous ? await store.find(previous, config.idleSeconds) : null;
    if (linking && !session) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in before connecting Google.');
    if (linking && !store.linkGoogle) throw new HttpError(503, 'GOOGLE_UNAVAILABLE', 'Google account linking is currently unavailable.');
    const attempt = { state: token(), nonce: token(), verifier: token() };
    let authorizationUrl: string;
    try { authorizationUrl = await google.begin(attempt); }
    catch { throw new HttpError(503, 'IDENTITY_UNAVAILABLE', 'Google sign-in is currently unavailable.'); }
    const browser = token();
    await store.saveAttempt(hash(browser), seal(config.key, {
      ...attempt, ...(session ? { userId: session.userId, sessionId: session.id } : {}),
    }), new Date(Date.now() + 300000));
    res.cookie(attemptName, browser, { ...options, maxAge: 300000 });
    res.json({ data: { authorizationUrl } });
  });

  router.get('/google/callback', async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    const fail = (reason = 'failed') => res.redirect(303, `${config.frontendOrigin}/login?error=google&reason=${reason}`);
    const browser = readCookie(req.headers.cookie, attemptName);
    res.clearCookie(attemptName, options);
    if (!browser || !google) return fail();
    try {
      const sealed = await store.consumeAttempt(hash(browser));
      if (!sealed) return fail();
      const attempt = z.object({
        state: z.string().length(43), nonce: z.string().length(43), verifier: z.string().length(43),
        userId: z.string().optional(), sessionId: z.string().optional(),
      }).parse(unseal(config.key, sealed));
      const query = z.object({
        state: z.string().min(1).max(256), code: z.string().min(1).max(4096).optional(),
        error: z.string().max(256).optional(),
      }).passthrough().parse(req.query);
      if (query.state !== attempt.state) return fail();
      if (query.error) return fail(query.error === 'access_denied' ? 'cancelled' : 'failed');
      if (!query.code) return fail();
      const callback = new URL(config.apiOrigin + '/api/v1/auth/google/callback');
      for (const [name, value] of Object.entries(query)) if (typeof value === 'string') callback.searchParams.set(name, value);
      const identity = await google.complete(callback, attempt);
      if (identity.issuer !== GOOGLE_ISSUER) return fail();
      if (attempt.userId) {
        const currentHash = sessionHash(req);
        const session = currentHash ? await store.find(currentHash, config.idleSeconds) : null;
        if (!session || session.userId !== attempt.userId || session.id !== attempt.sessionId || !store.linkGoogle) return fail();
        await store.linkGoogle(identity, currentHash!);
      }
      await startSession(req, res, identity);
      return res.redirect(303, `${config.frontendOrigin}/login?signedIn=google`);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'ACCOUNT_LINK_REQUIRED') return fail('link-required');
      if (error instanceof HttpError && error.code === 'GOOGLE_EMAIL_MISMATCH') return fail('email-mismatch');
      return fail();
    }
  });
  return router;
}
