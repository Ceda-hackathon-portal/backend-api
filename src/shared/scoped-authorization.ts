import type { AccessRequest, AuthorizationPolicy, Principal } from './authorization.js';

export interface ScopedGrant {
  readonly permission: string;
  readonly programmeId: string | null;
  readonly revoked: boolean;
  readonly expiresAt: Date | null;
}
export interface AccessSnapshot {
  readonly userId: string;
  readonly sessionId: string;
  readonly userActive: boolean;
  readonly sessionActive: boolean;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly grants: readonly ScopedGrant[];
  readonly resource?: {
    readonly id: string;
    readonly programmeId: string;
    readonly ownerId: string;
    readonly assignment?: {
      readonly reviewerId: string;
      readonly active: boolean;
      readonly conflicted: boolean;
      readonly versionId: string;
    };
    readonly requestedVersionId?: string;
  };
}
// Implementations must read trusted, current server data on every call, never request roles.
// A database adapter and concrete session persistence are not part of this increment.
export interface AccessSnapshotReader {
  read(principal: Principal, access: AccessRequest): Promise<AccessSnapshot | null>;
}
export type PermissionRule = 'scope' | 'owner' | 'assigned-version';

export class ScopedAuthorization implements AuthorizationPolicy {
  private readonly rules: ReadonlyMap<string, PermissionRule>;
  constructor(private readonly reader: AccessSnapshotReader, rules: ReadonlyMap<string, PermissionRule>, private readonly clock: () => Date = () => new Date()) {
    this.rules = new Map(rules); // Caller cannot later mutate accepted permission rules.
  }
  async allows(principal: Principal, access: AccessRequest): Promise<boolean> {
    const rule = this.rules.get(access.permission);
    if (!rule || !principal.userId || !principal.sessionId) return false;
    const snapshot = await this.reader.read(principal, access); // Errors propagate; never stale-allow.
    const now = this.clock().getTime();
    if (!Number.isFinite(now) || !snapshot || snapshot.userId !== principal.userId || snapshot.sessionId !== principal.sessionId || !snapshot.userActive || !snapshot.sessionActive) return false;
    if (!(snapshot.idleExpiresAt.getTime() > now) || !(snapshot.absoluteExpiresAt.getTime() > now)) return false;
    const scope = access.programmeId ?? null;
    // Global grants do not silently become cross-programme grants.
    if (!snapshot.grants.some(grant => grant.permission === access.permission && grant.programmeId === scope && !grant.revoked && (grant.expiresAt === null || grant.expiresAt.getTime() > now))) return false;
    if (access.recordId !== undefined || rule !== 'scope') {
      const resource = snapshot.resource;
      if (!access.recordId || !access.programmeId || !resource || resource.id !== access.recordId || resource.programmeId !== access.programmeId) return false;
      if (rule === 'owner' && resource.ownerId !== principal.userId) return false;
      if (rule === 'assigned-version') {
        const assignment = resource.assignment;
        if (!assignment || !assignment.active || assignment.conflicted || assignment.reviewerId !== principal.userId || !resource.requestedVersionId || assignment.versionId !== resource.requestedVersionId) return false;
      }
    }
    return true;
  }
}
