import { insights } from '../src/modules/service-center/reporting.js';
import { notices } from '../src/modules/service-center/repository.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import express from 'express';
import { Client } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { applicationRoutes } from '../src/modules/applications/routes.js';
import { persistEligibilityRuleVersion, PrismaEligibilityScreeningService } from '../src/modules/eligibility/persistence.js';
import { executeTransition } from '../src/modules/workflow/engine.js';
import { PrismaWorkflowRepository, type WorkflowFactSource } from '../src/infrastructure/workflow-repository.js';
import { PrismaEvaluationRepository } from '../src/infrastructure/evaluation-repository.js';
import { mountEvaluationRoutes } from '../src/infrastructure/evaluation-routes.js';
import { PrismaDecisionRepository } from '../src/infrastructure/decision-repository.js';
import { mountDecisionRoutes } from '../src/infrastructure/decision-routes.js';
import { PrismaOfficerAssignmentService } from '../src/modules/applications/officer-assignment-service.js';
import { PrismaOfficerSubmissionReader } from '../src/modules/applications/officer-submission-reader.js';
import { PrismaOfficerReviewScope } from '../src/modules/applications/prisma-officer-review-scope.js';
import { mountOfficerSubmissionRoutes } from '../src/modules/applications/officer-routes.js';
import { HttpError } from '../src/shared/errors.js';
import { attachFixtureTechnicalProposal, requiredFixtureBudget } from './support/valid-submission-fixture.js';

