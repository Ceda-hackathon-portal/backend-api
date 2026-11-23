import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Principal } from '../../shared/authorization.js';
import { HttpError } from '../../shared/errors.js';
import { requireActiveSession, requireProgrammePermission } from '../auth/session-access.js';

export const OFFICER_ASSIGNMENT_MANAGE_PERMISSION = 'assignment.manage';
const readPermission = 'eligibility.read-submission';
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const issueCommand = z.object({
  actorId: uuid,
  applicationId: uuid,
  submissionVersionId: uuid,
  programmeId: uuid,
  validFrom: z.coerce.date().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});
const unavailable = () => new HttpError(404, 'NOT_FOUND', 'Resource not found.');
const conflict = (message: string) => new HttpError(409, 'CONFLICT', message);

export interface OfficerAssignmentReceipt {
  readonly assignmentId: string;
  readonly replayed: boolean;
}

/** Internal service for a separately configured assignment-provisioner Prisma client. */
export class PrismaOfficerAssignmentService {
  constructor(private readonly db: PrismaClient) {}

  async issue(principal: Principal, requestId: string, input: unknown): Promise<OfficerAssignmentReceipt> {
    const actor = z.object({ userId: uuid, sessionId: uuid, authnLevel: z.string().min(1) }).safeParse(principal);
    const request = uuid.safeParse(requestId);
    const command = issueCommand.safeParse(input);
    if (!actor.success || !request.success) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    if (!command.success || (command.data.expiresAt && command.data.validFrom && command.data.expiresAt <= command.data.validFrom)) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'A valid assignment scope and validity period are required.');
    }
    const requestHash = createHash('sha256').update(JSON.stringify({
      actorId: command.data.actorId, applicationId: command.data.applicationId,
      submissionVersionId: command.data.submissionVersionId, programmeId: command.data.programmeId,
      validFrom: command.data.validFrom?.toISOString() ?? null, expiresAt: command.data.expiresAt?.toISOString() ?? null,
    })).digest('hex');

    return this.db.$transaction(async tx => {
      await requireActiveSession(tx, actor.data);
      await requireProgrammePermission(tx, actor.data, command.data.programmeId, OFFICER_ASSIGNMENT_MANAGE_PERMISSION);
      const target = await tx.$queryRaw<Array<{ id: string; owner_id: string }>>`
        SELECT sv.id, app.owner_id FROM submission_versions sv
        JOIN applications app ON app.id=sv.application_id AND app.programme_id=${command.data.programmeId}::uuid
        JOIN programme_versions pv ON pv.id=sv.programme_version_id AND pv.programme_id=app.programme_id
        WHERE sv.id=${command.data.submissionVersionId}::uuid AND app.id=${command.data.applicationId}::uuid
          AND app.programme_version_id=sv.programme_version_id`;
      if (target.length !== 1 || target[0]!.owner_id.toLowerCase() === command.data.actorId) throw unavailable();

      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(
        'officer-assignment-set:' || ${command.data.applicationId}::uuid::text || ':' || ${command.data.submissionVersionId}::uuid::text || ':' || ${command.data.programmeId}::uuid::text,0))`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(
        'officer-assignment-scope:' || ${command.data.actorId}::uuid::text || ':' || ${command.data.applicationId}::uuid::text || ':' ||
        ${command.data.submissionVersionId}::uuid::text || ':' || ${command.data.programmeId}::uuid::text,0))`;

      const targetOfficer = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT u.id FROM users u JOIN programme_grants g ON g.user_id=u.id
        WHERE u.id=${command.data.actorId}::uuid AND u.status='ACTIVE'
          AND g.programme_id=${command.data.programmeId}::uuid AND g.permission=${readPermission}
          AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
        FOR SHARE OF u, g`;
      if (targetOfficer.length !== 1) throw unavailable();

      const existing = await tx.officerAssignment.findUnique({ where: { issuedRequestId: request.data } });
      if (existing) {
        const same = existing.issuedById?.toLowerCase() === actor.data.userId &&
          existing.actorId.toLowerCase() === command.data.actorId && existing.applicationId.toLowerCase() === command.data.applicationId &&
          existing.submissionVersionId.toLowerCase() === command.data.submissionVersionId && existing.programmeId.toLowerCase() === command.data.programmeId &&
          existing.requestHash === requestHash;
        if (!same) throw conflict('The request identifier was already used for another assignment.');
        return Object.freeze({ assignmentId: existing.id, replayed: true });
      }

      const assignment = await tx.officerAssignment.create({ data: {
        actorId: command.data.actorId, applicationId: command.data.applicationId,
        submissionVersionId: command.data.submissionVersionId, programmeId: command.data.programmeId,
        issuedById: actor.data.userId, issuedRequestId: request.data, requestHash,
        ...(command.data.validFrom ? { validFrom: command.data.validFrom } : {}),
        ...(command.data.expiresAt !== undefined ? { expiresAt: command.data.expiresAt } : {}),
      } });
      return Object.freeze({ assignmentId: assignment.id, replayed: false });
    }, { maxWait: 5000, timeout: 10000 });
  }

  async revoke(principal: Principal, requestId: string, assignmentId: string, reason: string): Promise<OfficerAssignmentReceipt> {
    const actor = z.object({ userId: uuid, sessionId: uuid, authnLevel: z.string().min(1) }).safeParse(principal);
    const request = uuid.safeParse(requestId), id = uuid.safeParse(assignmentId);
    const rationale = z.string().trim().min(1).max(1000).safeParse(reason);
    if (!actor.success || !request.success) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    if (!id.success || !rationale.success) throw new HttpError(422, 'VALIDATION_FAILED', 'A valid assignment and revocation reason are required.');
    return this.db.$transaction(async tx => {
      await requireActiveSession(tx, actor.data);
      const existing = await tx.officerAssignment.findUnique({ where: { id: id.data } });
      if (!existing) throw unavailable();
      await requireProgrammePermission(tx, actor.data, existing.programmeId, OFFICER_ASSIGNMENT_MANAGE_PERMISSION);
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(
        'officer-assignment-set:' || ${existing.applicationId}::uuid::text || ':' || ${existing.submissionVersionId}::uuid::text || ':' || ${existing.programmeId}::uuid::text,0))`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(
        'officer-assignment-scope:' || ${existing.actorId}::uuid::text || ':' || ${existing.applicationId}::uuid::text || ':' ||
        ${existing.submissionVersionId}::uuid::text || ':' || ${existing.programmeId}::uuid::text,0))`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('officer-conflict:' || ${existing.id}::uuid::text,0))`;
      const current = await tx.officerAssignment.findUnique({ where: { id: id.data } });
      if (!current) throw unavailable();
      const usedRequest = await tx.officerAssignment.findUnique({ where: { revocationRequestId: request.data } });
      if (usedRequest) {
        if (usedRequest.id !== current.id || usedRequest.revokedById !== actor.data.userId || usedRequest.revocationReason !== rationale.data) {
          throw conflict('The request identifier was already used for another revocation.');
        }
        return Object.freeze({ assignmentId: current.id, replayed: true });
      }
      const changed = await tx.officerAssignment.updateMany({
        where: { id: id.data, status: 'ACTIVE', revokedAt: null },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedById: actor.data.userId, revocationReason: rationale.data, revocationRequestId: request.data },
      });
      if (changed.count !== 1) throw conflict('The assignment is no longer active.');
      return Object.freeze({ assignmentId: id.data, replayed: false });
    }, { maxWait: 5000, timeout: 10000 });
  }

  async discloseConflict(principal: Principal, requestId: string, assignmentId: string,
    declared: 'UNRESOLVED' | 'CONFLICT' = 'UNRESOLVED'): Promise<{ readonly disclosureId: string; readonly replayed: boolean }> {
    const actor = z.object({ userId: uuid, sessionId: uuid, authnLevel: z.string().min(1) }).safeParse(principal);
    const request = uuid.safeParse(requestId), id = uuid.safeParse(assignmentId);
    if (!actor.success || !request.success) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    if (!id.success) throw new HttpError(422, 'VALIDATION_FAILED', 'A valid assignment is required.');
    return this.db.$transaction(async tx => {
      await requireActiveSession(tx, actor.data);
      const assignment = await tx.officerAssignment.findFirst({ where: { id: id.data, actorId: actor.data.userId } });
      if (!assignment) throw unavailable();
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(
        'officer-assignment-set:' || ${assignment.applicationId}::uuid::text || ':' || ${assignment.submissionVersionId}::uuid::text || ':' || ${assignment.programmeId}::uuid::text,0))`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('officer-conflict:' || ${assignment.id}::uuid::text,0))`;
      const existing = await tx.conflictDisclosure.findUnique({ where: { disclosedRequestId: request.data } });
      if (existing) {
        if (existing.assignmentId !== id.data || existing.disclosedById !== actor.data.userId) throw conflict('The request identifier was already used for another disclosure.');
        return Object.freeze({ disclosureId: existing.id, replayed: true });
      }
      const disclosure = await tx.conflictDisclosure.create({ data: {
        assignmentId: id.data, status: declared, disclosedById: actor.data.userId, disclosedRequestId: request.data,
      } });
      return Object.freeze({ disclosureId: disclosure.id, replayed: false });
    }, { maxWait: 5000, timeout: 10000 });
  }

  async resolveConflict(
    principal: Principal, requestId: string, disclosureId: string,
    outcome: 'NO_CONFLICT' | 'CONFLICT', resolution: string,
  ): Promise<{ readonly disclosureId: string; readonly replayed: boolean }> {
    const actor = z.object({ userId: uuid, sessionId: uuid, authnLevel: z.string().min(1) }).safeParse(principal);
    const request = uuid.safeParse(requestId), id = uuid.safeParse(disclosureId);
    const rationale = z.string().trim().min(1).max(500).safeParse(resolution);
    if (!actor.success || !request.success) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    if (!id.success || !rationale.success || !['NO_CONFLICT', 'CONFLICT'].includes(outcome)) throw new HttpError(422, 'VALIDATION_FAILED', 'A supported conflict outcome and rationale are required.');
    return this.db.$transaction(async tx => {
      await requireActiveSession(tx, actor.data);
      const current = await tx.conflictDisclosure.findUnique({ where: { id: id.data }, include: { assignment: { select: { applicationId: true, submissionVersionId: true, programmeId: true } } } });
      if (!current) throw unavailable();
      await requireProgrammePermission(tx, actor.data, current.assignment.programmeId, OFFICER_ASSIGNMENT_MANAGE_PERMISSION);
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(
        'officer-assignment-set:' || ${current.assignment.applicationId}::uuid::text || ':' || ${current.assignment.submissionVersionId}::uuid::text || ':' || ${current.assignment.programmeId}::uuid::text,0))`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('officer-conflict:' || ${current.assignmentId}::uuid::text,0))`;
      const existing = await tx.conflictDisclosure.findUnique({ where: { resolutionRequestId: request.data } });
      if (existing) {
        if (existing.id !== id.data || existing.resolvedById !== actor.data.userId || existing.status !== outcome || existing.resolution !== rationale.data) {
          throw conflict('The request identifier was already used for another conflict resolution.');
        }
        return Object.freeze({ disclosureId: existing.id, replayed: true });
      }
      const changed = await tx.conflictDisclosure.updateMany({
        where: { id: id.data, status: 'UNRESOLVED', resolvedAt: null },
        data: { status: outcome, resolvedAt: new Date(), resolvedById: actor.data.userId, resolution: rationale.data, resolutionRequestId: request.data },
      });
      if (changed.count !== 1) throw conflict('The conflict disclosure has already been resolved.');
      return Object.freeze({ disclosureId: id.data, replayed: false });
    }, { maxWait: 5000, timeout: 10000 });
  }
}
