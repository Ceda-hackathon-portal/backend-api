import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Principal } from '../../shared/authorization.js';
import { publishedScoringConfig } from '../../infrastructure/review-config.js';
import { projectOfficerSubmissionFields } from '../applications/officer-submission-reader.js';
import { draftFields, parseStoredBudget } from '../applications/service.js';
import { requireActiveSession } from '../auth/session-access.js';
import { conflictState, hidden, isLive, liveGrants, reviewersRequired, roleFor } from './access.js';

// Read models only. Nothing here changes state, and every read re-checks the session and live grants.
const afterScoring = ['SCORES_LOCKED', 'ADJUDICATION', 'DECIDED', 'OUTCOME_RELEASED'];
const criterionText = z.array(z.object({ id: z.string(), name: z.string(), description: z.string() }));

const include = {
  programmeVersion: { include: { programme: true } },
  workflowState: true,
  submissions: { orderBy: { version: 'desc' }, take: 1, include: { documents: true } },
} satisfies Prisma.ApplicationInclude;

async function facts(db: Prisma.TransactionClient, applicationIds: string[]) {
  const [assignments, disclosures, evaluations, reviews, decisions] = await Promise.all([
    db.officerAssignment.findMany({ where: { applicationId: { in: applicationIds } }, orderBy: { createdAt: 'asc' } }),
    db.conflictDisclosure.findMany({ where: { assignment: { applicationId: { in: applicationIds } } } }),
    db.evaluation.findMany({ where: { applicationId: { in: applicationIds } }, include: { scores: true } }),
    db.officerReview.findMany({ where: { applicationId: { in: applicationIds } }, orderBy: { createdAt: 'desc' } }),
    db.adjudicationDecision.findMany({ where: { applicationId: { in: applicationIds } } }),
  ]);
  return {
    evaluations, reviews, decisions,
    assignments: assignments.map(row => {
      const own = disclosures.filter(item => item.assignmentId === row.id);
      return { ...row, live: isLive(row), disclosures: own, conflict: conflictState(own) };
    }),
  };
}

export async function staffApplications(prisma: PrismaClient, principal: Principal) {
  return prisma.$transaction(async db => {
    await requireActiveSession(db, principal);
    const grants = await liveGrants(db, principal.userId);
    const managed = [...grants].filter(([, permissions]) => permissions.has('assignment.manage')).map(([id]) => id);
    const own = await db.officerAssignment.findMany({
      where: { actorId: principal.userId, programmeId: { in: [...grants.keys()] } },
    });
    const applications = await db.application.findMany({
      where: {
        stage: 'SUBMITTED', ownerId: { not: principal.userId },
        OR: [{ programmeId: { in: managed } }, { id: { in: own.filter(row => isLive(row)).map(row => row.applicationId) } }],
      },
      include, orderBy: { updatedAt: 'desc' }, take: 200,
    });
    const all = await facts(db, applications.map(row => row.id));
    return applications.flatMap(application => {
      const submission = application.submissions[0];
      if (!submission) return [];
      const team = all.assignments.filter(row => row.applicationId === application.id && row.live);
      const mine = team.find(row => row.actorId === principal.userId);
      const manages = managed.includes(application.programmeId);
      const fields = draftFields.parse(submission.fields);
      // An idea's title stays hidden from an assignee until their conflict declaration is confirmed.
      const mayName = manages || mine?.conflict === 'CLEARED';
      return [{
        id: application.id,
        reference: submission.reference,
        title: mayName ? fields.title : null,
        submittedAt: submission.submittedAt,
        programme: application.programmeVersion.programme.name,
        state: application.workflowState?.state ?? 'SUBMITTED',
        eligibility: all.reviews.find(row => row.applicationId === application.id)?.outcome ?? null,
        myConflict: mine?.conflict ?? null,
        awaitingConfirmation: manages
          ? team.filter(row => row.conflict === 'AWAITING_CONFIRMATION' && row.actorId !== principal.userId).length
          : 0,
      }];
    });
  }, { maxWait: 5000, timeout: 15000 });
}

