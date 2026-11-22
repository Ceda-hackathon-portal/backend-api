import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { ApplicationService } from '../src/modules/applications/service.js';
import { PrismaApplicationRepository } from '../src/modules/applications/repository.js';
import { EligibilityEvidenceInputError, PrismaEligibilityScreeningService, persistEligibilityRuleVersion } from '../src/modules/eligibility/persistence.js';
import { EligibilityConfigurationError } from '../src/modules/eligibility/rules.js';
import { attachFixtureTechnicalProposal, requiredFixtureBudget } from './support/valid-submission-fixture.js';

test('PostgreSQL eligibility screening persists immutable findings, idempotency and atomic audit/outbox', async () => {
  assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? '', /^[a-f0-9-]{36}$/);
  const url = process.env.DATABASE_URL!;
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: '-c timezone=UTC', max: 8 }) });
  try {
    const user = await db.authUser.create({ data: { email: `${randomUUID()}@example.test`, name: 'Eligibility fixture' } });
    const session = await db.authSession.create({ data: { userId: user.id, tokenHash: randomUUID().replaceAll('-', '').repeat(2), idleExpiresAt: new Date(Date.now() + 600000), absoluteExpiresAt: new Date(Date.now() + 1200000) } });
    const principal = { userId: user.id, sessionId: session.id, authnLevel: 'oidc' };
    const programme = await db.programme.create({ data: { code: randomUUID(), name: 'Eligibility fixture' } });
    const programmeVersion = await db.programmeVersion.create({ data: { programmeId: programme.id, version: 1, publishedAt: new Date(Date.now() - 10000), opensAt: new Date(Date.now() - 10000), closesAt: new Date(Date.now() + 600000), config: { themes: ['digital'] } } });
    const appService = new ApplicationService(new PrismaApplicationRepository(db, principal, randomUUID()));
    const app = await appService.create(principal, programme.id, programmeVersion.id);
    await appService.update(principal, app.id, 0, { title: 'Idea', theme: 'digital', problem: 'Problem', solution: 'Solution', impact: 'Impact', team: 'Team', eligibilityEvidence: [
      { requirementId: 'declared', value: true },
      { requirementId: 'amount', value: 2.125, unit: 'units' },
      { requirementId: 'supporting', value: true },
      { requirementId: 'supporting', value: false },
    ] }, requiredFixtureBudget);
    await attachFixtureTechnicalProposal(db, app.id, user.id);
    const submission = await appService.submit(principal, app.id, 1, 'eligibility-submit');
    const ruleVersionId = randomUUID();
    const snapshot = { schemaVersion: 1, ruleVersion: ruleVersionId, requirements: [
      { id: 'declared', mandatory: true, waivable: false, rule: { kind: 'attestation' } },
      { id: 'amount', mandatory: true, waivable: false, rule: { kind: 'number', operator: 'gte', threshold: 1, unit: 'units' } },
      { id: 'supporting', mandatory: false, waivable: false, rule: { kind: 'attestation' } },
    ] } as const;
    await persistEligibilityRuleVersion(db, { id: ruleVersionId, programmeId: programme.id, programmeVersionId: programmeVersion.id, version: 1, snapshot, publishedAt: new Date(Date.now() - 5000) });
    const service = new PrismaEligibilityScreeningService(db);
    // The database prohibits draft changes after submission; screening is
    // independently bound to the immutable version and cannot fall back to it.
    await assert.rejects(db.application.update({ where: { id: app.id }, data: { draft: { title: 'Later draft', theme: 'digital', problem: 'Later', solution: 'Later', impact: 'Later', team: 'Later', eligibilityEvidence: [{ requirementId: 'amount', value: 900, unit: 'wrong' }] } } }));
    const command = { applicationId: app.id, submissionVersionId: submission.id, ruleVersionId, idempotencyKey: 'screen-1' };
    const result = await service.screen(principal, command);
    assert.equal(result.status, 'MET');
    assert.deepEqual(result.findings.map(item => [item.requirementId, item.status, item.unknownReason]), [
      ['amount', 'MET', undefined], ['declared', 'MET', undefined], ['supporting', 'UNKNOWN', 'CONFLICT'],
    ]);
    assert.equal(result.findings[0]?.evidence.length, 1);
    assert.equal(result.findings[0]?.evidence[0]?.unit, 'units');
    assert.equal(result.findings[0]?.evidence[0]?.provenance?.submissionVersionId, submission.id);
    assert.equal(result.findings[0]?.evidence[0]?.provenance?.path, 'fields.eligibilityEvidence[1]');
    assert.equal(result.findings.find(item => item.requirementId === 'supporting')?.evidence.length, 2);
    assert.ok(result.findings.flatMap(item => item.evidence).every(item => item.verified === undefined));
    assert.deepEqual(await service.screen(principal, command), { ...result, replayed: true });
    const upperPrincipal = { ...principal, userId: principal.userId.toUpperCase(), sessionId: principal.sessionId.toUpperCase() };
    const upperCommand = { ...command, applicationId: command.applicationId.toUpperCase(),
      submissionVersionId: command.submissionVersionId.toUpperCase(), ruleVersionId: command.ruleVersionId.toUpperCase() };
    assert.deepEqual(await service.screen(upperPrincipal, upperCommand), { ...result, replayed: true });
    await assert.rejects(service.screen(principal, { ...command, ruleVersionId: randomUUID() }), { code: 'IDEMPOTENCY_CONFLICT' });
    const stranger = await db.authUser.create({ data: { email: `${randomUUID()}@example.test`, name: 'Other applicant' } });
    const strangerSession = await db.authSession.create({ data: { userId: stranger.id, tokenHash: randomUUID().replaceAll('-', '').repeat(2), idleExpiresAt: new Date(Date.now() + 600000), absoluteExpiresAt: new Date(Date.now() + 1200000) } });
    await assert.rejects(service.screen({ ...principal, userId: stranger.id, sessionId: strangerSession.id }, command), { status: 404 });
    await assert.rejects(service.screen(principal, { ...command, submissionVersionId: randomUUID(), idempotencyKey: 'wrong-submission' }), { code: 'SUBMISSION_VERSION_MISMATCH' });
    await assert.rejects(service.screen(principal, { ...command, ruleVersionId: randomUUID(), idempotencyKey: 'missing-rule' }), { code: 'RULE_VERSION_UNAVAILABLE' });
    const invalidRuleId = randomUUID();
    await db.eligibilityRuleVersion.create({ data: { id: invalidRuleId, programmeId: programme.id, programmeVersionId: programmeVersion.id, version: 2, schemaVersion: 1, snapshot: { schemaVersion: 2 }, digest: 'a'.repeat(64), publishedAt: new Date(Date.now() - 1000) } });
    await assert.rejects(service.screen(principal, { ...command, ruleVersionId: invalidRuleId, idempotencyKey: 'invalid-rule' }), EligibilityConfigurationError);
    const [concurrentA, concurrentB] = await Promise.all([
      service.screen(upperPrincipal, { ...upperCommand, idempotencyKey: 'screen-concurrent' }),
      service.screen(principal, { ...command, idempotencyKey: 'screen-concurrent' }),
    ]);
    assert.equal(concurrentA.checkId, concurrentB.checkId);
    assert.equal([concurrentA, concurrentB].filter(item => item.replayed).length, 1);
    const immutableReplay = await service.screen(upperPrincipal, { ...upperCommand, idempotencyKey: 'screen-no-evidence' });
    assert.equal(immutableReplay.status, 'MET');
    assert.equal(immutableReplay.findings.find(item => item.requirementId === 'amount')?.evidence[0]?.value, 2.125);

    const invalidApp = await appService.create(principal, programme.id, programmeVersion.id);
    await appService.update(principal, invalidApp.id, 0, { title: 'Invalid evidence', theme: 'digital', problem: 'Problem', solution: 'Solution', impact: 'Impact', team: 'Team', eligibilityEvidence: [{ requirementId: 'amount', value: 2, unit: 'wrong' }] }, requiredFixtureBudget);
    await attachFixtureTechnicalProposal(db, invalidApp.id, user.id);
    const invalidSubmission = await appService.submit(principal, invalidApp.id, 1, 'invalid-evidence-submit');
    await assert.rejects(service.screen(principal, { applicationId: invalidApp.id, submissionVersionId: invalidSubmission.id, ruleVersionId, idempotencyKey: 'invalid-evidence' }), EligibilityEvidenceInputError);
    assert.equal(await db.eligibilityCheck.count({ where: { applicationId: invalidApp.id } }), 0);

    const missingApp = await appService.create(principal, programme.id, programmeVersion.id);
    await appService.update(principal, missingApp.id, 0, { title: 'Missing evidence', theme: 'digital', problem: 'Problem', solution: 'Solution', impact: 'Impact', team: 'Team' }, requiredFixtureBudget);
    await attachFixtureTechnicalProposal(db, missingApp.id, user.id);
    const missingSubmission = await appService.submit(principal, missingApp.id, 1, 'missing-evidence-submit');
    const missingResult = await service.screen(principal, { applicationId: missingApp.id, submissionVersionId: missingSubmission.id, ruleVersionId, idempotencyKey: 'missing-evidence' });
    assert.equal(missingResult.status, 'UNKNOWN');
    assert.ok(missingResult.findings.every(item => item.status === 'UNKNOWN' && item.unknownReason === 'MISSING'));

    const otherProgramme = await db.programme.create({ data: { code: randomUUID(), name: 'Other programme' } });
    const otherProgrammeVersion = await db.programmeVersion.create({ data: { programmeId: otherProgramme.id, version: 1, publishedAt: new Date(Date.now() - 10000), opensAt: new Date(Date.now() - 10000), closesAt: new Date(Date.now() + 600000), config: { themes: ['digital'] } } });
    const otherRuleVersionId = randomUUID();
    await persistEligibilityRuleVersion(db, { id: otherRuleVersionId, programmeId: otherProgramme.id, programmeVersionId: otherProgrammeVersion.id, version: 1,
      snapshot: { schemaVersion: 1, ruleVersion: otherRuleVersionId, requirements: [{ id: 'other', rule: { kind: 'attestation' } }] }, publishedAt: new Date(Date.now() - 5000) });
    await assert.rejects(service.screen(principal, { ...command, ruleVersionId: otherRuleVersionId, idempotencyKey: 'wrong-programme' }), { code: 'RULE_VERSION_UNAVAILABLE' });

    assert.equal(await db.eligibilityCheck.count({ where: { applicationId: app.id } }), 3);
    assert.equal(await db.eligibilityFinding.count({ where: { check: { applicationId: app.id } } }), 9);
    assert.equal(await db.eligibilityAudit.count({ where: { check: { applicationId: app.id } } }), 3);
    assert.equal(await db.eligibilityOutbox.count({ where: { audit: { check: { applicationId: app.id } } } }), 3);

    await db.$executeRawUnsafe(`CREATE FUNCTION fail_eligibility_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM eligibility_checks WHERE id=NEW.check_id AND application_id='${app.id}'::uuid) THEN RAISE EXCEPTION 'forced outbox failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER fail_eligibility_outbox BEFORE INSERT ON eligibility_outbox FOR EACH ROW EXECUTE FUNCTION fail_eligibility_outbox()');
    const before = await db.eligibilityCheck.count({ where: { applicationId: app.id } });
    await assert.rejects(service.screen(principal, { ...command, idempotencyKey: 'screen-rollback' }));
    assert.equal(await db.eligibilityCheck.count({ where: { applicationId: app.id } }), before);
    assert.equal(await db.eligibilityFinding.count({ where: { applicationId: app.id } }), 9);
    assert.equal(await db.eligibilityAudit.count({ where: { check: { applicationId: app.id } } }), 3);
    assert.equal(await db.eligibilityOutbox.count({ where: { audit: { check: { applicationId: app.id } } } }), 3);
    await db.$executeRawUnsafe('DROP TRIGGER fail_eligibility_outbox ON eligibility_outbox');
    await db.$executeRawUnsafe('DROP FUNCTION fail_eligibility_outbox()');

    // An unrelated uniqueness failure must roll back, never become a successful
    // root-client recovery. A later authorized retry uses the normal transaction.
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_screening_unique() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM eligibility_checks WHERE id=NEW.check_id AND application_id='${app.id}'::uuid) THEN RAISE EXCEPTION 'forced uniqueness failure' USING ERRCODE='23505'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER fail_screening_unique BEFORE INSERT ON eligibility_outbox FOR EACH ROW EXECUTE FUNCTION fail_screening_unique()');
    await assert.rejects(service.screen(principal, { ...command, idempotencyKey: 'unique-rollback' }), { code: 'P2002' });
    assert.equal(await db.eligibilityCheck.count({ where: { applicationId: app.id } }), before);
    assert.equal(await db.eligibilityFinding.count({ where: { applicationId: app.id } }), 9);
    assert.equal(await db.eligibilityAudit.count({ where: { check: { applicationId: app.id } } }), 3);
    assert.equal(await db.eligibilityOutbox.count({ where: { audit: { check: { applicationId: app.id } } } }), 3);
    await db.$executeRawUnsafe('DROP TRIGGER fail_screening_unique ON eligibility_outbox');
    await db.$executeRawUnsafe('DROP FUNCTION fail_screening_unique()');
    const recovered = await service.screen(upperPrincipal, { ...upperCommand, idempotencyKey: 'unique-rollback' });
    assert.equal(recovered.replayed, false);
    assert.equal(await db.eligibilityCheck.count({ where: { applicationId: app.id } }), before + 1);
    assert.equal(await db.eligibilityAudit.count({ where: { check: { applicationId: app.id } } }), 4);
    assert.equal(await db.eligibilityOutbox.count({ where: { audit: { check: { applicationId: app.id } } } }), 4);

    const stored = await db.eligibilityCheck.findUniqueOrThrow({ where: { id: result.checkId }, include: { findings: true, ruleVersion: true, submission: true } });
    assert.equal(stored.submissionVersionId, submission.id);
    assert.equal(stored.ruleVersion.id, ruleVersionId);
    assert.equal(stored.findings.find(f => f.requirementId === 'supporting')?.unknownReason, 'CONFLICT');
    await assert.rejects(db.eligibilityCheck.update({ where: { id: result.checkId }, data: { overallStatus: 'NOT_MET' } }));
    await assert.rejects(db.eligibilityFinding.deleteMany({ where: { checkId: result.checkId } }));
    await assert.rejects(db.eligibilityRuleVersion.update({ where: { id: ruleVersionId }, data: { digest: 'f'.repeat(64) } }));
    await db.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    await assert.rejects(service.screen(upperPrincipal, upperCommand), { status: 401 });
    await db.authSession.update({ where: { id: session.id }, data: { revokedAt: null, idleExpiresAt: new Date(0) } });
    await assert.rejects(service.screen(principal, command), { status: 401 });
    await db.authSession.update({ where: { id: session.id }, data: { idleExpiresAt: new Date(0), absoluteExpiresAt: new Date(0) } });
    await assert.rejects(service.screen(principal, command), { status: 401 });
    await db.authSession.update({ where: { id: session.id }, data: { idleExpiresAt: new Date(Date.now() + 600000), absoluteExpiresAt: new Date(Date.now() + 1200000) } });
    await db.authUser.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    await assert.rejects(service.screen(principal, command), { status: 401 });
    await db.authUser.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
    // Suspension revokes existing sessions. Reactivation needs a new login,
    // rather than treating the old session as valid again.
    const freshSession = await db.authSession.create({ data: { userId: user.id, tokenHash: randomUUID().replaceAll('-', '').repeat(2), idleExpiresAt: new Date(Date.now() + 600000), absoluteExpiresAt: new Date(Date.now() + 1200000) } });
    assert.deepEqual(await service.screen({ ...principal, sessionId: freshSession.id }, command), { ...result, replayed: true });
  } finally { await db.$disconnect(); }
});
