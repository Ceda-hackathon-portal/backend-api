import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { randomUUID } from 'node:crypto';
import { PrismaOfficerSubmissionReader, projectOfficerSubmissionFields, type AuthenticatedRequestContext } from '../src/modules/applications/officer-submission-reader.js';

test('officer evidence projection is version-bound and excludes team and extra private fields', () => {
  const expected = { title: 'Idea', theme: 'digital', problem: 'Problem', solution: 'Solution', impact: 'Impact' };
  const projected = projectOfficerSubmissionFields(1, { ...expected, team: 'Private names', identityDocument: 'private', scores: [10] });
  assert.deepEqual(projected, expected);
  assert.ok(Object.isFrozen(projected));
  assert.throws(() => projectOfficerSubmissionFields(2, expected), { status: 404 });
});

test('officer reader rejects untrusted context and malformed version before repository access', async () => {
  const reader = new PrismaOfficerSubmissionReader({} as PrismaClient);
  await assert.rejects(reader.readForOfficer(null as unknown as AuthenticatedRequestContext, randomUUID()), { status: 401 });
  const context = { principal: { userId: randomUUID(), sessionId: randomUUID(), authnLevel: 'oidc' }, requestId: randomUUID() };
  await assert.rejects(reader.readForOfficer(context, 'not-a-uuid'), { status: 422 });
  await assert.rejects(reader.readForOfficer({ ...context, requestId: 'invalid' }, randomUUID()), { status: 422 });
});
