import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignOfficer, canReadAssignedSubmission, canReviewAssignment, changeAssignment, declareConflict, revokeAssignment, type ReviewAssignment } from '../src/modules/assignments/policy.js';
import { executeEvaluationCommand, writeEvaluation, type Evaluation } from '../src/modules/evaluations/policy.js';
import { executeDecisionCommand, recordDecision, releaseDecision, type Decision } from '../src/modules/decisions/policy.js';
import { executeReleaseCommand } from '../src/modules/feedback/policy.js';
import type { WorkflowActor } from '../src/modules/workflow/authorization.js';

const binding = { applicationId: 'app', submissionVersionId: 'v1', programmeId: 'p', programmeVersionId: 'pv1' };
const assignment: ReviewAssignment = { ...binding, id: 'a1', officerId: 'reviewer', ownerId: 'owner', active: true, revoked: false, conflict: 'UNDECLARED' };
const eligible = { userId: 'reviewer', programmeId: 'p', active: true, mayReview: true };
const manager: WorkflowActor = { userId: 'manager', sessionActive: true, role: 'officer', grants: [{ permission: 'assignment.manage', programmeId: 'p', active: true }] };
const reviewer: WorkflowActor = { userId: 'reviewer', sessionActive: true, role: 'evaluator', grants: [{ permission: 'evaluation.write', programmeId: 'p', active: true }] };
const cleared = { ...assignment, conflict: 'CLEARED' as const };
const readingOfficer: WorkflowActor = { userId: 'reviewer', sessionActive: true, role: 'officer',
  grants: [{ permission: 'eligibility.read-submission', programmeId: 'p', active: true }] };

test('officer read requires an active programme read grant', () => {
  assert.equal(canReadAssignedSubmission(readingOfficer, cleared, binding), true);
  assert.equal(canReadAssignedSubmission({ ...readingOfficer, grants: [] }, cleared, binding), false);
  assert.equal(canReadAssignedSubmission({ ...readingOfficer, grants: [{ ...readingOfficer.grants[0]!, active: false }] }, cleared, binding), false);
  assert.equal(canReadAssignedSubmission({ ...readingOfficer, grants: [{ ...readingOfficer.grants[0]!, programmeId: 'other' }] }, cleared, binding), false);
});

test('officer read requires an active assignment', () => {
  assert.equal(canReadAssignedSubmission(readingOfficer, { ...cleared, active: false }, binding), false);
});

test('officer read requires the exact application and immutable submission version', () => {
  assert.equal(canReadAssignedSubmission(readingOfficer, cleared, { ...binding, submissionVersionId: 'v2' }), false);
  assert.equal(canReadAssignedSubmission(readingOfficer, cleared, { ...binding, applicationId: 'other' }), false);
});

test('officer read denies undeclared or declared conflict', () => {
  assert.equal(canReadAssignedSubmission(readingOfficer, assignment, binding), false);
  assert.equal(canReadAssignedSubmission(readingOfficer, { ...cleared, conflict: 'DECLARED' }, binding), false);
});

test('officer read denies self-review', () => {
  assert.equal(canReadAssignedSubmission(readingOfficer, { ...cleared, ownerId: 'reviewer' }, binding), false);
});

test('officer read denies revoked assignment and inactive session', () => {
  assert.equal(canReadAssignedSubmission(readingOfficer, { ...cleared, revoked: true }, binding), false);
  assert.equal(canReadAssignedSubmission({ ...readingOfficer, sessionActive: false }, cleared, binding), false);
});
const evaluation: Evaluation = { ...binding, assignmentId: 'a1', officerId: 'reviewer', revision: 0, state: 'DRAFT', scores: [], comment: '', recommendation: null, total: null };
const config = { criteria: [{ id: 'quality', minimum: 0, maximum: 5, evidenceRequired: true }], aggregation: 'SUM' as const };
const write = { expectedRevision: 0, scores: [{ criterionId: 'quality', value: 4, evidence: 'document reviewed' }], comment: 'Reviewed', recommendation: 'APPROVE' as const, finalize: true };

