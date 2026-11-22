import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { Principal } from '../shared/authorization.js';
import { HttpError } from '../shared/errors.js';
import { requireActiveSession, requireProgrammePermission } from '../modules/auth/session-access.js';
import { executeDecisionCommand, type Decision } from '../modules/decisions/policy.js';
import type { Evaluation } from '../modules/evaluations/policy.js';
import type { CommandReceipt, EligibilityInput, TransitionCommand, TransitionContext, WorkflowSnapshot } from '../modules/workflow/engine.js';
import { transitionWorkflow } from '../modules/workflow/engine.js';
import type { WorkflowActor, SubmissionBinding } from '../modules/workflow/authorization.js';
import { executeReleaseCommand, type ApplicantOutcome } from '../modules/feedback/policy.js';
import { publishedDecisionPolicy } from './decision-config.js';
import { PrismaWorkflowRepository } from './workflow-repository.js';
import { PrismaReviewWorkflowFacts } from './review-workflow-facts.js';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const decisionCommandSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative().max(2147483646),
  outcome: z.enum(['APPROVED', 'REJECTED', 'REVISION_REQUESTED']), reason: z.string().trim().min(1).max(4000) });
const releaseCommandSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative().max(2147483646),
  reason: z.string().trim().min(1).max(4000), applicantMessage: z.string().trim().min(1).max(4000) });
const decisionSchema = z.strictObject({
  id: uuid, applicationId: uuid, submissionVersionId: uuid, programmeId: uuid, programmeVersionId: uuid,
  outcome: z.enum(['APPROVED', 'REJECTED', 'REVISION_REQUESTED']), reason: z.string(), adjudicatorId: uuid, released: z.boolean(),
});
const decisionReceiptSchema = z.strictObject({ key: z.string(), actorId: uuid, fingerprint: z.string(), afterRevision: z.number().int(),
  decision: decisionSchema, audit: z.object({ type: z.enum(['DECISION_RECORDED', 'DECISION_RELEASED']), actorId: uuid,
    decisionId: uuid, reason: z.string(), binding: z.object({ applicationId: uuid, submissionVersionId: uuid, programmeId: uuid, programmeVersionId: uuid }),
    outcome: z.enum(['APPROVED', 'REJECTED', 'REVISION_REQUESTED']) }) });
const releaseReceiptSchema = z.strictObject({ key: z.string(), actorId: uuid, fingerprint: z.string(), afterRevision: z.number().int(),
  decision: decisionSchema, applicantOutcome: z.object({ applicationId: uuid, submissionVersionId: uuid, programmeId: uuid,
    programmeVersionId: uuid, outcome: z.enum(['APPROVED', 'REJECTED', 'REVISION_REQUESTED']), message: z.string() }),
  audit: z.object({ type: z.enum(['DECISION_RECORDED', 'DECISION_RELEASED']), actorId: uuid, decisionId: uuid, reason: z.string(),
    binding: z.object({ applicationId: uuid, submissionVersionId: uuid, programmeId: uuid, programmeVersionId: uuid }),
    outcome: z.enum(['APPROVED', 'REJECTED', 'REVISION_REQUESTED']) }) });

type ContextRow = {
  application: { id: string; ownerId: string; programmeId: string; programmeVersionId: string; stage: string; programmeVersion: { publishedAt: Date; config: unknown } };
  snapshot: { applicationId: string; submissionVersionId: string; eligibilityCheckId: string; state: string; revision: number;
    submission: { id: string; applicationId: string; programmeVersionId: string; version: number };
    eligibilityCheck: { id: string; ruleVersionId: string; overallStatus: string; createdAt: Date; ruleVersion: { publishedAt: Date };
      findings: Array<{ requirementId: string; status: string; unknownReason: string | null }>;
      audit: { outbox: { auditId: string } | null } | null } };
  binding: SubmissionBinding;
  eligibility: EligibilityInput;
  workflow: WorkflowSnapshot;
  occurredAt: string;
};

