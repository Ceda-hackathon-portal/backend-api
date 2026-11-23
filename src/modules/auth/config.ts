import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

interface SharedAuthConfig { google?: { clientId: string; clientSecret: string }; apiOrigin: string; frontendOrigin: string; key: string; secure: boolean; idleSeconds: number; absoluteSeconds: number }
export interface CognitoAuthConfig extends SharedAuthConfig { mode: 'cognito'; issuer: string; clientId: string; clientSecret?: string }
export interface LocalAccount { email: string; name: string; passwordHash: string }
export interface LocalAuthConfig extends SharedAuthConfig, LocalAccount { mode: 'local'; accounts?: readonly LocalAccount[] }
export interface GoogleAuthConfig extends SharedAuthConfig { mode: 'google'; google: { clientId: string; clientSecret: string } }
export type AuthConfig = CognitoAuthConfig | LocalAuthConfig | GoogleAuthConfig;

function isLoopbackHost(host: string) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  return normalized === 'localhost' || (family === 4 && normalized.startsWith('127.')) || (family === 6 && normalized === '::1');
}

/** Extra development sign-ins. An account carries no role: staff access comes only from programme grants. */
function localAccounts(path: string | undefined): LocalAccount[] {
  if (!path) return [];
  try {
    return z.array(z.strictObject({
      email: z.string().email().max(254).transform(value => value.toLowerCase()), name: z.string().min(1).max(100),
      passwordHash: z.string().regex(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/),
    })).max(30).parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch { throw new Error('Invalid authentication configuration'); }
}

function baseAuthConfig(env: NodeJS.ProcessEnv, idleSeconds: number, absoluteSeconds: number): AuthConfig | null {
  const mode = env.AUTH_MODE;
  if (mode === 'local') {
    if (env.NODE_ENV !== 'development' || !isLoopbackHost(env.HOST ?? '127.0.0.1') || (env.AUTH_ENABLED !== undefined && env.AUTH_ENABLED !== 'false')) throw new Error('Invalid authentication configuration');
    const result = z.object({
      AUTH_API_ORIGIN: z.string().url(), AUTH_FRONTEND_ORIGIN: z.string().url(), AUTH_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
      AUTH_LOCAL_EMAIL: z.string().email().max(254), AUTH_LOCAL_NAME: z.string().min(1).max(100).default('Local Developer'),
      AUTH_LOCAL_PASSWORD_HASH: z.string().regex(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/),
    }).safeParse(env);
    if (!result.success) throw new Error('Invalid authentication configuration');
    const v = result.data;
    const apiUrl = new URL(v.AUTH_API_ORIGIN); const frontendUrl = new URL(v.AUTH_FRONTEND_ORIGIN);
    const allowedOrigins = (env.ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim());
    if (apiUrl.origin !== v.AUTH_API_ORIGIN || frontendUrl.origin !== v.AUTH_FRONTEND_ORIGIN || apiUrl.protocol !== 'http:' || frontendUrl.protocol !== 'http:' || !isLoopbackHost(apiUrl.hostname) || !isLoopbackHost(frontendUrl.hostname) ||
      apiUrl.hostname !== frontendUrl.hostname || !allowedOrigins.includes(v.AUTH_FRONTEND_ORIGIN)) throw new Error('Invalid authentication origins');
    return { mode, accounts: localAccounts(env.AUTH_LOCAL_ACCOUNTS_FILE), email: v.AUTH_LOCAL_EMAIL.toLowerCase(), name: v.AUTH_LOCAL_NAME, passwordHash: v.AUTH_LOCAL_PASSWORD_HASH,
      apiOrigin: v.AUTH_API_ORIGIN, frontendOrigin: v.AUTH_FRONTEND_ORIGIN, key: v.AUTH_ENCRYPTION_KEY, secure: false, idleSeconds, absoluteSeconds };
  }
  if (mode !== undefined && mode !== 'cognito') throw new Error('Invalid authentication configuration');
  if (env.AUTH_ENABLED === undefined || env.AUTH_ENABLED === 'false') return null;
  if (env.AUTH_ENABLED !== 'true') throw new Error('Invalid authentication configuration');
  const result = z.object({
    COGNITO_ISSUER: z.string().regex(/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/),
    COGNITO_CLIENT_ID: z.string().min(1).max(128), COGNITO_CLIENT_SECRET: z.string().min(1).optional(),
    AUTH_API_ORIGIN: z.string().url(), AUTH_FRONTEND_ORIGIN: z.string().url(), AUTH_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  }).safeParse(env);
  if (!result.success) throw new Error('Invalid authentication configuration');
  const v = result.data;
  for (const origin of [v.AUTH_API_ORIGIN, v.AUTH_FRONTEND_ORIGIN]) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)))) throw new Error('Invalid authentication origins');
  }
  return { mode: 'cognito', issuer: v.COGNITO_ISSUER, clientId: v.COGNITO_CLIENT_ID, ...(v.COGNITO_CLIENT_SECRET ? { clientSecret: v.COGNITO_CLIENT_SECRET } : {}), apiOrigin: v.AUTH_API_ORIGIN, frontendOrigin: v.AUTH_FRONTEND_ORIGIN, key: v.AUTH_ENCRYPTION_KEY, secure: v.AUTH_API_ORIGIN.startsWith('https:'), idleSeconds, absoluteSeconds };
}


/** Google may supplement an existing provider, or run as the sole production provider. */
export function authConfig(env: NodeJS.ProcessEnv, idleSeconds: number, absoluteSeconds: number): AuthConfig | null {
  let google: GoogleAuthConfig['google'] | undefined;
  if (env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_SECRET) {
    const result = z.object({
      GOOGLE_CLIENT_ID: z.string().regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/),
      GOOGLE_CLIENT_SECRET: z.string().min(1).max(4096),
    }).safeParse(env);
    if (!result.success) throw new Error('Invalid Google authentication configuration');
    google = { clientId: result.data.GOOGLE_CLIENT_ID, clientSecret: result.data.GOOGLE_CLIENT_SECRET };
  }
  if (env.AUTH_MODE !== 'google') {
    const base = baseAuthConfig(env, idleSeconds, absoluteSeconds);
    return base && google ? { ...base, google } : base;
  }
  if (env.AUTH_ENABLED !== 'true' || !google) throw new Error('Invalid Google authentication configuration');
  const shared = z.object({
    AUTH_API_ORIGIN: z.url(), AUTH_FRONTEND_ORIGIN: z.url(), AUTH_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  }).safeParse(env);
  if (!shared.success) throw new Error('Invalid authentication configuration');
  const v = shared.data;
  for (const origin of [v.AUTH_API_ORIGIN, v.AUTH_FRONTEND_ORIGIN]) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && url.protocol === 'http:' && isLoopbackHost(url.hostname))))
      throw new Error('Invalid authentication origins');
  }
  if (!(env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).includes(v.AUTH_FRONTEND_ORIGIN))
    throw new Error('Invalid authentication origins');
  return { mode: 'google', google, apiOrigin: v.AUTH_API_ORIGIN, frontendOrigin: v.AUTH_FRONTEND_ORIGIN,
    key: v.AUTH_ENCRYPTION_KEY, secure: v.AUTH_API_ORIGIN.startsWith('https:'), idleSeconds, absoluteSeconds };
}
