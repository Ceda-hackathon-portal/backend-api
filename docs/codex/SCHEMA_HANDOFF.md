# Single-writer Prisma schema protocol

**As of inspected ZIP, no Prisma schema exists.** Developer A creates it after approval; Developer B supplies data requirements and test cases before migration creation. Do not invent migrations in separate branches.

## A's day-1 minimum relational foundation
`User`, `Session`, `Programme`, `ProgrammeVersion`, `ProgrammeRoleGrant` or policy-equivalent scoped grants, `Application`, `ApplicationDraft`, `SubmissionVersion`, `AuditEvent`, `OutboxEvent`. Use UUID primary keys, foreign keys, version pinning, proper unique indexes, timestamps and optimistic revision. For concurrency, use transactions and DB constraints rather than UI checks.

## B's schema-change request to A
Before code referencing a new table, submit a small spec describing fields, key types, relations, required uniqueness, indexes, sensitive columns, authorization requirements and lifecycle. B needs at least:
- `EligibilityCheck` / `OfficerReview` including rule version, result, source and reviewer; unknown/unavailable must not auto-reject.
- `StageRun`, `WorkflowEvent`, `RevisionRequest`, including who/when/why, prior/next state.
- `ReviewerAssignment` tied to exact `SubmissionVersion`, programme and stage run.
- `ConflictDeclaration` and reassignment history.
- `Evaluation` + `EvaluationScore` with criterion version, decimal score/rationale, uniqueness and locked timestamp; no peer-mark leakage before closure.
- `Decision` + release status/reason; `Feedback` + publication status; `Notification`.
- Optional `ChatConversation`, `ChatMessage`, `FAQ` after P0.

## Critical invariants
- Unique `(applicationId, versionNumber)`; audit and outbox append-only to ordinary app users.
- Unique score per assignment+criterion; assignment not valid when reviewer is conflicted or no longer assigned.
- Programme rules and published criteria immutable for submissions pinned to them. `stage` and status permissions guarded server-side.
- Submission, status, audit and outbox entries committed atomically. No HTTP/email calls inside transaction.
- Do not expose Prisma entities directly as API JSON. No admin bypass of private score visibility.

## Migration process
A creates the reviewed migration in a focused branch and tests it on a disposable PostgreSQL database, runs typecheck/tests, then merges to `develop`. B updates from merged `develop`, runs migrations on her **own** development DB and continues. Applied migrations are immutable; a migration conflict prompts a human review, not automatic regeneration. CI validates clean migration replay and transaction tests.
