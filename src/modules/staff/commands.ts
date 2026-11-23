import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Principal } from '../../shared/authorization.js';
import { HttpError } from '../../shared/errors.js';
import { PrismaReviewWorkflowFacts } from '../../infrastructure/review-workflow-facts.js';
import { PrismaWorkflowRepository, type WorkflowFactSource } from '../../infrastructure/workflow-repository.js';
import { PrismaOfficerAssignmentService } from '../applications/officer-assignment-service.js';
import { PrismaOfficerReviewScope } from '../applications/prisma-officer-review-scope.js';
import { requireActiveSession, requireProgrammePermission } from '../auth/session-access.js';
import { executeTransition, type Transition } from '../workflow/engine.js';
import { conflictState, hidden, isLive, refuse, reviewersRequired } from './access.js';

/** Supplies the two guards the workflow engine requires for ASSIGN, from current records under its locks. */
class StaffWorkflowFacts implements WorkflowFactSource {
  private readonly review = new PrismaReviewWorkflowFacts();

  async read(...[db, context]: Parameters<WorkflowFactSource['read']>) {
    const base = await this.review.read(db, context);
    if (context.role !== 'officer' || context.snapshot.state !== 'OFFICER_VERIFICATION') return base;
    const { applicationId, submissionVersionId, programmeId, programmeVersionId } = context.snapshot;
    const review = await db.officerReview.findFirst({
      where: { applicationId, submissionVersionId, checkId: context.eligibilityCheckId }, orderBy: { createdAt: 'desc' },
    });
    const evaluators = await db.programmeGrant.findMany({
      where: { programmeId, permission: 'evaluation.write', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { userId: true },
    });
    const assignments = (await db.officerAssignment.findMany({
      where: { applicationId, submissionVersionId, programmeId, actorId: { in: evaluators.map(row => row.userId) } },
      include: { conflicts: true },
    })).filter(row => isLive(row));
    const version = await db.programmeVersion.findUnique({ where: { id: programmeVersionId } });
    return {
      ...base,
      guards: {
        ...base.guards,
        officerConfirmedEligible: review?.outcome === 'ELIGIBLE',
        reviewersCleared: !!version && assignments.length >= reviewersRequired(version.config) &&
          assignments.every(row => conflictState(row.conflicts) === 'CLEARED'),
      },
    };
  }
}

export class StaffCommands {
  private readonly assignments: PrismaOfficerAssignmentService | null;

  /** assignmentDb is the separate assignment-manager connection. The applicant-facing role cannot write assignments. */
  constructor(private readonly db: PrismaClient, private readonly assignmentDb: PrismaClient | null,
    private readonly principal: Principal, private readonly requestId: string) {
    this.assignments = assignmentDb ? new PrismaOfficerAssignmentService(assignmentDb) : null;
  }

  private provisioner(): PrismaOfficerAssignmentService {
    if (!this.assignments) throw new HttpError(503, 'ASSIGNMENTS_UNAVAILABLE', 'Staff assignment is not configured on this server.');
    return this.assignments;
  }

