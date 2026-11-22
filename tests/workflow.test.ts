import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canReadOfficerSubmission } from '../src/modules/workflow/authorization.js';
import type { WorkflowActor } from '../src/modules/workflow/authorization.js';
import { executeTransition, provisionalTransitions, transitionWorkflow } from '../src/modules/workflow/engine.js';
import type { CommandReceipt, TransitionCommand, TransitionContext, WorkflowSnapshot } from '../src/modules/workflow/engine.js';

const binding = { applicationId: 'app', submissionVersionId: 'v1', programmeId: 'p', programmeVersionId: 'pv1' };
const snapshot: WorkflowSnapshot = { ...binding, ownerId: 'owner', state: 'ELIGIBILITY_SCREENING', revision: 2, ruleSetVersion: 'rules1' };
const actor: WorkflowActor = { userId: 'officer', sessionActive: true, role: 'officer',
  grants: ['eligibility.read-submission', 'eligibility.verify'].map(permission => ({ permission, programmeId: 'p', active: true })),
  assignment: { ...binding, userId: 'officer', active: true, revoked: false, conflictCleared: true } };
const command: TransitionCommand = { ...binding, transition: 'OPEN_VERIFICATION', expectedRevision: 2, idempotencyKey: 'key', reason: '' };
const context: TransitionContext = { actor, guards: { screeningPersisted: true }, occurredAt: '2026-11-20T12:00:00Z',
  eligibility: { ...binding, ruleSetVersion: 'rules1', status: 'UNKNOWN', findings: [{ requirementId: 'r', status: 'UNKNOWN' }] } };

test('all screening outcomes route to officer verification and preserve findings', () => {
  for (const status of ['MET', 'NOT_MET', 'UNKNOWN'] as const) {
    const result = transitionWorkflow(snapshot, command, { ...context, eligibility: { ...context.eligibility!, status } });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('Expected transition');
    assert.equal(result.receipt.change.after.state, 'OFFICER_VERIFICATION');
    assert.equal(result.receipt.change.after.revision, 3);
    assert.equal(result.receipt.change.audit.eligibility?.status, status);
    assert.equal(snapshot.revision, 2);
  }
});

test('officer access defaults to deny for every missing or invalid authority fact', () => {
  assert.equal(canReadOfficerSubmission(actor, binding, 'owner'), true);
  const { assignment: ignored, ...unassigned } = actor;
  const denied: WorkflowActor[] = [unassigned, { ...actor, sessionActive: false }, { ...actor, grants: [] },
    { ...actor, userId: 'owner' }, { ...actor, grants: actor.grants.map(g => ({ ...g, active: false })) },
    { ...actor, grants: actor.grants.map(g => ({ ...g, programmeId: 'other' })) },
    ...[{ revoked: true }, { active: false }, { conflictCleared: false }, { userId: 'other' },
      { submissionVersionId: 'v2' }, { programmeId: 'other' }, { programmeVersionId: 'pv2' }, { applicationId: 'other' }]
      .map(patch => ({ ...actor, assignment: { ...actor.assignment!, ...patch } }))];
  for (const deniedActor of denied) {
    assert.equal(canReadOfficerSubmission(deniedActor, binding, 'owner'), false);
    assert.deepEqual(transitionWorkflow(snapshot, command, { ...context, actor: deniedActor }), { ok: false, code: 'FORBIDDEN' });
  }
});

test('state, guards, immutable binding and revision failures never emit a state change', () => {
  assert.deepEqual(transitionWorkflow({ ...snapshot, state: 'DECIDED' }, command, context), { ok: false, code: 'INVALID_TRANSITION' });
  assert.deepEqual(transitionWorkflow(snapshot, command, { ...context, guards: {} }), { ok: false, code: 'GUARD_FAILED' });
  assert.deepEqual(transitionWorkflow(snapshot, { ...command, expectedRevision: 1 }, context), { ok: false, code: 'REVISION_CONFLICT' });
  assert.deepEqual(transitionWorkflow(snapshot, { ...command, submissionVersionId: 'v2' }, context), { ok: false, code: 'INVALID_TRANSITION' });
  assert.deepEqual(transitionWorkflow(snapshot, command, { ...context, eligibility: { ...context.eligibility!, ruleSetVersion: 'other' } }), { ok: false, code: 'GUARD_FAILED' });
});

