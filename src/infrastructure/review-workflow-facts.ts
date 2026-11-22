import type { Prisma } from '../generated/prisma/client.js';
import type { WorkflowFactSource } from './workflow-repository.js';

/** Transaction-local evaluator/adjudicator assignment facts for the validated workflow subset. */
export class PrismaReviewWorkflowFacts implements WorkflowFactSource {
  async read(db: Prisma.TransactionClient, context: Parameters<WorkflowFactSource['read']>[1]) {
    const supportedRole = context.role === 'evaluator' || context.role === 'adjudicator' || context.role === 'publisher';
    let assignment: NonNullable<Awaited<ReturnType<WorkflowFactSource['read']>>['assignment']> | undefined;
    if (supportedRole) {
      const clock = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = clock[0]?.now;
      if (!now) return { guards: {} };
      await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended(
        'officer-assignment-scope:' || ${context.principal.userId}::uuid::text || ':' ||
        ${context.snapshot.applicationId}::uuid::text || ':' || ${context.snapshot.submissionVersionId}::uuid::text || ':' ||
        ${context.snapshot.programmeId}::uuid::text,0))`;
      const rows = await db.officerAssignment.findMany({ where: {
        actorId: context.principal.userId, applicationId: context.snapshot.applicationId,
        submissionVersionId: context.snapshot.submissionVersionId, programmeId: context.snapshot.programmeId,
        status: 'ACTIVE', validFrom: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        revokedAt: null, issuedById: { not: null }, issuedRequestId: { not: null },
      } });
      if (rows.length === 1) {
        const row = rows[0]!;
        await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended('officer-conflict:' || ${row.id}::uuid::text,0))`;
        const conflicts = await db.conflictDisclosure.findMany({ where: { assignmentId: row.id } });
        const clear = conflicts.length > 0 && conflicts.every(conflict =>
          (conflict.status === 'CLEARED' || conflict.status === 'NO_CONFLICT') && conflict.disclosedById !== null &&
          conflict.disclosedRequestId !== null && conflict.resolvedAt !== null && conflict.resolvedById !== null &&
          conflict.resolutionRequestId !== null && (conflict.status === 'NO_CONFLICT' || !!conflict.resolution?.trim()));
        if (clear) assignment = {
          applicationId: context.snapshot.applicationId, submissionVersionId: context.snapshot.submissionVersionId,
          programmeId: context.snapshot.programmeId, programmeVersionId: context.snapshot.programmeVersionId,
          userId: context.principal.userId, active: true, revoked: false, conflictCleared: true,
        };
      }
    }

    let evaluationsComplete = false;
    if (context.role === 'evaluator' || context.role === 'adjudicator') {
      const rows = await db.$queryRaw<Array<{ state: string | null; comment: string | null; recommendation: string | null; score_count: bigint; conflicted: boolean }>>`
        SELECT e.state,e.comment,e.recommendation,
          (SELECT count(*) FROM evaluation_scores s WHERE s.evaluation_id=e.id) AS score_count,
          EXISTS (SELECT 1 FROM conflict_disclosures c WHERE c.assignment_id=a.id AND
            (c.status NOT IN ('CLEARED','NO_CONFLICT') OR c.disclosed_by_id IS NULL OR c.disclosed_request_id IS NULL OR
             c.resolved_at IS NULL OR c.resolved_by_id IS NULL OR c.resolution_request_id IS NULL OR
             (c.status='CLEARED' AND length(btrim(coalesce(c.resolution,'')))=0))) AS conflicted
        FROM officer_assignments a
        JOIN programme_grants g ON g.user_id=a.actor_id AND g.programme_id=a.programme_id AND g.permission='evaluation.write'
          AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
        LEFT JOIN evaluations e ON e.assignment_id=a.id AND e.application_id=a.application_id AND e.submission_version_id=a.submission_version_id
        WHERE a.application_id=${context.snapshot.applicationId}::uuid AND a.submission_version_id=${context.snapshot.submissionVersionId}::uuid
          AND a.programme_id=${context.snapshot.programmeId}::uuid AND a.status='ACTIVE' AND a.revoked_at IS NULL
          AND a.valid_from<=clock_timestamp() AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
          AND a.issued_by_id IS NOT NULL AND a.issued_request_id IS NOT NULL`;
      evaluationsComplete = rows.length > 0 && rows.every(row => row.state === 'FINALIZED' && !!row.comment?.trim() &&
        !!row.recommendation && row.score_count > 0n && !row.conflicted);
    }
    const transition = context.snapshot.state;
    return {
      ...(assignment ? { assignment } : {}),
      guards: {
        ...(context.role === 'evaluator' && transition === 'UNDER_EVALUATION' ? { scoresValid: evaluationsComplete } : {}),
        ...(context.role === 'adjudicator' && transition === 'SCORES_LOCKED' ? { reviewsComplete: evaluationsComplete } : {}),
      },
    };
  }
}
