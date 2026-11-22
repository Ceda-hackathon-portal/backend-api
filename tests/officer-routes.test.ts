import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';
import { pino } from 'pino';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { mountOfficerSubmissionRoutes } from '../src/modules/applications/officer-routes.js';
import type { OfficerSubmissionDTO } from '../src/modules/applications/officer-submission-reader.js';

const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/test' };
test('officer HTTP configuration is strictly boolean and defaults off', () => {
  assert.equal(loadConfig(env).OFFICER_READ_API_ENABLED, false);
  assert.equal(loadConfig({ ...env, OFFICER_READ_API_ENABLED: 'true' }).OFFICER_READ_API_ENABLED, true);
  assert.equal(loadConfig({ ...env, OFFICER_READ_API_ENABLED: 'false' }).OFFICER_READ_API_ENABLED, false);
  for (const value of ['TRUE','1','yes','']) assert.throws(() => loadConfig({ ...env, OFFICER_READ_API_ENABLED: value }));
});

test('disabled officer routes touch neither session nor reader; outgoing excess fields fail closed', async () => {
  const id = randomUUID(); let calls = 0;
  const fixture = async (enabled: boolean) => {
    const config = loadConfig({ ...env, OFFICER_READ_API_ENABLED: String(enabled) });
    const api = Router();
    mountOfficerSubmissionRoutes(api, config, { async verify() { calls++; return { userId: id, sessionId: id, authnLevel: 'oidc' }; } }, {
      async readForOfficer(context, versionId) {
        calls++; assert.match(context.requestId, /^[a-f0-9-]{36}$/); assert.equal(versionId, id);
        return { submissionVersionId: id, applicationId: id, programmeId: id, programmeVersionId: id,
          submissionVersionNumber: 1, reference: 'CEDA-fixture', submittedAt: new Date().toISOString(),
          submissionFields: { title: '', theme: '', problem: '', solution: '', impact: '' },
          token: 'PRIVATE_SENTINEL',
        } as OfficerSubmissionDTO;
      },
    });
    const server = createServer(createApp(config, { database: { async check() {}, async close() {} }, logger: pino({ level: 'silent' }), apiRouter: api }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try { const response = await fetch('http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1/officer/submissions/' + id);
      const body = await response.text(); assert.ok(!body.includes('PRIVATE_SENTINEL')); return response.status;
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
  assert.equal(await fixture(false), 404); assert.equal(calls, 0);
  assert.equal(await fixture(true), 500); assert.equal(calls, 2);
});