const hidden = () => new HttpError(404, 'NOT_FOUND', 'Resource not found.');
const conflict = (code = 'REVISION_CONFLICT') => new HttpError(409, code, 'The command conflicts with current application state.');
const configurationError = () => new HttpError(503, 'CONFIGURATION_ERROR', 'The published decision configuration is invalid or unavailable.');

function policyError(code: string): HttpError {
  if (code === 'FORBIDDEN') return hidden();
  if (code === 'CONFIGURATION_ERROR') return configurationError();
  if (code === 'INVALID_INPUT') return new HttpError(422, code, 'The decision command is invalid.');
  if (code === 'INCOMPLETE_EVALUATIONS') return conflict(code);
  if (code === 'REVISION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT' || code === 'CONFLICT') return conflict(code);
  return conflict(code);
}

function decisionFromRow(row: { id: string; applicationId: string; submissionVersionId: string; programmeId: string;
  outcome: string; reason: string; adjudicatorId: string; releasedAt: Date | null }, programmeVersionId: string): Decision {
  return { id: row.id, applicationId: row.applicationId, submissionVersionId: row.submissionVersionId, programmeId: row.programmeId,
    programmeVersionId, outcome: row.outcome as Decision['outcome'], reason: row.reason, adjudicatorId: row.adjudicatorId,
    released: row.releasedAt !== null };
}

function workflowContext(context: ContextRow, actor: WorkflowActor, guards: TransitionContext['guards']): TransitionContext {
  return { actor, guards, eligibility: structuredClone(context.eligibility), occurredAt: context.occurredAt };
}

/** Decision, workflow, audit, receipt and outbox persistence share one serializable application transaction. */
export class PrismaDecisionRepository {
  private readonly principal: Principal;
  private readonly requestId: string;

  constructor(private readonly prisma: PrismaClient, principal: Principal, requestId: string) {
    this.principal = z.object({ userId: uuid, sessionId: uuid, authnLevel: z.string().min(1) }).parse(principal);
    this.requestId = uuid.parse(requestId);
  }

  async lockScores(applicationIdInput: string, expectedRevision: number, idempotencyKey: string) {
    return this.workflowTransition(applicationIdInput, 'LOCK_SCORES', expectedRevision, idempotencyKey);
  }

  async openAdjudication(applicationIdInput: string, expectedRevision: number, idempotencyKey: string) {
    return this.workflowTransition(applicationIdInput, 'OPEN_ADJUDICATION', expectedRevision, idempotencyKey);
  }

