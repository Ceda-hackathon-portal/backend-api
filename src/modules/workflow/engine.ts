import { canReadOfficerSubmission, hasAssignment, hasGrant, sameBinding } from './authorization.js';
import type { SubmissionBinding, WorkflowActor } from './authorization.js';
import { canonicalIdentity } from '../../shared/identity.js';

export type WorkflowState = 'SUBMITTED' | 'RESUBMITTED' | 'ELIGIBILITY_SCREENING' | 'OFFICER_VERIFICATION' |
  'CORRECTION_REQUESTED' | 'ASSIGNED' | 'UNDER_EVALUATION' | 'SCORES_LOCKED' | 'ADJUDICATION' |
  'DECIDED' | 'OUTCOME_RELEASED' | 'REJECTED' | 'WITHDRAWN' | 'ARCHIVED';
export type Guard = 'snapshotValidated' | 'screeningPersisted' | 'officerConfirmedEligible' |
  'reviewersCleared' | 'evidenceRequested' | 'scoresValid' | 'reviewsComplete' |
  'humanDecision' | 'evidenceComplete' | 'separationOfDuties' | 'releaseReviewed' | 'withdrawalAllowed' | 'retentionCleared';
export interface TransitionRule {
  readonly from: readonly WorkflowState[];
  readonly to: WorkflowState;
  readonly role: WorkflowActor['role'];
  readonly permission: string;
  readonly guards: readonly Guard[];
  readonly event: string;
  readonly reason?: boolean;
}