test('assignment requires scoped manager, distinct owner and officer, exact binding and no active duplicate', () => {
  const result = assignOfficer(manager, assignment, eligible, [], 'Assigned');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.audit.type, 'ASSIGNMENT_CREATED');
  assert.equal(assignOfficer({ ...manager, grants: [] }, assignment, eligible, [], 'Assigned').ok, false);
  assert.equal(assignOfficer(manager, { ...assignment, ownerId: 'reviewer' }, eligible, [], 'Assigned').ok, false);
  assert.equal(assignOfficer(manager, assignment, eligible, [assignment], 'Assigned').ok, false);
  assert.equal(assignOfficer(manager, assignment, { ...eligible, mayReview: false }, [], 'Assigned').ok, false);
  assert.equal(assignOfficer(manager, assignment, { ...eligible, programmeId: 'other' }, [], 'Assigned').ok, false);
  assert.equal(assignOfficer(manager, assignment, eligible, [{ ...assignment, active: false, revoked: true, conflict: 'DECLARED' }], 'Assigned').ok, false);
  assert.deepEqual(assignOfficer(manager, assignment, eligible, [{ ...assignment, active: false, revoked: true }], 'Assigned'), { ok: false, code: 'CONFLICT' });
  assert.deepEqual(assignOfficer(manager, assignment, eligible, [{ ...assignment, id: 'old', ownerId: 'different', active: false, revoked: true }], 'Assigned'), { ok: false, code: 'CONFLICT' });
  assert.equal(canReviewAssignment(reviewer, cleared, binding), true);
  assert.equal(canReviewAssignment(reviewer, cleared, { ...binding, submissionVersionId: 'v2' }), false);
  assert.equal(canReviewAssignment({ ...reviewer, grants: [{ permission: 'evaluation.write', programmeId: 'other', active: true }] }, cleared, binding), false);
});

test('conflict and revocation immediately block review and produce audit', () => {
  const conflict = declareConflict(reviewer, cleared, 'Personal relationship');
  assert.ok(conflict.ok);
  if (!conflict.ok) return;
  assert.equal(conflict.audit.type, 'CONFLICT_DECLARED');
  assert.equal(canReviewAssignment(reviewer, conflict.assignment, binding), false);
  assert.equal(declareConflict(reviewer, conflict.assignment, 'Again').ok, false);
  assert.deepEqual(declareConflict({ ...reviewer, grants: [] }, cleared, 'Conflict'), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(declareConflict({ ...reviewer, role: 'owner' }, cleared, 'Conflict'), { ok: false, code: 'FORBIDDEN' });
  const revoked = revokeAssignment(manager, cleared, 'Reassigned');
  assert.ok(revoked.ok);
  if (!revoked.ok) return;
  assert.equal(revoked.audit.type, 'ASSIGNMENT_REVOKED');
  assert.equal(canReviewAssignment(reviewer, revoked.assignment, binding), false);
});

test('explicit assignment change preserves the revoked record and both audit events', () => {
  const replacement: ReviewAssignment = { ...assignment, id: 'a2', officerId: 'other' };
  const nextOfficer = { ...eligible, userId: 'other' };
  const result = changeAssignment(manager, cleared, replacement, nextOfficer, [cleared], 'Workload change');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.previous.id, 'a1');
  assert.equal(result.previous.revoked, true);
  assert.equal(result.replacement.id, 'a2');
  assert.deepEqual(result.audit.map(event => event.type), ['ASSIGNMENT_REVOKED', 'ASSIGNMENT_CREATED']);
  assert.equal(cleared.revoked, false);
  assert.deepEqual(changeAssignment(manager, cleared, { ...replacement, submissionVersionId: 'v2' }, nextOfficer, [cleared], 'Change'),
    { ok: false, code: 'CONFLICT' });
  assert.deepEqual(changeAssignment(manager, cleared, { ...replacement, officerId: 'reviewer' }, eligible, [cleared], 'Change'),
    { ok: false, code: 'CONFLICT' });
  assert.deepEqual(changeAssignment(manager, cleared, replacement, nextOfficer, [{ ...cleared, revoked: true }], 'Change'),
    { ok: false, code: 'CONFLICT' });
});

test('scoring validates configuration, ranges, evidence and locks finalized evaluation', () => {
  const result = writeEvaluation(reviewer, cleared, evaluation, binding, config, write);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.evaluation.total, 4);
  assert.equal(result.audit.type, 'EVALUATION_FINALIZED');
  assert.deepEqual(writeEvaluation(reviewer, cleared, result.evaluation, binding, config, { ...write, expectedRevision: 1 }), { ok: false, code: 'LOCKED' });
  assert.deepEqual(writeEvaluation(reviewer, cleared, evaluation, binding, { criteria: [] }, write), { ok: false, code: 'CONFIGURATION_ERROR' });
  assert.deepEqual(writeEvaluation(reviewer, cleared, evaluation, binding, { ...config, aggregation: 'WEIGHTED_SUM' }, write), { ok: false, code: 'CONFIGURATION_ERROR' });
  assert.deepEqual(writeEvaluation(reviewer, cleared, evaluation, binding, config, { ...write, scores: [{ ...write.scores[0]!, value: 6 }] }), { ok: false, code: 'INVALID_INPUT' });
  assert.deepEqual(writeEvaluation(reviewer, cleared, evaluation, binding, config, { ...write, scores: [{ ...write.scores[0]!, evidence: '' }] }), { ok: false, code: 'INVALID_INPUT' });
  assert.deepEqual(writeEvaluation(reviewer, cleared, evaluation, binding, config, { ...write, expectedRevision: 2 }), { ok: false, code: 'REVISION_CONFLICT' });
  assert.deepEqual(writeEvaluation(reviewer, { ...cleared, revoked: true }, evaluation, binding, config, write), { ok: false, code: 'FORBIDDEN' });
});

