import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { Client } from 'pg';

const root = fileURLToPath(new URL('.', import.meta.url));
process.chdir(root);
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Run with pinned portable Node 24');
const bin = resolve('node_modules/@embedded-postgres/windows-x64/native/bin');
const runDir = resolve('.runtime', randomUUID());
const dataDir = join(runDir, 'data');
mkdirSync(runDir, { recursive: true });
// No external database URL is accepted. Every run creates its own local cluster.
const server = net.createServer();
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
const port = server.address().port;
await new Promise(ok => server.close(ok));
const env = { ...process.env, SPIKE_DATABASE_URL: `postgresql://spike@127.0.0.1:${port}/postgres?schema=public`, CHECKPOINT_DISABLE: '1' };
function command(exe, args, commandEnv = env) {
  const result = spawnSync(exe, args, { cwd: root, env: commandEnv, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`Command failed: ${exe}; ${result.error?.message ?? result.status}`);
}
command(join(bin, 'initdb.exe'), ['-D', dataDir, '-U', 'spike', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
// Portable test cluster only: trust is restricted to loopback, never production.
let pg;
try {
  pg = spawn(join(bin, 'postgres.exe'), ['-D', dataDir, '-h', '127.0.0.1', '-p', String(port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  pg.on('error', e => console.error(e.message));
  let databaseLog = '';
  pg.stdout.on('data', chunk => { databaseLog += chunk.toString(); });
  pg.stderr.on('data', chunk => { databaseLog += chunk.toString(); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const test = new Client({ connectionString: env.SPIKE_DATABASE_URL, connectionTimeoutMillis: 500 });
    try {
      await test.connect();
      await test.query('SELECT 1');
      ready = true;
    } catch { /* Startup is asynchronous. */ }
    finally { await test.end().catch(() => {}); }
    if (ready) break;
    if (pg.exitCode !== null) throw new Error('Disposable postgres exited before ready');
    await new Promise(ok => setTimeout(ok, 100));
  }
  if (!ready) throw new Error(`Disposable PostgreSQL startup timed out: ${databaseLog}`);
  const cli = resolve('node_modules/prisma/build/index.js');
  command(process.execPath, [cli, 'validate']);
  command(process.execPath, [cli, 'generate']);
  command(process.execPath, [cli, 'migrate', 'deploy']);
  command(process.execPath, [cli, 'migrate', 'deploy']);
  command(process.execPath, [cli, 'migrate', 'status']);
  command(process.execPath, [resolve('node_modules/typescript/bin/tsc')]);
  command(process.execPath, [resolve('dist/probe.js')]);
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({ passed: true, runtime: process.version, stopped: 'finally invokes pg_ctl', recordedAt: new Date().toISOString() }, null, 2));
} finally {
  if (pg) command(join(bin, 'pg_ctl.exe'), ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
  console.log('Disposable cluster stopped; retained ignored data under backend/spikes/prisma7/.runtime for inspection.');
}