/** Provisional platform graph, not official CEDA policy or a published programme graph. */
export const provisionalTransitions = {
  SCREEN: { from: ['SUBMITTED', 'RESUBMITTED'], to: 'ELIGIBILITY_SCREENING', role: 'workflow', permission: 'eligibility.screen', guards: ['snapshotValidated'], event: 'ELIGIBILITY_SCREENED' },
  OPEN_VERIFICATION: { from: ['ELIGIBILITY_SCREENING'], to: 'OFFICER_VERIFICATION', role: 'officer', permission: 'eligibility.verify', guards: ['screeningPersisted'], event: 'OFFICER_REVIEW_OPENED' },
  ASSIGN: { from: ['OFFICER_VERIFICATION'], to: 'ASSIGNED', role: 'officer', permission: 'assignment.manage', guards: ['officerConfirmedEligible', 'reviewersCleared'], event: 'REVIEWER_ASSIGNED', reason: true },
  REQUEST_CORRECTION: { from: ['OFFICER_VERIFICATION'], to: 'CORRECTION_REQUESTED', role: 'officer', permission: 'eligibility.verify', guards: ['evidenceRequested'], event: 'ELIGIBILITY_CORRECTION_REQUESTED', reason: true },
  START_EVALUATION: { from: ['ASSIGNED'], to: 'UNDER_EVALUATION', role: 'evaluator', permission: 'evaluation.write', guards: [], event: 'EVALUATION_STARTED' },
  LOCK_SCORES: { from: ['UNDER_EVALUATION'], to: 'SCORES_LOCKED', role: 'evaluator', permission: 'evaluation.submit', guards: ['scoresValid'], event: 'EVALUATION_LOCKED' },
  OPEN_ADJUDICATION: { from: ['SCORES_LOCKED'], to: 'ADJUDICATION', role: 'adjudicator', permission: 'adjudication.read', guards: ['reviewsComplete'], event: 'ADJUDICATION_OPENED' },
  DECIDE: { from: ['ADJUDICATION'], to: 'DECIDED', role: 'adjudicator', permission: 'adjudication.decide', guards: ['humanDecision', 'evidenceComplete', 'separationOfDuties'], event: 'DECISION_RECORDED', reason: true },
  RELEASE: { from: ['DECIDED'], to: 'OUTCOME_RELEASED', role: 'publisher', permission: 'decision.publish', guards: ['releaseReviewed', 'humanDecision'], event: 'OUTCOME_RELEASED', reason: true },
  WITHDRAW: { from: ['SUBMITTED', 'RESUBMITTED', 'ELIGIBILITY_SCREENING', 'OFFICER_VERIFICATION', 'CORRECTION_REQUESTED', 'ASSIGNED', 'UNDER_EVALUATION', 'SCORES_LOCKED', 'ADJUDICATION'], to: 'WITHDRAWN', role: 'owner', permission: 'application.withdraw', guards: ['withdrawalAllowed'], event: 'APPLICATION_WITHDRAWN', reason: true },
  ARCHIVE: { from: ['REJECTED', 'WITHDRAWN', 'OUTCOME_RELEASED'], to: 'ARCHIVED', role: 'archivist', permission: 'application.archive', guards: ['retentionCleared'], event: 'APPLICATION_ARCHIVED', reason: true },
} as const satisfies Readonly<Record<string, TransitionRule>>;
export type Transition = keyof typeof provisionalTransitions;
export interface WorkflowSnapshot extends SubmissionBinding {
  readonly state: WorkflowState;
  readonly revision: number;
  readonly ownerId: string;
  readonly ruleSetVersion: string;
}
export interface EligibilityInput extends SubmissionBinding {
  readonly ruleSetVersion: string;
  readonly status: 'MET' | 'NOT_MET' | 'UNKNOWN';
  readonly findings: readonly {
    readonly requirementId: string;
    readonly status: 'MET' | 'NOT_MET' | 'UNKNOWN';
    readonly unknownReason?: string;
  }[];
}
export interface TransitionCommand extends SubmissionBinding {
  readonly transition: Transition;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly reason: string;
}
export interface TransitionContext {
  readonly actor: WorkflowActor;
  readonly guards: Readonly<Partial<Record<Guard, boolean>>>;
  readonly eligibility?: EligibilityInput;
  readonly occurredAt: string;
}
export interface StateChange {
  readonly before: WorkflowSnapshot;
  readonly after: WorkflowSnapshot;
  readonly audit: { readonly type: string; readonly actorId: string; readonly occurredAt: string; readonly reason: string; readonly binding: SubmissionBinding; readonly eligibility?: EligibilityInput };
}
export interface CommandReceipt {
  readonly key: string;
  readonly actorId: string;
  readonly fingerprint: string;
  readonly change: StateChange;
}
export type TransitionResult =
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'INVALID_TRANSITION' | 'REVISION_CONFLICT' | 'INVALID_INPUT' | 'GUARD_FAILED' | 'IDEMPOTENCY_CONFLICT' }
  | { readonly ok: true; readonly replayed: boolean; readonly receipt: CommandReceipt };

