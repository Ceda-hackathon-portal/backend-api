import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScopedAuthorization, type AccessSnapshot, type PermissionRule } from '../src/shared/scoped-authorization.js';

const principal = { userId: 'owner', sessionId: 'session', authnLevel: 'test-only' };
const now = new Date('2026-11-09T12:00:00Z');
const later = new Date('2026-11-09T13:00:00Z');
const rules = new Map<string, PermissionRule>([['read-own', 'owner'], ['review', 'assigned-version'], ['aggregate', 'scope']]);
const base = (): AccessSnapshot => ({ userId: 'owner', sessionId: 'session', userActive: true, sessionActive: true, idleExpiresAt: later, absoluteExpiresAt: later, grants: [{ permission: 'read-own', programmeId: 'p1', revoked: false, expiresAt: null }], resource: { id: 'r1', programmeId: 'p1', ownerId: 'owner' } });
const request = { permission: 'read-own', programmeId: 'p1', recordId: 'r1' };
const policy = (snapshot: AccessSnapshot | null) => new ScopedAuthorization({ async read() { return snapshot; } }, rules, () => now);

test('owner allowed only with matching current identity, grant, scope and record', async () => {
  assert.equal(await policy(base()).allows(principal, request), true);
  for (const change of [{ userActive: false }, { sessionActive: false }, { userId: 'other' }, { sessionId: 'other' }, { idleExpiresAt: now }, { absoluteExpiresAt: now }, { idleExpiresAt: new Date('invalid') }, { grants: [] }]) {
    assert.equal(await policy({ ...base(), ...change }).allows(principal, request), false);
  }
  for (const resource of [{ id: 'other', programmeId: 'p1', ownerId: 'owner' }, { id: 'r1', programmeId: 'p2', ownerId: 'owner' }, { id: 'r1', programmeId: 'p1', ownerId: 'other' }]) assert.equal(await policy({ ...base(), resource }).allows(principal, request), false);
  assert.equal(await policy(base()).allows(principal, { permission: 'unregistered' }), false);
  assert.equal(await policy(null).allows(principal, request), false);
});
test('revoked, expired, cross-programme and global grants cannot satisfy programme access', async () => {
  for (const change of [{ revoked: true }, { expiresAt: now }, { expiresAt: new Date('invalid') }, { programmeId: 'p2' }, { programmeId: null }, { permission: 'other' }]) {
    const grant = { permission: 'read-own', programmeId: 'p1', revoked: false, expiresAt: null, ...change };
    assert.equal(await policy({ ...base(), grants: [grant] }).allows(principal, request), false);
  }
  assert.equal(await policy(base()).allows(principal, { permission: 'read-own' }), false);
});
test('review requires exact active unconflicted reviewer assignment and version', async () => {
  const snapshot: AccessSnapshot = { ...base(), grants: [{ permission: 'review', programmeId: 'p1', revoked: false, expiresAt: null }], resource: { id: 'r1', programmeId: 'p1', ownerId: 'someone-else', requestedVersionId: 'v2', assignment: { reviewerId: 'owner', active: true, conflicted: false, versionId: 'v2' } } };
  const access = { ...request, permission: 'review' };
  assert.equal(await policy(snapshot).allows(principal, access), true);
  for (const change of [{ active: false }, { conflicted: true }, { versionId: 'v1' }, { reviewerId: 'other' }]) {
    assert.equal(await policy({ ...snapshot, resource: { ...snapshot.resource!, assignment: { ...snapshot.resource!.assignment!, ...change } } }).allows(principal, access), false);
  }
  assert.equal(await policy({ ...base(), grants: snapshot.grants }).allows(principal, access), false);
});
test('grant changes are read fresh and reader outage never authorizes', async () => {
  let state: AccessSnapshot | null = base(); let calls = 0;
  const fresh = new ScopedAuthorization({ async read() { calls++; return state; } }, rules, () => now);
  assert.equal(await fresh.allows(principal, request), true);
  state = { ...base(), grants: [] };
  assert.equal(await fresh.allows(principal, request), false);
  state = null;
  assert.equal(await fresh.allows(principal, request), false);
  assert.equal(calls, 3);
  await assert.rejects(new ScopedAuthorization({ async read() { throw new Error('unavailable'); } }, rules).allows(principal, request), /unavailable/);
});
test('scope-only permissions do not confer owner/reviewer or arbitrary global access', async () => {
  const snapshot = { ...base(), grants: [{ permission: 'aggregate', programmeId: 'p1', revoked: false, expiresAt: null }] };
  assert.equal(await policy(snapshot).allows(principal, { permission: 'aggregate', programmeId: 'p1' }), true);
  assert.equal(await policy(snapshot).allows(principal, { permission: 'aggregate' }), false);
  assert.equal(await policy(snapshot).allows(principal, { permission: 'read-own', programmeId: 'p1', recordId: 'r1' }), false);
});
