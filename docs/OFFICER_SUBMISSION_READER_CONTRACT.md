# Current HTTP adapter status — 20 November 2026

This section supersedes historical statements elsewhere in this document that HTTP mounting is entirely deferred.
`GET /api/v1/officer/submissions/:submissionVersionId` is conditionally registered only with
authentication and `OFFICER_READ_API_ENABLED=true`. The flag defaults false, including staging examples.
The adapter calls the existing Prisma reader with PrismaOfficerReviewScope, derives the principal
from the live session, validates the UUID and strict outgoing DTO, and preserves concealed errors/no-store.
GET needs no mutation CSRF token. Assignment and conflict mutation APIs remain unmounted, with
resolution restricted to the separate controlled provisioner and programme permission.
Operational clearance policy, credentials and shared migration execution require separate approval.
See openapi.yaml and FRONTEND_API_HANDOFF.md for the wire contract. No workflow mutation occurs on read.


## Historical implementation and review notes

Historical status and test counts below refer to earlier commits and are superseded by the current HTTP status above.

# Officer submission reader contract

The internal service is implemented on feat/a-officer-submission-reader, based on develop 9dd3804. Developer A approved the security boundaries and proposed permission. Developer B confirmation and review-scope/grant provisioning remain open. The HTTP route remains unmounted.

## Exact interfaces

Import the exported types and class from src/modules/applications/officer-submission-reader.ts.

```ts
interface AuthenticatedRequestContext {
  readonly principal: Principal;
  readonly requestId: string;
}

interface OfficerReviewTarget {
  readonly submissionVersionId: string;
  readonly applicationId: string;
  readonly programmeId: string;
  readonly programmeVersionId: string;
}

interface OfficerReviewScope {
  allows(
    db: Prisma.TransactionClient,
    context: AuthenticatedRequestContext,
    target: OfficerReviewTarget
  ): Promise<boolean>;
}

interface OfficerSubmissionReader {
  readForOfficer(
    context: AuthenticatedRequestContext,
    submissionVersionId: string
  ): Promise<OfficerSubmissionDTO>;
}

interface OfficerSubmissionDTO {
  readonly submissionVersionId: string;
  readonly applicationId: string;
  readonly programmeId: string;
  readonly programmeVersionId: string;
  readonly submissionVersionNumber: number;
  readonly reference: string;
  readonly submittedAt: string;
  readonly submissionFields: OfficerSubmissionFields;
}

type OfficerSubmissionFields = Readonly<{
  title: string;
  theme: string;
  problem: string;
  solution: string;
  impact: string;
}>;
```

Principal is the canonical {userId,sessionId,authnLevel} type. Use authRoutes.verifier.verify(cookieHeader) to obtain it, then the server-generated res.locals.requestId UUID. Client role, identity, programme or scope assertions cannot supply authority. The reader checks current session/user state again in PostgreSQL. A syntactically valid context alone confers no access.

## Enforced authorization

The proposed capability is eligibility.read-submission, exported as OFFICER_SUBMISSION_PERMISSION. It follows existing dot-separated conventions. Developer A approval is recorded; Developer B must confirm the shared identifier before provisioning and HTTP mounting.

Exactly one current unrevoked, unexpired ProgrammeGrant must match the officer, that permission and the server-resolved programme. Generic staff permissions confer no access. The reader resolves an exact immutable SubmissionVersion and verifies its application and pinned published programme version. Future publication and mismatched bindings are unavailable.

Self-review is always denied when principal.userId equals Application.ownerId, even with an active permission and approved scope. The current model cannot identify team membership or prior involvement, so broader conflict rules await reviewed identity/assignment data. OIDC authentication is not evidence of staff MFA assurance.

A permission grant must be combined with explicit trusted approval of the exact OfficerReviewTarget. Default scope denies every read. The provider receives a frozen context and target IDs before fields are released. No constructor flag or HTTP body can bypass this check. Only a literal true from the configured provider permits the read.

## Trusted scope provider and assignment authorization

`PrismaOfficerReviewScope` is the production-compatible provider for `OfficerReviewScope`. It reads authoritative assignment and conflict rows using the transaction supplied by the reader, binds actor plus application, programme, programme version and exact immutable submission version, and rejects missing, duplicate, revoked, expired, not-yet-valid or conflicted assignments. It also checks the active session and exact programme grant itself. Perform no external network operations inside this transaction and never use request-supplied role/assignment claims as proof.

The provider treats a missing disclosure or any state except resolved `NO_CONFLICT`/`CLEARED` as default-deny. New assignments must carry issuer and request identities. Existing assignments without that metadata remain stored but cannot authorize reads until reviewed and backfilled. The application runtime role receives SELECT only on assignment and disclosure tables. `PrismaOfficerAssignmentService` is intended for a separately configured provisioner client. `ops/assignment-provisioner-role.sql` grants that identity only assignment/disclosure insert and constrained update privileges plus the parent-table reads needed for live session and grant checks. It is not granted to `ceda_runtime`. The HTTP route remains unmounted.

One bounded transaction takes row locks in user, session, application and grant order, then transaction-scoped shared advisory locks for the exact assignment and its conflicts. Session and grant expiry use PostgreSQL `clock_timestamp()` and are rechecked before return. Assignment changes take the matching exclusive advisory lock in a database trigger and can only revoke once with an audit identity; deletion and binding changes fail. Conflict disclosure writes take a separate assignment-keyed exclusive advisory transaction lock via a database trigger. A concurrent change therefore serializes before or after the authorization read without granting the read-only runtime role UPDATE privilege on assignment tables. No permission cache is used. Already disclosed information cannot be recalled.