export async function staffApplication(prisma: PrismaClient, principal: Principal, id: string) {
  return prisma.$transaction(async db => {
    await requireActiveSession(db, principal);
    const application = await db.application.findFirst({
      where: { id, stage: 'SUBMITTED', ownerId: { not: principal.userId } }, include,
    });
    const submission = application?.submissions[0];
    if (!application || !submission) throw hidden();
    const permissions = (await liveGrants(db, principal.userId)).get(application.programmeId);
    if (!permissions) throw hidden();

    const all = await facts(db, [id]);
    const mine = all.assignments.find(row => row.live && row.actorId === principal.userId);
    const manages = permissions.has('assignment.manage');
    if (!manages && !mine) throw hidden();

    const cleared = mine?.conflict === 'CLEARED';
    const state = application.workflowState?.state ?? 'SUBMITTED';
    const config = application.programmeVersion.config;
    const role = roleFor(permissions);
    const fields = draftFields.parse(submission.fields);

    const userGrants = await db.programmeGrant.findMany({
      where: { programmeId: application.programmeId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { userId: true, permission: true },
    });
    const roleOf = (userId: string) => roleFor(new Set(userGrants.filter(row => row.userId === userId).map(row => row.permission)));
    const people = manages
      ? await db.authUser.findMany({ where: { id: { in: [...new Set(userGrants.map(row => row.userId))] } }, select: { id: true, name: true, status: true } })
      : [];

    const check = application.workflowState
      ? await db.eligibilityCheck.findUnique({ where: { id: application.workflowState.eligibilityCheckId }, include: { findings: true } })
      : await db.eligibilityCheck.findFirst({ where: { applicationId: id, submissionVersionId: submission.id }, orderBy: { createdAt: 'desc' }, include: { findings: true } });
    const review = all.reviews[0];
    const decision = all.decisions[0];
    const evaluation = mine ? all.evaluations.find(row => row.assignmentId === mine.id) : undefined;
    const reviewers = all.assignments.filter(row => row.live && roleOf(row.actorId) === 'evaluator');
    const named = criterionText.safeParse((config as { criteriaText?: unknown } | null)?.criteriaText);

    return {
      id,
      reference: submission.reference,
      submittedAt: submission.submittedAt,
      programme: application.programmeVersion.programme.name,
      title: manages || cleared ? fields.title : null,
      state,
      revision: application.workflowState?.revision ?? 0,
      role,
      screening: check && (manages || role === 'eligibility-officer') ? { status: check.overallStatus } : null,
      eligibility: review && (manages || cleared) ? { outcome: review.outcome, reason: review.rationale, at: review.createdAt } : null,
      progress: {
        required: reviewersRequired(config),
        assigned: reviewers.length,
        cleared: reviewers.filter(row => row.conflict === 'CLEARED').length,
        finalized: all.evaluations.filter(row => row.state === 'FINALIZED' && reviewers.some(item => item.id === row.assignmentId)).length,
      },
      assignment: mine ? { id: mine.id, conflict: mine.conflict } : null,
      content: cleared ? {
        // Reviewers get the officer projection: no applicant, team or contact details.
        ...projectOfficerSubmissionFields(submission.version, submission.fields),
        ...(role === 'eligibility-officer' ? { team: fields.team, applicant: fields.applicant ?? null } : {}),
        budget: parseStoredBudget(submission.budget),
        documents: submission.documents
          .filter(item => role === 'eligibility-officer' || ['technical-proposal', 'supporting'].includes(item.category))
          .map(item => ({ id: item.id, category: item.category, name: item.originalName, sizeBytes: item.sizeBytes })),
      } : null,
      criteria: cleared
        ? (publishedScoringConfig(config)?.criteria ?? []).map(criterion => ({
          id: criterion.id, minimum: criterion.minimum, maximum: criterion.maximum,
          name: (named.success && named.data.find(item => item.id === criterion.id)?.name) || criterion.id,
          description: (named.success && named.data.find(item => item.id === criterion.id)?.description) || '',
        }))
        : [],
      evaluation: cleared && evaluation ? {
        revision: evaluation.revision, state: evaluation.state, comment: evaluation.comment, recommendation: evaluation.recommendation,
        scores: evaluation.scores.map(score => ({ criterionId: score.criterionId, value: score.value, evidence: score.evidence })),
      } : null,
      // Individual marks reach the adjudicator only after scoring locks, and reach nobody else.
      evaluations: cleared && role === 'adjudicator' && afterScoring.includes(state)
        ? all.evaluations.filter(row => row.state === 'FINALIZED').map((row, index) => ({
          label: `Reviewer ${index + 1}`, total: row.total, comment: row.comment, recommendation: row.recommendation,
          scores: row.scores.map(score => ({ criterionId: score.criterionId, value: score.value, evidence: score.evidence })),
        }))
        : [],
      decision: cleared && decision && (role === 'adjudicator' || role === 'administrator')
        ? { id: decision.id, outcome: decision.outcome, reason: decision.reason, releasedAt: decision.releasedAt }
        : null,
      team: manages ? all.assignments.map(row => ({
        id: row.id,
        name: people.find(person => person.id === row.actorId)?.name ?? 'Staff member',
        role: roleOf(row.actorId),
        self: row.actorId === principal.userId,
        live: row.live,
        conflict: row.conflict,
        disclosureId: row.disclosures.find(item => item.status === 'UNRESOLVED')?.id ?? null,
        review: all.evaluations.find(item => item.assignmentId === row.id)?.state ?? null,
      })) : [],
      candidates: manages ? people
        .filter(person => person.status === 'ACTIVE' && person.id !== application.ownerId && roleOf(person.id) &&
          !all.assignments.some(row => row.actorId === person.id))
        .map(person => ({ id: person.id, name: person.name, role: roleOf(person.id) })) : [],
    };
  }, { maxWait: 5000, timeout: 15000 });
}

/** The one document a cleared assignee asked for, limited by the same category rule as the detail view. */
export async function staffDocument(prisma: PrismaClient, principal: Principal, id: string, documentId: string) {
  const detail = await staffApplication(prisma, principal, id);
  if (!detail.content?.documents.some(item => item.id === documentId)) throw hidden();
  const document = await prisma.applicationDocument.findFirst({ where: { id: documentId, applicationId: id } });
  if (!document) throw hidden();
  return document;
}

/** What the applicant may know: the stage, a confirmed eligibility result and a released outcome. */
export async function applicantProgress(prisma: PrismaClient, principal: Principal, id: string) {
  return prisma.$transaction(async db => {
    await requireActiveSession(db, principal);
    const application = await db.application.findFirst({
      where: { id, ownerId: principal.userId, stage: 'SUBMITTED' }, include: { workflowState: true },
    });
    if (!application) throw hidden();
    const state = application.workflowState?.state ?? 'SUBMITTED';
    const review = await db.officerReview.findFirst({ where: { applicationId: id }, orderBy: { createdAt: 'desc' } });
    const release = state === 'OUTCOME_RELEASED'
      ? await db.outcomeRelease.findFirst({ where: { applicationId: id, decision: { releasedAt: { not: null } } }, include: { decision: true } })
      : null;
    return {
      state,
      eligibility: review ? {
        outcome: review.outcome, at: review.createdAt,
        // An officer's rationale is released only when it is the applicant's final answer.
        reason: review.outcome === 'NOT_ELIGIBLE' ? review.rationale : null,
      } : null,
      outcome: release ? { outcome: release.outcome, message: release.applicantMessage, releasedAt: release.decision.releasedAt } : null,
    };
  }, { maxWait: 5000, timeout: 10000 });
}
