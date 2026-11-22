import { canonicalIdentity } from '../../shared/identity.js';
import { releaseDecision, type Decision, type DecisionResult } from '../decisions/policy.js';
import { hasAssignment, hasGrant, sameBinding, type SubmissionBinding, type WorkflowActor } from '../workflow/authorization.js';
import type { WorkflowState } from '../workflow/engine.js';

/** Applicant projection deliberately excludes internal reasons, reviewers and scores. */
export interface ApplicantOutcome extends SubmissionBinding {
  readonly outcome: Decision['outcome'];
  readonly message: string;
}
export interface ReleaseCommand {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly applicantMessage: string;
}
export interface ReleaseReceipt {
  /** Internal persistence record; applicant APIs serialize applicantOutcome only. */
  readonly key: string;
  readonly actorId: string;
  readonly fingerprint: string;
  readonly afterRevision: number;
  readonly decision: Decision;
  readonly applicantOutcome: ApplicantOutcome;
  readonly audit: Extract<DecisionResult, { ok: true }>['audit'];
}
export type ReleaseResult =
  | Extract<DecisionResult, { ok: false }>
  | { readonly ok: false; readonly code: 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' }
  | { readonly ok: true; readonly replayed: boolean; readonly receipt: ReleaseReceipt };

/** A loads current authority, decision and receipt under transaction locks.
 * Persist revision CAS, release, public outcome, receipt, audit, history and outbox atomically.
 */
export function executeReleaseCommand(actor: WorkflowActor, binding: SubmissionBinding, ownerId: string,
  state: WorkflowState, currentRevision: number, decision: Decision, command: ReleaseCommand,
  prior?: ReleaseReceipt): ReleaseResult {
  if (actor.role !== 'publisher' || !hasGrant(actor, binding, 'decision.publish') || !hasAssignment(actor, binding, ownerId)) return { ok: false, code: 'FORBIDDEN' };
  if (!sameBinding(decision, binding)) return { ok: false, code: 'INVALID_INPUT' };
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !Number.isSafeInteger(currentRevision) || currentRevision < 0 || currentRevision >= Number.MAX_SAFE_INTEGER ||
      !command.idempotencyKey?.trim() || !command.reason?.trim() || !command.applicantMessage?.trim()) return { ok: false, code: 'INVALID_INPUT' };
  const fingerprint = JSON.stringify([binding, decision.id, command.expectedRevision, command.reason, command.applicantMessage]);
  if (prior) {
    if (prior.key !== command.idempotencyKey || canonicalIdentity(prior.actorId) !== canonicalIdentity(actor.userId) ||
        prior.fingerprint !== fingerprint || prior.afterRevision !== currentRevision || state !== 'OUTCOME_RELEASED' ||
        JSON.stringify(prior.decision) !== JSON.stringify(decision)) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    return { ok: true, replayed: true, receipt: structuredClone(prior) };
  }
  if (currentRevision !== command.expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
  const result = releaseDecision(actor, binding, ownerId, state, decision, command.reason);
  if (!result.ok) return result;
  const applicantOutcome: ApplicantOutcome = { ...structuredClone(binding), outcome: decision.outcome, message: command.applicantMessage };
  return { ok: true, replayed: false, receipt: { key: command.idempotencyKey, actorId: actor.userId,
    fingerprint, afterRevision: currentRevision + 1, decision: result.decision,
    applicantOutcome, audit: result.audit } };
}