  private async workflowTransition(applicationIdInput: string, transition: 'LOCK_SCORES' | 'OPEN_ADJUDICATION',
    expectedRevision: number, keyInput: string) {
    const applicationId = uuid.parse(applicationIdInput);
    const key = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/).parse(keyInput);
    const app = await this.prisma.application.findUnique({ where: { id: applicationId }, include: { workflowState: true } });
    if (!app?.workflowState) throw hidden();
    const checkId = app.workflowState.eligibilityCheckId;
    const command: TransitionCommand = { applicationId, submissionVersionId: app.workflowState.submissionVersionId,
      programmeId: app.programmeId, programmeVersionId: app.programmeVersionId, transition,
      expectedRevision, idempotencyKey: `${transition === 'LOCK_SCORES' ? 'ls' : 'oa'}_${key}`, reason: '' };
    const result = await new PrismaWorkflowRepository(this.prisma, { principal: this.principal, requestId: this.requestId,
      eligibilityCheckId: checkId }, new PrismaReviewWorkflowFacts()).transaction(async port => {
      const loaded = await port.read(command);
      const decision = transitionWorkflow(loaded.snapshot, command, loaded.context, loaded.prior);
      if (decision.ok && !decision.replayed) await port.commit(decision.receipt);
      return decision;
    });
    if (!result.ok) throw result.code === 'FORBIDDEN' ? hidden() : conflict(result.code);
    return { applicationId, state: result.receipt.change.after.state, revision: result.receipt.change.after.revision,
      replayed: result.replayed };
  }

  async recordDecision(applicationIdInput: string, input: unknown, idempotencyKeyInput: string) {
    const applicationId = uuid.parse(applicationIdInput);
    const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).safeParse(idempotencyKeyInput);
    const parsed = decisionCommandSchema.safeParse(input);
    if (!key.success || !parsed.success) throw new HttpError(422, 'VALIDATION_FAILED', 'A valid decision command and Idempotency-Key are required.');
    const commandInput = parsed.data;
    return this.prisma.$transaction(async db => {
      await requireActiveSession(db, this.principal);
      await db.$queryRaw`SELECT id FROM applications WHERE id=${applicationId}::uuid FOR UPDATE`;
      const context = await this.loadContext(db, applicationId);
      await requireProgrammePermission(db, this.principal, context.binding.programmeId, 'adjudication.decide');
      const assignment = await this.authorizedAssignment(db, context, 'adjudication.decide');
      const policy = publishedDecisionPolicy(context.application.programmeVersion.config);
      if (!policy) throw configurationError();
      const evaluations = await this.finalizedEvaluations(db, context);
      if (!await this.reviewsComplete(db, context)) throw conflict('INCOMPLETE_EVALUATIONS');

      const priorRow = await db.decisionCommandReceipt.findUnique({ where: { applicationId_actorId_key: {
        applicationId, actorId: this.principal.userId, key: key.data,
      } } });
      const prior = priorRow ? decisionReceiptSchema.safeParse(priorRow.result) : null;
      if (priorRow && !prior?.success) throw new HttpError(500, 'INTERNAL_ERROR', 'The saved decision receipt is invalid.');
      const existingRow = await db.adjudicationDecision.findUnique({ where: { applicationId } });
      const existingDecision = existingRow ? decisionFromRow(existingRow, context.application.programmeVersionId) : null;
      const proposed: Decision = prior?.success ? { ...prior.data.decision, outcome: commandInput.outcome, reason: commandInput.reason } : {
        id: randomUUID(), ...context.binding, outcome: commandInput.outcome, reason: commandInput.reason,
        adjudicatorId: this.principal.userId, released: false,
      };
      const actor = this.actor(context, assignment, 'adjudicator', 'adjudication.decide');
      const decisionResult = executeDecisionCommand(actor, context.binding, context.application.ownerId, context.snapshot.state as never,
        context.snapshot.revision, evaluations, { policy, existingDecision }, { expectedRevision: commandInput.expectedRevision,
          idempotencyKey: key.data, decision: proposed }, prior?.success ? prior.data : undefined);
      if (!decisionResult.ok) throw policyError(decisionResult.code);
      if (decisionResult.replayed) return { decisionId: decisionResult.receipt.decision.id, outcome: decisionResult.receipt.decision.outcome,
        revision: decisionResult.receipt.afterRevision, replayed: true };
      if (existingRow || context.snapshot.state !== 'ADJUDICATION') throw conflict('CONFLICT');

      const workflowCommand: TransitionCommand = { ...context.binding, transition: 'DECIDE', expectedRevision: context.snapshot.revision,
        idempotencyKey: `dc_${key.data}`.slice(0, 128), reason: commandInput.reason };
      const workflowDecision = transitionWorkflow(context.workflow, workflowCommand,
        workflowContext(context, actor, { humanDecision: true, evidenceComplete: true, separationOfDuties: true }));
      if (!workflowDecision.ok) throw policyError(workflowDecision.code);
      const receipt = decisionResult.receipt;
      const decision = await db.adjudicationDecision.create({ data: { id: receipt.decision.id, applicationId,
        submissionVersionId: context.binding.submissionVersionId, programmeId: context.binding.programmeId,
        adjudicatorId: this.principal.userId, outcome: receipt.decision.outcome, reason: receipt.decision.reason,
        workflowRevision: workflowDecision.receipt.change.after.revision } });
      await this.commitWorkflow(db, context, workflowDecision.receipt);
      const auditId = randomUUID();
      await db.$executeRaw`INSERT INTO decision_audits (id,decision_id,application_id,submission_version_id,actor_id,workflow_revision,request_id,action,reason,outcome)
        VALUES (${auditId}::uuid,${decision.id}::uuid,${applicationId}::uuid,${decision.submissionVersionId}::uuid,${this.principal.userId}::uuid,
          ${decision.workflowRevision},${this.requestId}::uuid,'DECISION_RECORDED',${decision.reason},${decision.outcome})`;
      await db.$executeRaw`INSERT INTO decision_outbox (audit_id) VALUES (${auditId}::uuid)`;
      await db.decisionCommandReceipt.create({ data: { applicationId, actorId: this.principal.userId, key: key.data,
        fingerprint: receipt.fingerprint, auditId, result: receipt as unknown as Prisma.InputJsonValue } });
      return { decisionId: decision.id, outcome: decision.outcome, revision: decision.workflowRevision, replayed: false };
    }, { maxWait: 5000, timeout: 15000 });
  }

  async releaseDecision(decisionIdInput: string, input: unknown, idempotencyKeyInput: string) {
    const decisionId = uuid.parse(decisionIdInput);
    const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).safeParse(idempotencyKeyInput);
    const parsed = releaseCommandSchema.safeParse(input);
    if (!key.success || !parsed.success) throw new HttpError(422, 'VALIDATION_FAILED', 'A valid outcome release command and Idempotency-Key are required.');
    const command = parsed.data;
    return this.prisma.$transaction(async db => {
      await requireActiveSession(db, this.principal);
      const initial = await db.adjudicationDecision.findUnique({ where: { id: decisionId }, select: { applicationId: true } });
      if (!initial) throw hidden();
      await db.$queryRaw`SELECT id FROM applications WHERE id=${initial.applicationId}::uuid FOR UPDATE`;
      const context = await this.loadContext(db, initial.applicationId);
      const row = await db.adjudicationDecision.findUnique({ where: { id: decisionId } });
      if (!row || row.applicationId !== context.binding.applicationId || row.submissionVersionId !== context.binding.submissionVersionId ||
          row.programmeId !== context.binding.programmeId) throw hidden();
      await requireProgrammePermission(db, this.principal, context.binding.programmeId, 'decision.publish');
      const assignment = await this.authorizedAssignment(db, context, 'decision.publish');
      const persistedRelease = await db.outcomeRelease.findUnique({ where: { decisionId: row.id } });
      const priorRow = persistedRelease ? await db.outcomeReleaseReceipt.findFirst({ where: {
        releaseId: persistedRelease.id, publisherId: this.principal.userId, key: key.data,
      } }) : null;
      const prior = priorRow ? releaseReceiptSchema.safeParse(priorRow.result) : null;
      if (priorRow && !prior?.success) throw new HttpError(500, 'INTERNAL_ERROR', 'The saved release receipt is invalid.');
      const decision = decisionFromRow(row, context.application.programmeVersionId);
      const actor = this.actor(context, assignment, 'publisher', 'decision.publish');
      const releaseResult = executeReleaseCommand(actor, context.binding, context.application.ownerId,
        context.snapshot.state as never, context.snapshot.revision, decision,
        { expectedRevision: command.expectedRevision, idempotencyKey: key.data, reason: command.reason, applicantMessage: command.applicantMessage },
        prior?.success ? prior.data : undefined);
      if (!releaseResult.ok) throw policyError(releaseResult.code);
      if (releaseResult.replayed) return { decisionId, revision: releaseResult.receipt.afterRevision, replayed: true };
      if (persistedRelease || context.snapshot.state !== 'DECIDED') throw conflict('INVALID_STATE');

      const workflowCommand: TransitionCommand = { ...context.binding, transition: 'RELEASE', expectedRevision: context.snapshot.revision,
        idempotencyKey: `rl_${key.data}`.slice(0, 128), reason: command.reason };
      const workflowDecision = transitionWorkflow(context.workflow, workflowCommand,
        workflowContext(context, actor, { releaseReviewed: true, humanDecision: true }));
      if (!workflowDecision.ok) throw policyError(workflowDecision.code);

      const auditId = randomUUID();
      await db.$executeRaw`INSERT INTO decision_audits (id,decision_id,application_id,submission_version_id,actor_id,workflow_revision,request_id,action,reason,outcome)
        VALUES (${auditId}::uuid,${row.id}::uuid,${row.applicationId}::uuid,${row.submissionVersionId}::uuid,${this.principal.userId}::uuid,
          ${workflowDecision.receipt.change.after.revision},${this.requestId}::uuid,'DECISION_RELEASED',${command.reason},${row.outcome})`;
      await db.$executeRaw`INSERT INTO decision_outbox (audit_id) VALUES (${auditId}::uuid)`;
      const release = await db.outcomeRelease.create({ data: { id: randomUUID(), decisionId: row.id, applicationId: row.applicationId,
        submissionVersionId: row.submissionVersionId, programmeId: row.programmeId, publisherId: this.principal.userId,
        outcome: row.outcome, applicantMessage: command.applicantMessage, releaseReason: command.reason, releaseAuditId: auditId } });
      await db.adjudicationDecision.update({ where: { id: row.id }, data: { releasedAt: new Date() } });
      await this.commitWorkflow(db, context, workflowDecision.receipt);
      await db.outcomeReleaseReceipt.create({ data: { id: randomUUID(), releaseId: release.id, publisherId: this.principal.userId,
        key: key.data, fingerprint: releaseResult.receipt.fingerprint, result: releaseResult.receipt as unknown as Prisma.InputJsonValue } });
      return { decisionId, revision: releaseResult.receipt.afterRevision, replayed: false };
    }, { maxWait: 5000, timeout: 15000 });
  }

  async readApplicantOutcome(applicationIdInput: string): Promise<ApplicantOutcome> {
    const applicationId = uuid.parse(applicationIdInput);
    return this.prisma.$transaction(async db => {
      await requireActiveSession(db, this.principal);
      const row = await db.outcomeRelease.findFirst({ where: { applicationId,
        application: { ownerId: this.principal.userId },
        decision: { releasedAt: { not: null } },
      }, include: { application: { include: { workflowState: true } } } });
      if (!row || row.application.workflowState?.state !== 'OUTCOME_RELEASED' ||
          row.application.workflowState.submissionVersionId !== row.submissionVersionId) throw hidden();
      return { applicationId: row.applicationId, submissionVersionId: row.submissionVersionId, programmeId: row.programmeId,
        programmeVersionId: row.application.programmeVersionId, outcome: row.outcome as ApplicantOutcome['outcome'], message: row.applicantMessage };
    }, { maxWait: 5000, timeout: 10000 });
  }

  private async loadContext(db: Prisma.TransactionClient, applicationId: string): Promise<ContextRow> {
    const row = await db.application.findUnique({ where: { id: applicationId }, include: {
      programmeVersion: true,
      workflowState: { include: { submission: true, eligibilityCheck: { include: {
        ruleVersion: true, findings: { orderBy: { requirementId: 'asc' } }, audit: { include: { outbox: true } },
      } } } },
    } });
    const clock = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (!row || row.stage !== 'SUBMITTED' || !row.workflowState || !row.workflowState.eligibilityCheck.audit?.outbox ||
        row.programmeVersion.publishedAt > clock[0]!.now || row.workflowState.eligibilityCheck.ruleVersion.publishedAt > clock[0]!.now ||
        row.workflowState.submission.id !== row.workflowState.submissionVersionId ||
        row.workflowState.submission.applicationId !== row.id || row.workflowState.submission.programmeVersionId !== row.programmeVersionId) throw hidden();
    const binding: SubmissionBinding = { applicationId: row.id, submissionVersionId: row.workflowState.submissionVersionId,
      programmeId: row.programmeId, programmeVersionId: row.programmeVersionId };
    const result = z.object({ status: z.enum(['MET', 'NOT_MET', 'UNKNOWN']), findings: z.array(z.object({
      requirementId: z.string().min(1), status: z.enum(['MET', 'NOT_MET', 'UNKNOWN']), unknownReason: z.string().optional(),
    })) }).safeParse({ status: row.workflowState.eligibilityCheck.overallStatus, findings: row.workflowState.eligibilityCheck.findings.map(finding => ({
      requirementId: finding.requirementId, status: finding.status, ...(finding.unknownReason ? { unknownReason: finding.unknownReason } : {}),
    })) });
    if (!result.success) throw hidden();
    const workflow: WorkflowSnapshot = { ...binding, ownerId: row.ownerId, ruleSetVersion: row.workflowState.eligibilityCheck.ruleVersionId,
      state: row.workflowState.state as WorkflowSnapshot['state'], revision: row.workflowState.revision };
    return { application: row, snapshot: row.workflowState, binding, eligibility: { ...binding,
      ruleSetVersion: row.workflowState.eligibilityCheck.ruleVersionId, status: result.data.status, findings: result.data.findings },
      workflow, occurredAt: clock[0]!.now.toISOString() } as unknown as ContextRow;
  }

  private actor(context: ContextRow, assignment: NonNullable<Awaited<ReturnType<PrismaDecisionRepository['authorizedAssignment']>>>,
    role: 'adjudicator' | 'publisher', permission: string): WorkflowActor {
    return { userId: this.principal.userId, sessionActive: true, role,
      grants: [{ permission, programmeId: context.binding.programmeId, active: true }],
      assignment: { ...context.binding, userId: this.principal.userId, active: true, revoked: false, conflictCleared: true } };
  }

  private async authorizedAssignment(db: Prisma.TransactionClient, context: ContextRow, _permission: string) {
    const actorId = this.principal.userId;
    const clock = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = clock[0]?.now;
    if (!now) throw hidden();
    await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended(
      'officer-assignment-set:' || ${context.binding.applicationId}::uuid::text || ':' || ${context.binding.submissionVersionId}::uuid::text || ':' || ${context.binding.programmeId}::uuid::text,0))`;
    await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended(
      'officer-assignment-scope:' || ${actorId}::uuid::text || ':' || ${context.binding.applicationId}::uuid::text || ':' ||
      ${context.binding.submissionVersionId}::uuid::text || ':' || ${context.binding.programmeId}::uuid::text,0))`;
    const candidates = await db.officerAssignment.findMany({ where: { actorId, applicationId: context.binding.applicationId,
      submissionVersionId: context.binding.submissionVersionId, programmeId: context.binding.programmeId,
      status: 'ACTIVE', revokedAt: null, issuedById: { not: null }, issuedRequestId: { not: null }, validFrom: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
    if (candidates.length !== 1) throw hidden();
    const assignment = candidates[0]!;
    await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended('officer-conflict:' || ${assignment.id}::uuid::text,0))`;
    const conflicts = await db.conflictDisclosure.findMany({ where: { assignmentId: assignment.id } });
    const clear = conflicts.length > 0 && conflicts.every(conflict => (conflict.status === 'CLEARED' || conflict.status === 'NO_CONFLICT') &&
      conflict.disclosedById !== null && conflict.disclosedRequestId !== null && conflict.resolvedAt !== null &&
      conflict.resolvedById !== null && conflict.resolutionRequestId !== null &&
      (conflict.status === 'NO_CONFLICT' || !!conflict.resolution?.trim()));
    if (!clear || context.application.ownerId === actorId) throw hidden();
    return assignment;
  }

  private async finalizedEvaluations(db: Prisma.TransactionClient, context: ContextRow): Promise<readonly Evaluation[]> {
    const rows = await db.evaluation.findMany({ where: { applicationId: context.binding.applicationId,
      submissionVersionId: context.binding.submissionVersionId, state: 'FINALIZED' },
      include: { scores: { orderBy: { criterionId: 'asc' } } } });
    return rows.map(row => ({ ...context.binding, assignmentId: row.assignmentId, officerId: row.evaluatorId,
      revision: row.revision, state: row.state as Evaluation['state'],
      scores: row.scores.map(score => ({ criterionId: score.criterionId, value: score.value, evidence: score.evidence,
        ...(score.comment === null ? {} : { comment: score.comment }) })),
      comment: row.comment, recommendation: row.recommendation as Evaluation['recommendation'], total: row.total }));
  }

  private async reviewsComplete(db: Prisma.TransactionClient, context: ContextRow): Promise<boolean> {
    const rows = await db.$queryRaw<Array<{ state: string | null; comment: string | null; recommendation: string | null;
      score_count: bigint; conflict_count: bigint; invalid_conflicts: boolean }>>`
      SELECT e.state,e.comment,e.recommendation,
        (SELECT count(*) FROM evaluation_scores s WHERE s.evaluation_id=e.id) AS score_count,
        (SELECT count(*) FROM conflict_disclosures c WHERE c.assignment_id=a.id) AS conflict_count,
        EXISTS (SELECT 1 FROM conflict_disclosures c WHERE c.assignment_id=a.id AND
          (c.status NOT IN ('CLEARED','NO_CONFLICT') OR c.disclosed_by_id IS NULL OR c.disclosed_request_id IS NULL OR
           c.resolved_at IS NULL OR c.resolved_by_id IS NULL OR c.resolution_request_id IS NULL OR
           (c.status='CLEARED' AND length(btrim(coalesce(c.resolution,'')))=0))) AS invalid_conflicts
      FROM officer_assignments a
      JOIN programme_grants g ON g.user_id=a.actor_id AND g.programme_id=a.programme_id AND g.permission='evaluation.write'
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
      LEFT JOIN evaluations e ON e.assignment_id=a.id AND e.application_id=a.application_id AND e.submission_version_id=a.submission_version_id
      WHERE a.application_id=${context.binding.applicationId}::uuid AND a.submission_version_id=${context.binding.submissionVersionId}::uuid
        AND a.programme_id=${context.binding.programmeId}::uuid AND a.status='ACTIVE' AND a.revoked_at IS NULL
        AND a.valid_from<=clock_timestamp() AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
        AND a.issued_by_id IS NOT NULL AND a.issued_request_id IS NOT NULL`;
    return rows.length > 0 && rows.every(row => row.state === 'FINALIZED' && !!row.comment?.trim() && !!row.recommendation &&
      row.score_count > 0n && row.conflict_count > 0n && !row.invalid_conflicts);
  }

  private async commitWorkflow(db: Prisma.TransactionClient, context: ContextRow, receipt: CommandReceipt) {
    const change = receipt.change;
    const after = change.after;
    const updated = await db.stateSnapshot.updateMany({ where: { applicationId: after.applicationId,
      submissionVersionId: after.submissionVersionId, eligibilityCheckId: context.snapshot.eligibilityCheckId,
      revision: change.before.revision, state: change.before.state }, data: { state: after.state, revision: after.revision, updatedAt: new Date() } });
    if (updated.count !== 1) throw conflict();
    const eventId = randomUUID();
    await db.workflowEvent.create({ data: { id: eventId, applicationId: after.applicationId, submissionVersionId: after.submissionVersionId,
      eligibilityCheckId: context.snapshot.eligibilityCheckId, revision: after.revision, previousState: change.before.state,
      nextState: after.state, actorId: receipt.actorId, action: change.audit.type, reason: change.audit.reason,
      createdAt: new Date(change.audit.occurredAt) } });
    await db.workflowCommandReceipt.create({ data: { applicationId: after.applicationId, actorId: receipt.actorId,
      key: receipt.key, fingerprint: receipt.fingerprint, eventId, change: change as unknown as Prisma.InputJsonValue } });
    await db.workflowAudit.create({ data: { eventId, requestId: this.requestId } });
    await db.workflowOutbox.create({ data: { eventId } });
  }
}
