import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { Principal } from '../shared/authorization.js';
import { HttpError } from '../shared/errors.js';
import { requireActiveSession, requireProgrammePermission } from '../modules/auth/session-access.js';
import { PrismaOfficerReviewScope } from '../modules/applications/prisma-officer-review-scope.js';
import { draftFields } from '../modules/applications/service.js';
import type { SubmissionBinding, WorkflowActor } from '../modules/workflow/authorization.js';
import { provisionalTransitions, transitionWorkflow } from '../modules/workflow/engine.js';
import type { CommandReceipt, EligibilityInput, Guard, TransitionCommand, TransitionContext, WorkflowRepository, WorkflowSnapshot, WorkflowTransaction } from '../modules/workflow/engine.js';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const principalSchema = z.object({ userId: uuid, sessionId: uuid, authnLevel: z.string().min(1) });
const bindingSchema = z.object({ applicationId: uuid, submissionVersionId: uuid, programmeId: uuid, programmeVersionId: uuid });
const states = z.enum(['SUBMITTED','RESUBMITTED','ELIGIBILITY_SCREENING','OFFICER_VERIFICATION','CORRECTION_REQUESTED','ASSIGNED','UNDER_EVALUATION','SCORES_LOCKED','ADJUDICATION','DECIDED','OUTCOME_RELEASED','REJECTED','WITHDRAWN','ARCHIVED']);
const snapshotSchema = bindingSchema.extend({ state: states, revision: z.number().int().nonnegative(), ownerId: uuid, ruleSetVersion: uuid });
const eligibilitySchema = bindingSchema.extend({ ruleSetVersion: uuid, status: z.enum(['MET','NOT_MET','UNKNOWN']), findings: z.array(z.object({ requirementId: z.string(), status: z.enum(['MET','NOT_MET','UNKNOWN']), unknownReason: z.string().optional() })) })
  .transform(data => ({ ...data, findings: data.findings.map(({ unknownReason, ...finding }) => ({ ...finding, ...(unknownReason === undefined ? {} : { unknownReason }) })) }));
const changeSchema = z.object({ before: snapshotSchema, after: snapshotSchema, audit: z.object({ type: z.string(), actorId: uuid, occurredAt: z.iso.datetime(), reason: z.string(), binding: bindingSchema, eligibility: eligibilitySchema.optional() }) })
  .transform(({ audit, ...change }) => { const { eligibility, ...base } = audit; return { ...change, audit: { ...base, ...(eligibility === undefined ? {} : { eligibility }) } }; });
const commandSchema = bindingSchema.extend({ transition: z.enum(Object.keys(provisionalTransitions) as [TransitionCommand['transition'], ...TransitionCommand['transition'][]]),
  expectedRevision: z.number().int().nonnegative().max(2147483646), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), reason: z.string().max(2000) });

export interface WorkflowFactContext {
  readonly principal: Principal;
  readonly snapshot: WorkflowSnapshot;
  readonly eligibilityCheckId: string;
  readonly eligibility: EligibilityInput;
  readonly role: WorkflowActor['role'];
}
/** B-owned facts must be derived from current database records under transaction locks.
 * No network operations or client-supplied guards. Missing facts deny the transition.
 * Future evaluator/adjudicator/publisher assignments need a reviewed role-specific adapter.
 */
export interface WorkflowFactSource {
  read(db: Prisma.TransactionClient, context: WorkflowFactContext): Promise<{
    readonly guards?: Readonly<Partial<Record<Guard, boolean>>>;
    readonly assignment?: NonNullable<WorkflowActor['assignment']>;
  }>;
}
const denyFacts: WorkflowFactSource = { async read() { return {}; } };
const unavailable = () => new HttpError(404, 'NOT_FOUND', 'Resource not found.');
const conflict = () => new HttpError(409, 'WORKFLOW_CONFLICT', 'The workflow binding or revision changed.');

/** Internal port implementation. It never mounts an API or accepts role/guard claims. */
export class PrismaWorkflowRepository implements WorkflowRepository {
  private readonly principal: Principal;
  private readonly requestId: string;
  private readonly checkId: string;
  constructor(private readonly db: PrismaClient, context: { principal: Principal; requestId: string; eligibilityCheckId: string },
    private readonly facts: WorkflowFactSource = denyFacts) {
    this.principal = Object.freeze(principalSchema.parse(context.principal));
    this.requestId = uuid.parse(context.requestId);
    this.checkId = uuid.parse(context.eligibilityCheckId);
  }

