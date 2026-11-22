# Transaction-backed workflow adapter

Implemented against develop after officer HTTP PR #15. This is an internal service, not a mounted mutation API. `OFFICER_READ_API_ENABLED` remains false in environment examples.

```ts
const repository = new PrismaWorkflowRepository(prisma, {
  principal, // server-verified current session, never request-body identity
  requestId, // server-generated UUID
  eligibilityCheckId, // selected persisted check; never a client assessment/guard
});
const result = await executeTransition(repository, {
  applicationId, submissionVersionId, programmeId, programmeVersionId,
  transition: 'SCREEN', expectedRevision: 0,
  idempotencyKey: 'screen-transition-1', reason: '',
});
```

## Implemented authority and transaction boundary

- Reuses B's unchanged `executeTransition`/`transitionWorkflow` engine and provisional graph.
- Validates/canonicalizes UUIDs, bounds command keys/reasons/revisions and derives the actor role from the engine's transition definition. A current programme permission must authorize that action; no role/guard claims are accepted from command input.
- Locks current user, session and application in that order. The application row serializes initialization and concurrent commands across every actor and key. The update also compares the workflow revision.
- Loads the exact immutable submission, programme version, published rule and persisted eligibility check, findings and screening audit/outbox. Wrong check/application/submission/programme bindings deny access. The check identity is pinned in state and every event; the engine receives its actual rule ID, status and complete findings.
- Officer commands require the existing PrismaOfficerReviewScope in the write transaction, including live `eligibility.read-submission`, assignment, conflict clearance and self-review checks. Its transaction locks serialize revocation/conflict changes. Rechecks occur before writes and before commit/replay return.
- A validated initial submitted application is revision 0 conceptually. The first successful transition atomically creates StateSnapshot revision 1, its WorkflowEvent, WorkflowCommandReceipt, WorkflowAudit and WorkflowOutbox. Rejected commands do not create placeholder state/history.
- Workflow revision is StateSnapshot.revision, separate from Application.revision used by the existing draft/submit API. Intake audit uniqueness and intake behavior are unchanged. A future HTTP contract must expose this distinction explicitly.
- Receipt uniqueness is application + authenticated actor + key. Identical retries reauthorize and return the original immutable receipt without another event. Changed fingerprints conflict. No root-client recovery reads follow rollback.
- Commit independently reruns the existing engine with fresh authorization/guard facts and compares the supplied receipt. No network operation belongs inside this transaction.

## Human and later-stage guard dependencies

`PrismaReviewWorkflowFacts` supplies transaction-local evaluator, adjudicator and publisher assignments plus finalized-review guards from current database records. It does not read guard claims from HTTP bodies or make network calls. The adjudication and release command adapter performs its own live grant, assignment, conflict, exact-version and decision-policy checks. Correction/resubmission still needs separately approved new immutable-version creation and rebinding rules. No automatic repinning to a newer screening/check is permitted.

## Additive database slice and release gate

`202611200003_workflow_transactions` adds:

- Required eligibility-check bindings on workflow state/events, with composite submission/application/check foreign keys.
- WorkflowCommandReceipt, WorkflowAudit (server request UUID, actor linked through event) and WorkflowOutbox. Payloads contain engine state changes and finding statuses/reasons, not raw evidence or identity documents.
- Immutable receipts/audits/history, consecutive revision/binding guards and deferred constraint triggers requiring a contiguous event chain and matching state/receipt/audit/outbox at commit.
- Runtime SELECT/INSERT for these workflow records and column-limited state updates. Runtime cannot rewrite history, receipts, audit, eligibility bindings, tables or triggers. Delivery-worker privileges remain separate future work.

The migration is transactional and refuses existing workflow_state/workflow_events rows rather than inventing check identities or historical receipts. Inspect and reconcile such data through a separately reviewed plan before applying to any shared environment. The original migration files are unchanged. No shared migration is authorized by this PR. The runtime role script is a separately reviewed owner operation; existing deployments need its explicit privilege changes, not startup DDL.

## Verification and remaining exposure

The real PostgreSQL suite uses a distinct restricted LOGIN and tests authorization, exact binding, UNKNOWN preservation, replay, altered-payload conflict, concurrent stale revisions, session/grant revocation, assignment revocation winning before the write, outbox rollback, deferred history consistency and immutable/DDL denials. The adjudication/release integration test additionally verifies explicit release, applicant projection, concurrent idempotent commands and rollback. See `ADJUDICATION_PERSISTENCE.md`.

Run Prisma validation/typecheck/build, npm test, compiled smoke, disposable database replay/tests and hosted container verification. These routes are protected backend commands; frontend wiring, staging configuration and any shared-database migration remain separate work.
