import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Principal } from '../../shared/authorization.js';
import { HttpError } from '../../shared/errors.js';
import { requireActiveSession, requireProgrammePermission } from '../auth/session-access.js';
import { draftFields } from './service.js';

/** Proposed capability, following existing dot-separated permission conventions. */
export const OFFICER_SUBMISSION_PERMISSION = 'eligibility.read-submission';

const officerFieldsV1 = draftFields.pick({
  title: true, theme: true, problem: true, solution: true, impact: true,
}).strip();
export type OfficerSubmissionFields = Readonly<z.infer<typeof officerFieldsV1>>;

/** Each supported immutable submission version needs an explicitly reviewed projection. */
export function projectOfficerSubmissionFields(version: number, input: unknown): OfficerSubmissionFields {
  if (version !== 1) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
  return Object.freeze(officerFieldsV1.parse(input));
}

export interface AuthenticatedRequestContext {
  readonly principal: Principal;
  readonly requestId: string;
}

export interface OfficerSubmissionDTO {
  readonly submissionVersionId: string;
  readonly applicationId: string;
  readonly programmeId: string;
  readonly programmeVersionId: string;
  readonly submissionVersionNumber: number;
  readonly reference: string;
  readonly submittedAt: string;
  readonly submissionFields: OfficerSubmissionFields;
}

export interface OfficerReviewTarget {
  readonly submissionVersionId: string;
  readonly applicationId: string;
  readonly programmeId: string;
  readonly programmeVersionId: string;
}

/** A trusted, transaction-bound scope/assignment reader. No network operations. */
export interface OfficerReviewScope {
  allows(db: Prisma.TransactionClient, context: AuthenticatedRequestContext, target: OfficerReviewTarget): Promise<boolean>;
}

export interface OfficerSubmissionReader {
  readForOfficer(context: AuthenticatedRequestContext, submissionVersionId: string): Promise<OfficerSubmissionDTO>;
}

const denyScope: OfficerReviewScope = { async allows() { return false; } };
const principalSchema = z.object({
  userId: z.string().uuid().transform(value => value.toLowerCase()),
  sessionId: z.string().uuid().transform(value => value.toLowerCase()),
  authnLevel: z.string().min(1),
});
const unavailable = () => new HttpError(404, 'NOT_FOUND', 'Resource not found.');

export class PrismaOfficerSubmissionReader implements OfficerSubmissionReader {
  constructor(private readonly db: PrismaClient, private readonly scope: OfficerReviewScope = denyScope) {}

  async readForOfficer(context: AuthenticatedRequestContext, submissionVersionId: string): Promise<OfficerSubmissionDTO> {
    const principal = principalSchema.safeParse(context?.principal);
    if (!principal.success) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    if (!z.string().uuid().safeParse(submissionVersionId).success || !z.string().uuid().safeParse(context.requestId).success) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'Valid request and submission identifiers are required.');
    }
    const trustedContext = Object.freeze({ principal: Object.freeze(principal.data), requestId: context.requestId });
    return this.db.$transaction(async db => {
      await requireActiveSession(db, principal.data);
      const identity = await db.submissionVersion.findUnique({ where: { id: submissionVersionId }, select: { applicationId: true } });
      if (!identity) throw unavailable();
      await db.$queryRaw`SELECT id FROM applications WHERE id=${identity.applicationId}::uuid FOR SHARE`;
      const row = await db.submissionVersion.findUnique({
        where: { id: submissionVersionId },
        select: {
          id: true, applicationId: true, programmeVersionId: true, version: true,
          reference: true, submittedAt: true, fields: true,
          application: { select: {
            id: true, ownerId: true, programmeId: true, programmeVersionId: true,
            programmeVersion: { select: { id: true, programmeId: true, publishedAt: true } },
          } },
        },
      });
      if (!row) throw unavailable();
      const app = row.application;
      const published = app.programmeVersion;
      const clock = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      if (row.applicationId !== app.id || row.programmeVersionId !== app.programmeVersionId ||
          published.id !== row.programmeVersionId || published.programmeId !== app.programmeId ||
          row.version !== 1 || !clock[0] || published.publishedAt > clock[0].now || app.ownerId === principal.data.userId) {
        throw unavailable();
      }
      const requireGrant = async () => {
        try {
          await requireProgrammePermission(db, principal.data, app.programmeId, OFFICER_SUBMISSION_PERMISSION);
        } catch (error) {
          if (error instanceof HttpError && error.status === 403) throw unavailable();
          throw error;
        }
      };
      await requireGrant();
      const target: OfficerReviewTarget = Object.freeze({
        submissionVersionId: row.id, applicationId: app.id,
        programmeId: app.programmeId, programmeVersionId: row.programmeVersionId,
      });
      if (await this.scope.allows(db, trustedContext, target) !== true) throw unavailable();
      // Recheck time-sensitive grants and sessions while their policy anchors stay locked.
      await requireActiveSession(db, principal.data);
      await requireGrant();
      return Object.freeze({
        submissionVersionId: row.id, applicationId: app.id, programmeId: app.programmeId,
        programmeVersionId: row.programmeVersionId, submissionVersionNumber: row.version,
        reference: row.reference, submittedAt: row.submittedAt.toISOString(),
        submissionFields: projectOfficerSubmissionFields(row.version, row.fields),
      });
    }, { maxWait: 5000, timeout: 10000 });
  }
}
