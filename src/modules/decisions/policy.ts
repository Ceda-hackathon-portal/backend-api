import { canonicalIdentity } from '../../shared/identity.js';
import type { Evaluation } from '../evaluations/policy.js';
import { hasAssignment, hasGrant, sameBinding, type SubmissionBinding, type WorkflowActor } from '../workflow/authorization.js';
import type { WorkflowState } from '../workflow/engine.js';

export interface Decision extends SubmissionBinding {
  readonly id: string;
  readonly outcome: 'APPROVED' | 'REJECTED' | 'REVISION_REQUESTED';
  readonly reason: string;
  readonly adjudicatorId: string;
  readonly released: boolean;
}
export interface DecisionPolicy {
  readonly permittedOutcomes: readonly Decision['outcome'][];
}
export interface DecisionContext {
  readonly policy: DecisionPolicy;
  /** Current-stage decision loaded from trusted storage; null means none exists. */
  readonly existingDecision: Decision | null;
}
export type DecisionResult =
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'INVALID_INPUT' | 'INVALID_STATE' | 'INCOMPLETE_EVALUATIONS' | 'CONFLICT' | 'CONFIGURATION_ERROR' }
  | { readonly ok: true; readonly decision: Decision; readonly audit: { readonly type: 'DECISION_RECORDED' | 'DECISION_RELEASED'; readonly actorId: string; readonly decisionId: string; readonly reason: string; readonly binding: SubmissionBinding; readonly outcome: Decision['outcome'] } };

export function recordDecision(actor: WorkflowActor, binding: SubmissionBinding, ownerId: string, state: WorkflowState,
  evaluations: readonly Evaluation[], decision: Decision, context: DecisionContext | null | undefined): DecisionResult {
  const fail = (code: Extract<DecisionResult, { ok: false }>['code']): DecisionResult => ({ ok: false, code });
  if (actor.role !== 'adjudicator' || !hasGrant(actor, binding, 'adjudication.decide') || !hasAssignment(actor, binding, ownerId)) return fail('FORBIDDEN');
  if (state !== 'ADJUDICATION') return fail('INVALID_STATE');
  if (!context || !Object.hasOwn(context, 'existingDecision') || !context.policy ||
      !Array.isArray(context.policy.permittedOutcomes) || !context.policy.permittedOutcomes.length ||
      context.existingDecision === undefined ||
      context.policy.permittedOutcomes.some(outcome => !['APPROVED', 'REJECTED', 'REVISION_REQUESTED'].includes(outcome))) return fail('CONFIGURATION_ERROR');
  if (context.existingDecision !== null) return fail('CONFLICT');
  if (!decision.id || !decision.reason.trim() || !sameBinding(decision, binding) || decision.released ||
      canonicalIdentity(decision.adjudicatorId) !== canonicalIdentity(actor.userId) ||
      !['APPROVED', 'REJECTED', 'REVISION_REQUESTED'].includes(decision.outcome)) return fail('INVALID_INPUT');
  if (!context.policy.permittedOutcomes.includes(decision.outcome)) return fail('INVALID_STATE');
  if (!evaluations.length || evaluations.some(e => e.state !== 'FINALIZED' || !sameBinding(e, binding) ||
      !e.assignmentId || !e.officerId || !e.scores.length || !e.comment.trim() || !e.recommendation) ||
      new Set(evaluations.map(e => e.assignmentId)).size !== evaluations.length) return fail('INCOMPLETE_EVALUATIONS');
  if (evaluations.some(e => canonicalIdentity(e.officerId) === canonicalIdentity(actor.userId))) return fail('CONFLICT');
  return { ok: true, decision: structuredClone(decision), audit: { type: 'DECISION_RECORDED', actorId: actor.userId, decisionId: decision.id,
    reason: decision.reason, binding: structuredClone(binding), outcome: decision.outcome } };
}

export function releaseDecision(actor: WorkflowActor, binding: SubmissionBinding, ownerId: string, state: WorkflowState,
  decision: Decision, reason: string): DecisionResult {
  const fail = (code: Extract<DecisionResult, { ok: false }>['code']): DecisionResult => ({ ok: false, code });
  if (actor.role !== 'publisher' || !hasGrant(actor, binding, 'decision.publish') || !hasAssignment(actor, binding, ownerId)) return fail('FORBIDDEN');
  if (state !== 'DECIDED') return fail('INVALID_STATE');
  if (!sameBinding(decision, binding) || decision.released || !reason.trim()) return fail('INVALID_INPUT');
  if (canonicalIdentity(decision.adjudicatorId) === canonicalIdentity(actor.userId)) return fail('CONFLICT');
  return { ok: true, decision: { ...decision, released: true }, audit: { type: 'DECISION_RELEASED', actorId: actor.userId, decisionId: decision.id,
    reason, binding: structuredClone(binding), outcome: decision.outcome } };
}

export interface DecisionCommand {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly decision: Decision;
}
export interface DecisionReceipt {
  readonly key: string;
  readonly actorId: string;
  readonly fingerprint: string;
  readonly afterRevision: number;
  readonly decision: Decision;
  readonly audit: Extract<DecisionResult, { ok: true }>['audit'];
}
export type DecisionCommandResult =
  | Extract<DecisionResult, { ok: false }>
  | { readonly ok: false; readonly code: 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' }
  | { readonly ok: true; readonly replayed: boolean; readonly receipt: DecisionReceipt };

/** A loads current revision, finalized evidence, existing decision and receipt under transaction locks.
 * Persist the revision CAS, decision, receipt, history, audit and outbox atomically.
 */
export function executeDecisionCommand(actor: WorkflowActor, binding: SubmissionBinding, ownerId: string,
  state: WorkflowState, currentRevision: number, evaluations: readonly Evaluation[], context: DecisionContext | null | undefined,
  command: DecisionCommand, prior?: DecisionReceipt): DecisionCommandResult {
  if (actor.role !== 'adjudicator' || !hasGrant(actor, binding, 'adjudication.decide') || !hasAssignment(actor, binding, ownerId)) return { ok: false, code: 'FORBIDDEN' };
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !Number.isSafeInteger(currentRevision) || currentRevision < 0 || currentRevision >= Number.MAX_SAFE_INTEGER ||
      !command.idempotencyKey?.trim()) return { ok: false, code: 'INVALID_INPUT' };
  const fingerprint = JSON.stringify([binding, command.expectedRevision, command.decision]);
  if (prior) {
    if (prior.key !== command.idempotencyKey || canonicalIdentity(prior.actorId) !== canonicalIdentity(actor.userId) ||
        prior.fingerprint !== fingerprint || prior.afterRevision !== currentRevision || state !== 'DECIDED' ||
        JSON.stringify(context?.existingDecision) !== JSON.stringify(prior.decision)) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    return { ok: true, replayed: true, receipt: structuredClone(prior) };
  }
  if (currentRevision !== command.expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
  const result = recordDecision(actor, binding, ownerId, state, evaluations, command.decision, context);
  if (!result.ok) return result;
  return { ok: true, replayed: false, receipt: { key: command.idempotencyKey, actorId: actor.userId,
    fingerprint, afterRevision: currentRevision + 1, decision: result.decision, audit: result.audit } };
}