/** Pure decision only. Context and prior receipts MUST come from trusted transaction reads. */
export function transitionWorkflow(snapshot: WorkflowSnapshot, command: TransitionCommand, context: TransitionContext, prior?: CommandReceipt): TransitionResult {
  const deny = (code: Extract<TransitionResult, { ok: false }>['code']): TransitionResult => ({ ok: false, code });
  const rule: TransitionRule | undefined = Object.hasOwn(provisionalTransitions, command.transition) ? provisionalTransitions[command.transition] : undefined;
  const actor = context.actor;
  if (!rule || !sameBinding(snapshot, command)) return deny('INVALID_TRANSITION');
  if (actor.role !== rule.role || !hasGrant(actor, snapshot, rule.permission)) return deny('FORBIDDEN');
  if (actor.role === 'owner' && canonicalIdentity(actor.userId) !== canonicalIdentity(snapshot.ownerId)) return deny('FORBIDDEN');
  if (actor.role === 'officer' && !canReadOfficerSubmission(actor, snapshot, snapshot.ownerId)) return deny('FORBIDDEN');
  if (['evaluator', 'adjudicator', 'publisher'].includes(actor.role) && !hasAssignment(actor, snapshot, snapshot.ownerId)) return deny('FORBIDDEN');
  if (!command.idempotencyKey.trim() || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.revision >= Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(Date.parse(context.occurredAt)) || (rule.reason && !command.reason.trim())) return deny('INVALID_INPUT');
  const fingerprint = JSON.stringify([canonicalIdentity(command.applicationId), canonicalIdentity(command.submissionVersionId), canonicalIdentity(command.programmeId),
    canonicalIdentity(command.programmeVersionId), command.transition, command.expectedRevision, command.reason]);
  // Authorization is deliberately re-evaluated before replay; guards may have changed since success.
  if (prior) {
    if (prior.key !== command.idempotencyKey || canonicalIdentity(prior.actorId) !== canonicalIdentity(actor.userId) || prior.fingerprint !== fingerprint ||
        !sameBinding(prior.change.after, snapshot)) return deny('IDEMPOTENCY_CONFLICT');
    return { ok: true, replayed: true, receipt: structuredClone(prior) };
  }
  if (snapshot.revision !== command.expectedRevision) return deny('REVISION_CONFLICT');
  if (!rule.from.includes(snapshot.state)) return deny('INVALID_TRANSITION');
  if (rule.guards.some(guard => context.guards[guard] !== true)) return deny('GUARD_FAILED');
  const eligibility = context.eligibility;
  if (eligibility) {
    if (!sameBinding(eligibility, snapshot) || canonicalIdentity(eligibility.ruleSetVersion) !== canonicalIdentity(snapshot.ruleSetVersion) ||
        !['MET', 'NOT_MET', 'UNKNOWN'].includes(eligibility.status) || eligibility.findings.length === 0 ||
        eligibility.findings.some(finding => !finding.requirementId || !['MET', 'NOT_MET', 'UNKNOWN'].includes(finding.status))) return deny('GUARD_FAILED');
  }
  if (['SCREEN', 'OPEN_VERIFICATION', 'ASSIGN', 'REQUEST_CORRECTION'].includes(command.transition)) {
    if (!eligibility) return deny('GUARD_FAILED');
    if (command.transition === 'ASSIGN' && eligibility.status !== 'MET') return deny('GUARD_FAILED');
  }
  const change: StateChange = structuredClone({
    before: snapshot, after: { ...snapshot, state: rule.to, revision: snapshot.revision + 1 },
    audit: { type: rule.event, actorId: canonicalIdentity(actor.userId), occurredAt: context.occurredAt, reason: command.reason,
      binding: { applicationId: snapshot.applicationId, submissionVersionId: snapshot.submissionVersionId, programmeId: snapshot.programmeId, programmeVersionId: snapshot.programmeVersionId },
      ...(eligibility ? { eligibility } : {}) },
  });
  return { ok: true, replayed: false, receipt: { key: command.idempotencyKey, actorId: canonicalIdentity(actor.userId), fingerprint, change } };
}

/** A-owned adapter contract, not a proposed database schema. No external I/O in callback. */
export interface WorkflowTransaction {
  read(command: TransitionCommand): Promise<{ snapshot: WorkflowSnapshot; context: TransitionContext; prior?: CommandReceipt }>;
  /** Atomically CAS revision and persist state, receipt, history, audit and outbox; rollback all on failure. */
  commit(receipt: CommandReceipt): Promise<void>;
}
export interface WorkflowRepository {
  transaction<T>(work: (transaction: WorkflowTransaction) => Promise<T>): Promise<T>;
}
export function executeTransition(repository: WorkflowRepository, command: TransitionCommand): Promise<TransitionResult> {
  return repository.transaction(async transaction => {
    const { snapshot, context, prior } = await transaction.read(command);
    const result = transitionWorkflow(snapshot, command, context, prior);
    if (result.ok && !result.replayed) await transaction.commit(result.receipt);
    return result;
  });
}
