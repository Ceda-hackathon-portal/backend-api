import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../shared/errors.js';

/** A staff role is never stored or accepted from a client. It is read from live programme grants. */
export const staffRoles = [
  { role: 'administrator', permission: 'decision.publish' },
  { role: 'eligibility-officer', permission: 'eligibility.verify' },
  { role: 'adjudicator', permission: 'adjudication.decide' },
  { role: 'evaluator', permission: 'evaluation.write' },
  { role: 'management', permission: 'report.read' },
  { role: 'system-administrator', permission: 'audit.read' },
  { role: 'support-agent', permission: 'support.manage' },
] as const;
export type StaffRole = (typeof staffRoles)[number]['role'];

export function roleFor(permissions: ReadonlySet<string>): StaffRole | null {
  return staffRoles.find(item => permissions.has(item.permission))?.role ?? null;
}

export const hidden = () => new HttpError(404, 'NOT_FOUND', 'Resource not found.');
export const refuse = (code: string, message: string) => new HttpError(409, code, message);

/** programmeId to the caller's live permissions in that programme. */
export async function liveGrants(db: Prisma.TransactionClient, userId: string): Promise<Map<string, Set<string>>> {
  const rows = await db.programmeGrant.findMany({
    where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { programmeId: true, permission: true },
  });
  const grants = new Map<string, Set<string>>();
  for (const row of rows) grants.set(row.programmeId, (grants.get(row.programmeId) ?? new Set<string>()).add(row.permission));
  return grants;
}

interface Disclosure {
  status: string; disclosedById: string | null; disclosedRequestId: string | null;
  resolvedAt: Date | null; resolvedById: string | null; resolutionRequestId: string | null; resolution: string | null;
}

/** For display and quorum. Every command re-checks this under the backend's own locks. */
export function conflictState(disclosures: readonly Disclosure[]): 'UNDECLARED' | 'AWAITING_CONFIRMATION' | 'CLEARED' | 'CONFLICT' {
  if (!disclosures.length) return 'UNDECLARED';
  const cleared = disclosures.every(item => (item.status === 'CLEARED' || item.status === 'NO_CONFLICT') &&
    item.disclosedById && item.disclosedRequestId && item.resolvedAt && item.resolvedById && item.resolutionRequestId &&
    (item.status === 'NO_CONFLICT' || item.resolution?.trim()));
  if (cleared) return 'CLEARED';
  return disclosures.every(item => item.status === 'UNRESOLVED') ? 'AWAITING_CONFIRMATION' : 'CONFLICT';
}

/** An assignment that is in force now. */
export function isLive(row: { status: string; revokedAt: Date | null; validFrom: Date; expiresAt: Date | null; issuedById: string | null }, now = new Date()) {
  return row.status === 'ACTIVE' && !row.revokedAt && !!row.issuedById && row.validFrom <= now && (!row.expiresAt || row.expiresAt > now);
}

export function reviewersRequired(config: unknown): number {
  const parsed = z.object({ reviewersPerApplication: z.number().int().min(1).max(5) }).safeParse(config);
  return parsed.success ? parsed.data.reviewersPerApplication : 2;
}
