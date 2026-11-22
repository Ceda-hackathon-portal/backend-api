import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { canReviewAssignment, type ReviewAssignment } from '../modules/assignments/policy.js';
import { executeEvaluationCommand, type Evaluation as DomainEvaluation, type EvaluationWrite } from '../modules/evaluations/policy.js';
import type { WorkflowActor } from '../modules/workflow/authorization.js';
import { requireActiveSession, requireProgrammePermission } from '../modules/auth/session-access.js';
import type { Principal } from '../shared/authorization.js';
import { HttpError } from '../shared/errors.js';
import { publishedScoringConfig } from './review-config.js';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const commandSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  scores: z.array(z.strictObject({ criterionId: z.string().min(1).max(100), value: z.number().finite(), evidence: z.string().max(4000), comment: z.string().max(4000).optional() })),
  comment: z.string().max(4000),
  recommendation: z.enum(['APPROVE', 'REJECT', 'REVISE']).nullable(),
  finalize: z.boolean(),
});
const evaluationSchema = z.strictObject({
  applicationId: uuid, submissionVersionId: uuid, programmeId: uuid, programmeVersionId: uuid,
  assignmentId: uuid, officerId: uuid, revision: z.number().int().positive(),
  state: z.enum(['DRAFT', 'FINALIZED']),
  scores: z.array(z.strictObject({ criterionId: z.string(), value: z.number().finite(), evidence: z.string(), comment: z.string().optional() })),
  comment: z.string(), recommendation: z.enum(['APPROVE', 'REJECT', 'REVISE']).nullable(), total: z.number().finite().nullable(),
});
type PersistedEvaluation = z.infer<typeof evaluationSchema>;

const hidden = () => new HttpError(404, 'NOT_FOUND', 'Resource not found.');
const conflict = (code = 'REVISION_CONFLICT') => new HttpError(409, code, 'The evaluation changed or is no longer writable.');
const configurationError = () => new HttpError(503, 'CONFIGURATION_ERROR', 'The published scoring configuration is invalid or unavailable.');

function fingerprint(assignmentId: string, command: z.infer<typeof commandSchema>): string {
  return createHash('sha256').update(JSON.stringify([assignmentId, command.expectedRevision, command.scores,
    command.comment, command.recommendation, command.finalize])).digest('hex');
}

function policyError(code: string): HttpError {
  if (code === 'FORBIDDEN') return hidden();
  if (code === 'CONFIGURATION_ERROR') return configurationError();
  if (code === 'INVALID_INPUT') return new HttpError(422, code, 'The evaluation is invalid.');
  if (code === 'REVISION_CONFLICT') return conflict();
  return conflict(code);
}

/** Transaction-backed adapter for B's evaluator policy. */
export class PrismaEvaluationRepository {
  constructor(private readonly prisma: PrismaClient, private readonly principal: Principal, private readonly requestId: string) {}

