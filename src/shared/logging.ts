import { pino } from 'pino';
import type { Config } from '../config/env.js';

export function createLogger(config: Pick<Config, 'LOG_LEVEL'>) {
  return pino({
    level: config.LOG_LEVEL,
    base: null,
    redact: { paths: ['password', 'token', 'cookie', 'authorization', 'databaseUrl', 'req.headers', 'body', 'url', 'err'], censor: '[REDACTED]' },
  });
}
