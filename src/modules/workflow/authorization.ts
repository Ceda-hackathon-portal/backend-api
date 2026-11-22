import { canonicalIdentity } from '../../shared/identity.js';
const sameIdentity = (a: string, b: string) => canonicalIdentity(a) === canonicalIdentity(b);
/** Trusted facts loaded from current server data, never from an HTTP body. */
export interface SubmissionBinding {
  readonly applicationId: string;
  readonly submissionVersionId: string;
  readonly programmeId: string;
  readonly programmeVersionId: string;
}

export interface WorkflowActor {
  readonly userId: string;
  readonly sessionActive: boolean;
  readonly role: 'owner' | 'workflow' | 'officer' | 'evaluator' | 'adjudicator' | 'publisher' | 'archivist';
  readonly grants: readonly { readonly permission: string; readonly programmeId: string; readonly active: boolean }[];
  readonly assignment?: SubmissionBinding & {
    readonly userId: string;
    readonly active: boolean;
    readonly revoked: boolean;
    readonly conflictCleared: boolean;
  };
}

export function sameBinding(a: SubmissionBinding, b: SubmissionBinding): boolean {
  return !!a.applicationId && !!a.submissionVersionId && !!a.programmeId && !!a.programmeVersionId &&
    sameIdentity(a.applicationId, b.applicationId) && sameIdentity(a.submissionVersionId, b.submissionVersionId) &&
    sameIdentity(a.programmeId, b.programmeId) && sameIdentity(a.programmeVersionId, b.programmeVersionId);
}

export function hasGrant(actor: WorkflowActor, binding: SubmissionBinding, permission: string): boolean {
  return !!actor.userId && actor.sessionActive === true && actor.grants.some(grant =>
    grant.active === true && sameIdentity(grant.programmeId, binding.programmeId) && grant.permission === permission);
}

export function hasAssignment(actor: WorkflowActor, binding: SubmissionBinding, ownerId: string): boolean {
  const assignment = actor.assignment;
  return actor.sessionActive === true && !!actor.userId && !sameIdentity(actor.userId, ownerId) && !!assignment &&
    sameIdentity(assignment.userId, actor.userId) && assignment.active === true && assignment.revoked === false &&
    assignment.conflictCleared === true && sameBinding(assignment, binding);
}

/** Default-deny policy; A's transaction-bound scope adapter must supply live facts. */
export function canReadOfficerSubmission(actor: WorkflowActor, binding: SubmissionBinding, ownerId: string): boolean {
  return hasGrant(actor, binding, 'eligibility.read-submission') && hasAssignment(actor, binding, ownerId);
}