test('scoring without aggregation leaves total unset and draft may be incomplete', () => {
  const result = writeEvaluation(reviewer, cleared, evaluation, binding, { criteria: config.criteria }, { ...write, scores: [], finalize: false, recommendation: null });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.evaluation.total, null);
});

test('scoring rejects absent configuration, conflicted officer and wrong version', () => {
  assert.deepEqual(writeEvaluation(reviewer, cleared, evaluation, binding, undefined, write), { ok: false, code: 'CONFIGURATION_ERROR' });
  assert.deepEqual(writeEvaluation(reviewer, { ...cleared, conflict: 'DECLARED' }, evaluation, binding, config, write), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(writeEvaluation(reviewer, cleared, evaluation, { ...binding, submissionVersionId: 'v2' }, config, write), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(writeEvaluation({ ...reviewer, grants: [] }, cleared, evaluation, binding, config, write), { ok: false, code: 'FORBIDDEN' });
});

test('configured criterion comments and weights are validated without default weights', () => {
  const weighted = { criteria: [{ ...config.criteria[0]!, commentRequired: true, weight: 2 }], aggregation: 'WEIGHTED_SUM' as const };
  assert.deepEqual(writeEvaluation(reviewer, cleared, evaluation, binding, weighted, write), { ok: false, code: 'INVALID_INPUT' });
  const result = writeEvaluation(reviewer, cleared, evaluation, binding, weighted,
    { ...write, scores: [{ ...write.scores[0]!, comment: 'Strong evidence' }] });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.evaluation.total, 8);
    assert.equal(result.evaluation.scores[0]?.comment, 'Strong evidence');
  }
  assert.deepEqual(writeEvaluation(reviewer, cleared, evaluation, binding,
    { criteria: [{ ...config.criteria[0]!, weight: -1 }], aggregation: 'SUM' }, write), { ok: false, code: 'CONFIGURATION_ERROR' });
});

test('score aggregation and stored criterion order follow configuration', () => {
  const ordered = { criteria: [
    { id: 'a', minimum: 0, maximum: 1, evidenceRequired: false },
    { id: 'b', minimum: 0, maximum: 1, evidenceRequired: false },
    { id: 'c', minimum: 0, maximum: 1, evidenceRequired: false },
  ], aggregation: 'SUM' as const };
  const scores = [
    { criterionId: 'a', value: 1e-16, evidence: '' },
    { criterionId: 'b', value: 1, evidence: '' },
    { criterionId: 'c', value: 1e-16, evidence: '' },
  ];
  const first = writeEvaluation(reviewer, cleared, evaluation, binding, ordered, { ...write, scores });
  const reversed = writeEvaluation(reviewer, cleared, evaluation, binding, ordered, { ...write, scores: scores.toReversed() });
  assert.ok(first.ok && reversed.ok);
  if (first.ok && reversed.ok) {
    assert.deepEqual(first.evaluation.scores, reversed.evaluation.scores);
    assert.equal(first.evaluation.total, reversed.evaluation.total);
  }
});

