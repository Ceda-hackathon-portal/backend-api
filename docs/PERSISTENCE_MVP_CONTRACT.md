# Eligibility persistence MVP contract

## Implemented

- Rule snapshots are version 1 and must be explicitly stored in `EligibilityRuleVersion.snapshot`; runtime parsing never treats unrelated programme JSON as eligibility rules.
- The snapshot `ruleVersion` UUID must equal the immutable row ID. Its SHA-256 digest is recalculated before screening.
- Eligibility checks bind one application, programme version, immutable submission version, and rule version. Findings are immutable, one per configured requirement, and retain unknown reason plus evidence provenance.
- A repeated `(requester, application, idempotency key)` replays the first result only when the request hash matches. PostgreSQL transaction advisory locks serialize concurrent requests; the unique constraint is the final guard.
- Intake audits remain unique per application revision. Each eligibility check has its own immutable audit and outbox entry keyed by check ID. All screening writes share one transaction.
- Screening is preliminary; it does not reject or terminate an application.
- Applicant submissions may include an optional `eligibilityEvidence` array in the existing typed draft fields. Each entry has `requirementId`, `value` (boolean, finite number, or null), and an optional `unit`. This is applicant-provided, unverified information, not a document or officer verification record.
- Numeric published rules require an explicit unit. The adapter accepts numeric evidence only when its unit exactly matches the rule's configured unit; it does not convert or round values.
- The production screening adapter reads only `SubmissionVersion.fields` for the explicitly selected immutable version. It assigns an evidence ID and provenance path from that immutable version and ignores current mutable application draft values.
- Missing evidence is passed to the policy as absent and produces `UNKNOWN`/`MISSING`. Conflicting values are retained individually and produce `UNKNOWN`/`CONFLICT`. Malformed values, unknown requirement IDs, and unit mismatches return a controlled `INVALID_ELIGIBILITY_EVIDENCE` error and create no screening records. Invalid rules remain `INVALID_ELIGIBILITY_CONFIGURATION`.

## Technical decisions authorized for this MVP

- Published rule versions and persisted screening rows are append-only at the database layer.
- The screening service checks active session, application ownership, submitted state, exact submission ID, programme ownership, and published rule version inside one transaction.
- A trusted `EligibilityEvidenceSource` is the only input to the policy. Submitted prose is not converted into typed facts. The default `PrismaSubmissionEligibilityEvidenceSource` validates and reads the optional structured evidence from the exact immutable submission snapshot. Constructor injection remains available for isolated tests or future trusted sources.

## Still unresolved

- Evidence capture remains applicant supplied and unverified. Independent officer evidence, document references, evidence resolution, and exact decimal arithmetic are separate work; this adapter does not claim to establish evidentiary truth.
- Rule publication authorization is a trusted internal caller responsibility. No publication or officer HTTP endpoint is added here.
- Officer review authorization and workflow state persistence are separate integrations; this migration provides the models but does not claim their transactional services are complete.
- No CEDA thresholds or official eligibility requirements are introduced by this contract.
