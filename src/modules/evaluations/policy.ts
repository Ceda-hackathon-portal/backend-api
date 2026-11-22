import { canonicalIdentity } from '../../shared/identity.js';
import { canReviewAssignment, type ReviewAssignment } from '../assignments/policy.js';
import { sameBinding, type SubmissionBinding, type WorkflowActor } from '../workflow/authorization.js';

export interface Criterion {
  readonly id: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly evidenceRequired: boolean;
  readonly commentRequired?: boolean;
  readonly weight?: number;
}
export interface ScoringConfig {
  readonly criteria: readonly Criterion[];
  readonly aggregation?: 'SUM' | 'WEIGHTED_SUM';
}
export interface Score { readonly criterionId: string; readonly value: number; readonly evidence: string; readonly comment?: string }
export interface Evaluation extends SubmissionBinding {
  readonly assignmentId: string;
  readonly officerId: string;
  readonly revision: number;
  readonly state: 'DRAFT' | 'FINALIZED';
  readonly scores: readonly Score[];
  readonly comment: string;
  readonly recommendation: 'APPROVE' | 'REJECT' | 'REVISE' | null;
  readonly total: number | null;
}
export interface EvaluationWrite {
  readonly expectedRevision: number;
  readonly scores: readonly Score[];
  readonly comment: string;
  readonly recommendation: Evaluation['recommendation'];
  readonly finalize: boolean;
}
export type EvaluationResult =
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'CONFIGURATION_ERROR' | 'INVALID_INPUT' | 'REVISION_CONFLICT' | 'LOCKED' }
  | { readonly ok: true; readonly evaluation: Evaluation; readonly audit: { readonly type: 'EVALUATION_SAVED' | 'EVALUATION_FINALIZED'; readonly actorId: string; readonly assignmentId: string } };

export function writeEvaluation(actor: WorkflowActor, assignment: ReviewAssignment, current: Evaluation,
  binding: SubmissionBinding, config: ScoringConfig | null | undefined, write: EvaluationWrite): EvaluationResult {
  const fail = (code: Extract<EvaluationResult, { ok: false }>['code']): EvaluationResult => ({ ok: false, code });
  if (!canReviewAssignment(actor, assignment, binding) || !sameBinding(current, binding) ||
      canonicalIdentity(current.officerId) !== canonicalIdentity(actor.userId) || current.assignmentId !== assignment.id) return fail('FORBIDDEN');
  if (current.state === 'FINALIZED') return fail('LOCKED');
  if (current.state !== 'DRAFT') return fail('INVALID_INPUT');
  if (!Number.isSafeInteger(write.expectedRevision) || write.expectedRevision < 0 || current.revision !== write.expectedRevision) return fail('REVISION_CONFLICT');
  if (!config || !Array.isArray(config.criteria)) return fail('CONFIGURATION_ERROR');
  const criteria = config.criteria;
  if (!criteria.length || criteria.some(c => !c.id || !Number.isFinite(c.minimum) || !Number.isFinite(c.maximum) || c.maximum < c.minimum) ||
      new Set(criteria.map(c => c.id)).size !== criteria.length ||
      criteria.some(c => c.weight !== undefined && (!Number.isFinite(c.weight) || c.weight < 0)) ||
      (config.aggregation === 'WEIGHTED_SUM' && criteria.some(c => !Number.isFinite(c.weight) || (c.weight ?? -1) < 0)) ||
      (config.aggregation !== undefined && !['SUM', 'WEIGHTED_SUM'].includes(config.aggregation))) return fail('CONFIGURATION_ERROR');
  if (new Set(write.scores.map(s => s.criterionId)).size !== write.scores.length ||
      write.scores.some(s => !criteria.some(c => c.id === s.criterionId))) return fail('INVALID_INPUT');
  for (const score of write.scores) {
    const criterion = criteria.find(c => c.id === score.criterionId)!;
    if (!Number.isFinite(score.value) || score.value < criterion.minimum || score.value > criterion.maximum ||
        (criterion.evidenceRequired && !score.evidence.trim()) ||
        (criterion.commentRequired && !score.comment?.trim())) return fail('INVALID_INPUT');
  }
  if (write.finalize && (write.scores.length !== criteria.length || !write.comment.trim() || !write.recommendation)) return fail('INVALID_INPUT');
  const scores = criteria.flatMap(criterion => write.scores.filter(score => score.criterionId === criterion.id));
  const total = config.aggregation === undefined ? null : config.aggregation === 'SUM'
    ? scores.reduce((sum, score) => sum + score.value, 0)
    : scores.reduce((sum, score) => sum + score.value * criteria.find(c => c.id === score.criterionId)!.weight!, 0);
  if (total !== null && !Number.isFinite(total)) return fail('CONFIGURATION_ERROR');
  const evaluation: Evaluation = { ...current, revision: current.revision + 1, state: write.finalize ? 'FINALIZED' : 'DRAFT',
    scores: structuredClone(scores), comment: write.comment, recommendation: write.recommendation, total };
  return { ok: true, evaluation, audit: { type: write.finalize ? 'EVALUATION_FINALIZED' : 'EVALUATION_SAVED', actorId: actor.userId, assignmentId: assignment.id } };
}

export interface EvaluationCommand extends EvaluationWrite { readonly idempotencyKey: string }
export interface EvaluationReceipt {
  readonly key: string;
  readonly actorId: string;
  readonly fingerprint: string;
  readonly evaluation: Evaluation;
  readonly audit: Extract<EvaluationResult, { ok: true }>['audit'];
}
export type EvaluationCommandResult =
  | Extract<EvaluationResult, { ok: false }>
  | { readonly ok: false; readonly code: 'IDEMPOTENCY_CONFLICT' }
  | { readonly ok: true; readonly replayed: boolean; readonly receipt: EvaluationReceipt };

/** A loads live grants, assignment, evaluation and prior receipt in one transaction.
 * Persist the revision CAS, evaluation, receipt and audit atomically; no external I/O in that transaction.
 */
export function executeEvaluationCommand(actor: WorkflowActor, assignment: ReviewAssignment, current: Evaluation,
  binding: SubmissionBinding, config: ScoringConfig | null | undefined, command: EvaluationCommand,
  prior?: EvaluationReceipt): EvaluationCommandResult {
  if (!canReviewAssignment(actor, assignment, binding) || !sameBinding(current, binding) ||
      canonicalIdentity(current.officerId) !== canonicalIdentity(actor.userId) || current.assignmentId !== assignment.id) return { ok: false, code: 'FORBIDDEN' };
  if (!command.idempotencyKey?.trim()) return { ok: false, code: 'INVALID_INPUT' };
  const fingerprint = JSON.stringify([binding, assignment.id, command.expectedRevision, command.scores,
    command.comment, command.recommendation, command.finalize]);
  if (prior) {
    if (prior.key !== command.idempotencyKey || canonicalIdentity(prior.actorId) !== canonicalIdentity(actor.userId) ||
        prior.fingerprint !== fingerprint || JSON.stringify(prior.evaluation) !== JSON.stringify(current)) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    return { ok: true, replayed: true, receipt: structuredClone(prior) };
  }
  const result = writeEvaluation(actor, assignment, current, binding, config, command);
  if (!result.ok) return result;
  return { ok: true, replayed: false, receipt: { key: command.idempotencyKey, actorId: actor.userId,
    fingerprint, evaluation: result.evaluation, audit: result.audit } };
}