test('evaluation command retries replay once and recheck live authorization', () => {
  const command = { ...write, idempotencyKey: 'evaluation-1' };
  const first = executeEvaluationCommand(reviewer, cleared, evaluation, binding, config, command);
  assert.ok(first.ok && !first.replayed);
  if (!first.ok) return;
  const replay = executeEvaluationCommand(reviewer, cleared, first.receipt.evaluation, binding, config, command, first.receipt);
  assert.ok(replay.ok && replay.replayed);
  assert.deepEqual(executeEvaluationCommand(reviewer, cleared, first.receipt.evaluation, binding, config,
    { ...command, comment: 'Changed' }, first.receipt), { ok: false, code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(executeEvaluationCommand(reviewer, { ...cleared, revoked: true }, first.receipt.evaluation, binding, config,
    command, first.receipt), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(executeEvaluationCommand(reviewer, cleared, evaluation, binding, config,
    command, first.receipt), { ok: false, code: 'IDEMPOTENCY_CONFLICT' });
});

const adjudicator: WorkflowActor = { userId: 'judge', sessionActive: true, role: 'adjudicator', grants: [{ permission: 'adjudication.decide', programmeId: 'p', active: true }],
  assignment: { ...binding, userId: 'judge', active: true, revoked: false, conflictCleared: true } };
const publisher: WorkflowActor = { ...adjudicator, userId: 'publisher', role: 'publisher', grants: [{ permission: 'decision.publish', programmeId: 'p', active: true }], assignment: { ...adjudicator.assignment!, userId: 'publisher' } };
const decision: Decision = { ...binding, id: 'd1', outcome: 'APPROVED', reason: 'Evidence reviewed', adjudicatorId: 'judge', released: false };
const decisionPolicy = { policy: { permittedOutcomes: ['APPROVED', 'REJECTED', 'REVISION_REQUESTED'] as const }, existingDecision: null };
const finalized: Evaluation = { ...evaluation, state: 'FINALIZED', scores: write.scores, comment: 'Reviewed', recommendation: 'APPROVE' };

test('decision needs finalized exact-version evaluations, authority and separation', () => {
  const result = recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [finalized], decision, decisionPolicy);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.audit.type, 'DECISION_RECORDED');
    assert.deepEqual(result.audit.binding, binding);
    assert.equal(result.audit.outcome, 'APPROVED');
  }
  assert.deepEqual(recordDecision({ ...adjudicator, grants: [] }, binding, 'owner', 'ADJUDICATION', [finalized], decision, decisionPolicy), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [evaluation], decision, decisionPolicy), { ok: false, code: 'INCOMPLETE_EVALUATIONS' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [{ ...finalized, scores: [] }], decision, decisionPolicy), { ok: false, code: 'INCOMPLETE_EVALUATIONS' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [finalized, finalized], decision, decisionPolicy), { ok: false, code: 'INCOMPLETE_EVALUATIONS' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [{ ...finalized, submissionVersionId: 'v2' }], decision, decisionPolicy), { ok: false, code: 'INCOMPLETE_EVALUATIONS' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'SUBMITTED', [finalized], decision, decisionPolicy), { ok: false, code: 'INVALID_STATE' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [{ ...finalized, officerId: 'judge' }], decision, decisionPolicy), { ok: false, code: 'CONFLICT' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [finalized], decision, { ...decisionPolicy, policy: { permittedOutcomes: [] } }), { ok: false, code: 'CONFIGURATION_ERROR' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [finalized], decision, { ...decisionPolicy, policy: { permittedOutcomes: ['REJECTED'] } }), { ok: false, code: 'INVALID_STATE' });
});

test('release is separate, authorized and audited', () => {
  const result = releaseDecision(publisher, binding, 'owner', 'DECIDED', decision, 'Publication approved');
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.decision.released, true);
  assert.equal(result.audit.type, 'DECISION_RELEASED');
  assert.deepEqual(releaseDecision(publisher, binding, 'owner', 'DECIDED', result.decision, 'Again'), { ok: false, code: 'INVALID_INPUT' });
  assert.deepEqual(releaseDecision(adjudicator, binding, 'owner', 'DECIDED', decision, 'Now'), { ok: false, code: 'FORBIDDEN' });
});

test('screening findings and recommendations cannot create a decision without finalized evaluations', () => {
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [], decision, decisionPolicy),
    { ok: false, code: 'INCOMPLETE_EVALUATIONS' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [{ ...evaluation, recommendation: 'APPROVE' }], decision, decisionPolicy),
    { ok: false, code: 'INCOMPLETE_EVALUATIONS' });
});

test('decision requires reason, cleared adjudicator assignment and configured outcomes', () => {
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [finalized], { ...decision, reason: '' }, decisionPolicy),
    { ok: false, code: 'INVALID_INPUT' });
  assert.deepEqual(recordDecision({ ...adjudicator, assignment: { ...adjudicator.assignment!, conflictCleared: false } }, binding, 'owner', 'ADJUDICATION', [finalized], decision, decisionPolicy),
    { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [finalized], decision, undefined),
    { ok: false, code: 'CONFIGURATION_ERROR' });
});

test('decision creation rejects an existing current-stage decision and missing decision facts', () => {
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [finalized], decision,
    { ...decisionPolicy, existingDecision: decision }), { ok: false, code: 'CONFLICT' });
  assert.deepEqual(recordDecision(adjudicator, binding, 'owner', 'ADJUDICATION', [finalized], decision,
    { policy: decisionPolicy.policy } as unknown as Parameters<typeof recordDecision>[6]), { ok: false, code: 'CONFIGURATION_ERROR' });
});

