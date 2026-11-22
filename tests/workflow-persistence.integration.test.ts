import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { ApplicationService } from '../src/modules/applications/service.js';
import { PrismaApplicationRepository } from '../src/modules/applications/repository.js';
import { persistEligibilityRuleVersion, PrismaEligibilityScreeningService } from '../src/modules/eligibility/persistence.js';
import { executeTransition } from '../src/modules/workflow/engine.js';
import type { TransitionCommand } from '../src/modules/workflow/engine.js';
import { PrismaWorkflowRepository } from '../src/infrastructure/workflow-repository.js';
import { attachFixtureTechnicalProposal, requiredFixtureBudget } from './support/valid-submission-fixture.js';

test('restricted PostgreSQL workflow persists reauthorized, version-bound, retry-safe atomic transitions', { timeout: 60000 }, async () => {
  assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? '', /^[a-f0-9-]{36}$/);
  const url = process.env.DATABASE_URL!; assert.equal(new URL(url).hostname, '127.0.0.1');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: '-c timezone=UTC', max: 8 }) });
  const admin = new Client({ connectionString: url }); await admin.connect();
  let runtime: PrismaClient | undefined;
  try {
    const suffix = randomUUID().replaceAll('-', ''); const group = 'workflow_group_' + suffix, login = 'workflow_login_' + suffix;
    await admin.query(readFileSync('ops/runtime-role.sql', 'utf8').replaceAll('ceda_runtime', group));
    const password = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE ${group} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const runtimeUrl = new URL(url); runtimeUrl.username = login; runtimeUrl.password = password;
    runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl.href, options: '-c timezone=UTC', max: 8 }) });
    const current = await runtime.$queryRaw<Array<{ name: string }>>`SELECT current_user AS name`; assert.equal(current[0]?.name, login);
    for (const sql of ['ALTER TABLE workflow_state DISABLE TRIGGER ALL','TRUNCATE workflow_events CASCADE','UPDATE workflow_audits SET request_id=request_id','DELETE FROM workflow_command_receipts']) await assert.rejects(runtime.$executeRawUnsafe(sql));
    const person = async () => {
      const user = await db.authUser.create({ data: { email: randomUUID() + '@example.test', name: 'Fictional workflow actor' } });
      const session = await db.authSession.create({ data: { userId: user.id, tokenHash: randomBytes(32).toString('hex'), idleExpiresAt: new Date(Date.now() + 600000), absoluteExpiresAt: new Date(Date.now() + 1200000) } });
      return { userId: user.id, sessionId: session.id, authnLevel: 'oidc' };
    };
    const applicant = await person(), processor = await person(), officer = await person(), outsider = await person();
    const programme = await db.programme.create({ data: { code: randomUUID(), name: 'Workflow fixture' } });
    const version = await db.programmeVersion.create({ data: { programmeId: programme.id, version: 1, publishedAt: new Date(Date.now() - 60000), opensAt: new Date(Date.now() - 60000), closesAt: new Date(Date.now() + 600000), config: { themes: ['digital'] } } });
    const ruleId = randomUUID();
    await persistEligibilityRuleVersion(db, { id: ruleId, programmeId: programme.id, programmeVersionId: version.id, version: 1, publishedAt: new Date(Date.now() - 50000),
      snapshot: { schemaVersion: 1, ruleVersion: ruleId, requirements: [{ id: 'attestation', mandatory: true, waivable: false, rule: { kind: 'attestation' } }] } });
    const grant = (actorId: string, permission: string, programmeId = programme.id) => db.programmeGrant.create({ data: { userId: actorId, programmeId, permission, grantedById: applicant.userId, grantedAt: new Date(Date.now() - 60000) } });
    const screenGrant = await grant(processor.userId, 'eligibility.screen');
    await grant(officer.userId, 'eligibility.verify'); await grant(officer.userId, 'eligibility.read-submission');
    const fixture = async () => {
      const apps = new ApplicationService(new PrismaApplicationRepository(runtime!, applicant, randomUUID()));
      const app = await apps.create(applicant, programme.id, version.id);
      await apps.update(applicant, app.id, 0, { title: 'Idea', theme: 'digital', problem: 'Problem', solution: 'Solution', impact: 'Impact', team: 'Team' }, requiredFixtureBudget);
      await attachFixtureTechnicalProposal(db, app.id, applicant.userId);
      const submission = await apps.submit(applicant, app.id, 1, 'submit');
      const check = await new PrismaEligibilityScreeningService(runtime!).screen(applicant, { applicationId: app.id, submissionVersionId: submission.id, ruleVersionId: ruleId, idempotencyKey: 'screen' });
      return { binding: { applicationId: app.id, submissionVersionId: submission.id, programmeId: programme.id, programmeVersionId: version.id }, checkId: check.checkId };
    };
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const repository = (f: Fixture, principal = processor, requestId = randomUUID()) => new PrismaWorkflowRepository(runtime!, { principal, requestId, eligibilityCheckId: f.checkId });
    const command = (f: Fixture, patch: Partial<TransitionCommand> = {}): TransitionCommand => ({ ...f.binding, transition: 'SCREEN', expectedRevision: 0, idempotencyKey: 'workflow-screen', reason: '', ...patch });
    const assign = async (f: Fixture, actorId = officer.userId) => {
      const assignment = await db.officerAssignment.create({ data: { applicationId: f.binding.applicationId, submissionVersionId: f.binding.submissionVersionId, programmeId: programme.id, actorId,
        issuedById: applicant.userId, issuedRequestId: randomUUID(), validFrom: new Date(Date.now() - 60000) } });
      await db.conflictDisclosure.create({ data: { assignmentId: assignment.id, status: 'NO_CONFLICT', disclosedById: actorId, disclosedRequestId: randomUUID(), resolvedById: applicant.userId, resolutionRequestId: randomUUID(), resolvedAt: new Date(), resolution: 'Controlled fixture' } });
      return assignment;
    };
    const counts = async (f: Fixture) => ({
      states: await db.stateSnapshot.count({ where: { applicationId: f.binding.applicationId } }),
      events: await db.workflowEvent.count({ where: { applicationId: f.binding.applicationId } }),
      receipts: await db.workflowCommandReceipt.count({ where: { applicationId: f.binding.applicationId } }),
      audits: await db.workflowAudit.count({ where: { event: { applicationId: f.binding.applicationId } } }),
      outbox: await db.workflowOutbox.count({ where: { audit: { event: { applicationId: f.binding.applicationId } } } }),
    });
    const f = await fixture(); const requestId = randomUUID();
    await assert.rejects(executeTransition(repository({ ...f, checkId: randomUUID() }), command(f)), { status: 404 });
    await assert.rejects(executeTransition(repository(f, outsider), command(f)), { status: 403 });
    await assert.rejects(executeTransition(repository(f), command(f, { programmeId: randomUUID() })), { status: 404 });
    await assert.rejects(executeTransition(repository(f), command(f, { submissionVersionId: randomUUID() })), { status: 404 });
    assert.deepEqual(await counts(f), { states: 0, events: 0, receipts: 0, audits: 0, outbox: 0 });
    const first = await executeTransition(repository(f, processor, requestId), command(f));
    assert.equal(first.ok, true); if (!first.ok) throw new Error('Expected screening transition');
    assert.equal(first.receipt.change.after.state, 'ELIGIBILITY_SCREENING');
    assert.equal(first.receipt.change.audit.eligibility?.status, 'UNKNOWN');
    assert.equal(first.receipt.change.audit.eligibility?.findings[0]?.unknownReason, 'MISSING');
    const upper = Object.fromEntries(Object.entries(f.binding).map(([key, value]) => [key, value.toUpperCase()]));
    assert.deepEqual(await executeTransition(repository(f, { ...processor, userId: processor.userId.toUpperCase(), sessionId: processor.sessionId.toUpperCase() }), { ...command(f), ...upper }), { ...first, replayed: true });
    assert.deepEqual(await executeTransition(repository(f), command(f, { reason: 'Changed payload' })), { ok: false, code: 'IDEMPOTENCY_CONFLICT' });
    assert.deepEqual(await executeTransition(repository(f), command(f, { expectedRevision: 1, idempotencyKey: 'illegal' })), { ok: false, code: 'INVALID_TRANSITION' });
    assert.deepEqual(await counts(f), { states: 1, events: 1, receipts: 1, audits: 1, outbox: 1 });
    const stored = await db.stateSnapshot.findUniqueOrThrow({ where: { applicationId: f.binding.applicationId } });
    assert.equal(stored.eligibilityCheckId, f.checkId); assert.equal(stored.revision, 1);
    const event = await db.workflowEvent.findFirstOrThrow({ where: { applicationId: f.binding.applicationId }, include: { audit: true } });
    assert.equal(event.eligibilityCheckId, f.checkId); assert.equal(event.audit?.requestId, requestId); assert.equal(event.actorId, processor.userId);
    await assert.rejects(db.workflowCommandReceipt.updateMany({ where: { applicationId: f.binding.applicationId }, data: { fingerprint: 'rewrite' } }));
    await assert.rejects(db.workflowAudit.delete({ where: { eventId: event.id } }));
    await assert.rejects(db.workflowOutbox.delete({ where: { eventId: event.id } }));
    await assert.rejects(runtime.stateSnapshot.update({ where: { applicationId: f.binding.applicationId }, data: { eligibilityCheckId: randomUUID() } }));
    await db.programmeGrant.update({ where: { id: screenGrant.id }, data: { revokedAt: new Date() } });
    await assert.rejects(executeTransition(repository(f), command(f)), { status: 403 });
    await db.programmeGrant.update({ where: { id: screenGrant.id }, data: { revokedAt: null } });
    await db.programmeGrant.update({ where: { id: screenGrant.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await assert.rejects(executeTransition(repository(f), command(f)), { status: 403 });
    await db.programmeGrant.update({ where: { id: screenGrant.id }, data: { expiresAt: null } });
    const open = command(f, { transition: 'OPEN_VERIFICATION', expectedRevision: 1, idempotencyKey: 'open' });
    await assert.rejects(executeTransition(repository(f, officer), open), { status: 403 });
    await grant(applicant.userId, 'eligibility.verify'); await grant(applicant.userId, 'eligibility.read-submission');
    await assign(f, applicant.userId);
    await assert.rejects(executeTransition(repository(f, applicant), open), { status: 403 });
    await assign(f);
    const opened = await executeTransition(repository(f, officer), open); assert.equal(opened.ok, true);
    await grant(officer.userId, 'assignment.manage');
    assert.deepEqual(await executeTransition(repository(f, officer), command(f, { transition: 'ASSIGN', expectedRevision: 2, idempotencyKey: 'no-human-decision', reason: 'Not approved' })), { ok: false, code: 'GUARD_FAILED' });
    assert.deepEqual(await counts(f), { states: 1, events: 2, receipts: 2, audits: 2, outbox: 2 });
    await assert.rejects(runtime.stateSnapshot.update({ where: { applicationId: f.binding.applicationId }, data: { revision: 3, state: 'ASSIGNED' } }));
    assert.equal((await db.stateSnapshot.findUniqueOrThrow({ where: { applicationId: f.binding.applicationId } })).revision, 2);

    const concurrent = await fixture();
    const competing = await Promise.all(['one','two'].map(key => executeTransition(repository(concurrent), command(concurrent, { idempotencyKey: key }))));
    assert.equal(competing.filter(result => result.ok).length, 1);
    assert.ok(competing.some(result => !result.ok && result.code === 'REVISION_CONFLICT'));
    const duplicate = await fixture();
    const repeated = await Promise.all([executeTransition(repository(duplicate), command(duplicate)), executeTransition(repository(duplicate), command(duplicate))]);
    assert.ok(repeated.every(result => result.ok)); assert.equal(repeated.filter(result => result.ok && result.replayed).length, 1);
    assert.deepEqual(await counts(duplicate), { states: 1, events: 1, receipts: 1, audits: 1, outbox: 1 });

    const rollback = await fixture();
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_workflow_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM workflow_events WHERE id=NEW.event_id AND application_id='${rollback.binding.applicationId}'::uuid) THEN RAISE EXCEPTION 'workflow outbox fixture failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER fail_workflow_outbox BEFORE INSERT ON workflow_outbox FOR EACH ROW EXECUTE FUNCTION fail_workflow_outbox()');
    await assert.rejects(executeTransition(repository(rollback), command(rollback)));
    assert.deepEqual(await counts(rollback), { states: 0, events: 0, receipts: 0, audits: 0, outbox: 0 });
    await db.$executeRawUnsafe('DROP TRIGGER fail_workflow_outbox ON workflow_outbox'); await db.$executeRawUnsafe('DROP FUNCTION fail_workflow_outbox()');
    assert.equal((await executeTransition(repository(rollback), command(rollback))).ok, true);

    // Revocation obtains the exclusive scope lock first; the waiting write must
    // reauthorize against its committed revoked state, not stale read facts.
    const revoked = await fixture(); await executeTransition(repository(revoked), command(revoked)); const assignment = await assign(revoked);
    let release!: () => void, signal!: () => void;
    const locked = new Promise<void>(resolve => { signal = resolve; }); const hold = new Promise<void>(resolve => { release = resolve; });
    const revocation = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('officer-assignment-scope:' || ${officer.userId}::uuid::text || ':' || ${revoked.binding.applicationId}::uuid::text || ':' || ${revoked.binding.submissionVersionId}::uuid::text || ':' || ${programme.id}::uuid::text,0))`;
      signal(); await hold;
      await tx.officerAssignment.update({ where: { id: assignment.id }, data: { status: 'REVOKED', revokedAt: new Date(), revokedById: applicant.userId, revocationRequestId: randomUUID(), revocationReason: 'Before write' } });
    }, { timeout: 15000 });
    await locked;
    const denied = assert.rejects(executeTransition(repository(revoked, officer), command(revoked, { transition: 'OPEN_VERIFICATION', expectedRevision: 1, idempotencyKey: 'revoked-open' })), { status: 403 });
    const key = BigInt((await admin.query("SELECT hashtextextended('officer-assignment-scope:'||$1::uuid::text||':'||$2::uuid::text||':'||$3::uuid::text||':'||$4::uuid::text,0)::text AS key", [officer.userId, revoked.binding.applicationId, revoked.binding.submissionVersionId, programme.id])).rows[0].key);
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=$1::oid AND objid=$2::oid AND objsubid=1", [Number((key >> 32n) & 0xffffffffn), Number(key & 0xffffffffn)]);
        if (rows.rowCount) { waiting = true; break; } await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true);
    } finally { release(); }
    await revocation; await denied;
    assert.deepEqual(await counts(revoked), { states: 1, events: 1, receipts: 1, audits: 1, outbox: 1 });
    await db.authSession.update({ where: { id: officer.sessionId }, data: { revokedAt: new Date() } });
    await assert.rejects(executeTransition(repository(f, officer), open), { status: 401 });
    await db.authSession.update({ where: { id: processor.sessionId }, data: { idleExpiresAt: new Date(0) } });
    await assert.rejects(executeTransition(repository(f), command(f)), { status: 401 });
    await db.authSession.update({ where: { id: processor.sessionId }, data: { idleExpiresAt: new Date(Date.now() + 600000) } });
    await db.authUser.update({ where: { id: processor.userId }, data: { status: 'SUSPENDED' } });
    await assert.rejects(executeTransition(repository(f), command(f)), { status: 401 });
    const history = await db.workflowEvent.findMany({ where: { applicationId: f.binding.applicationId }, orderBy: { revision: 'asc' } });
    assert.deepEqual(history.map(item => [item.revision,item.previousState,item.nextState]), [[1,'SUBMITTED','ELIGIBILITY_SCREENING'],[2,'ELIGIBILITY_SCREENING','OFFICER_VERIFICATION']]);
  } finally { await runtime?.$disconnect(); await db.$disconnect(); await admin.end(); }
});