test('full PostgreSQL lifecycle uses immutable submitted evidence, authorized assignments, evaluation, adjudication and released applicant outcome', { timeout: 60000 }, async () => {
  assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? '', /^[a-f0-9-]{36}$/);
  const url = process.env.DATABASE_URL!; assert.equal(new URL(url).hostname, '127.0.0.1');
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: '-c timezone=UTC', max: 8 }) });
  const admin = new Client({ connectionString: url }); await admin.connect();
  let runtime: PrismaClient | undefined;
  try {
    const suffix = randomUUID().replaceAll('-', ''), group = 'evaluation_group_' + suffix, login = 'evaluation_login_' + suffix;
    await admin.query(readFileSync('ops/runtime-role.sql', 'utf8').replaceAll('ceda_runtime', group));
    const password = randomBytes(24).toString('hex'), runtimeUrl = new URL(url);
    runtimeUrl.username = login; runtimeUrl.password = password;
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE ${group} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl.href, options: '-c timezone=UTC', max: 8 }) });
    const identity = await runtime.$queryRaw<Array<{ name: string; superuser: boolean }>>`SELECT current_user AS name, rolsuper AS superuser FROM pg_roles WHERE rolname=current_user`;
    assert.equal(identity[0]?.name, login); assert.equal(identity[0]?.superuser, false);
    const tableVisibility = await runtime.$queryRaw<Array<{ evaluation: string | null; scores: string | null }>>`
      SELECT to_regclass('public.evaluations')::text AS evaluation,to_regclass('public.evaluation_scores')::text AS scores`;
    assert.deepEqual(tableVisibility, [{ evaluation: 'evaluations', scores: 'evaluation_scores' }]);

    const person = async () => {
      const user = await owner.authUser.create({ data: { email: randomUUID() + '@example.test', name: 'Fictional review actor' } });
      const session = await owner.authSession.create({ data: { userId: user.id, tokenHash: randomBytes(32).toString('hex'), idleExpiresAt: new Date(Date.now() + 600000), absoluteExpiresAt: new Date(Date.now() + 1200000) } });
      return { principal: { userId: user.id, sessionId: session.id, authnLevel: 'oidc' }, userId: user.id };
    };
    const applicant = await person(), processor = await person(), officer = await person(), reviewer = await person(), secondReviewer = await person(), rollbackReviewer = await person(), routeReviewer = await person(), adjudicator = await person(), publisher = await person(), outsider = await person();
    const principals = new Map([['applicant', applicant.principal], ['processor', processor.principal], ['officer', officer.principal],
      ['reviewer', reviewer.principal], ['secondReviewer', secondReviewer.principal], ['rollbackReviewer', rollbackReviewer.principal],
      ['routeReviewer', routeReviewer.principal], ['adjudicator', adjudicator.principal], ['publisher', publisher.principal], ['outsider', outsider.principal]]);
    const sessions = { async verify(cookie?: string) {
      const match = /^ceda_session=(?:decision-)?(applicant|processor|officer|reviewer|secondReviewer|rollbackReviewer|routeReviewer|adjudicator|publisher|outsider)$/.exec(cookie ?? '');
      return match ? principals.get(match[1]!) ?? null : null;
    } };
    const csrf = (request: express.Request) => {
      if (request.headers['x-csrf-token'] !== 'csrf-test') throw new HttpError(403, 'CSRF_FAILED', 'Request verification failed.');
    };
    const programme = await owner.programme.create({ data: { code: randomUUID(), name: 'Fictional review programme' } });
    const version = await owner.programmeVersion.create({ data: { programmeId: programme.id, version: 1,
      publishedAt: new Date(Date.now() - 60000), opensAt: new Date(Date.now() - 60000), closesAt: new Date(Date.now() + 600000),
      config: { themes: ['digital'], decisionPolicy: { schemaVersion: 1, permittedOutcomes: ['APPROVED', 'REJECTED', 'REVISION_REQUESTED'] }, reviewPolicy: { schemaVersion: 1, scoring: { criteria: [
        { id: 'configured-quality', minimum: 0, maximum: 10, evidenceRequired: true, commentRequired: true },
      ], aggregation: 'SUM' } } } } });
    const ruleId = randomUUID();
    await persistEligibilityRuleVersion(owner, { id: ruleId, programmeId: programme.id, programmeVersionId: version.id, version: 1,
      publishedAt: new Date(Date.now() - 50000), snapshot: { schemaVersion: 1, ruleVersion: ruleId,
        requirements: [{ id: 'attestation', mandatory: true, waivable: false, rule: { kind: 'attestation' } }] } });
    const grant = (actor: typeof applicant, permission: string) => owner.programmeGrant.create({ data: {
      userId: actor.userId, programmeId: programme.id, permission, grantedById: applicant.userId, grantedAt: new Date(Date.now() - 60000),
    } });
    await grant(processor, 'eligibility.screen'); await grant(processor, 'assignment.manage');
    for (const permission of ['eligibility.verify', 'eligibility.read-submission', 'assignment.manage']) await grant(officer, permission);
    for (const actor of [reviewer, secondReviewer, rollbackReviewer, routeReviewer]) for (const permission of ['evaluation.write', 'evaluation.submit', 'eligibility.read-submission']) await grant(actor, permission);
    await grant(adjudicator, 'adjudication.read');
    await grant(adjudicator, 'adjudication.decide');
    await grant(publisher, 'decision.publish');

    const applicantHttp = express(); applicantHttp.use(express.json());
    applicantHttp.use((_req, res, next) => { res.locals.requestId = randomUUID(); next(); });
    applicantHttp.use('/api/v1/applications', applicationRoutes(runtime, sessions, csrf));
    applicantHttp.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = error instanceof HttpError ? error.status : 500;
      res.status(status).json({ error: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' } });
    });
    const applicantServer = createServer(applicantHttp);
    await new Promise<void>(resolve => applicantServer.listen(0, '127.0.0.1', resolve));
    const applicantAddress = applicantServer.address(); assert.ok(applicantAddress && typeof applicantAddress !== 'string');
    let application: { id: string };
    let submission: { id: string; fields: Record<string, unknown> };
    try {
      const base = `http://127.0.0.1:${applicantAddress.port}/api/v1/applications`;
      const headers = { cookie: 'ceda_session=applicant', 'x-csrf-token': 'csrf-test', 'content-type': 'application/json' };
      const created = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ programmeId: programme.id, programmeVersionId: version.id }) });
      assert.equal(created.status, 201);
      application = (await created.json() as { data: { id: string } }).data;
      const patched = await fetch(`${base}/${application.id}`, { method: 'PATCH', headers, body: JSON.stringify({ expectedRevision: 0, budget: requiredFixtureBudget, fields: {
        title: 'Review fixture', theme: 'digital', problem: 'Problem', solution: 'Solution', impact: 'Impact', team: 'Private team',
        eligibilityEvidence: [{ requirementId: 'attestation', value: true }],
      } }) });
      assert.equal(patched.status, 200);
      await attachFixtureTechnicalProposal(owner, application.id, applicant.userId);
      const submitted = await fetch(`${base}/${application.id}/submit`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'review-submit' }, body: JSON.stringify({ expectedRevision: 1 }) });
      assert.equal(submitted.status, 200);
      submission = (await submitted.json() as { data: { id: string; fields: Record<string, unknown> } }).data;
    } finally { await new Promise<void>((resolve, reject) => applicantServer.close(error => error ? reject(error) : resolve())); }
    const screened = await new PrismaEligibilityScreeningService(runtime).screen(applicant.principal, {
      applicationId: application.id, submissionVersionId: submission.id, ruleVersionId: ruleId, idempotencyKey: 'review-screen',
    });
    assert.equal(screened.status, 'MET');
    assert.equal(screened.findings[0]?.evidence[0]?.value, true);
    assert.equal(screened.findings[0]?.evidence[0]?.provenance?.submissionVersionId, submission.id);
    assert.equal(screened.findings[0]?.evidence[0]?.verified, undefined);
    const assign = async (actor: typeof officer | typeof reviewer | typeof secondReviewer | typeof rollbackReviewer | typeof routeReviewer | typeof adjudicator | typeof publisher) => {
      const row = await owner.officerAssignment.create({ data: { applicationId: application.id, submissionVersionId: submission.id,
        programmeId: programme.id, actorId: actor.userId, issuedById: applicant.userId, issuedRequestId: randomUUID(), validFrom: new Date(Date.now() - 60000) } });
      await owner.conflictDisclosure.create({ data: { assignmentId: row.id, status: 'NO_CONFLICT', disclosedById: actor.userId,
        disclosedRequestId: randomUUID(), resolvedById: applicant.userId, resolutionRequestId: randomUUID(), resolvedAt: new Date(), resolution: 'Controlled test clearance' } });
      return row;
    };
    const assignmentService = new PrismaOfficerAssignmentService(owner);
    const assignThroughService = async (actor: typeof officer | typeof reviewer) => {
      const issued = await assignmentService.issue(processor.principal, randomUUID(), { actorId: actor.userId,
        applicationId: application.id, submissionVersionId: submission.id, programmeId: programme.id });
      const disclosure = await assignmentService.discloseConflict(actor.principal, randomUUID(), issued.assignmentId);
      await assignmentService.resolveConflict(processor.principal, randomUUID(), disclosure.disclosureId, 'NO_CONFLICT', 'Controlled integration fixture clearance.');
      return owner.officerAssignment.findUniqueOrThrow({ where: { id: issued.assignmentId } });
    };
    const officerAssignment = await assignThroughService(officer), evaluatorAssignment = await assignThroughService(reviewer),
      revokedAssignment = await assign(secondReviewer), rollbackAssignment = await assign(rollbackReviewer), routeAssignment = await assign(routeReviewer),
      adjudicatorAssignment = await assign(adjudicator), publisherAssignment = await assign(publisher);
    const facts: WorkflowFactSource = { async read(db, context) {
      const row = await db.officerAssignment.findFirst({ where: { actorId: context.principal.userId,
        applicationId: context.snapshot.applicationId, submissionVersionId: context.snapshot.submissionVersionId,
        programmeId: context.snapshot.programmeId }, include: { conflicts: true } });
      const allowedConflict = !!row && row.conflicts.length > 0 && row.conflicts.every(value => value.status === 'NO_CONFLICT' || value.status === 'CLEARED');
      return {
        ...(row ? { assignment: { applicationId: context.snapshot.applicationId, submissionVersionId: context.snapshot.submissionVersionId,
          programmeId: context.snapshot.programmeId, programmeVersionId: context.snapshot.programmeVersionId,
          userId: context.principal.userId, active: row.status === 'ACTIVE', revoked: row.revokedAt !== null, conflictCleared: allowedConflict } } : {}),
        guards: { officerConfirmedEligible: true, reviewersCleared: true },
      };
    } };
    const transition = async (actor: typeof applicant | typeof officer | typeof reviewer, command: Parameters<typeof executeTransition>[1]) =>
      executeTransition(new PrismaWorkflowRepository(runtime!, { principal: actor.principal, requestId: randomUUID(), eligibilityCheckId: screened.checkId }, facts), command);
    const binding = { applicationId: application.id, submissionVersionId: submission.id, programmeId: programme.id, programmeVersionId: version.id };
    const screen = await transition(processor, { ...binding, transition: 'SCREEN', expectedRevision: 0, idempotencyKey: 'eval-screen-transition', reason: '' });
    assert.equal(screen.ok, true);
    const open = await transition(officer, { ...binding, transition: 'OPEN_VERIFICATION', expectedRevision: 1, idempotencyKey: 'eval-open-transition', reason: '' });
    assert.equal(open.ok, true);
    const assignTransition = await transition(officer, { ...binding, transition: 'ASSIGN', expectedRevision: 2, idempotencyKey: 'eval-assign-transition', reason: 'Test fixture assignment' });
    assert.equal(assignTransition.ok, true, JSON.stringify(assignTransition));
    const start = await transition(reviewer, { ...binding, transition: 'START_EVALUATION', expectedRevision: 3, idempotencyKey: 'eval-start-transition', reason: '' });
    assert.equal(start.ok, true);
    assert.equal((await owner.stateSnapshot.findUniqueOrThrow({ where: { applicationId: application.id } })).state, 'UNDER_EVALUATION');
    await assert.rejects(new PrismaDecisionRepository(runtime!, adjudicator.principal, randomUUID()).recordDecision(application.id,
      { expectedRevision: 4, outcome: 'APPROVED', reason: 'Premature decision must be denied.' }, 'unfinalized-evaluations'),
    { status: 409, code: 'INCOMPLETE_EVALUATIONS' });
    assert.equal(await owner.adjudicationDecision.count({ where: { applicationId: application.id } }), 0);
    assert.ok(officerAssignment.id && evaluatorAssignment.id && revokedAssignment.id && rollbackAssignment.id && routeAssignment.id);

    const http = express();
    http.use(express.json());
    http.use((_req, res, next) => { res.locals.requestId = randomUUID(); next(); });
    const api = express.Router();
    mountEvaluationRoutes(api, runtime, sessions, csrf);
    mountOfficerSubmissionRoutes(api, { OFFICER_READ_API_ENABLED: true }, sessions,
      new PrismaOfficerSubmissionReader(runtime, new PrismaOfficerReviewScope()));
    http.use('/api/v1', api);
    http.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = error instanceof HttpError ? error.status : 500;
      res.status(status).json({ error: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' } });
    });
    const server = createServer(http);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    try {
      const officerUrl = `http://127.0.0.1:${address.port}/api/v1/officer/submissions/${submission.id}`;
      assert.equal((await fetch(officerUrl)).status, 401);
      const officerRead = await fetch(officerUrl, { headers: { cookie: 'ceda_session=routeReviewer' } });
      assert.equal(officerRead.status, 200);
      const officerPayload = await officerRead.json() as { data: { submissionVersionId: string; applicationId: string; submissionFields: Record<string, unknown> } };
      assert.equal(officerPayload.data.submissionVersionId, submission.id);
      assert.equal(officerPayload.data.applicationId, application.id);
      assert.deepEqual(Object.keys(officerPayload.data.submissionFields).sort(), ['impact', 'problem', 'solution', 'theme', 'title']);
      assert.equal((await fetch(officerUrl, { headers: { cookie: 'ceda_session=outsider' } })).status, 404);
      const endpoint = `http://127.0.0.1:${address.port}/api/v1/assignments/${routeAssignment.id}/evaluation`;
      const body = { expectedRevision: 0, scores: [{ criterionId: 'configured-quality', value: 9, evidence: 'Authorized route evidence', comment: 'Criterion note' }],
        comment: '', recommendation: null, finalize: false };
      const unauthenticated = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-test', 'idempotency-key': 'http-eval-unauth' }, body: JSON.stringify(body) });
      assert.equal(unauthenticated.status, 401);
      const csrfDenied = await fetch(endpoint, { method: 'PUT', headers: { cookie: 'ceda_session=routeReviewer', 'content-type': 'application/json', 'idempotency-key': 'http-eval-csrf' }, body: JSON.stringify(body) });
      assert.equal(csrfDenied.status, 403);
      const authorized = await fetch(endpoint, { method: 'PUT', headers: { cookie: 'ceda_session=routeReviewer', 'x-csrf-token': 'csrf-test',
        'content-type': 'application/json', 'idempotency-key': 'http-eval-authorized' }, body: JSON.stringify(body) });
      const responseText = await authorized.text();
      assert.equal(authorized.status, 200, responseText);
      const payload = JSON.parse(responseText) as { data: { revision: number; scores: Array<{ value: number }> } };
      assert.equal(payload.data.revision, 1); assert.equal(payload.data.scores[0]?.value, 9);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

    const repository = (actor: typeof reviewer, requestId = randomUUID()) => new PrismaEvaluationRepository(runtime!, actor.principal, requestId);
    const draft = { expectedRevision: 0, idempotencyKey: 'evaluation-draft', scores: [{ criterionId: 'configured-quality', value: 8,
      evidence: 'Reviewed source evidence', comment: 'Specific score comment' }],
      comment: '', recommendation: null, finalize: false } as const;
    await assert.rejects(repository(outsider).write(evaluatorAssignment.id, draft), { status: 403 });
    await assert.rejects(repository(reviewer).write(randomUUID(), draft), { status: 404 });
    const [first, duplicate] = await Promise.all([
      repository(reviewer).write(evaluatorAssignment.id, draft), repository(reviewer).write(evaluatorAssignment.id, draft),
    ]);
    assert.equal(first.revision, 1); assert.equal(first.state, 'DRAFT'); assert.equal(first.scores[0]?.value, 8);
    assert.equal(first.scores[0]?.comment, 'Specific score comment');
    assert.equal((await owner.evaluationScore.findFirstOrThrow({ where: { evaluation: { assignmentId: evaluatorAssignment.id } } })).comment, 'Specific score comment');
    assert.deepEqual(duplicate, first);
    await assert.rejects(repository(reviewer).write(evaluatorAssignment.id, { ...draft, scores: [{ ...draft.scores[0], value: 7 }] }), { status: 409 });
    const finalized = await repository(reviewer).write(evaluatorAssignment.id, { ...draft, expectedRevision: 1, idempotencyKey: 'evaluation-final', finalize: true,
      comment: 'Evidence assessed', recommendation: 'APPROVE' });
    assert.equal(finalized.revision, 2); assert.equal(finalized.state, 'FINALIZED');
    assert.equal(await owner.evaluationAudit.count({ where: { evaluationId: (await owner.evaluation.findUniqueOrThrow({ where: { assignmentId: evaluatorAssignment.id } })).id } }), 2);
    assert.equal(await owner.evaluationOutbox.count({ where: { audit: { evaluation: { assignmentId: evaluatorAssignment.id } } } }), 2);
    await assert.rejects(runtime.evaluationScore.deleteMany({ where: { evaluation: { assignmentId: evaluatorAssignment.id } } }));
    await assert.rejects(runtime.evaluationCommandReceipt.deleteMany({ where: { assignmentId: evaluatorAssignment.id } }));
    for (const sql of ['TRUNCATE evaluations CASCADE', 'ALTER TABLE evaluations DISABLE TRIGGER ALL', 'DELETE FROM evaluation_audits']) await assert.rejects(runtime.$executeRawUnsafe(sql));

    await owner.officerAssignment.update({ where: { id: revokedAssignment.id }, data: { status: 'REVOKED', revokedAt: new Date(),
      revokedById: applicant.userId, revocationRequestId: randomUUID(), revocationReason: 'Test revocation' } });
    await assert.rejects(repository(secondReviewer).write(revokedAssignment.id, draft), { status: 404 });
    assert.equal(await owner.evaluation.count({ where: { assignmentId: revokedAssignment.id } }), 0);

    await owner.$executeRawUnsafe(`CREATE FUNCTION fail_evaluation_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM evaluation_audits WHERE id=NEW.audit_id AND application_id='${application.id}'::uuid AND actor_id='${rollbackReviewer.userId}'::uuid) THEN RAISE EXCEPTION 'controlled outbox failure'; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe('CREATE TRIGGER fail_evaluation_outbox BEFORE INSERT ON evaluation_outbox FOR EACH ROW EXECUTE FUNCTION fail_evaluation_outbox()');
    try { await assert.rejects(repository(rollbackReviewer).write(rollbackAssignment.id, draft)); }
    finally { await owner.$executeRawUnsafe('DROP TRIGGER fail_evaluation_outbox ON evaluation_outbox'); await owner.$executeRawUnsafe('DROP FUNCTION fail_evaluation_outbox()'); }
    assert.equal(await owner.evaluation.count({ where: { assignmentId: rollbackAssignment.id } }), 0);
    assert.equal(await owner.evaluationAudit.count({ where: { actorId: rollbackReviewer.userId } }), 0);
    assert.equal(await owner.evaluationOutbox.count({ where: { audit: { actorId: rollbackReviewer.userId } } }), 0);
    assert.equal(await owner.evaluationCommandReceipt.count({ where: { evaluatorId: rollbackReviewer.userId } }), 0);

    // Leave one active evaluator assignment so the configured workflow guard
    // verifies every current assigned reviewer without inventing a quorum.
    for (const assignment of [rollbackAssignment, routeAssignment]) {
      await owner.officerAssignment.update({ where: { id: assignment.id }, data: { status: 'REVOKED', revokedAt: new Date(),
        revokedById: applicant.userId, revocationRequestId: randomUUID(), revocationReason: 'End test assignment' } });
    }
    const adjudication = (actor: typeof adjudicator | typeof outsider, requestId = randomUUID()) =>
      new PrismaDecisionRepository(runtime!, actor.principal, requestId);
    const decisionCommand = { expectedRevision: 6, outcome: 'APPROVED' as const, reason: 'Decision based on finalized review evidence.' };
    await assert.rejects(adjudication(outsider).recordDecision(application.id, decisionCommand, 'decision-denied'));
    await assert.rejects(adjudication(adjudicator).recordDecision(application.id, { ...decisionCommand, expectedRevision: 5 }, 'decision-stale'), { status: 409 });

    const expectedState = async (state: string, revision: number) => {
      const current = await owner.stateSnapshot.findUniqueOrThrow({ where: { applicationId: application.id } });
      assert.equal(current.state, state); assert.equal(current.revision, revision);
    };
    const workflowRepository = (actor: typeof adjudicator | typeof reviewer, requestId = randomUUID()) =>
      new PrismaDecisionRepository(runtime!, actor.principal, requestId);
    const locked = await workflowRepository(reviewer).lockScores(application.id, 4, 'integration-lock-scores');
    assert.equal(locked.state, 'SCORES_LOCKED');
    const opened = await workflowRepository(adjudicator).openAdjudication(application.id, 5, 'integration-open-adjudication');
    assert.equal(opened.state, 'ADJUDICATION');

    await owner.$executeRawUnsafe(`CREATE FUNCTION fail_decision_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM decision_audits WHERE id=NEW.audit_id AND application_id='${application.id}'::uuid AND actor_id='${adjudicator.userId}'::uuid) THEN RAISE EXCEPTION 'controlled decision outbox failure'; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe('CREATE TRIGGER fail_decision_outbox BEFORE INSERT ON decision_outbox FOR EACH ROW EXECUTE FUNCTION fail_decision_outbox()');
    try { await assert.rejects(adjudication(adjudicator).recordDecision(application.id, decisionCommand, 'decision-rollback')); }
    finally { await owner.$executeRawUnsafe('DROP TRIGGER fail_decision_outbox ON decision_outbox'); await owner.$executeRawUnsafe('DROP FUNCTION fail_decision_outbox()'); }
    await expectedState('ADJUDICATION', 6);
    assert.equal(await owner.adjudicationDecision.count({ where: { applicationId: application.id } }), 0);
    assert.equal(await owner.decisionAudit.count({ where: { applicationId: application.id } }), 0);
    assert.equal(await owner.decisionOutbox.count({ where: { audit: { applicationId: application.id } } }), 0);

    const [recorded, concurrentDecision] = await Promise.all([
      adjudication(adjudicator).recordDecision(application.id, decisionCommand, 'decision-once'),
      adjudication(adjudicator).recordDecision(application.id, decisionCommand, 'decision-once'),
    ]);
    assert.equal(recorded.outcome, 'APPROVED');
    assert.deepEqual([recorded.replayed, concurrentDecision.replayed].sort(), [false, true]);
    await assert.rejects(adjudication(adjudicator).recordDecision(application.id, { ...decisionCommand, outcome: 'REJECTED' }, 'decision-once'), { status: 409 });
    const decisionRow = await owner.adjudicationDecision.findUniqueOrThrow({ where: { applicationId: application.id } });
    assert.equal(decisionRow.outcome, 'APPROVED');
    const releaseCommand = { expectedRevision: 7, reason: 'Release reviewed and approved outcome.', applicantMessage: 'Your application outcome is available.' };
    await assert.rejects(new PrismaDecisionRepository(runtime!, outsider.principal, randomUUID()).releaseDecision(decisionRow.id, releaseCommand, 'release-unauthorized'), { status: 403 });
    assert.equal((await owner.adjudicationDecision.findUniqueOrThrow({ where: { applicationId: application.id } })).releasedAt, null);
    const applicantRepository = new PrismaDecisionRepository(runtime!, applicant.principal, randomUUID());
    await assert.rejects(applicantRepository.readApplicantOutcome(application.id), { status: 404 });

    const publishRepository = (actor: typeof publisher, requestId = randomUUID()) => new PrismaDecisionRepository(runtime!, actor.principal, requestId);
    await assert.rejects(publishRepository(publisher).releaseDecision(decisionRow.id, { ...releaseCommand, expectedRevision: 6 }, 'release-stale'), { status: 409 });
    await owner.$executeRawUnsafe(`CREATE FUNCTION fail_release_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM decision_audits WHERE id=NEW.audit_id AND application_id='${application.id}'::uuid AND actor_id='${publisher.userId}'::uuid) THEN RAISE EXCEPTION 'controlled release outbox failure'; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe('CREATE TRIGGER fail_release_outbox BEFORE INSERT ON decision_outbox FOR EACH ROW EXECUTE FUNCTION fail_release_outbox()');
    try { await assert.rejects(publishRepository(publisher).releaseDecision(decisionRow.id, releaseCommand, 'release-rollback')); }
    finally { await owner.$executeRawUnsafe('DROP TRIGGER fail_release_outbox ON decision_outbox'); await owner.$executeRawUnsafe('DROP FUNCTION fail_release_outbox()'); }
    await expectedState('DECIDED', 7);
    assert.equal(await owner.outcomeRelease.count({ where: { applicationId: application.id } }), 0);
    assert.equal((await owner.adjudicationDecision.findUniqueOrThrow({ where: { applicationId: application.id } })).releasedAt, null);

    await runtime!.$transaction(async tx=>{await notices(tx);});
    assert.equal(await owner.serviceNotification.count({where:{recipientId:applicant.userId,sourceKey:{startsWith:'outcome:'}}}),0);
    const [released, concurrentRelease] = await Promise.all([
      publishRepository(publisher).releaseDecision(decisionRow.id, releaseCommand, 'release-once'),
      publishRepository(publisher).releaseDecision(decisionRow.id, releaseCommand, 'release-once'),
    ]);
    assert.deepEqual([released.replayed, concurrentRelease.replayed].sort(), [false, true]);
    await assert.rejects(publishRepository(publisher).releaseDecision(decisionRow.id,
      { ...releaseCommand, applicantMessage: 'Changed message' }, 'release-once'), { status: 409 });
    await expectedState('OUTCOME_RELEASED', 8);
    const report=await runtime!.$transaction(tx=>insights(tx,[programme.id],new Date(Date.now()-86400000),new Date(Date.now()+86400000)));
    assert.deepEqual(report.outcomes,[{outcome:'APPROVED',count:1}]);
    assert.equal(report.timing?.released,1);assert.ok((report.timing?.averageDays??-1)>=0);
    await runtime!.$transaction(async tx=>{await notices(tx);});await runtime!.$transaction(async tx=>{await notices(tx);});
    assert.equal(await owner.serviceNotification.count({where:{recipientId:applicant.userId,sourceKey:{startsWith:'outcome:'}}}),1);

    const releasedOutcome = await applicantRepository.readApplicantOutcome(application.id);
    assert.deepEqual(releasedOutcome, { applicationId: application.id, submissionVersionId: submission.id,
      programmeId: programme.id, programmeVersionId: version.id, outcome: 'APPROVED', message: releaseCommand.applicantMessage });
    await assert.rejects(new PrismaDecisionRepository(runtime!, outsider.principal, randomUUID()).readApplicantOutcome(application.id), { status: 404 });
    const decisionHttp = express();
    decisionHttp.use(express.json());
    decisionHttp.use((_req, res, next) => { res.locals.requestId = randomUUID(); next(); });
    const decisionApi = express.Router();
    mountDecisionRoutes(decisionApi, runtime!, sessions, csrf);
    decisionHttp.use('/api/v1', decisionApi);
    decisionHttp.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = error instanceof HttpError ? error.status : 500;
      res.status(status).json({ error: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' } });
    });
    const decisionServer = createServer(decisionHttp);
    await new Promise<void>(resolve => decisionServer.listen(0, '127.0.0.1', resolve));
    const decisionAddress = decisionServer.address(); assert.ok(decisionAddress && typeof decisionAddress !== 'string');
    try {
      const headers = (actor: string) => ({ cookie: `ceda_session=decision-${actor}`, 'x-csrf-token': 'csrf-test', 'content-type': 'application/json' });
      const outcomeUrl = `http://127.0.0.1:${decisionAddress.port}/api/v1/applications/${application.id}/outcome`;
      const noSession = await fetch(outcomeUrl);
      assert.equal(noSession.status, 401);
      const ownerResponse = await fetch(outcomeUrl, { headers: headers('applicant') });
      assert.equal(ownerResponse.status, 200);
      const ownerJson = await ownerResponse.json() as { data: Record<string, unknown> };
      assert.deepEqual(Object.keys(ownerJson.data).sort(), ['applicationId', 'message', 'outcome', 'programmeId', 'programmeVersionId', 'submissionVersionId']);
      const outsiderResponse = await fetch(outcomeUrl, { headers: headers('outsider') });
      assert.equal(outsiderResponse.status, 404);
      const decisionUrl = `http://127.0.0.1:${decisionAddress.port}/api/v1/applications/${application.id}/decisions`;
      const csrfDenied = await fetch(decisionUrl, { method: 'POST', headers: { cookie: 'ceda_session=decision-adjudicator',
        'content-type': 'application/json', 'idempotency-key': 'route-decision' }, body: JSON.stringify(decisionCommand) });
      assert.equal(csrfDenied.status, 403);
      const replayDecision = await fetch(decisionUrl, { method: 'POST', headers: { ...headers('adjudicator'), 'idempotency-key': 'decision-once' },
        body: JSON.stringify(decisionCommand) });
      assert.equal(replayDecision.status, 409);
      const releaseUrl = `http://127.0.0.1:${decisionAddress.port}/api/v1/decisions/${decisionRow.id}/publish`;
      const replayRelease = await fetch(releaseUrl, { method: 'POST', headers: { ...headers('publisher'), 'idempotency-key': 'release-once' },
        body: JSON.stringify(releaseCommand) });
      assert.equal(replayRelease.status, 200);
      assert.equal((await replayRelease.json() as { data: { replayed: boolean } }).data.replayed, true);
    } finally { await new Promise<void>((resolve, reject) => decisionServer.close(error => error ? reject(error) : resolve())); }
    assert.equal(await owner.decisionAudit.count({ where: { applicationId: application.id } }), 2);
    assert.equal(await owner.decisionOutbox.count({ where: { audit: { applicationId: application.id } } }), 2);
    assert.equal(await owner.decisionCommandReceipt.count({ where: { applicationId: application.id } }), 1);
    assert.equal(await owner.outcomeReleaseReceipt.count({ where: { release: { applicationId: application.id } } }), 1);
    assert.equal(adjudicatorAssignment.applicationId, application.id); assert.equal(publisherAssignment.applicationId, application.id);
  } finally { await runtime?.$disconnect(); await owner.$disconnect(); await admin.end(); }
});