test('decision command rejects stale writes and replays only the identical authorized command', () => {
  const command = { expectedRevision: 4, idempotencyKey: 'decision-1', decision };
  assert.deepEqual(executeDecisionCommand(adjudicator, binding, 'owner', 'ADJUDICATION', 5, [finalized], decisionPolicy, command),
    { ok: false, code: 'REVISION_CONFLICT' });
  const first = executeDecisionCommand(adjudicator, binding, 'owner', 'ADJUDICATION', 4, [finalized], decisionPolicy, command);
  assert.ok(first.ok && !first.replayed);
  if (!first.ok) return;
  const after = { ...decisionPolicy, existingDecision: decision };
  const replay = executeDecisionCommand(adjudicator, binding, 'owner', 'DECIDED', 5, [finalized], after, command, first.receipt);
  assert.ok(replay.ok && replay.replayed);
  assert.deepEqual(executeDecisionCommand(adjudicator, binding, 'owner', 'DECIDED', 5, [finalized], after,
    { ...command, decision: { ...decision, reason: 'Changed' } }, first.receipt), { ok: false, code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(executeDecisionCommand({ ...adjudicator, grants: [] }, binding, 'owner', 'DECIDED', 5,
    [finalized], after, command, first.receipt), { ok: false, code: 'FORBIDDEN' });
});

test('outcome release is version-bound and excludes internal review material from applicant feedback', () => {
  const command = { expectedRevision: 5, idempotencyKey: 'release-1', reason: 'Publication approved', applicantMessage: 'Your application was approved.' };
  const result = executeReleaseCommand(publisher, binding, 'owner', 'DECIDED', 5, decision, command);
  assert.ok(result.ok && !result.replayed);
  if (!result.ok) return;
  assert.deepEqual(result.receipt.applicantOutcome, { ...binding, outcome: 'APPROVED', message: command.applicantMessage });
  assert.equal(JSON.stringify(result.receipt.applicantOutcome).includes(decision.reason), false);
  assert.equal(result.receipt.audit.type, 'DECISION_RELEASED');
  assert.deepEqual(executeReleaseCommand(publisher, { ...binding, submissionVersionId: 'v2' }, 'owner', 'DECIDED', 5,
    decision, command), { ok: false, code: 'FORBIDDEN' });
});

test('release rejects premature state, stale revision, empty feedback and unauthorized actor', () => {
  const command = { expectedRevision: 5, idempotencyKey: 'release-1', reason: 'Publication approved', applicantMessage: 'Decision released' };
  assert.deepEqual(executeReleaseCommand(publisher, binding, 'owner', 'ADJUDICATION', 5, decision, command),
    { ok: false, code: 'INVALID_STATE' });
  assert.deepEqual(executeReleaseCommand(publisher, binding, 'owner', 'DECIDED', 6, decision, command),
    { ok: false, code: 'REVISION_CONFLICT' });
  assert.deepEqual(executeReleaseCommand(publisher, binding, 'owner', 'DECIDED', 5, decision,
    { ...command, applicantMessage: ' ' }), { ok: false, code: 'INVALID_INPUT' });
  assert.deepEqual(executeReleaseCommand({ ...publisher, grants: [] }, binding, 'owner', 'DECIDED', 5, decision, command),
    { ok: false, code: 'FORBIDDEN' });
});

test('release retries return one authorized result and reject changed payloads', () => {
  const command = { expectedRevision: 5, idempotencyKey: 'release-1', reason: 'Publication approved', applicantMessage: 'Decision released' };
  const first = executeReleaseCommand(publisher, binding, 'owner', 'DECIDED', 5, decision, command);
  assert.ok(first.ok && !first.replayed);
  if (!first.ok) return;
  const replay = executeReleaseCommand(publisher, binding, 'owner', 'OUTCOME_RELEASED', 6,
    first.receipt.decision, command, first.receipt);
  assert.ok(replay.ok && replay.replayed);
  assert.deepEqual(executeReleaseCommand(publisher, binding, 'owner', 'OUTCOME_RELEASED', 6,
    first.receipt.decision, { ...command, applicantMessage: 'Changed' }, first.receipt), { ok: false, code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(executeReleaseCommand({ ...publisher, assignment: { ...publisher.assignment!, revoked: true } }, binding,
    'owner', 'OUTCOME_RELEASED', 6, first.receipt.decision, command, first.receipt), { ok: false, code: 'FORBIDDEN' });
});