  async transaction<T>(work: (transaction: WorkflowTransaction) => Promise<T>): Promise<T> {
    return this.db.$transaction(async db => {
      let loaded: { command: TransitionCommand; snapshot: WorkflowSnapshot; context: TransitionContext; prior?: CommandReceipt; initial: boolean } | undefined;
      let eligibility!: EligibilityInput;
      let snapshotValidated = false;
      let committed = false;
      const principal = this.principal;
      const context = async (): Promise<TransitionContext> => {
        if (!loaded) throw new Error('Workflow read is required');
        await requireActiveSession(db, principal);
        const rule = provisionalTransitions[loaded.command.transition];
        await requireProgrammePermission(db, principal, loaded.snapshot.programmeId, rule.permission);
        const supplied = await this.facts.read(db, { principal, snapshot: structuredClone(loaded.snapshot), eligibilityCheckId: this.checkId, eligibility: structuredClone(eligibility), role: rule.role });
        let assignment = supplied.assignment;
        if (rule.role === 'officer') {
          if (!await new PrismaOfficerReviewScope().allows(db, { principal, requestId: this.requestId }, loaded.snapshot)) throw new HttpError(403, 'FORBIDDEN', 'This action is not permitted.');
          assignment = { ...bindingSchema.parse(loaded.snapshot), userId: principal.userId, active: true, revoked: false, conflictCleared: true };
        }
        const actor: WorkflowActor = { userId: principal.userId, sessionActive: true, role: rule.role,
          grants: [{ programmeId: loaded.snapshot.programmeId, permission: rule.permission, active: true },
            ...(rule.role === 'officer' ? [{ programmeId: loaded.snapshot.programmeId, permission: 'eligibility.read-submission', active: true }] : [])],
          ...(assignment ? { assignment } : {}),
        };
        return { actor, guards: { ...supplied.guards, snapshotValidated, screeningPersisted: true }, eligibility: structuredClone(eligibility), occurredAt: loaded.context.occurredAt };
      };
      const port: WorkflowTransaction = {
        read: async input => {
          if (loaded) throw new Error('One workflow command per transaction');
          const parsed = commandSchema.safeParse(input);
          if (!parsed.success) throw new HttpError(422, 'VALIDATION_FAILED', 'A valid workflow command is required.');
          const command = parsed.data;
          await requireActiveSession(db, principal);
          // Application lock serializes initialization and commands for every actor/key.
          await db.$queryRaw`SELECT id FROM applications WHERE id=${command.applicationId}::uuid FOR UPDATE`;
          // Assignment and conflict mutations take the exclusive counterpart. This
          // shared set lock keeps transition guards stable through commit.
          await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended(
            'officer-assignment-set:' || ${command.applicationId}::uuid::text || ':' || ${command.submissionVersionId}::uuid::text || ':' || ${command.programmeId}::uuid::text,0))`;
          const application = await db.application.findFirst({ where: { id: command.applicationId, programmeId: command.programmeId, programmeVersionId: command.programmeVersionId }, include: { programmeVersion: true } });
          if (!application || application.stage !== 'SUBMITTED') throw unavailable();
          const submission = await db.submissionVersion.findFirst({ where: { id: command.submissionVersionId, applicationId: application.id, programmeVersionId: application.programmeVersionId } });
          if (!submission) throw unavailable();
          const check = await db.eligibilityCheck.findFirst({ where: { id: this.checkId, applicationId: application.id, submissionVersionId: submission.id, programmeId: application.programmeId, programmeVersionId: application.programmeVersionId },
            include: { ruleVersion: true, findings: { orderBy: { requirementId: 'asc' } }, audit: { include: { outbox: true } } } });
          const clock = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
          const now = clock[0]!.now;
          if (!check?.audit?.outbox || check.ruleVersion.publishedAt > now || application.programmeVersion.publishedAt > now) throw unavailable();
          const stored = await db.stateSnapshot.findUnique({ where: { applicationId: application.id } });
          if (stored && (stored.submissionVersionId !== submission.id || stored.eligibilityCheckId !== this.checkId)) throw conflict();
          const fields = draftFields.safeParse(submission.fields);
          const themes = z.object({ themes: z.array(z.string()) }).safeParse(application.programmeVersion.config);
          snapshotValidated = submission.version === 1 && fields.success &&
            [fields.data.title, fields.data.theme, fields.data.problem, fields.data.solution, fields.data.impact, fields.data.team].every(value => value.length > 0) &&
            themes.success && themes.data.themes.includes(fields.data.theme);
          const snapshot = snapshotSchema.parse({ ...bindingSchema.parse(command), ownerId: application.ownerId, ruleSetVersion: check.ruleVersionId, state: stored?.state ?? 'SUBMITTED', revision: stored?.revision ?? 0 });
          eligibility = eligibilitySchema.parse({ ...bindingSchema.parse(command), ruleSetVersion: check.ruleVersionId, status: check.overallStatus,
            findings: check.findings.map(finding => ({ requirementId: finding.requirementId, status: finding.status, ...(finding.unknownReason ? { unknownReason: finding.unknownReason } : {}) })) });
          loaded = { command, snapshot, initial: !stored, context: { actor: { userId: principal.userId, sessionActive: false, role: 'workflow', grants: [] }, guards: {}, occurredAt: now.toISOString() } };
          loaded.context = await context();
          const receipt = await db.workflowCommandReceipt.findUnique({ where: { applicationId_actorId_key: { applicationId: application.id, actorId: principal.userId, key: command.idempotencyKey } } });
          if (receipt) loaded.prior = { key: receipt.key, actorId: receipt.actorId, fingerprint: receipt.fingerprint, change: changeSchema.parse(receipt.change) };
          return structuredClone({ snapshot, context: loaded.context, ...(loaded.prior ? { prior: loaded.prior } : {}) });
        },
        commit: async supplied => {
          if (!loaded || committed || loaded.prior) throw new Error('Invalid workflow commit');
          const verify = async () => {
            const decision = transitionWorkflow(loaded!.snapshot, loaded!.command, await context());
            if (!decision.ok) throw new HttpError(decision.code === 'FORBIDDEN' ? 403 : 409, decision.code, 'The workflow command is no longer permitted.');
            if (JSON.stringify(decision.receipt) !== JSON.stringify(supplied)) throw conflict();
          };
          await verify();
          const receipt = supplied;
          const after = receipt.change.after;
          if (loaded.initial) await db.stateSnapshot.create({ data: { applicationId: after.applicationId, submissionVersionId: after.submissionVersionId, eligibilityCheckId: this.checkId, state: after.state, revision: after.revision } });
          else {
            const changed = await db.stateSnapshot.updateMany({ where: { applicationId: after.applicationId, submissionVersionId: after.submissionVersionId, eligibilityCheckId: this.checkId, revision: loaded.snapshot.revision }, data: { state: after.state, revision: after.revision } });
            if (changed.count !== 1) throw conflict();
          }
          const eventId = randomUUID();
          await db.workflowEvent.create({ data: { id: eventId, applicationId: after.applicationId, submissionVersionId: after.submissionVersionId, eligibilityCheckId: this.checkId,
            revision: after.revision, previousState: receipt.change.before.state, nextState: after.state, actorId: principal.userId,
            action: receipt.change.audit.type, reason: receipt.change.audit.reason, createdAt: new Date(receipt.change.audit.occurredAt) } });
          await db.workflowCommandReceipt.create({ data: { applicationId: after.applicationId, actorId: principal.userId, key: receipt.key, fingerprint: receipt.fingerprint, eventId, change: receipt.change as unknown as Prisma.InputJsonValue } });
          await db.workflowAudit.create({ data: { eventId, requestId: this.requestId } });
          await db.workflowOutbox.create({ data: { eventId } });
          await verify();
          committed = true;
        },
      };
      const result = await work(port);
      if (loaded) {
        const fresh = await context();
        const decision = transitionWorkflow(loaded.snapshot, loaded.command, fresh, loaded.prior);
        if (decision.ok && !loaded.prior && !committed) throw new Error('A successful workflow command must commit');
        if (!decision.ok && (committed || decision.code === 'FORBIDDEN')) throw new HttpError(decision.code === 'FORBIDDEN' ? 403 : 409, decision.code, 'This action is not permitted.');
      }
      await requireActiveSession(db, principal);
      return result;
    }, { maxWait: 5000, timeout: 15000 });
  }
}
