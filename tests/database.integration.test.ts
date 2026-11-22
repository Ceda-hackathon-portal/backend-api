import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { loadConfig } from '../src/config/env.js';
import { createDatabase, databaseOptions } from '../src/infrastructure/database.js';

test('production database adapter checks real PostgreSQL 17 and closes cleanly', async () => {
  assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? '', /^[0-9a-f-]{36}$/);
  const config = loadConfig(process.env);
  assert.equal(new URL(config.DATABASE_URL).hostname, '127.0.0.1');
  const pool = new Pool(databaseOptions(config));
  try {
    const version = await pool.query('SHOW server_version');
    assert.match(String(version.rows[0].server_version), /^17\./);
    const settings = await pool.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock");
    assert.equal(settings.rows[0].statement, '100ms');
    assert.equal(settings.rows[0].lock, '100ms');
    await assert.rejects(pool.query('SELECT pg_sleep(1)'), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '57014');
  } finally { await pool.end(); }
  let idleErrors = 0;
  const database = createDatabase(config, () => { idleErrors++; });
  await database.check();
  await database.close();
  await assert.rejects(database.check());
  assert.equal(idleErrors, 0);
});
