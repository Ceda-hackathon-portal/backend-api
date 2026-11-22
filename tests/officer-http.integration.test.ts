import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';
import { pino } from 'pino';
import { Client } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { authRoutes } from '../src/modules/auth/routes.js';
import { PrismaSessionStore } from '../src/modules/auth/store.js';
import { hash, token } from '../src/modules/auth/crypto.js';
import { ApplicationService } from '../src/modules/applications/service.js';
import { PrismaApplicationRepository } from '../src/modules/applications/repository.js';
import { applicationRoutes } from '../src/modules/applications/routes.js';
import { mountOfficerSubmissionRoutes } from '../src/modules/applications/officer-routes.js';
import { PrismaOfficerSubmissionReader, type OfficerReviewScope } from '../src/modules/applications/officer-submission-reader.js';
import { PrismaOfficerReviewScope } from '../src/modules/applications/prisma-officer-review-scope.js';
import { attachFixtureTechnicalProposal, requiredFixtureBudget } from './support/valid-submission-fixture.js';

test('officer HTTP enforces live restricted-role assignment authorization and revocation ordering', { timeout: 60000 }, async () => {
  assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? '', /^[a-f0-9-]{36}$/);
  const url = process.env.DATABASE_URL!;
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: '-c timezone=UTC', max: 6 }) });
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const servers: Server[] = [];
  let runtime: PrismaClient | undefined;
  let releaseRead = () => {};
  try {
    const suffix = randomUUID().replaceAll('-', '');
    const group = 'http_group_' + suffix, login = 'http_login_' + suffix;
    await admin.query(readFileSync('ops/runtime-role.sql', 'utf8').replaceAll('ceda_runtime', group));
    const password = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE ${group} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const runtimeUrl = new URL(url); runtimeUrl.username = login; runtimeUrl.password = password;
    runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl.href, options: '-c timezone=UTC', max: 8 }) });
    const identity = await runtime.$queryRaw<Array<{ name: string; privileged: boolean }>>`SELECT current_user AS name, rolsuper AS privileged FROM pg_roles WHERE rolname=current_user`;
    assert.equal(identity[0]?.name, login); assert.equal(identity[0]?.privileged, false);
    await assert.rejects(runtime.$executeRaw`UPDATE officer_assignments SET status='ACTIVE'`);
    await assert.rejects(runtime.$executeRaw`UPDATE conflict_disclosures SET status='NO_CONFLICT'`);
    const person = async () => {
      const raw = token();
      const user = await owner.authUser.create({ data: { name: 'Fictional officer HTTP', email: randomUUID() + '@example.test' } });
      const session = await owner.authSession.create({ data: { userId: user.id, tokenHash: hash(raw), idleExpiresAt: new Date(Date.now() + 600000), absoluteExpiresAt: new Date(Date.now() + 1200000) } });
      return { user, session, cookie: '__Host-ceda_session=' + raw, principal: { userId: user.id, sessionId: session.id, authnLevel: 'oidc' } };
    };
    const applicant = await person(), officer = await person();
    const programme = await owner.programme.create({ data: { code: randomUUID(), name: 'Fictional HTTP intake' } });
    const version = await owner.programmeVersion.create({ data: { programmeId: programme.id, version: 1, config: { themes: ['digital'] }, publishedAt: new Date(Date.now() - 60000), opensAt: new Date(Date.now() - 60000), closesAt: new Date(Date.now() + 600000) } });
    const apps = new ApplicationService(new PrismaApplicationRepository(owner, applicant.principal, randomUUID()));
    const fields = { title: 'Private HTTP idea', theme: 'digital', problem: 'Private problem', solution: 'Private solution', impact: 'Private impact', team: 'Excluded private team' };
    const submitted = async (key: string) => {
      const app = await apps.create(applicant.principal, programme.id, version.id);
      await apps.update(applicant.principal, app.id, 0, fields, requiredFixtureBudget);
      await attachFixtureTechnicalProposal(owner, app.id, applicant.user.id);
      return { app, submission: await apps.submit(applicant.principal, app.id, 1, key) };
    };
    const { app, submission } = await submitted('http-first');
    const grant = async (subject: Awaited<ReturnType<typeof person>>, programmeId = programme.id) => owner.programmeGrant.create({ data: {
      userId: subject.user.id, programmeId, permission: 'eligibility.read-submission', grantedById: applicant.user.id,
      grantedAt: new Date(Date.now() - 60000),
    } });
    const assign = async (subject: Awaited<ReturnType<typeof person>>, options: { expired?: boolean; conflict?: string; metadata?: boolean } = {}) => {
      const assignment = await owner.officerAssignment.create({ data: { applicationId: app.id, submissionVersionId: submission.id,
        programmeId: programme.id, actorId: subject.user.id, validFrom: new Date(Date.now() - 60000),
        ...(options.expired ? { expiresAt: new Date(Date.now() - 1000) } : {}),
        ...(options.metadata === false ? {} : { issuedById: applicant.user.id, issuedRequestId: randomUUID() }),
      } });
      await owner.conflictDisclosure.create({ data: { assignmentId: assignment.id, status: options.conflict ?? 'NO_CONFLICT',
        disclosedById: subject.user.id, disclosedRequestId: randomUUID(), resolvedAt: new Date(), resolvedById: applicant.user.id,
        resolutionRequestId: randomUUID(), resolution: 'Controlled fixture clearance',
      } });
      return assignment;
    };
    const officerGrant = await grant(officer), assignment = await assign(officer);
    const store = new PrismaSessionStore(runtime);
    const auth = authRoutes({ mode: 'cognito', issuer: 'https://fixture.example', clientId: 'fixture', apiOrigin: 'https://api.example.test', frontendOrigin: 'https://portal.example.test',
      key: randomBytes(32).toString('hex'), secure: true, idleSeconds: 1800, absoluteSeconds: 28800 }, store,
      { async begin() { throw new Error('unused'); }, async complete() { throw new Error('unused'); } });
    const realScope = new PrismaOfficerReviewScope();
    let hold = false, signalRead = () => {};
    const scope: OfficerReviewScope = { async allows(tx, context, target) {
      const allowed = await realScope.allows(tx, context, target);
      if (hold && allowed) { signalRead(); await new Promise<void>(resolve => { releaseRead = resolve; }); }
      return allowed;
    } };
    const reader = new PrismaOfficerSubmissionReader(runtime, scope);
    const launch = async (enabled: boolean) => {
      const config = loadConfig({ ...process.env, DATABASE_URL: runtimeUrl.href, ALLOWED_ORIGINS: 'https://portal.example.test', OFFICER_READ_API_ENABLED: String(enabled) });
      const api = Router();
      api.use('/applications', applicationRoutes(runtime!, auth.verifier, auth.requireCsrf));
      mountOfficerSubmissionRoutes(api, config, auth.verifier, reader);
      const server = createServer(createApp(config, { database: { async check() {}, async close() {} }, logger: pino({ level: 'silent' }), apiRouter: api }));
      servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    };
    const path = '/api/v1/officer/submissions/' + submission.id;
    const disabled = await launch(false), base = await launch(true);
    const get = (cookie = officer.cookie, target = path, origin = 'https://portal.example.test') => fetch(base + target, { headers: { Cookie: cookie, Origin: origin }, signal: AbortSignal.timeout(10000) });
    const denied = async (response: Response, status: number) => {
      assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json(); assert.deepEqual(Object.keys(body), ['error']);
      assert.match(body.error.requestId, /^[a-f0-9-]{36}$/);
      assert.equal(JSON.stringify(body).includes(fields.title), false);
      assert.equal(JSON.stringify(body).includes(fields.team), false);
    };
    await denied(await fetch(disabled + path, { headers: { Cookie: officer.cookie } }), 404);
    await denied(await get(''), 401); await denied(await get('__Host-ceda_session=invalid'), 401);
    const success = await get(); assert.equal(success.status, 200);
    assert.equal(success.headers.get('cache-control'), 'no-store');
    assert.equal(success.headers.get('access-control-allow-origin'), 'https://portal.example.test');
    const dto = (await success.json()).data;
    assert.deepEqual(Object.keys(dto).sort(), ['submissionVersionId','applicationId','programmeId','programmeVersionId','submissionVersionNumber','reference','submittedAt','submissionFields'].sort());
    assert.deepEqual(Object.keys(dto.submissionFields).sort(), ['title','theme','problem','solution','impact'].sort());
    assert.equal(dto.submissionVersionId, submission.id);
    await denied(await get(officer.cookie, '/api/v1/officer/submissions/invalid'), 422);
    await denied(await get(officer.cookie, '/api/v1/officer/submissions/' + randomUUID()), 404);
    await denied(await get(officer.cookie, path, 'https://untrusted.example'), 403);
    const missingGrant = await person(); await assign(missingGrant); await denied(await get(missingGrant.cookie), 404);
    await denied(await get(missingGrant.cookie, path + '?role=administrator&actorId=' + officer.user.id), 404);
    const missingAssignment = await person(); await grant(missingAssignment); await denied(await get(missingAssignment.cookie), 404);
    const expired = await person(); await grant(expired); await assign(expired, { expired: true }); await denied(await get(expired.cookie), 404);
    for (const conflict of ['UNRESOLVED', 'CONFLICT']) {
      const subject = await person(); await grant(subject); await assign(subject, { conflict }); await denied(await get(subject.cookie), 404);
    }
    const ambiguous = await person(); await grant(ambiguous); await assign(ambiguous); await assign(ambiguous); await denied(await get(ambiguous.cookie), 404);
    const noMetadata = await person(); await grant(noMetadata); await assign(noMetadata, { metadata: false }); await denied(await get(noMetadata.cookie), 404);
    await grant(applicant); await assign(applicant); await denied(await get(applicant.cookie), 404);
    const otherProgramme = await owner.programme.create({ data: { code: randomUUID(), name: 'Other HTTP scope' } });
    const outsider = await person(); await grant(outsider, otherProgramme.id); await denied(await get(outsider.cookie), 404);
    const other = await submitted('http-second');
    await denied(await get(officer.cookie, '/api/v1/officer/submissions/' + other.submission.id), 404);
    await owner.programmeGrant.update({ where: { id: officerGrant.id }, data: { revokedAt: new Date() } });
    await denied(await get(), 404);
    await owner.programmeGrant.update({ where: { id: officerGrant.id }, data: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } });
    await denied(await get(), 404);
    await owner.programmeGrant.update({ where: { id: officerGrant.id }, data: { expiresAt: null } });
    for (const kind of ['revoked', 'expired', 'suspended']) {
      const subject = await person();
      if (kind === 'suspended') await owner.authUser.update({ where: { id: subject.user.id }, data: { status: 'SUSPENDED' } });
      else await owner.authSession.update({ where: { id: subject.session.id }, data: kind === 'revoked' ? { revokedAt: new Date() } : { idleExpiresAt: new Date(0) } });
      await denied(await get(subject.cookie), 401);
    }
    const ownResponse = await get(applicant.cookie, '/api/v1/applications/' + app.id); assert.equal(ownResponse.status, 200);
    await denied(await get(officer.cookie, '/api/v1/applications/' + app.id), 404);
    // Real scope locks are retained while the HTTP reader is paused, so revocation
    // cannot commit between authorization and the response's final session check.
    const readLocked = new Promise<void>(resolve => { signalRead = resolve; }); hold = true;
    const pending = get(); await readLocked;
    let revoked = false;
    const revoke = owner.officerAssignment.update({ where: { id: assignment.id }, data: { status: 'REVOKED', revokedAt: new Date(), revokedById: applicant.user.id,
      revocationRequestId: randomUUID(), revocationReason: 'HTTP concurrency fixture' } }).then(() => { revoked = true; });
    const key = (await admin.query("SELECT hashtextextended('officer-assignment-scope:'||$1::uuid::text||':'||$2::uuid::text||':'||$3::uuid::text||':'||$4::uuid::text,0)::text AS key", [officer.user.id, app.id, submission.id, programme.id])).rows[0].key;
    const lock = BigInt(key); let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=$1::oid AND objid=$2::oid AND objsubid=1", [Number((lock >> 32n) & 0xffffffffn), Number(lock & 0xffffffffn)]);
        if (rows.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true); assert.equal(revoked, false);
    } finally { hold = false; releaseRead(); }
    assert.equal((await pending).status, 200); await revoke;
    await denied(await get(), 404);
  } finally {
    releaseRead();
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await runtime?.$disconnect(); await owner.$disconnect(); await admin.end();
  }
});
