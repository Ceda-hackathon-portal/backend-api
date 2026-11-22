import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, type PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaEligibilityScreeningService } from '../src/modules/eligibility/persistence.js';
import { canReadOfficerSubmission } from '../src/modules/workflow/authorization.js';
import { transitionWorkflow } from '../src/modules/workflow/engine.js';

test('screening uniqueness failure never recovers findings through the unauthenticated root client', async () => {
  const failure = new Prisma.PrismaClientKnownRequestError('Injected uniqueness failure', { code: 'P2002', clientVersion: '7.10.1' });
  let rootReads = 0;
  const db = {
    async $transaction() { throw failure; },
    eligibilityCheck: { async findUnique() { rootReads++; throw new Error('Root read is forbidden'); } },
  } as unknown as PrismaClient;
  const service = new PrismaEligibilityScreeningService(db);
  await assert.rejects(service.screen({ userId: randomUUID(), sessionId: randomUUID(), authnLevel: 'oidc' }, {
    applicationId: randomUUID(), submissionVersionId: randomUUID(), ruleVersionId: randomUUID(), idempotencyKey: 'retry',
  }), error => error === failure);
  assert.equal(rootReads, 0);
});

test('screening validates trusted principal before database operations', async () => {
  const db = { async $transaction() { throw new Error('Must not reach database'); } } as unknown as PrismaClient;
  await assert.rejects(new PrismaEligibilityScreeningService(db).screen({ userId: 'invalid', sessionId: randomUUID(), authnLevel: 'oidc' }, {
    applicationId: randomUUID(), submissionVersionId: randomUUID(), ruleVersionId: randomUUID(), idempotencyKey: 'retry',
  }), { status: 401 });
});

test('workflow UUID equivalence preserves self-review denial and retry identity', () => {
  const binding = { applicationId: randomUUID(), submissionVersionId: randomUUID(), programmeId: randomUUID(), programmeVersionId: randomUUID() };
  const ownerId = randomUUID();
  const upperBinding = { applicationId: binding.applicationId.toUpperCase(), submissionVersionId: binding.submissionVersionId.toUpperCase(),
    programmeId: binding.programmeId.toUpperCase(), programmeVersionId: binding.programmeVersionId.toUpperCase() };
  assert.equal(canReadOfficerSubmission({ userId: ownerId.toUpperCase(), sessionActive: true, role: 'officer',
    grants: [{ programmeId: binding.programmeId, permission: 'eligibility.read-submission', active: true }],
    assignment: { ...upperBinding, userId: ownerId.toUpperCase(), active: true, revoked: false, conflictCleared: true },
  }, binding, ownerId), false);
  const officerId = randomUUID();
  assert.equal(canReadOfficerSubmission({ userId: officerId.toUpperCase(), sessionActive: true, role: 'officer',
    grants: [{ programmeId: binding.programmeId.toUpperCase(), permission: 'eligibility.read-submission', active: true }],
    assignment: { ...upperBinding, userId: officerId, active: true, revoked: false, conflictCleared: true },
  }, binding, ownerId), true);
  const snapshot = { ...binding, ownerId, state: 'SUBMITTED' as const, revision: 0, ruleSetVersion: randomUUID() };
  const command = { ...binding, transition: 'WITHDRAW' as const, expectedRevision: 0, idempotencyKey: 'withdraw', reason: 'Applicant withdrawal' };
  const context = { actor: { userId: ownerId.toUpperCase(), sessionActive: true, role: 'owner' as const,
    grants: [{ programmeId: binding.programmeId.toUpperCase(), permission: 'application.withdraw', active: true }] },
    guards: { withdrawalAllowed: true }, occurredAt: new Date().toISOString() };
  const first = transitionWorkflow(snapshot, command, context);
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error('Expected withdrawal');
  assert.equal(first.receipt.actorId, ownerId);
  assert.deepEqual(transitionWorkflow(first.receipt.change.after, { ...command, ...upperBinding }, context, first.receipt),
    { ok: true, replayed: true, receipt: first.receipt });
});
