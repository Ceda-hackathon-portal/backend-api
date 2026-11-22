import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('container probe uses readiness and fails closed on dependency failure', async () => {
  let status = 200;
  const server = createServer((request, response) => {
    assert.equal(request.url, '/health/ready');
    response.writeHead(status).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const probe = async () => {
    const child = spawn(process.execPath, ['ops/healthcheck.mjs'], {
      env: { ...process.env, PORT: String((server.address() as AddressInfo).port) },
      windowsHide: true,
    });
    const deadline = setTimeout(() => child.kill(), 5000);
    try { return (await once(child, 'exit'))[0]; }
    finally { clearTimeout(deadline); }
  };
  try {
    assert.equal(await probe(), 0);
    status = 503;
    assert.equal(await probe(), 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
