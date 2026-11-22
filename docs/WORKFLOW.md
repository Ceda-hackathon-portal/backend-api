# Configurable workflow proposal

This is a mechanism proposal, not CEDA policy. Existing Submitted / Under review / Feedback / Approved / Award are integration labels, not a mandatory graph. Internal stage changes may be hidden until publication; applicant status comes from audience-visible events, not a raw internal pointer.

1. Application is a stable owner/configuration identity. Its incomplete Draft is mutable.
2. Initial submit validates saved draft, pinned configuration, programme availability, permissions and attachments if later enabled. In one transaction create immutable Version 1, first StageRun, history, audit, outbox and idempotency result; increment application revision.
3. Assignment references a StageRun whose exact SubmissionVersion never changes. Repeated review opens a new run. Recusal is durable, not a resettable checkbox.
4. Evaluation draft permits missing scores; finalization requires the configured criteria/ranges/reasons and assignment validity. Freeze finalized scorecard. Calculate totals with decimals and pinned weights, never browser totals.
5. Feedback authoring is private. Separate capability publishes a safe audience-specific record. Constructive evaluation feedback is not automatically applicant-visible.
6. Revision request identifies base version, allowed changes and approved deadline. Owner creates a revision Draft. Resubmit creates Version N+1; never edits Version N. New assignments do not silently reuse prior-version evaluations.
7. Recommendation, authorized final decision and publication are separate records/commands. A recommendation is never automatically an approval. Published outcomes create visible history and notifications transactionally.

All mutation commands check expected revision. Same idempotency key/actor/operation/request hash returns one result after current authorization; different payload conflicts. Proposed retention 24h requires approval before production. Concurrent writes cannot silently overwrite. Configuration publication freezes a version; new versions do not migrate active applications automatically.

Guards are schema-validated declarative rules, not executable uploaded code. Published graph validation checks reachable stages, coherent scales/weights and configured authorities. Eligibility, quorum, conflict handling, score visibility, revision windows, late exceptions, appeals and terminal outcomes remain unresolved; missing policy must block the relevant production action rather than choose a default silently.

History and audit are distinct: audience-safe workflow events explain progress; restricted audit records who changed what and why. Append-only application conventions alone do not provide tamper-proof audit. Reviewed SQL privileges/triggers and operational controls are required.
