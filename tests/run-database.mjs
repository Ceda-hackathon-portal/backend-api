import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { Client } from 'pg';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) !== 24) throw new Error('This local harness requires Windows x64 and Node24; install spike dev tooling first.');
const id = randomUUID();
const runtime = resolve('.runtime', id);
const data = join(runtime, 'data');
const bin = resolve('spikes/prisma7/node_modules/@embedded-postgres/windows-x64/native/bin');
mkdirSync(runtime, { recursive: true });
function command(exe, args, env = process.env) {
  const result = spawnSync(exe, args, { env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`Local harness command failed: ${result.status ?? result.error?.message}`);
}
const socket = net.createServer();
await new Promise((ok, fail) => { socket.once('error', fail); socket.listen(0, '127.0.0.1', ok); });
const port = socket.address().port;
await new Promise(ok => socket.close(ok));
// Ignores any caller database URL. New loopback-only disposable cluster per run.
command(join(bin, 'initdb.exe'), ['-D', data, '-U', 'fixture', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
const child = spawn(join(bin, 'postgres.exe'), ['-D', data, '-h', '127.0.0.1', '-p', String(port)], { windowsHide: true, stdio: 'ignore' });
child.on('error', () => {});
const url = `postgresql://fixture@127.0.0.1:${port}/postgres`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 500 });
    try { await client.connect(); await client.query('SELECT 1'); ready = true; }
    catch { /* Wait for private disposable cluster. */ }
    finally { await client.end().catch(() => {}); }
    if (ready) break;
    await new Promise(ok => setTimeout(ok, 100));
  }
  if (!ready) throw new Error('Disposable database unavailable');
  command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { ...process.env, DATABASE_URL: url });
  command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { ...process.env, DATABASE_URL: url });
  command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'status'], { ...process.env, DATABASE_URL: url });
  // Integration files provision and mutate PostgreSQL roles and shared catalog
  // objects. Run them sequentially to avoid concurrent DDL/catalog updates.
  command(process.execPath, ['--test', '--test-concurrency=1', 'dist/tests/database.integration.test.js', 'dist/tests/auth-store.integration.test.js', 'dist/tests/phase4-security.integration.test.js', 'dist/tests/applications.integration.test.js', 'dist/tests/application-http.integration.test.js', 'dist/tests/officer-reader.integration.test.js', 'dist/tests/eligibility-persistence.integration.test.js', 'dist/tests/officer-http.integration.test.js', 'dist/tests/workflow-persistence.integration.test.js', 'dist/tests/evaluation-persistence.integration.test.js'], {
    ...process.env, NODE_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: 'false', DATABASE_CA_FILE: undefined,
    DATABASE_POOL_MAX: '2', DATABASE_STATEMENT_TIMEOUT_MS: '100', DATABASE_LOCK_TIMEOUT_MS: '100',
    DATABASE_QUERY_TIMEOUT_MS: '2000', LOG_LEVEL: 'silent', DISPOSABLE_DATABASE_RUN: id,
  });
} finally {
  command(join(bin, 'pg_ctl.exe'), ['-D', data, '-m', 'fast', '-w', 'stop']);
  console.log('Foundation integration database stopped; ignored fixtures retained under backend/.runtime.');
}
