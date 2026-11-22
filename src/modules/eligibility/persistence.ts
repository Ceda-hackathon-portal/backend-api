import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { requireActiveSession } from '../auth/session-access.js';
import type { Principal } from '../../shared/authorization.js';
import { HttpError } from '../../shared/errors.js';
import type { EligibilityEvidence, EligibilityRequirement, EligibilityStatus } from './eligibilityPolicy.js';
import { screenEligibility } from './eligibilityPolicy.js';
import { EligibilityConfigurationError, parseEligibilityRuleSnapshot } from './rules.js';
import { z } from 'zod';

export interface ScreeningCommand {
  readonly applicationId: string;
  readonly submissionVersionId: string;
  readonly ruleVersionId: string;
  readonly idempotencyKey: string;
}
export interface PersistedFinding {
  readonly requirementId: string;
  readonly status: EligibilityStatus;
  readonly unknownReason?: string;
  readonly evidence: readonly EligibilityEvidence[];
}
export interface PersistedEligibilityResult {
  readonly checkId: string;
  readonly status: EligibilityStatus;
  readonly findings: readonly PersistedFinding[];
  readonly replayed: boolean;
}

/** Trusted evidence adapter. It reads server-owned structured evidence; submitted prose is never coerced into a fact. */
export interface EligibilityEvidenceSource {
  load(db: Prisma.TransactionClient, submission: { readonly id: string; readonly applicationId: string; readonly fields: Prisma.JsonValue }, requirements: readonly EligibilityRequirement[]): Promise<readonly EligibilityEvidence[]>;
}

const applicantEvidenceSchema = z.array(z.strictObject({
  requirementId: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  value: z.union([z.boolean(), z.number().finite(), z.null()]),
  unit: z.string().trim().min(1).max(40).optional(),
})).max(200);

export class EligibilityEvidenceInputError extends HttpError {
  constructor(message: string) { super(422, 'INVALID_ELIGIBILITY_EVIDENCE', message); this.name = 'EligibilityEvidenceInputError'; }
}