  async write(assignmentIdInput: string, input: EvaluationWrite & { readonly idempotencyKey: string }): Promise<PersistedEvaluation> {
    const principal = z.object({ userId: uuid, sessionId: uuid, authnLevel: z.string().min(1) }).parse(this.principal);
    const requestId = uuid.parse(this.requestId);
    const assignmentId = uuid.parse(assignmentIdInput);
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(422, 'VALIDATION_FAILED', 'A valid evaluation command is required.');
    const command = parsed.data;
    const requestFingerprint = fingerprint(assignmentId, command);

    return this.prisma.$transaction(async db => {
      await requireActiveSession(db, principal);
      const initial = await db.$queryRaw<Array<{ application_id: string; submission_version_id: string; programme_id: string; actor_id: string }>>`
        SELECT application_id,submission_version_id,programme_id,actor_id FROM officer_assignments WHERE id=${assignmentId}::uuid`;
      if (initial.length !== 1) throw hidden();
      const raw = initial[0]!;
      await requireProgrammePermission(db, principal, raw.programme_id, 'evaluation.write');
      if (command.finalize) await requireProgrammePermission(db, principal, raw.programme_id, 'evaluation.submit');

      // Shared advisory locks serialize reads against assignment revocation and conflict writes.
      await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended(
        'officer-assignment-scope:' || ${principal.userId}::uuid::text || ':' || ${raw.application_id}::uuid::text || ':' ||
        ${raw.submission_version_id}::uuid::text || ':' || ${raw.programme_id}::uuid::text,0))`;
      await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended('officer-conflict:' || ${assignmentId}::uuid::text,0))`;
      await db.$queryRaw`SELECT id FROM applications WHERE id=${raw.application_id}::uuid FOR UPDATE`;

      const records = await db.$queryRaw<Array<{
        assignment_id: string; application_id: string; submission_version_id: string; programme_id: string; actor_id: string;
        owner_id: string; application_version_id: string; submitted_version_id: string; submission_programme_version_id: string;
        workflow_state: string | null; status: string; valid_from: Date; expires_at: Date | null; revoked_at: Date | null;
        issued_by_id: string | null; issued_request_id: string | null; config: unknown;
      }>>`
        SELECT a.id AS assignment_id,a.application_id,a.submission_version_id,a.programme_id,a.actor_id,
          app.owner_id,app.programme_version_id AS application_version_id,sv.id AS submitted_version_id,
          sv.programme_version_id AS submission_programme_version_id,ws.state AS workflow_state,
          a.status,a.valid_from,a.expires_at,a.revoked_at,a.issued_by_id,a.issued_request_id,pv.config
        FROM officer_assignments a
        JOIN applications app ON app.id=a.application_id AND app.programme_id=a.programme_id
        JOIN submission_versions sv ON sv.id=a.submission_version_id AND sv.application_id=a.application_id
        JOIN programme_versions pv ON pv.id=sv.programme_version_id AND pv.programme_id=app.programme_id
        LEFT JOIN workflow_state ws ON ws.application_id=app.id
        WHERE a.id=${assignmentId}::uuid AND a.actor_id=${principal.userId}::uuid
          AND app.programme_version_id=sv.programme_version_id
          AND a.status='ACTIVE' AND a.revoked_at IS NULL AND a.valid_from<=clock_timestamp()
          AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
          AND a.issued_by_id IS NOT NULL AND a.issued_request_id IS NOT NULL`;
      if (records.length !== 1) throw hidden();
      const row = records[0]!;
      if (row.workflow_state !== 'UNDER_EVALUATION' || row.submitted_version_id !== row.submission_version_id ||
          row.application_version_id !== row.submission_programme_version_id || row.owner_id.toLowerCase() === principal.userId) throw hidden();

      const conflicts = await db.$queryRaw<Array<{
        status: string; disclosed_by_id: string | null; disclosed_request_id: string | null;
        resolved_at: Date | null; resolved_by_id: string | null; resolution_request_id: string | null; resolution: string | null;
      }>>`SELECT status,disclosed_by_id,disclosed_request_id,resolved_at,resolved_by_id,resolution_request_id,resolution
        FROM conflict_disclosures WHERE assignment_id=${assignmentId}::uuid`;
      const cleared = conflicts.length > 0 && conflicts.every(value =>
        (value.status === 'CLEARED' || value.status === 'NO_CONFLICT') && value.disclosed_by_id !== null && value.disclosed_request_id !== null &&
        value.resolved_at !== null && value.resolved_by_id !== null && value.resolution_request_id !== null &&
        (value.status === 'NO_CONFLICT' || !!value.resolution?.trim()));
      if (!cleared) throw hidden();

      const assignment: ReviewAssignment = {
        applicationId: row.application_id, submissionVersionId: row.submission_version_id,
        programmeId: row.programme_id, programmeVersionId: row.application_version_id,
        id: row.assignment_id, officerId: row.actor_id, ownerId: row.owner_id,
        active: true, revoked: false, conflict: 'CLEARED',
      };
      const binding = { applicationId: row.application_id, submissionVersionId: row.submission_version_id,
        programmeId: row.programme_id, programmeVersionId: row.application_version_id };
      const actor: WorkflowActor = { userId: principal.userId, sessionActive: true, role: 'evaluator',
        grants: [{ permission: 'evaluation.write', programmeId: row.programme_id, active: true }] };
      if (!canReviewAssignment(actor, assignment, binding)) throw hidden();

      const prior = await db.evaluationCommandReceipt.findUnique({ where: { assignmentId_evaluatorId_key: {
        assignmentId, evaluatorId: principal.userId, key: command.idempotencyKey,
      } } });
      if (prior) {
        if (prior.fingerprint !== requestFingerprint) throw conflict('IDEMPOTENCY_CONFLICT');
        const result = evaluationSchema.safeParse(prior.result);
        if (!result.success) throw new HttpError(500, 'INTERNAL_ERROR', 'The saved evaluation receipt is invalid.');
        return result.data;
      }

      const existing = await db.evaluation.findUnique({ where: { assignmentId }, include: { scores: { orderBy: { criterionId: 'asc' } } } });
      const current: DomainEvaluation = existing ? {
        ...binding, assignmentId, officerId: existing.evaluatorId, revision: existing.revision,
        state: existing.state as DomainEvaluation['state'],
        scores: existing.scores.map(score => ({ criterionId: score.criterionId, value: score.value, evidence: score.evidence,
          ...(score.comment === null ? {} : { comment: score.comment }) })),
        comment: existing.comment, recommendation: existing.recommendation as DomainEvaluation['recommendation'], total: existing.total,
      } : { ...binding, assignmentId, officerId: principal.userId, revision: 0, state: 'DRAFT', scores: [], comment: '', recommendation: null, total: null };
      const config = publishedScoringConfig(row.config);
      if (!config) throw configurationError();
      const policyCommand = { ...command, scores: command.scores.map(({ comment, ...score }) => ({ ...score,
        ...(comment === undefined ? {} : { comment }) })) };
      const decision = executeEvaluationCommand(actor, assignment, current, binding, config, policyCommand);
      if (!decision.ok) throw policyError(decision.code);
      const next = evaluationSchema.parse(decision.receipt.evaluation);

      let evaluationId = existing?.id;
      if (!evaluationId) {
        const inserted = await db.evaluation.create({ data: { assignmentId, applicationId: next.applicationId,
          submissionVersionId: next.submissionVersionId, evaluatorId: principal.userId, revision: next.revision,
          state: 'DRAFT', comment: next.comment, recommendation: next.recommendation, total: next.total } });
        evaluationId = inserted.id;
      } else {
        const changed = await db.evaluation.updateMany({ where: { id: evaluationId, revision: command.expectedRevision, state: 'DRAFT' },
          data: { revision: next.revision, comment: next.comment, recommendation: next.recommendation, total: next.total, updatedAt: new Date() } });
        if (changed.count !== 1) throw conflict();
      }
      await db.evaluationScore.deleteMany({ where: { evaluationId } });
      if (next.scores.length) await db.evaluationScore.createMany({ data: next.scores.map(score => ({ evaluationId: evaluationId!, criterionId: score.criterionId,
        value: score.value, evidence: score.evidence, comment: score.comment ?? null })) });
      if (next.state === 'FINALIZED') await db.evaluation.update({ where: { id: evaluationId }, data: { state: 'FINALIZED', finalizedAt: new Date() } });

      const audit = await db.evaluationAudit.create({ data: { id: randomUUID(), evaluationId, applicationId: next.applicationId,
        submissionVersionId: next.submissionVersionId, actorId: principal.userId, revision: next.revision, requestId,
        action: decision.receipt.audit.type } });
      await db.evaluationOutbox.create({ data: { auditId: audit.id } });
      await db.evaluationCommandReceipt.create({ data: { assignmentId, evaluatorId: principal.userId, evaluationId,
        key: command.idempotencyKey, fingerprint: requestFingerprint, result: next as unknown as Prisma.InputJsonValue } });
      return next;
    }, { maxWait: 5000, timeout: 15000 });
  }
}
