import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaSessionStore } from '../src/modules/auth/store.js';
import { hash, token } from '../src/modules/auth/crypto.js';

test('identity/session migrations: atomic attempt consume, no email linking, expiry, rotation, suspension and revocation', async () => {
  assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? '', /^[a-f0-9-]{36}$/);
  const url = process.env.DATABASE_URL!; assert.equal(new URL(url).hostname, '127.0.0.1');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2, connectionTimeoutMillis: 2000, options: '-c timezone=UTC' }) });
  const store = new PrismaSessionStore(db);
  try {
    const attempt = hash(token());
    await store.saveAttempt(attempt, 'encrypted-fixture', new Date(Date.now() + 60000));
    const consumed = await Promise.all([store.consumeAttempt(attempt), store.consumeAttempt(attempt)]);
    assert.equal(consumed.filter(value => value === 'encrypted-fixture').length, 1);
    const expired = hash(token()); await store.saveAttempt(expired, 'expired', new Date(0)); assert.equal(await store.consumeAttempt(expired), null);
    const identity = { issuer: 'https://fixture.example', subject: token(), email: token() + '@example.test', name: 'Fictional applicant' };
    const first = hash(token()); await store.create(identity, first, null, 1800, 28800);
    const session = await store.find(first, 1800);
    if (!session) {
      const diagnostic = await db.$queryRaw`SELECT CURRENT_TIMESTAMP AS now, idle_expires_at, absolute_expires_at, status FROM sessions JOIN users ON users.id=sessions.user_id`;
      assert.fail('Unexpected absent session: ' + JSON.stringify(diagnostic));
    }
    assert.notEqual(session.id, first);
    assert.ok(Math.abs(session.expiresAt.getTime() - Date.now() - 1800000) < 5000, 'returned expiry must be UTC without an offset shift');
    const stored = await db.authSession.findUniqueOrThrow({ where: { tokenHash: first } }); assert.equal(stored.tokenHash.length, 64);
    await assert.rejects(store.create({ ...identity, subject: token() }, hash(token()), null, 1800, 28800));
    assert.equal(await db.authUser.count({ where: { email: identity.email } }), 1);
    const second = hash(token()); await store.create(identity, second, first, 1800, 28800); assert.equal(await store.find(first, 1800), null);
    await db.authUser.update({ where: { id: session.userId }, data: { status: 'SUSPENDED' } }); assert.equal(await store.find(second, 1800), null);
    await db.authUser.update({ where: { id: session.userId }, data: { status: 'ACTIVE' } });
    assert.equal(await store.find(second, 1800), null);
    const third = hash(token()); await store.create(identity, third, null, 1800, 28800);
    await db.authSession.update({ where: { tokenHash: third }, data: { idleExpiresAt: new Date(0) } }); assert.equal(await store.find(third, 1800), null);
    const fourth = hash(token()); await store.create(identity, fourth, null, 1800, 28800);
    await db.authSession.update({ where: { tokenHash: fourth }, data: { idleExpiresAt: new Date(0), absoluteExpiresAt: new Date(0) } }); assert.equal(await store.find(fourth, 1800), null);
  } finally { await db.$disconnect(); }
});

test('Google sessions create new applicants, require explicit same-email linking, preserve identity and reject revoked sessions', async () => {
  assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? '', /^[a-f0-9-]{36}$/);
  const url = process.env.DATABASE_URL!;
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2, options: '-c timezone=UTC' }) });
  const store = new PrismaSessionStore(db);
  const issuer = 'https://accounts.google.com';
  try {
    const google = { issuer, subject: token(), email: token() + '@example.test', name: 'Synthetic Google applicant' };
    const googleHash = hash(token());
    await store.create(google, googleHash, null, 1800, 28800);
    const googleSession = await store.find(googleHash, 1800);
    assert.ok(googleSession);
    assert.equal(await db.programmeGrant.count({ where: { userId: googleSession.userId } }), 0);

    const original = { issuer: 'https://fixture.example', subject: token(), email: token() + '@example.test', name: 'Existing synthetic applicant' };
    const originalHash = hash(token());
    await store.create(original, originalHash, null, 1800, 28800);
    const originalSession = (await store.find(originalHash, 1800))!;
    const toLink = { issuer, subject: token(), email: original.email, name: original.name };
    await assert.rejects(store.create(toLink, hash(token()), null, 1800, 28800), { code: 'ACCOUNT_LINK_REQUIRED' });
    assert.equal(await db.authIdentity.count({ where: { issuer, subject: toLink.subject } }), 0);
    await assert.rejects(store.linkGoogle({ ...toLink, email: 'wrong@example.test' }, originalHash), { code: 'GOOGLE_EMAIL_MISMATCH' });
    assert.equal(await db.authIdentity.count({ where: { issuer, subject: toLink.subject } }), 0);
    await store.linkGoogle(toLink, originalHash);
    await store.linkGoogle(toLink, originalHash);
    assert.equal(await db.authUser.count({ where: { email: original.email } }), 1);
    assert.equal((await db.authIdentity.findUniqueOrThrow({ where: { issuer_subject: { issuer, subject: toLink.subject } } })).userId, originalSession.userId);
    const linkedHash = hash(token());
    await store.create(toLink, linkedHash, originalHash, 1800, 28800);
    assert.equal((await store.find(linkedHash, 1800))!.userId, originalSession.userId);
    assert.equal(await store.find(originalHash, 1800), null);
    await assert.rejects(store.linkGoogle(toLink, originalHash), { code: 'UNAUTHENTICATED' });
    await assert.rejects(store.linkGoogle({ ...google, email: original.email }, linkedHash), { code: 'ACCOUNT_LINK_REQUIRED' });
    assert.equal((await store.find(googleHash, 1800))!.userId, googleSession.userId);
    await db.authUser.update({ where: { id: originalSession.userId }, data: { status: 'SUSPENDED' } });
    await assert.rejects(store.create(toLink, hash(token()), null, 1800, 28800));
    assert.equal(await store.find(linkedHash, 1800), null);
  } finally { await db.$disconnect(); }
});