/** Reads only structured values from the exact immutable SubmissionVersion.fields JSON. */
export class PrismaSubmissionEligibilityEvidenceSource implements EligibilityEvidenceSource {
  async load(_db: Prisma.TransactionClient, submission: { readonly id: string; readonly applicationId: string; readonly fields: Prisma.JsonValue }, requirements: readonly EligibilityRequirement[]): Promise<readonly EligibilityEvidence[]> {
    if (!submission.id || !submission.applicationId) throw new EligibilityEvidenceInputError('Submitted evidence is not bound to an application version.');
    if (submission.fields === null || typeof submission.fields !== 'object' || Array.isArray(submission.fields)) {
      throw new EligibilityEvidenceInputError('The immutable submission fields are malformed.');
    }
    const raw = (submission.fields as Prisma.JsonObject).eligibilityEvidence;
    if (raw === undefined) return [];
    const parsed = applicantEvidenceSchema.safeParse(raw);
    if (!parsed.success) throw new EligibilityEvidenceInputError(`Submitted eligibility evidence is invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    const byId = new Map(requirements.map(requirement => [requirement.id, requirement]));
    return parsed.data.map((item, index): EligibilityEvidence => {
      const requirement = byId.get(item.requirementId);
      if (!requirement) throw new EligibilityEvidenceInputError(`Submitted evidence references unconfigured requirement '${item.requirementId}'.`);
      if (requirement.rule.kind === 'number') {
        if (typeof item.value === 'number' && item.unit !== requirement.rule.unit) {
          throw new EligibilityEvidenceInputError(`Submitted evidence for '${item.requirementId}' must use configured unit '${requirement.rule.unit}'.`);
        }
        if (item.unit !== undefined && item.unit !== requirement.rule.unit) {
          throw new EligibilityEvidenceInputError(`Submitted evidence for '${item.requirementId}' uses a unit that does not match its rule.`);
        }
      } else if (item.unit !== undefined) {
        throw new EligibilityEvidenceInputError(`Attestation '${item.requirementId}' cannot include a numerical unit.`);
      }
      return {
        id: `${submission.id}:${index}`,
        requirementId: item.requirementId,
        value: item.value,
        ...(item.unit === undefined ? {} : { unit: item.unit }),
        provenance: { kind: 'SUBMISSION_VERSION', submissionVersionId: submission.id, path: `fields.eligibilityEvidence[${index}]` },
      };
    });
  }
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function configuration(message: string): never { throw new EligibilityConfigurationError(message); }
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const principalSchema = z.object({ userId: uuid, sessionId: uuid, authnLevel: z.string().min(1) });
const bindingSchema = z.object({ applicationId: uuid, submissionVersionId: uuid, ruleVersionId: uuid });

export class PrismaEligibilityScreeningService {
  constructor(private readonly db: PrismaClient, private readonly evidence: EligibilityEvidenceSource = new PrismaSubmissionEligibilityEvidenceSource()) {}

  async screen(principal: Principal, command: ScreeningCommand): Promise<PersistedEligibilityResult> {
    const actor = principalSchema.safeParse(principal);
    if (!actor.success) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    const binding = bindingSchema.safeParse(command);
    if (!binding.success) throw new HttpError(400, 'INVALID_ID', 'A screening identifier is invalid.');
    principal = Object.freeze(actor.data);
    command = Object.freeze({ ...binding.data, idempotencyKey: command.idempotencyKey });
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(command.idempotencyKey)) throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'An idempotency key is invalid.');
    const requestHash = hash([command.applicationId, command.submissionVersionId, command.ruleVersionId]);
    // Canonical identifiers give equivalent UUID spellings the same lock and fingerprint.
    // All receipt reads stay under live authorization; a uniqueness error rolls back.
    return await this.db.$transaction(async (tx) => {
      await requireActiveSession(tx, principal);
      await tx.$queryRaw<Array<{ locked: string }>>`SELECT pg_advisory_xact_lock(hashtextextended(${`${principal.userId}:${command.applicationId}:${command.idempotencyKey}`}, 0))::text AS locked`;
      await tx.$queryRaw`SELECT id FROM applications WHERE id=${command.applicationId}::uuid FOR SHARE`;
      const application = await tx.application.findUnique({ where: { id: command.applicationId } });
      if (!application || application.ownerId !== principal.userId) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
      const existing = await tx.eligibilityCheck.findUnique({ where: { requestedById_applicationId_operationKey: {
        requestedById: principal.userId, applicationId: command.applicationId, operationKey: command.idempotencyKey,
      } }, include: { findings: true } });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was used for a different screening request.');
        await requireActiveSession(tx, principal);
        return this.result(existing.id, existing.overallStatus, existing.findings, true);
      }
      if (application.stage !== 'SUBMITTED') throw new HttpError(409, 'NOT_SUBMITTED', 'Only a submitted application can be screened.');
      const submission = await tx.submissionVersion.findFirst({ where: {
        id: command.submissionVersionId, applicationId: application.id, programmeVersionId: application.programmeVersionId,
      } });
      if (!submission) throw new HttpError(409, 'SUBMISSION_VERSION_MISMATCH', 'The requested immutable submission version does not match the application.');
      const rule = await tx.eligibilityRuleVersion.findFirst({ where: {
        id: command.ruleVersionId, programmeId: application.programmeId, programmeVersionId: application.programmeVersionId,
        publishedAt: { lte: new Date() },
      } });
      if (!rule) throw new HttpError(409, 'RULE_VERSION_UNAVAILABLE', 'The selected published eligibility rule version is unavailable for this programme version.');
      if (rule.schemaVersion !== 1) configuration(`Unsupported eligibility rule schema version ${rule.schemaVersion}.`);
      const parsed = parseEligibilityRuleSnapshot({ eligibilityRules: rule.snapshot });
      if (!parsed) configuration('The selected eligibility rule version is missing its explicit rules payload.');
      if (parsed.version.toLowerCase() !== rule.id || parsed.digest !== rule.digest) configuration('The selected eligibility rule snapshot failed its version or integrity check.');
      const evidence = await this.evidence.load(tx, { id: submission.id, applicationId: application.id, fields: submission.fields }, parsed.requirements);
      const assessment = screenEligibility(parsed.requirements, evidence);
      const id = randomUUID();
      const findings = assessment.findings.map(finding => ({
        requirementId: finding.requirementId,
        status: finding.status,
        ...(finding.unknownReason === undefined ? {} : { unknownReason: finding.unknownReason }),
        evidence: evidence.filter(item => item.requirementId === finding.requirementId),
      }));
      const check = await tx.eligibilityCheck.create({ data: {
        id, applicationId: application.id, programmeId: application.programmeId, programmeVersionId: application.programmeVersionId,
        submissionVersionId: submission.id, ruleVersionId: rule.id, requestedById: principal.userId,
        operationKey: command.idempotencyKey, requestHash, overallStatus: assessment.status,
        findings: { create: findings.map(item => ({ requirementId: item.requirementId, status: item.status, unknownReason: item.unknownReason ?? null, evidence: item.evidence as unknown as Prisma.InputJsonValue })) },
      }, include: { findings: true } });
      await tx.eligibilityAudit.createMany({ data: { checkId: check.id } });
      await tx.eligibilityOutbox.createMany({ data: { checkId: check.id } });
      await requireActiveSession(tx, principal);
      return this.result(check.id, check.overallStatus, check.findings, false);
    }, { maxWait: 5000, timeout: 15000 });
  }

  private result(id: string, status: string, findings: readonly { requirementId: string; status: string; unknownReason: string | null; evidence: Prisma.JsonValue }[], replayed: boolean): PersistedEligibilityResult {
    return { checkId: id, status: status as EligibilityStatus, replayed, findings: findings.map(item => ({
      requirementId: item.requirementId, status: item.status as EligibilityStatus,
      ...(item.unknownReason ? { unknownReason: item.unknownReason } : {}),
      evidence: item.evidence as unknown as EligibilityEvidence[],
    })).sort((left, right) => left.requirementId.localeCompare(right.requirementId)) };
  }
}

/** Persist an explicitly selected immutable rule snapshot; caller must already have authorized publication. */
export async function persistEligibilityRuleVersion(db: PrismaClient, input: { readonly id: string; readonly programmeId: string; readonly programmeVersionId: string; readonly version: number; readonly snapshot: unknown; readonly publishedAt: Date }): Promise<void> {
  const parsed = parseEligibilityRuleSnapshot({ eligibilityRules: input.snapshot });
  if (!parsed || parsed.version !== input.id) configuration('Published rules must carry the selected UUID as ruleVersion.');
  if (!Number.isSafeInteger(input.version) || input.version < 1) configuration('Rule version number must be a positive integer.');
  await db.eligibilityRuleVersion.create({ data: {
    id: input.id, programmeId: input.programmeId, programmeVersionId: input.programmeVersionId,
    version: input.version, schemaVersion: 1, snapshot: input.snapshot as Prisma.InputJsonValue,
    digest: parsed.digest, publishedAt: input.publishedAt,
  } });
}
