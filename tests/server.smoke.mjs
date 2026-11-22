import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const backendDirectory = fileURLToPath(new URL('../', import.meta.url));

function launch(overrides) {
  const child = spawn(process.execPath, ['dist/src/server.js'], {
    cwd: backendDirectory,
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', LOG_LEVEL: 'info', AUTH_ENABLED: 'false', DATABASE_SSL: 'false', DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/unreachable', ALLOWED_ORIGINS: '', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = once(child, 'close');
  // Bound failures even when startup exits unexpectedly or shutdown hangs.
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
  child.once('close', () => clearTimeout(deadline));
  return { child, closed, output: () => output };
}

test('compiled server rejects invalid configuration without exposing its value', { timeout: 15_000 }, async () => {
  const process = launch({ PORT: 'invalid-secret-value' });
  const [code] = await process.closed;
  assert.equal(code, 1);
  assert.match(process.output(), /Invalid configuration fields: PORT/);
  assert.ok(!process.output().includes('invalid-secret-value'));
});

test('compiled server serves health and terminates cleanly on POSIX', { timeout: 15_000 }, async () => {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const server = launch({ PORT: String(port), OFFICER_READ_API_ENABLED: 'true' });
  try {
    await new Promise((resolve, reject) => {
      server.child.stdout.on('data', () => {
        if (server.output().includes('server_listening')) resolve();
      });
      server.child.once('error', reject);
      server.child.once('close', () => reject(new Error('Server exited before startup')));
    });
    const base = 'http://127.0.0.1:' + port + '/health/';
    const live = await fetch(base + 'live', { signal: AbortSignal.timeout(3000) });
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { data: { status: 'ok' } });
    const unavailable = await fetch(base + 'ready', { signal: AbortSignal.timeout(3000) });
    assert.equal(unavailable.status, 503);
    const privateRoute = await fetch('http://127.0.0.1:' + port + '/api/v1/applications', {
      method: 'POST', signal: AbortSignal.timeout(3000),
    });
    assert.equal(privateRoute.status, 404, 'disabled authentication must not mount private routes');
    const officerRoute = await fetch('http://127.0.0.1:' + port + '/api/v1/officer/submissions/00000000-0000-4000-8000-000000000001', { signal: AbortSignal.timeout(3000) });
    assert.equal(officerRoute.status, 404, 'the officer flag cannot mount a route when authentication is disabled');
    server.child.kill('SIGTERM');
    const [code, signal] = await server.closed;
    // Windows terminates the process directly rather than delivering POSIX signals.
    if (process.platform !== 'win32') {
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.match(server.output(), /shutdown_complete/);
    }
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
    await server.closed;
  }
});
