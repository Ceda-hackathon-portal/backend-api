import { canonicalIdentity } from '../../shared/identity.js';
import { hasGrant, sameBinding, type SubmissionBinding, type WorkflowActor } from '../workflow/authorization.js';

export interface ReviewAssignment extends SubmissionBinding {
  readonly id: string;
  readonly officerId: string;
  readonly ownerId: string;
  readonly active: boolean;
  readonly revoked: boolean;
  readonly conflict: 'UNDECLARED' | 'CLEARED' | 'DECLARED';
}
export interface OfficerEligibility {
  readonly userId: string;
  readonly programmeId: string;
  readonly active: boolean;
  readonly mayReview: boolean;
}
export interface AssignmentAudit {
  readonly type: 'ASSIGNMENT_CREATED' | 'ASSIGNMENT_REVOKED' | 'CONFLICT_DECLARED';
  readonly actorId: string;
  readonly assignmentId: string;
  readonly reason: string;
}
export type AssignmentResult =
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'INVALID_INPUT' | 'CONFLICT' }
  | { readonly ok: true; readonly assignment: ReviewAssignment; readonly audit: AssignmentAudit };

const same = (a: string, b: string) => !!a && !!b && canonicalIdentity(a) === canonicalIdentity(b);
const denied = (code: Extract<AssignmentResult, { ok: false }>['code']): AssignmentResult => ({ ok: false, code });

/** The caller supplies fresh, transaction-scoped grant and eligibility facts. */
export function assignOfficer(actor: WorkflowActor, proposed: ReviewAssignment, officer: OfficerEligibility,
  existing: readonly ReviewAssignment[], reason: string): AssignmentResult {
  if (!proposed.id || !proposed.officerId || !proposed.ownerId || !reason.trim() || !sameBinding(proposed, proposed)) return denied('INVALID_INPUT');
  if (!hasGrant(actor, proposed, 'assignment.manage') || actor.role !== 'officer') return denied('FORBIDDEN');
  if (!same(officer.userId, proposed.officerId) || !same(officer.programmeId, proposed.programmeId) ||
      !officer.active || !officer.mayReview) return denied('FORBIDDEN');
  if (same(proposed.officerId, proposed.ownerId) || same(proposed.officerId, actor.userId) ||
      proposed.active !== true || proposed.revoked !== false || proposed.conflict !== 'UNDECLARED') return denied('CONFLICT');
  if (existing.some(item => same(item.id, proposed.id) ||
      (same(item.applicationId, proposed.applicationId) &&
       (!same(item.ownerId, proposed.ownerId) || !same(item.programmeId, proposed.programmeId) ||
        !same(item.programmeVersionId, proposed.programmeVersionId))))) return denied('CONFLICT');
  if (existing.some(item => same(item.officerId, proposed.officerId) && sameBinding(item, proposed) &&
      ((item.active && !item.revoked) || item.conflict === 'DECLARED'))) return denied('CONFLICT');
  return { ok: true, assignment: structuredClone(proposed), audit: { type: 'ASSIGNMENT_CREATED', actorId: actor.userId, assignmentId: proposed.id, reason } };
}

export function canReviewAssignment(actor: WorkflowActor, assignment: ReviewAssignment, binding: SubmissionBinding): boolean {
  return actor.role === 'evaluator' && hasGrant(actor, assignment, 'evaluation.write') &&
    same(actor.userId, assignment.officerId) && !same(actor.userId, assignment.ownerId) &&
    assignment.active && !assignment.revoked && assignment.conflict === 'CLEARED' && sameBinding(assignment, binding);
}

/** Submission content access requires a live programme grant and the exact cleared assignment. */
export function canReadAssignedSubmission(actor: WorkflowActor, assignment: ReviewAssignment, binding: SubmissionBinding): boolean {
  return actor.role === 'officer' && hasGrant(actor, binding, 'eligibility.read-submission') &&
    same(actor.userId, assignment.officerId) && !same(actor.userId, assignment.ownerId) &&
    assignment.active && !assignment.revoked && assignment.conflict === 'CLEARED' && sameBinding(assignment, binding);
}

export function declareConflict(actor: WorkflowActor, assignment: ReviewAssignment, reason: string): AssignmentResult {
  if (!reason.trim()) return denied('INVALID_INPUT');
  const permission = actor.role === 'evaluator' ? 'evaluation.write' : actor.role === 'officer' ? 'eligibility.read-submission' : null;
  if (!permission || !hasGrant(actor, assignment, permission) ||
      !same(actor.userId, assignment.officerId) || !sameBinding(assignment, assignment)) return denied('FORBIDDEN');
  if (!assignment.active || assignment.revoked || assignment.conflict === 'DECLARED') return denied('CONFLICT');
  return { ok: true, assignment: { ...assignment, active: false, revoked: true, conflict: 'DECLARED' },
    audit: { type: 'CONFLICT_DECLARED', actorId: actor.userId, assignmentId: assignment.id, reason } };
}

export function revokeAssignment(actor: WorkflowActor, assignment: ReviewAssignment, reason: string): AssignmentResult {
  if (!reason.trim()) return denied('INVALID_INPUT');
  if (actor.role !== 'officer' || !hasGrant(actor, assignment, 'assignment.manage')) return denied('FORBIDDEN');
  if (!assignment.active || assignment.revoked) return denied('CONFLICT');
  return { ok: true, assignment: { ...assignment, active: false, revoked: true },
    audit: { type: 'ASSIGNMENT_REVOKED', actorId: actor.userId, assignmentId: assignment.id, reason } };
}

export type AssignmentChangeResult =
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'INVALID_INPUT' | 'CONFLICT' }
  | { readonly ok: true; readonly previous: ReviewAssignment; readonly replacement: ReviewAssignment;
      readonly audit: readonly [AssignmentAudit, AssignmentAudit] };

/** Persist both records and audit events in one transaction; do not delete the previous assignment. */
export function changeAssignment(actor: WorkflowActor, current: ReviewAssignment, replacement: ReviewAssignment,
  officer: OfficerEligibility, existing: readonly ReviewAssignment[], reason: string): AssignmentChangeResult {
  if (!sameBinding(current, replacement) || !same(current.ownerId, replacement.ownerId) ||
      same(current.officerId, replacement.officerId) || !existing.some(item => same(item.id, current.id) &&
        sameBinding(item, current) && same(item.ownerId, current.ownerId) && same(item.officerId, current.officerId) &&
        item.active === current.active && item.revoked === current.revoked && item.conflict === current.conflict)) return { ok: false, code: 'CONFLICT' };
  const revoked = revokeAssignment(actor, current, reason);
  if (!revoked.ok) return revoked;
  const assigned = assignOfficer(actor, replacement, officer,
    existing.map(item => same(item.id, current.id) ? revoked.assignment : item), reason);
  if (!assigned.ok) return assigned;
  return { ok: true, previous: revoked.assignment, replacement: assigned.assignment,
    audit: [revoked.audit, assigned.audit] };
}