  private async context(id: string) {
    const application = await this.db.application.findFirst({
      where: { id, stage: 'SUBMITTED', ownerId: { not: this.principal.userId } },
      include: { workflowState: true, submissions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    const submission = application?.submissions[0];
    if (!application || !submission) throw hidden();
    const checkId = application.workflowState?.eligibilityCheckId ?? (await this.db.eligibilityCheck.findFirst({
      where: { applicationId: id, submissionVersionId: submission.id }, orderBy: { createdAt: 'desc' },
    }))?.id ?? null;
    return { application, submission, checkId, state: application.workflowState?.state ?? 'SUBMITTED' };
  }

  private async transition(id: string, transition: Transition, reason = '') {
    const { application, submission, checkId } = await this.context(id);
    if (!checkId) throw refuse('NOT_SCREENED', 'This application has no eligibility screening record.');
    const result = await executeTransition(new PrismaWorkflowRepository(this.db,
      { principal: this.principal, requestId: this.requestId, eligibilityCheckId: checkId }, new StaffWorkflowFacts()), {
      applicationId: id, submissionVersionId: submission.id, programmeId: application.programmeId,
      programmeVersionId: application.programmeVersionId, transition, reason,
      expectedRevision: application.workflowState?.revision ?? 0, idempotencyKey: randomUUID(),
    });
    if (result.ok) return;
    if (result.code === 'FORBIDDEN') throw hidden();
    throw refuse(result.code, result.code === 'GUARD_FAILED'
      ? 'The checks for this step are not complete.'
      : 'This application is not at that step. Reload it.');
  }

  async assign(id: string, userId: string) {
    const provisioner = this.provisioner();
    const { application, submission, checkId, state } = await this.context(id);
    await this.db.$transaction(async db => {
      await requireActiveSession(db, this.principal);
      await requireProgrammePermission(db, this.principal, application.programmeId, 'assignment.manage');
    });
    // The read scope fails closed on two rows for one person, including a revoked one.
    if (await this.db.officerAssignment.findFirst({ where: { applicationId: id, actorId: userId } }))
      throw refuse('ALREADY_ASSIGNED', 'This person has already been assigned to this application.');
    if (!checkId) throw refuse('NOT_SCREENED', 'This application has no eligibility screening record.');
    const permissions = new Set((await this.db.programmeGrant.findMany({
      where: { userId, programmeId: application.programmeId, revokedAt: null },
    })).map(row => row.permission));
    const evaluatorOpen = ['SUBMITTED', 'ELIGIBILITY_SCREENING', 'OFFICER_VERIFICATION'].includes(state);
    if (permissions.has('evaluation.write') && !evaluatorOpen)
      throw refuse('EVALUATION_STARTED', 'Reviewers cannot be added after evaluation has been assigned.');

    if (state === 'SUBMITTED') await this.transition(id, 'SCREEN');
    return provisioner.issue(this.principal, this.requestId, {
      actorId: userId, applicationId: id, submissionVersionId: submission.id, programmeId: application.programmeId,
    });
  }

  async revoke(id: string, assignmentId: string, reason: string) {
    const provisioner = this.provisioner();
    if (!await this.db.officerAssignment.findFirst({ where: { id: assignmentId, applicationId: id } })) throw hidden();
    return provisioner.revoke(this.principal, this.requestId, assignmentId, reason);
  }

  async declare(id: string, hasConflict: boolean) {
    const provisioner = this.provisioner();
    const rows = (await this.db.officerAssignment.findMany({
      where: { applicationId: id, actorId: this.principal.userId }, include: { conflicts: true },
    })).filter(row => isLive(row));
    const assignment = rows.length === 1 ? rows[0]! : null;
    if (!assignment) throw hidden();
    if (assignment.conflicts.length) throw refuse('ALREADY_DECLARED', 'Your declaration is already recorded.');
    return provisioner.discloseConflict(this.principal, this.requestId, assignment.id, hasConflict ? 'CONFLICT' : 'UNRESOLVED');
  }

  async confirm(id: string, disclosureId: string) {
    const provisioner = this.provisioner();
    const disclosure = await this.db.conflictDisclosure.findFirst({ where: { id: disclosureId, assignment: { applicationId: id } } });
    if (!disclosure) throw hidden();
    if (disclosure.disclosedById === this.principal.userId)
      throw refuse('SEPARATION_OF_DUTIES', 'Someone else must confirm your declaration.');
    return provisioner.resolveConflict(this.principal, this.requestId, disclosureId, 'NO_CONFLICT', 'Declaration of no conflict confirmed.');
  }

  async confirmEligibility(id: string, outcome: 'ELIGIBLE' | 'NOT_ELIGIBLE', reason: string) {
    if ((await this.context(id)).state === 'ELIGIBILITY_SCREENING') await this.transition(id, 'OPEN_VERIFICATION');
    const { application, submission, checkId } = await this.context(id);
    if (!checkId) throw refuse('NOT_SCREENED', 'This application has no eligibility screening record.');
    return this.db.$transaction(async db => {
      await requireActiveSession(db, this.principal);
      await db.$queryRaw`SELECT id FROM applications WHERE id=${id}::uuid FOR UPDATE`;
      await requireProgrammePermission(db, this.principal, application.programmeId, 'eligibility.verify');
      const allowed = await new PrismaOfficerReviewScope().allows(db, { principal: this.principal, requestId: this.requestId }, {
        applicationId: id, submissionVersionId: submission.id, programmeId: application.programmeId, programmeVersionId: application.programmeVersionId,
      });
      if (!allowed) throw hidden();
      const current = await db.stateSnapshot.findUnique({ where: { applicationId: id } });
      if (current?.state !== 'OFFICER_VERIFICATION') throw refuse('INVALID_STATE', 'This application is not awaiting an officer check.');
      if (await db.officerReview.findFirst({ where: { applicationId: id, checkId } }))
        throw refuse('ALREADY_CONFIRMED', 'An eligibility result is already recorded.');
      const check = await db.eligibilityCheck.findUnique({ where: { id: checkId } });
      if (outcome === 'ELIGIBLE' && check?.overallStatus !== 'MET')
        throw refuse('RULES_NOT_MET', 'The published eligibility rules are not met, so it cannot be confirmed eligible.');
      const assignment = (await db.officerAssignment.findMany({ where: { applicationId: id, actorId: this.principal.userId } })).find(row => isLive(row));
      if (!assignment) throw hidden();
      const review = await db.officerReview.create({ data: {
        applicationId: id, submissionVersionId: submission.id, checkId, assignmentId: assignment.id,
        reviewerId: this.principal.userId, outcome, rationale: reason,
      } });
      await requireActiveSession(db, this.principal);
      return { outcome: review.outcome };
    }, { maxWait: 5000, timeout: 15000 });
  }

  async sendToReview(id: string) {
    await this.transition(id, 'ASSIGN', 'Eligibility confirmed and reviewer declarations cleared.');
  }

  async startEvaluation(id: string) {
    if ((await this.context(id)).state !== 'ASSIGNED') throw refuse('INVALID_STATE', 'Evaluation is not waiting to start.');
    await this.transition(id, 'START_EVALUATION');
  }
}
