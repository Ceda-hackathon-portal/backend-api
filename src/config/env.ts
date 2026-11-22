import { isIP } from 'node:net';
import { z } from 'zod';

const integer = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const csv = z.string().default('').transform(value => value.split(',').map(s => s.trim()).filter(Boolean));
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: integer(3001, 0, 65535),
  OFFICER_READ_API_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  DATABASE_URL: z.string().url().refine(value => {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && [...url.searchParams.keys()].length === 0;
  }, 'Use a PostgreSQL URL without query overrides'),
  DATABASE_SSL: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  DATABASE_CA_FILE: z.string().min(1).optional(),
  DATABASE_POOL_MAX: integer(5, 1, 50),
  DATABASE_CONNECT_TIMEOUT_MS: integer(2000, 100, 30000),
  DATABASE_QUERY_TIMEOUT_MS: integer(3000, 100, 60000),
  DATABASE_STATEMENT_TIMEOUT_MS: integer(2500, 100, 60000),
  DATABASE_LOCK_TIMEOUT_MS: integer(1000, 100, 30000),
  ALLOWED_ORIGINS: csv.refine(values => values.every(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value; } catch { return false; }
  }), 'Origins must be exact HTTP(S) origins, without paths or wildcards'),
  TRUST_PROXY: csv.refine(values => values.every(value => {
    const [address, bits, extra] = value.split('/');
    const family = isIP(address ?? '');
    return !extra && family !== 0 && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128)));
  }), 'Trusted proxies must be explicit IPs/CIDRs, never booleans or hop counts'),
  JSON_LIMIT_BYTES: integer(65536, 1024, 1048576),
  SHUTDOWN_TIMEOUT_MS: integer(10000, 1000, 60000),
  SESSION_IDLE_SECONDS: integer(1800, 60, 86400),
  SESSION_ABSOLUTE_SECONDS: integer(28800, 60, 604800),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug']).default('info'),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && !value.DATABASE_SSL) context.addIssue({ code: 'custom', path: ['DATABASE_SSL'], message: 'TLS required in production' });
  if (value.NODE_ENV === 'production' && value.ALLOWED_ORIGINS.some(origin => !origin.startsWith('https://'))) context.addIssue({ code: 'custom', path: ['ALLOWED_ORIGINS'], message: 'HTTPS required' });
  if (value.SESSION_IDLE_SECONDS > value.SESSION_ABSOLUTE_SECONDS) context.addIssue({ code: 'custom', path: ['SESSION_IDLE_SECONDS'], message: 'Idle must not exceed absolute lifetime' });
});

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse(env);
  // Never expose rejected values (especially connection credentials) in startup diagnostics.
  if (!result.success) throw new Error(`Invalid configuration fields: ${[...new Set(result.error.issues.map(issue => issue.path.join('.')))].join(', ')}`);
  return result.data;
}
