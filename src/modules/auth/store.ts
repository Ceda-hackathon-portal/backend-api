import type { PrismaClient } from '../../generated/prisma/client.js';
import type { VerifiedIdentity } from './provider.js';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../shared/errors.js';
import { GOOGLE_ISSUER } from './google.js';
export interface SessionView { id: string; userId: string; name: string; email: string; expiresAt: Date }
export interface SessionStore {
  saveAttempt(tokenHash: string, payload: string, expiresAt: Date): Promise<void>;
  consumeAttempt(tokenHash: string): Promise<string | null>;
  create(identity: VerifiedIdentity, tokenHash: string, previousHash: string | null, idleSeconds: number, absoluteSeconds: number): Promise<void>;
  find(tokenHash: string, idleSeconds: number): Promise<SessionView | null>;
  revoke(tokenHash: string): Promise<void>;
  linkGoogle?(identity: VerifiedIdentity, currentHash: string): Promise<void>;
}
export class PrismaSessionStore implements SessionStore {
  constructor(private readonly db: PrismaClient) {}
  async saveAttempt(tokenHash: string, payload: string, expiresAt: Date) { await this.db.authAttempt.create({ data: { tokenHash, payload, expiresAt } }); }
  async consumeAttempt(tokenHash: string) {
    const rows = await this.db.$queryRaw<Array<{ payload: string | null }>>`DELETE FROM auth_attempts WHERE token_hash=${tokenHash} RETURNING CASE WHEN expires_at>CURRENT_TIMESTAMP THEN payload ELSE NULL END AS payload`;
    return rows[0]?.payload ?? null;
  }
  async create(identity: VerifiedIdentity, tokenHash: string, previousHash: string | null, idleSeconds: number, absoluteSeconds: number) {
    await this.db.$transaction(async tx => {
      if (identity.issuer === GOOGLE_ISSUER) {
        const known = await tx.authIdentity.findUnique({ where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } } });
        if (!known && await tx.authUser.findUnique({ where: { email: identity.email } }))
          throw new HttpError(409, 'ACCOUNT_LINK_REQUIRED', 'Sign in to your existing account before connecting Google.');
      }
      const linked = await tx.authIdentity.upsert({ where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } }, update: {}, create: { issuer: identity.issuer, subject: identity.subject, user: { create: { email: identity.email, name: identity.name } } }, include: { user: true } });
      if (linked.user.status !== 'ACTIVE') throw new Error('Account unavailable');
      const now = Date.now();
      await tx.$executeRaw`INSERT INTO sessions(id, user_id, token_hash, idle_expires_at, absolute_expires_at)
        VALUES (${randomUUID()}::uuid, ${linked.userId}::uuid, ${tokenHash}, CURRENT_TIMESTAMP + ${idleSeconds} * interval '1 second', CURRENT_TIMESTAMP + ${absoluteSeconds} * interval '1 second')`;
      if (previousHash) await tx.authSession.updateMany({ where: { tokenHash: previousHash, revokedAt: null }, data: { revokedAt: new Date(now) } });
    });
  }
  async linkGoogle(identity: VerifiedIdentity, currentHash: string): Promise<void> {
    if (identity.issuer !== GOOGLE_ISSUER) throw new HttpError(401, 'LOGIN_FAILED', 'Sign-in could not be verified.');
    await this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ userId: string; email: string }>>`
        SELECT s.user_id AS "userId",u.email FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=${currentHash} AND u.status='ACTIVE' AND s.revoked_at IS NULL
        AND s.idle_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp() FOR SHARE OF s,u`;
      const session = rows[0];
      if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
      if (identity.email.toLowerCase() !== session.email.toLowerCase())
        throw new HttpError(409, 'GOOGLE_EMAIL_MISMATCH', 'Choose the Google account with your CEDA email address.');
      const linked = await tx.authIdentity.upsert({
        where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } }, update: {},
        create: { issuer: identity.issuer, subject: identity.subject, userId: session.userId },
      });
      if (linked.userId !== session.userId) throw new HttpError(409, 'ACCOUNT_LINK_REQUIRED', 'This Google account is already connected elsewhere.');
    });
  }
  async find(tokenHash: string, idleSeconds: number) {
    const rows = await this.db.$queryRaw<Array<SessionView>>`
      UPDATE sessions AS s SET idle_expires_at=LEAST(s.absolute_expires_at, CURRENT_TIMESTAMP + ${idleSeconds} * interval '1 second')
      FROM users AS u WHERE s.token_hash=${tokenHash} AND s.user_id=u.id AND u.status='ACTIVE'
      AND s.revoked_at IS NULL AND s.idle_expires_at>CURRENT_TIMESTAMP AND s.absolute_expires_at>CURRENT_TIMESTAMP
      RETURNING s.id, s.user_id AS "userId", u.name, u.email, LEAST(s.idle_expires_at,s.absolute_expires_at) AS "expiresAt"`;
    return rows[0] ?? null;
  }
  async revoke(tokenHash: string) { await this.db.authSession.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } }); }
}
