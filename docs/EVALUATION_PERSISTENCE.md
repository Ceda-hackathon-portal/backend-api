# Evaluator persistence slice

`PrismaEvaluationRepository` persists through Developer B's `writeEvaluation` policy. The authenticated server mounts `PUT /api/v1/assignments/:assignmentId/evaluation`; the route requires an active session and CSRF check, while the repository rechecks the live session, programme-scoped `evaluation.write` grant (`evaluation.submit` for finalization), and one active, non-expired, non-revoked, conflict-cleared assignment bound to the exact immutable submission version.

The adapter reads `ProgrammeVersion.config.reviewPolicy` only when it is an explicit `{ "schemaVersion": 1, "scoring": ... }` object matching the existing `ScoringConfig` type. Criteria, ranges, evidence and criterion-comment requirements, weights, and aggregation are read from that immutable publication. Per-criterion comments are preserved. No defaults or policy values are supplied. Missing or invalid configuration fails closed.

Every accepted write advances the evaluation revision, replaces draft scores in the same transaction, and writes an immutable evaluation audit, outbox row, and idempotency receipt. PostgreSQL locks the application and takes shared advisory locks on the assignment and conflict scopes. Revocation and conflict writes take the matching exclusive locks, so the authorization facts cannot change while an evaluation write is committed. Finalized evaluations and their scores are protected by database triggers.

## Not covered by this slice

- No scoring criteria or official CEDA thresholds are supplied.
- Programme configuration publication and management remain unavailable through an API.
- Evaluation HTTP reads, frontend integration, and the remaining evaluator lifecycle endpoints are not implemented; the write route accepts only the strict persistence command documented by its implementation.
- Review quorum, multiple rounds, supersession, and decimal/rounding policy remain unresolved. Finalization therefore does not automatically close the workflow stage.
- Decision persistence and applicant outcome release are not implemented here.