The canonical applicant repository now calls the same requireActiveSession and requireProgrammePermission helpers. Its owner-only reads and mutation behavior are preserved.

## Version-aware evidence projection

Only immutable submission version number 1 is supported in this slice. Its explicit projection uses the established field validators for title (120), theme (100), problem (3000), solution (5000) and impact (3000). These are maximum character counts.

Team text, identity documents, attachments, arbitrary JSON keys, internal identities, profiles, findings, scores, decisions and feedback are excluded. Tests insert extra private projection fields and assert the exact returned shape. Both the DTO and nested submissionFields are frozen.

The five narrative fields can themselves contain confidential ideas or applicant-entered personal information. Disclosure is restricted to approved eligibility review. Field allowlisting is not content-level personal-data redaction. Separate evidence provenance/verification storage does not exist here, and the DTO makes no verified-evidence claim.

Other submission version numbers return concealed 404 until a reviewed projection supports them. Adding future resubmission versions must include explicit projection review. Published eligibility-rule projection and additional evidence fields also require joint agreement; raw configuration JSON is not included.

## Errors and endpoint status

- 401 UNAUTHENTICATED for missing/invalid principal, session/user mismatch, expiry, revocation or suspension.
- 422 VALIDATION_FAILED for malformed version/request UUID with a well-shaped principal.
- 404 NOT_FOUND with the same message for missing versions, invalid binding, unsupported versions, self-review, missing/wrong/revoked/expired permission or denied scope.
- Database errors, malformed stored fields and provider failures propagate to the established sanitized 500 boundary. There is no stale permission fallback.

GET /api/v1/officer/submissions/:submissionVersionId remains unavailable. HTTP regression checks authenticated and anonymous callers receive 404. Positive officer HTTP tests and OpenAPI entries will accompany the separately approved mounting task.

## Developer B usage

```ts
// approvedOfficerScope is a trusted, reviewed server dependency.
// Its implementation is pending the assignment/review-scope decision.
const reader = new PrismaOfficerSubmissionReader(prisma, approvedOfficerScope);
const principal = await auth.verifier.verify(request.headers.cookie);
if (!principal) {
  throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
}
const submission = await reader.readForOfficer(
  { principal, requestId: response.locals.requestId },
  submissionVersionId
);
```

This is internal composition guidance, not a mounted route. The caller imports canonical HttpError and uses the shared Prisma instance. Treat DTO evidence as a version-bound input. Any transition or officer decision must independently reauthorize in its own write transaction; this read is not a durable authorization ticket.

B should approve AuthenticatedRequestContext, OfficerReviewTarget, OfficerReviewScope and the five-field OfficerSubmissionDTO before implementing transition composition. Agree the exact permission name, scope model, conflict semantics and additional evidence requirements. Canonical application audit uniqueness allows one event per intake revision; separate workflow/read-access history remains a future reviewed design.

EligibilityCheck/Finding/OfficerReview tables, assignments, conflicts and workflow writes are outside this PR. B's policy and database models are unchanged.

## Focused PR

Title: Add version-bound officer reads with explicit evidence projection.
Target: develop.
Reuse current session/grant checks for a separate officer read. Require exact trusted review scope, deny self-review and cross-programme access, and return only five approved version-1 fields. Preserve owner-only applicant behavior. Add unit, restricted-login PostgreSQL and HTTP absence regressions. Keep HTTP mounting deferred.

Hosted CI has not run for this local branch. Seven unrelated review documents remain outside this PR. Final verification and commit are reported with the handoff.

## Final local verification

Run from backend using Node 24.22.2.

| Command | Result |
|---|---|
| npm.cmd run db:validate | Prisma schema valid |
| npm.cmd run typecheck | Strict check and Prisma generation passed |
| npm.cmd test | Production build and 22 unit/HTTP tests passed |
| npm.cmd run test:smoke | 2 compiled smoke tests passed |
| ./spikes/prisma7/node_modules/node-win-x64/bin/node.exe tests/run-database.mjs | 6 PostgreSQL suites passed, including restricted-role and officer reads |

All suites reported zero failures and zero skips. Four existing migrations replayed cleanly on a fresh PostgreSQL 17 cluster; second deploy found none pending and the cluster stopped. No new migration was created. The officer suite uses a separate restricted LOGIN with SELECT and row-lock privileges. Existing ownership, rollback, API, session and runtime-role tests remain passing. The unfinished officer HTTP path returns 404 with and without a session.

The PR contains exactly nine files. Seven unrelated review documents match their preserved backup hashes and remain untracked outside the commit. No hosted CI run exists for this branch yet. The local commit is prepared for review; publication and merge await permission.

## Message for Developer B

The internal PrismaOfficerSubmissionReader is ready for review. Construct it with the shared Prisma client and a trusted OfficerReviewScope, then call readForOfficer({principal,requestId},submissionVersionId) using the canonical verified session context.

Developer A approved eligibility.read-submission as the proposed shared identifier; please confirm it. The persistent programme grant and exact-submission scope are both mandatory, and self-review always denies. Default scope denies every read.

Version 1 returns metadata plus title, theme, problem, solution and impact. Team text, arbitrary evidence JSON and future versions are excluded pending explicit projection approval.

Before transition integration, please approve AuthenticatedRequestContext, OfficerReviewTarget, OfficerReviewScope and OfficerSubmissionDTO. We still need the assignment/stage/conflict scope, grant provisioning and evidence/rule mapping decisions. Reads do not authorize later transitions; writes must recheck permission and scope transactionally.

The endpoint stays unmounted until scope and provisioning are agreed. No eligibility, officer-review or workflow schema change is included.
