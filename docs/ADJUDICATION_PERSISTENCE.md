# Adjudication and outcome release persistence

This additive slice uses the existing decision, feedback, evaluation and workflow policies. It adds persistence and protected command routes; it does not add quorum, scoring thresholds or outcome semantics.

## Explicit programme configuration

An immutable published programme version may configure:

```json
{
  "decisionPolicy": {
    "schemaVersion": 1,
    "permittedOutcomes": ["APPROVED", "REJECTED", "REVISION_REQUESTED"]
  }
}
```

Only listed outcomes are accepted. Missing, malformed, duplicate or unsupported values fail closed. No default decision policy is supplied.

## Protected routes

- `POST /api/v1/applications/:applicationId/workflow/lock-scores`
- `POST /api/v1/applications/:applicationId/workflow/open-adjudication`
- `POST /api/v1/applications/:applicationId/decisions`
- `POST /api/v1/decisions/:decisionId/publish`
- `GET /api/v1/applications/:applicationId/outcome`

Mutations require an active server-verified session, CSRF verification and an `Idempotency-Key`. Roles, grants, assignment, conflicts, exact submission version, current workflow state and revision are read from PostgreSQL. Request bodies cannot supply actor, binding, guard or release state.

The applicant projection contains only application/version/programme binding, configured outcome and applicant message. Internal decision reasons, evaluator identities, scores and deliberations are excluded. A decision remains unreadable until an explicit authorized release has committed.

## Atomicity and concurrency

Decision/release, workflow state and revision, transition history, command receipt, audit and outbox writes share one PostgreSQL transaction. Application row locks serialize same-application commands. Assignment creation, revocation and conflict disclosure/resolution take an exclusive `officer-assignment-set` advisory lock; workflow guard evaluation and decision authorization take its shared counterpart. Exact actor assignment and conflict records also use the existing natural-scope and per-assignment conflict advisory locks. Those locks remain held through commit, so a competing assignment change cannot invalidate a check between authorization and protected writes.

Decision/audit/release records are append-only. The only update to a decision is its one-time `released_at`; a fixed-search-path integrity trigger requires a matching exact-version release and publisher audit. The runtime role inserts audit/outbox rows without audit-read privileges. Runtime grants are in `ops/runtime-role.sql` and must be applied by the database owner after migrations; application startup does not perform DDL.

## Verification

`tests/evaluation-persistence.integration.test.ts` exercises the persisted flow using a restricted runtime LOGIN against disposable PostgreSQL, including finalized evaluation, stale command denial, concurrent identical decision and release retries, unpublished outcome concealment, applicant ownership, and outbox-triggered atomic rollback. The fixture uses explicit fictional programme configuration and evidence.
