import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../shared/errors.js';
import { requireActiveSession, requireProgrammePermission } from '../auth/session-access.js';
import { OFFICER_SUBMISSION_PERMISSION, type AuthenticatedRequestContext, type OfficerReviewScope, type OfficerReviewTarget } from './officer-submission-reader.js';

const uuid = z.string().uuid().transform(value => value.toLowerCase());

/**
 * Reads live assignment and conflict facts in the reader's transaction.
 * Runtime DB grants are SELECT-only for these tables. The provider never accepts
 * role, assignment, or conflict claims from a caller.
 */
export class PrismaOfficerReviewScope implements OfficerReviewScope {
  async allows(db: Prisma.TransactionClient, context: AuthenticatedRequestContext, target: OfficerReviewTarget): Promise<boolean> {
    const principal = z.object({ userId: uuid, sessionId: uuid, authnLevel: z.string().min(1) }).safeParse(context?.principal);
    const ids = z.object({
      submissionVersionId: uuid, applicationId: uuid, programmeId: uuid, programmeVersionId: uuid,
    }).safeParse(target);
    if (!principal.success || !ids.success) return false;

    try {
      await requireActiveSession(db, principal.data);
      await requireProgrammePermission(db, principal.data, ids.data.programmeId, OFFICER_SUBMISSION_PERMISSION);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) return false;
      throw error;
    }

    // The natural authorization scope key makes assignments created or revoked
    // concurrently serialize with this exact read, even when a new row has a new id.
    await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended(
      'officer-assignment-scope:' || ${principal.data.userId}::uuid::text || ':' ||
      ${ids.data.applicationId}::uuid::text || ':' || ${ids.data.submissionVersionId}::uuid::text || ':' ||
      ${ids.data.programmeId}::uuid::text, 0))`;

    const candidates = await db.$queryRaw<Array<{ id: string }>>`
      SELECT a.id
      FROM officer_assignments a
      JOIN applications app ON app.id = a.application_id AND app.programme_id = a.programme_id
      JOIN submission_versions sv ON sv.id = a.submission_version_id AND sv.application_id = a.application_id
      JOIN programme_versions pv ON pv.id = sv.programme_version_id AND pv.programme_id = app.programme_id
      WHERE a.actor_id = ${principal.data.userId}::uuid
        AND a.application_id = ${ids.data.applicationId}::uuid
        AND a.submission_version_id = ${ids.data.submissionVersionId}::uuid
        AND a.programme_id = ${ids.data.programmeId}::uuid
        AND app.programme_version_id = ${ids.data.programmeVersionId}::uuid
        AND sv.programme_version_id = ${ids.data.programmeVersionId}::uuid
      ORDER BY a.id`;
    if (candidates.length !== 1) return false;

    // Advisory locks avoid granting UPDATE merely to use SELECT FOR SHARE.
    const assignmentId = candidates[0]!.id;
    const assignments = await db.$queryRaw<Array<{ id: string; owner_id: string }>>`
      SELECT a.id, app.owner_id
      FROM officer_assignments a
      JOIN applications app ON app.id = a.application_id AND app.programme_id = a.programme_id
      JOIN submission_versions sv ON sv.id = a.submission_version_id AND sv.application_id = a.application_id
      JOIN programme_versions pv ON pv.id = sv.programme_version_id AND pv.programme_id = app.programme_id
      WHERE a.id = ${assignmentId}::uuid
        AND a.actor_id = ${principal.data.userId}::uuid
        AND a.application_id = ${ids.data.applicationId}::uuid
        AND a.submission_version_id = ${ids.data.submissionVersionId}::uuid
        AND a.programme_id = ${ids.data.programmeId}::uuid
        AND app.programme_version_id = ${ids.data.programmeVersionId}::uuid
        AND sv.programme_version_id = ${ids.data.programmeVersionId}::uuid
        AND a.status = 'ACTIVE' AND a.revoked_at IS NULL
        AND a.valid_from <= clock_timestamp()
        AND (a.expires_at IS NULL OR a.expires_at > clock_timestamp())
        AND a.issued_by_id IS NOT NULL AND a.issued_request_id IS NOT NULL
      `;
    if (assignments.length !== 1 || assignments[0]!.owner_id.toLowerCase() === principal.data.userId) return false;

    // The disclosure trigger takes the matching exclusive lock before a write can commit.
    await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended('officer-conflict:' || ${assignmentId}::uuid::text, 0))`;
    const disclosures = await db.$queryRaw<Array<{
      status: string; disclosed_by_id: string | null; disclosed_request_id: string | null;
      resolved_at: Date | null; resolved_by_id: string | null; resolution_request_id: string | null; resolution: string | null;
    }>>`
      SELECT status, disclosed_by_id, disclosed_request_id, resolved_at, resolved_by_id, resolution_request_id, resolution
      FROM conflict_disclosures WHERE assignment_id = ${assignmentId}::uuid`;

    // No disclosure, unknown state, unresolved state, or a disqualifying conflict
    // is default-deny. A cleared/no-conflict status needs durable resolution identity.
    return disclosures.length > 0 && disclosures.every(row =>
      (row.status === 'CLEARED' || row.status === 'NO_CONFLICT') &&
      row.disclosed_by_id !== null && row.disclosed_request_id !== null &&
      row.resolved_at !== null && row.resolved_by_id !== null && row.resolution_request_id !== null &&
      (row.status === 'NO_CONFLICT' || (row.resolution?.trim().length ?? 0) > 0));
  }
}
