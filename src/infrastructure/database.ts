import { readFileSync } from 'node:fs';
import { Pool, type PoolConfig } from 'pg';
import type { Config } from '../config/env.js';

export interface DatabaseHealth {
  check(): Promise<void>;
  close(): Promise<void>;
}

export function databaseOptions(config: Config): PoolConfig {
  return {
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS,
    query_timeout: config.DATABASE_QUERY_TIMEOUT_MS,
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    lock_timeout: config.DATABASE_LOCK_TIMEOUT_MS,
    idleTimeoutMillis: 10000,
    application_name: 'ceda-api',
    options: '-c timezone=UTC',
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true, ...(config.DATABASE_CA_FILE ? { ca: readFileSync(config.DATABASE_CA_FILE, 'utf8') } : {}) } : false,
  };
}

// Own exactly one pool per process. No domain schema/query or generated Prisma client yet.
export function createDatabase(config: Config, onIdleError: () => void): DatabaseHealth & { pool: Pool } {
  const pool = new Pool(databaseOptions(config));
  pool.on('error', () => onIdleError()); // Do not log driver messages/credentials.
  return {
    pool,
    async check() { await pool.query('SELECT 1'); },
    async close() { await pool.end(); },
  };
}
