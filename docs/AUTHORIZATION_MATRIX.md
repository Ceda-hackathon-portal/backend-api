# Identity-independent authorization

Design only. Provider choice is open; no login is implemented. Principal carries internal user/session IDs and assurance level, not trusted browser roles. Every protected request validates live session expiry/revocation/user status and current grants in PostgreSQL. Scope queries before fetching records. Return 404 for inaccessible records, 403 for missing general capability. Never serialize a universal domain object.

| Actor | Default candidate authority | Explicit restrictions |
|---|---|---|
| submitter | Own drafts, snapshots, released feedback; permitted revision | No cross-owner access, scores, internal notes or direct transitions |
| evaluator | Own active assigned exact version and evaluation | No unassigned versions; conflict/revocation/deadline/finalization blocks writes |
| adjudicator | Scoped evidence and specifically granted decision operations | Recommendation, final decision and publication are separate capabilities |
| administrator | Scoped configuration and assignment administration | No implicit final-decision authority; cannot delegate beyond authority |
| management | Scoped aggregates | Raw ideas and exports require separately approved permission |
| system-administrator | Redacted operations/audit | Technical role never automatically grants idea content |

Candidate permission codes: application.read-own, draft.write-own, submission.submit-own, assignment.manage, evaluation.read-assigned, evaluation.write-own, evaluation.finalize-own, conflict.declare-own, evidence.read, recommendation.record, decision.finalize, decision.publish, feedback.author, feedback.publish, revision.request, programme.edit, programme.publish, role.delegate, report.read, export.create, audit.read-redacted, system.read. Final role-to-permission grants remain policy-reviewed seed data, not hardcoded CEDA rules.

Separate GlobalRoleGrant from ProgrammeRoleGrant; role definitions are not grants. Match verified identity + capability + programme + ownership/assignment + audience + conflict + workflow/deadline. Staff self-registration is forbidden. Team is descriptive text; it does not confer collaborative access.

Opaque random session token, hashed at rest; Secure/HttpOnly host-only production cookie, Path=/, SameSite=Lax; configurable 30m idle/8h absolute. Rotate after login/assurance change. No tokens in localStorage. Session/CSRF/login responses no-store. Protect mutations with session-bound CSRF token plus Origin validation and explicit credentialed CORS. Pre-authentication CSRF design depends on identity adapter. Require staff MFA capability in provider assessment, not an invented provider implementation.

Increment authz_revision when grants change. Never cache authoritative permissions in the MVP. Recheck permissions in critical transactions; lock application/assignment/user policy anchors in a consistent order with revocation commands, so a stale pre-check cannot authorize a later commit. Requests already completed cannot be undisclosed. Suspension/revocation must affect subsequent requests immediately, independent of cache TTL.

Verification: deny cross-user/cross-programme/unassigned/conflicted/revoked access; prevent private feedback/reviewer identity leakage; prohibit mass assignment of owner/role/status/totals. Test former reviewer cookie after reassignment and old session after logout. Deny on database failure, not stale authorization fallback.

References: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html and https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html .
