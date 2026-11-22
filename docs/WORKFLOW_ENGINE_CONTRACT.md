# Provisional workflow implementation contract

The 20 November 2026 execution instruction authorizes pure implementation using
the state table merged in develop at 86955f3. Document approval and database
schema approval are not prerequisites for this module. These are provisional
platform rules, not official CEDA criteria. Required review, CI, migration and
deployment gates remain in force.

## Implemented boundary

`src/modules/workflow/engine.ts` accepts an immutable submission binding, current
state/revision, command, trusted actor, guard results and eligibility assessment.
It returns either a typed denial or a state change plus audit event and retry
receipt. It has no database or HTTP dependency. `authorization.ts` supplies the
assignment-backed, default-deny officer access policy.

The exported graph follows the provisional table. Screening can only enter
ELIGIBILITY_SCREENING. MET, NOT_MET and UNKNOWN can all enter officer verification.
There is no screening-to-REJECTED edge. Controlled human decisions require the
adjudication path. Initial submission and correction resubmission are A-owned
snapshot operations: they supply SUBMITTED/RESUBMITTED snapshots after atomically
freezing the new version. The engine cannot manufacture a new immutable snapshot.

Guard inputs are trusted server results, never client assertions. Missing guards
deny the corresponding operation. Programme-specific deadlines, quorum, score
validation, conflict definitions, retention and separation of duties remain
explicit guard-provider responsibilities. No default business values are invented.

## Authorization and persistence integration

Developer A must implement `WorkflowRepository` and its transaction-scoped reads.
Read current session, exact programme grants, exact-version assignment and conflict
clearance on every command, including retries. SessionActive includes user state,
revocation, idle and absolute expiry; grantActive includes revocation and expiry.
Assignments must match application, submission version, programme and programme
version. Unknown conflicts deny access. Never accept these facts from a request body.

Commit must compare-and-swap the expected revision and atomically write state,
history, audit, outbox and the command receipt. Scope receipt lookup to application,
actor and idempotency key; a changed command conflicts. Recheck/lock authorization
anchors within the same transaction so revocation cannot race a successful write.
The port defines behavior, not new Prisma fields. Adapter failures must roll back
all writes. Pure fake-adapter tests do not establish database atomicity.

Do not mount officer or workflow HTTP routes until the assignment-backed scope,
transaction semantics and authorization-denial integration tests are verified.
The officer reader in PR #6 remains default-deny without that scope provider.

## Delivery and remaining dependencies

| Category | Status / exact next decision or implementation |
| --- | --- |
| Documentation-only | Removed for pure domain logic by the execution instruction. |
| Missing interface | Workflow transaction and trusted authorization contracts implemented. |
| Missing persistence schema | A owns additive schema review for assignments, conflicts, workflow receipts/history and eligibility. No migration added here. |
| CI/test configuration | Workflow tests are included in the canonical npm test list used by hosted CI; eligibility was already included in develop. |
| Genuine security | A implements live transactional scope and revocation locking before endpoint exposure. |
| External deployment | PR #7 is merged; AWS credentials and deployment authorization remain separate. |

B1 eligibility policy and B2 pure transitions must remain separately reviewable.
B2 compiles against develop without B1. B1 is [PR #10](https://github.com/Batoli19/CedaHackathon/pull/10);
both target develop independently. B2 preserves the supplied assessment and every
finding, including UNKNOWN reasons; B1 owns aggregate calculation. Neither module
automatically rejects or terminates an application.
A's persistence PR is independent. B can test the engine without any database.
The immediate integration task is the transaction-backed scope/repository adapter
with real PostgreSQL rollback, concurrent-write and revocation tests.