test('retries replay once, changed payload conflicts and revoked authorization denies replay', () => {
  const first = transitionWorkflow(snapshot, command, context);
  if (!first.ok) throw new Error('Expected transition');
  const after = first.receipt.change.after;
  const retry = transitionWorkflow(after, command, context, first.receipt);
  assert.ok(retry.ok && retry.replayed);
  assert.deepEqual(transitionWorkflow(after, { ...command, reason: 'different' }, context, first.receipt), { ok: false, code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(transitionWorkflow(after, command, { ...context, actor: { ...actor, sessionActive: false } }, first.receipt), { ok: false, code: 'FORBIDDEN' });
});

test('provisional graph has no automated terminal decision or screening rejection', () => {
  for (const rule of Object.values(provisionalTransitions)) {
    if (rule.role === 'workflow') assert.equal(rule.to, 'ELIGIBILITY_SCREENING');
    assert.notEqual(rule.to, 'REJECTED');
  }
});

test('NOT_MET routes to verification while retaining every UNKNOWN finding and reason', () => {
  const eligibility = { ...context.eligibility!, status: 'NOT_MET' as const, findings: [
    { requirementId: 'confirmed-failure', status: 'NOT_MET' as const },
    { requirementId: 'unresolved', status: 'UNKNOWN' as const, unknownReason: 'CONFLICT' },
  ] };
  const result = transitionWorkflow(snapshot, command, { ...context, eligibility });
  assert.ok(result.ok);
  assert.equal(result.receipt.change.after.state, 'OFFICER_VERIFICATION');
  assert.deepEqual(result.receipt.change.audit.eligibility, eligibility);
  eligibility.findings.pop();
  assert.equal(result.receipt.change.audit.eligibility?.findings.length, 2);
});

test('later transitions also reject eligibility from a different immutable version', () => {
  const evaluator: WorkflowActor = { ...actor, role: 'evaluator',
    grants: [{ permission: 'evaluation.write', programmeId: 'p', active: true }] };
  assert.deepEqual(transitionWorkflow({ ...snapshot, state: 'ASSIGNED' }, { ...command, transition: 'START_EVALUATION' },
    { ...context, actor: evaluator, eligibility: { ...context.eligibility!, submissionVersionId: 'v2' } }),
    { ok: false, code: 'GUARD_FAILED' });
});

test('every graph edge requires its role, grant and all guards', () => {
  for (const [transition, rule] of Object.entries(provisionalTransitions)) {
    const edgeActor: WorkflowActor = { ...actor, userId: rule.role === 'owner' ? 'owner' : actor.userId, role: rule.role,
      grants: [...actor.grants, { permission: rule.permission, programmeId: 'p', active: true }] };
    const edgeContext: TransitionContext = { ...context, actor: edgeActor,
      guards: Object.fromEntries(rule.guards.map(g => [g, true])), eligibility: { ...context.eligibility!, status: 'MET' } };
    const edgeCommand = { ...command, transition: transition as TransitionCommand['transition'], reason: 'Reviewed reason' };
    for (const state of rule.from) assert.equal(transitionWorkflow({ ...snapshot, state }, edgeCommand, edgeContext).ok, true, transition);
    assert.equal(transitionWorkflow({ ...snapshot, state: rule.from[0] }, edgeCommand, { ...edgeContext, actor: { ...edgeActor, grants: [] } }).ok, false);
    for (const guard of rule.guards) assert.equal(transitionWorkflow({ ...snapshot, state: rule.from[0] }, edgeCommand,
      { ...edgeContext, guards: { ...edgeContext.guards, [guard]: false } }).ok, false, guard);
  }
});

test('repository port commits a new receipt only once and propagates commit failure', async () => {
  let prior: CommandReceipt | undefined;
  let commits = 0;
  const repository = { async transaction<T>(work: (tx: import('../src/modules/workflow/engine.js').WorkflowTransaction) => Promise<T>): Promise<T> {
    return work({ async read() { return { snapshot: prior?.change.after ?? snapshot, context, ...(prior ? { prior } : {}) }; },
      async commit(receipt) { commits++; prior = receipt; } });
  } };
  assert.equal((await executeTransition(repository, command)).ok, true);
  assert.equal((await executeTransition(repository, command)).ok, true);
  assert.equal(commits, 1);
  await assert.rejects(executeTransition({ async transaction(work) {
    return work({ async read() { return { snapshot, context }; }, async commit() { throw new Error('rollback'); } });
  } }, command), /rollback/);
});
