# Eligibility policy contract

This pure TypeScript module is provisional. Programme owners must approve actual eligibility criteria before production use. It defines no CEDA-specific rule, API route, database table, or authorization check.

## Inputs and outputs

- `EligibilityRequirement[]`: a nonempty, ordered list with unique IDs and either an `attestation` rule or a numerical `gte`/`lte` rule with a finite threshold and explicit unit. The caller must load it from the application's pinned, published programme version.
- `EligibilityEvidence[]`: evidence IDs, requirement IDs, and boolean, finite numeric, null, or absent values. Numeric values from the structured submission adapter carry the exact configured unit match plus server-generated immutable-version provenance. Evidence IDs must be unique. The caller provides applicant evidence to `screenEligibility` and independently sourced officer evidence to `assessOfficerEvidence`.
- Both functions return `EligibilityAssessment` with an overall `MET`, `NOT_MET`, or `UNKNOWN` status and one finding per configured requirement, in configuration order. Missing values produce `UNKNOWN`/`MISSING`; differing nonmissing values for one requirement produce `UNKNOWN`/`CONFLICT`, even when both satisfy a threshold. A verified, mandatory, applicable and explicitly non-waivable failure makes the aggregate `NOT_MET`, even with other `UNKNOWN` findings. Preserve every finding; no aggregate automatically rejects or terminates. See `ELIGIBILITY_MVP_CONTRACT.md`.
- Numerical comparisons are inclusive. The submission adapter rejects mismatched units and does not normalize or round numeric values. The current engine uses JavaScript finite numbers; exact decimal or monetary decisions need an approved exact representation before use.
- Neither function returns a completed verification. `assessOfficerEvidence` is a calculation only. A separate authorized workflow command must record an officer decision and its audit history.

## Dependencies on the shared backend

Developer A's shared infrastructure must provide authenticated actor identity, server-side role and programme grants, application ownership and scope, a pinned published programme version, immutable submission versions, and a transaction boundary. The eligibility workflow needs to bind requirement configuration and evidence to the same application and submission version.

The shared data model needs durable records or equivalents for versioned requirement definitions, evidence with provenance and document references, applicant screening findings, officer findings, officer decision and rationale, actor ID, timestamps, workflow history, and audit events. Verification completion must be authorized server-side and committed with the decision and audit records. The policy module must never infer authorization from a caller-provided officer ID.

The existing applicant submission contract now permits an optional structured `eligibilityEvidence` list. It remains distinct from officer assessment and completed verification. The internal persistence adapter returns per-requirement `UNKNOWN` reasons and rejects malformed or unconfigured evidence. This does not add an officer route or authorize completed verification.

## Open decisions

- Confirm real programme criteria and evidence provenance. The provisional aggregate precedence is established in `ELIGIBILITY_MVP_CONTRACT.md`; officer verification remains required.
- Define how officers resolve conflicting documents, provenance trust, stale evidence, and revised submissions.
- Define exact numeric units, decimal precision, and rounding before using monetary or measured thresholds.

## Integration handoff after backend consolidation

The application service now exposes immutable submission reads keyed by application and version IDs, a server-derived `Principal`, programme-scoped grants, and transactional audit/outbox writes. `backend/src/modules/applications/eligibility-port.ts` defines a proposed `SubmissionReader` and `EligibilityWriteTransaction`; no concrete eligibility repository or schema exists yet. The current pure policy accepts JavaScript numbers and inclusive `gte`/`lte` only. It must not be used for authoritative decimal screening until the following joint contract is approved and implemented.

- **Exact decimal rules:** propose canonical decimal strings with an explicit unit on both rule and evidence; PostgreSQL `numeric(18,6)` and scale 0–6. Reject excess precision rather than round it. Compare scaled integers or exact decimals. Add `gt`, `gte`, `lt`, and `lte`; never translate a strict operator into an inclusive one. Pin the rule-set version to the submitted programme version. Numeric scales and unit vocabulary still need programme-owner approval.
- **UNKNOWN:** retain `MISSING` and `CONFLICT`; propose `UNVERIFIED` and `VERIFIER_UNAVAILABLE` for evidence that exists but cannot be trusted or checked. Malformed client input should return validation error 422, while unusable authorized external evidence remains `UNKNOWN`. Proposed precedence for a requirement: conflicting valid sources, then unverified, then verifier unavailable, then missing. The provisional aggregate rule now gives verified mandatory non-waivable `NOT_MET` precedence and retains all `UNKNOWN` findings. Controlled officer verification is required; no automated terminal decision is permitted.
- **Evidence provenance:** bind every evidence record to the exact submission version and requirement/rule-set version; retain source, source reference, capture time, verification state and authorized reviewer. Multiple facts per requirement must remain visible as separate records. Do not store raw evidence in audit metadata. Retention and supersession after resubmission remain open.
- **Officer review:** derive reviewer identity from the live session and recheck programme permission in the write transaction. Propose denying self-review when reviewer ID equals application owner ID; any broader team or prior-involvement restriction needs a reviewed identity model. A completed review requires an explicit decision, reason, reviewed evidence IDs, timestamp, and atomic audit/history entry. `assessOfficerEvidence` alone never completes review. Repeated reviews should append and reference the superseded review, subject to agreed correction authority.
- **Schema request to Developer A:** `EligibilityCheck` needs application ID, submission version ID, programme version ID, rule-set version ID, overall status, requester, input digest and time; `EligibilityFinding` needs check and requirement IDs, status, unknown reason, provenance/evidence links and explanation; `OfficerReview` needs check/application/submission/rule-set IDs, reviewer, decision, reason, reviewed evidence links, conflict resolution and time. Enforce version-consistent foreign keys, one finding per check and requirement, immutable history, and authorized review writes. Developer A remains the sole migration integrator.
