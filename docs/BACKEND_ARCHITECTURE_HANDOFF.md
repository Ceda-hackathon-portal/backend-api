# Backend architecture review and session handoff

Saved: 2026-11-08

## Session status

The user requested an analysis-only review before backend implementation. The repository was inspected and an architecture proposal delivered. Architecture approval is still pending: proposals below are not approved implementation decisions.

 This document is the only intended change for that request. No backend was generated, dependencies installed, frontend changed, or AWS resources provisioned. No application, build, lint, or test commands were run. Git working tree was clean at the start of the review and before saving this handoff.

## User requirements and boundaries

- Preserve the existing React + Vite frontend; do not rebuild or replace it.
- Add a separate `backend/` when implementation is authorized.
- Node.js, strict TypeScript, Express, PostgreSQL; Prisma proposed and assessed as suitable.
- Modular monolith, REST under `/api/v1`, database access separate from business logic.
- Zod validation, centralized errors, environment configuration, transactions, unit/integration tests and OpenAPI contracts.
- Configurable programmes, multi-stage evaluation, submission versions, audit logs and secure S3 attachments.
- Enforce authentication, server-owned permissions, ownership, reviewer assignments, conflicts and workflow transitions.
- Never trust frontend roles or client-supplied ownership identifiers.
- Prepare for AWS deployment; do not provision resources without approval.
- Do not install dependencies or begin implementation until the user reviews the architecture and authorizes the next step.

## Inspected repository

Read README, docs/FRONTEND_ROADMAP.md, package.json, contexts, all pages, routing, relevant shared components, utilities, main entry point, Vite configuration, Vercel rewrite and ignore rules. Inventoried tracked source/assets and searched for API calls, persistence and context consumers.

There is no existing backend, database schema, functioning API client or tracked test suite. React 19 + Vite frontend includes public pages and six role-oriented workspaces.

## Requirement provenance

README and frontend roadmap attribute seven themes to the official competition notice: submission, multi-level evaluation, appropriate status visibility, role-based access, feedback and iteration, basic reporting and scalability.

The original notice and 18-slide deck were not present in the repository, so their wording was not independently verified. The six roles, UR-01–UR-17, criteria, sample themes, five-stage journey and operating rules are team proposals or fixtures, not confirmed CEDA policy. User architecture/security instructions are requirements for this project, not quotations from CEDA.

## Existing frontend findings

- AuthContext.jsx holds demo identity in memory using a selected role. No authentication occurs.
- ProtectedRoute.jsx checks `user.role` for presentation only.
- PortalContext.jsx saves all ideas and one draft in `ceda.prototype.v1` localStorage. Data is shared across demo roles; no record ownership exists.
- Existing role IDs: `submitter`, `evaluator`, `adjudicator`, `administrator`, `management`, `system-administrator`.
- Initial field contract: `title`, `theme`, `problem`, `solution`, `impact`, `team`.
- Browser limits: title 120, problem 3000, solution 5000, impact 3000, team 150 characters. These are initial UI constraints, not confirmed policy.
- SubmitIdeaPage saves a local draft and calls synchronous `submitDemo()`. Its form initializes from draft only once. Real API integration requires async handlers and explicit draft hydration.
- The form checkbox confirms fictional demo information; it is not production privacy/IP consent.
- IdeaDetailPage searches the loaded ideas array and always renders Version 1; feedback is embedded in each idea.
- ReviewPage shows all browser ideas, local filters, uncontrolled unsaved scores/rationale, temporary conflict checkbox and unsaved decision previews.
- AdminPage and SystemPage are descriptive placeholders.
- ReportsPage derives aggregates from the same raw ideas collection used by operational pages.
- Dashboard updates are inferred from feedback rather than actual notifications.
- `/challenges` labels themes as programmes. Separate programme entities from their themes.
- Fixture stage labels: Submitted, Under review, Feedback, Approved, Award. Do not encode these as the permanent workflow.
- safeReturnPath() hardcodes digital/sustainable/inclusive theme codes.
- vercel.json rewrites all paths to index.html; future API routing must precede the SPA catch-all.

## Page-to-service map

| Page/routes | Required backend capability |
| --- | --- |
| Home | Optional published programme summaries |
| Services/Search | Existing service directory/search can stay local |
| Challenges | Public programmes, themes, briefs and intake windows |
| Guidelines | Published form requirements and public workflow guidance |
| Auth | Registration, verification, sessions, logout and recovery |
| Dashboard | Own applications/drafts/counts and notifications |
| Submit idea | Configuration, draft CRUD, upload lifecycle, validation, idempotent submission |
| Idea detail | Owner-scoped detail, released feedback, versions, public events and permitted revisions |
| Review | Assigned-only queue, deadlines, conflict declarations and version-bound evaluations |
| Adjudication | Authorized evidence, decisions, rationale and publication |
| Admin | Versioned programme configuration, assignments, scoped grants and deadline exceptions |
| Reports/management | Authorized aggregates and controlled exports |
| System | Restricted operational summaries and redacted audit access |
| About/help/privacy | Mostly static; replace prototype text before live use |

## Proposed architecture

One backend codebase, one PostgreSQL database, one API deployment. Worker entry point from the same codebase handles outbox deliveries, scanning coordination and scheduled work.

Flow: Express routes -> authentication and Zod validation -> application services and policies -> repositories/transaction boundary -> Prisma/PostgreSQL.

Modules: authentication; users/roles; programmes; applications; assignments; evaluations; workflow; feedback; notifications; reporting; audit.

Keep controllers thin. Services own rules, repositories own queries, infrastructure adapters own identity/email/storage. Services should not depend on Express request/response types. Commit state changes, workflow history, audit and outbox entries together. External calls happen outside database transactions.

Prisma is suitable for typed relational access and transactions. Use reviewed SQL migrations for constraints/indexes not fully represented by Prisma. Use optimistic concurrency and targeted stronger isolation with retry handling for competing workflow commands.

### Proposed folder structure

```text
backend/
  package.json
  package-lock.json
  tsconfig.json
  .env.example
  Dockerfile
  prisma/
    schema.prisma
    migrations/
    seed.ts
  src/
    app.ts
    server.ts
    worker.ts
    config/env.ts
    infrastructure/{database,identity,storage,email}/
    shared/{errors,http,middleware,authorization,transactions,logging}/
    modules/{auth,users,programmes,applications,assignments,evaluations,workflow,feedback,notifications,reporting,audit}/
    jobs/
  tests/{unit,integration,fixtures}/
  docs/{openapi.yaml,architecture.md,authorization-matrix.md,workflow.md,deployment.md,decisions/}
```

Module internals use routes, schemas, controllers, services, policies and repositories as needed. Avoid unnecessary empty layers. Backend gets its own dependencies/package boundary; retain frontend scripts and dependencies.

## Proposed PostgreSQL model

- User, Identity, Session: provider mappings; hashed opaque session identifiers, expiry/revocation.
- Role, Permission, RolePermission; explicit GlobalRoleGrant and ProgrammeRoleGrant.
- Programme -> ProgrammeVersion -> Theme, FormDefinition, StageDefinition, TransitionDefinition and Criterion.
- Application: owner, pinned programme version, lifecycle state, current stage run, concurrency revision.
- ApplicationDraft: mutable initial/revision answers; incomplete fields allowed.
- SubmissionVersion: immutable numbered validated snapshots.
- StageRun: actual visits to configured stages, including repeated review rounds.
- ReviewerAssignment: reviewer + stage run + exact submission version.
- ConflictDeclaration: durable declaration/recusal history.
- Evaluation -> EvaluationScore: assignment-bound scorecard with criterion scores/justifications.
- Decision: stage/version, rationale, authority and publication state.
- WorkflowEvent: append-only transition history.
- RevisionRequest: requested changes, deadline and fulfillment.
- Feedback, FeedbackReply: explicit audience and publication state.
- Attachment, VersionAttachment: storage metadata and exact object versions associated with snapshots.
- Notification, DeliveryAttempt; AuditEvent; OutboxEvent; IdempotencyRecord; DeadlineException; ExportJob.

Use UUIDs, separate human references, foreign keys, timestamptz and numeric concurrency revisions. Unique (application_id, version_number). Published configurations and submissions are immutable. Enforce matching programme/version/stage/criteria relationships with database constraints as well as services. Use decimal arithmetic for scores and server-calculated totals.

Validated JSONB answers tied to versioned form definitions support configurable forms; keep ownership/programme/theme/state/time fields relational. Preserve the six initial field keys through DTOs. Team remains descriptive text unless collaborative access is explicitly defined.

Use finite-state workflows with supported declarative guards, never administrator-uploaded executable code.

## Proposed REST contracts

All below are under `/api/v1`, unimplemented and subject to review.

| Area | Endpoints |
| --- | --- |
| Auth | POST /auth/register, /auth/login, /auth/logout, /auth/email-verifications, /auth/password-reset-requests, /auth/password-resets; GET /auth/session, /auth/csrf |
| Account | GET/PATCH /me |
| Public programme | GET /programmes, /programmes/{id}, /programmes/{id}/configuration |
| Programme admin | POST /programmes, /programmes/{id}/versions; PATCH /programme-versions/{id}; POST /programme-versions/{id}/publish |
| Users/grants | GET /users, /roles, /permissions; POST /programmes/{id}/role-grants; DELETE /programmes/{id}/role-grants/{grantId} |
| Applications | POST/GET /applications; GET /applications/{id} |
| Draft/submit | GET/PUT /applications/{id}/draft; POST /applications/{id}/submit |
| History | GET /applications/{id}/versions, /applications/{id}/versions/{number}, /applications/{id}/events |
| Assignments | GET /assignments; POST /applications/{id}/assignments, /assignments/{id}/revoke, /assignments/{id}/conflict-declarations |
| Evaluations | GET/PUT /assignments/{id}/evaluation; POST /assignments/{id}/evaluation/submit |
| Workflow | GET /applications/{id}/allowed-actions; POST /applications/{id}/transitions, /applications/{id}/decisions, /decisions/{id}/publish |
| Revisions | POST /applications/{id}/revision-requests, /applications/{id}/revision-drafts, /applications/{id}/resubmit |
| Feedback | GET/POST /applications/{id}/feedback; POST /feedback/{id}/publish, /feedback/{id}/replies |
| Attachments | POST /applications/{id}/attachments/upload-intents, /attachments/{id}/complete; GET /attachments/{id}/download-url; DELETE /attachments/{id} |
| Notifications | GET /notifications; PATCH /notifications/{id} |
| Reporting | GET /reports/summary, /reports/stages, /reports/review-workload, /reports/outcomes; POST /reports/exports; GET /reports/exports/{id} |
| Audit/operations | GET /audit-events, /system/summary |
| Exceptions | POST /applications/{id}/deadline-exceptions, /assignments/{id}/deadline-exceptions |

Draft write body: `{ revision, fields: { title, theme, problem, solution, impact, team } }`. Create application with programmeId; server derives owner and published configuration version. Submission command uses expectedRevision and Idempotency-Key. Server returns ID, human reference, version, status and timestamp.

Conventions: `{ data }` success; collection pagination metadata; `{ error: { code, message, requestId, details } }` errors. Cursor pagination, bounded sizes, allowlisted sorting/filtering, UTC timestamps plus programme time zone. 401 unauthenticated; 403 forbidden capability; 404 missing/inaccessible record; 409 concurrency/state conflict; 422 validation. Reject unknown input fields. Scope idempotency to actor/operation and request hash with explicit retention. Provide audience-specific response schemas; no raw universal entity serialization. Public configuration excludes private/unpublished material.

OpenAPI must eventually document each request/response, permission, workflow precondition, error and retry behavior. Identity endpoints may change with provider selection.

## Security proposal

Prefer backend-managed HttpOnly/Secure/SameSite cookie sessions and same-site frontend/API hosting. PostgreSQL stores hashed opaque session tokens. Identity adapter allows later CEDA SSO or managed provider. Local passwords, if selected, need maintained password hashing, verification, hashed single-use recovery tokens and rate limiting. Decide staff MFA with identity provider.

Cookie-authenticated mutations need CSRF protection; explicit CORS allowlist; rotate/revoke/expire sessions. Never put session credentials in localStorage.

Authorize using verified identity + server grants + programme scope + owner/assignment + conflict + workflow/deadline + data audience. Never allow self-selected staff roles or unconstrained delegated grants. Revocation/suspension takes effect on subsequent requests.

Default roles: submitters access own records/released feedback; evaluators access active assigned versions and own evaluations; adjudicators access authorized decision evidence; administrators manage scoped configuration/assignments/delegated actions; management receives aggregates and separately authorized exports; system administrators receive technical access without automatic idea-content access.

### S3 attachment lifecycle

Private storage, blocked public access, least-privilege IAM. Authorize upload intent; issue short-lived signed upload with server-generated key and limits. Verify actual size/type/checksum/content, quarantine and scan. Finalize against exact scanned object version, or promote verified content to an immutable final location. Presigned URLs can be reused before expiry and same-key uploads can overwrite objects. Reauthorize every download before issuing short-lived URLs. Preserve submitted file versions. Apply explicit lifecycle/retention rules; do not log URLs or confidential contents.

## Frontend integration proposal

- Preserve routes, layout, branding and components. Add a small API client and DTO adapters.
- AuthContext restores session, adds loading/login/register/async logout while preserving modal and requireAuth behavior.
- Keep user.role as UI workspace selection derived from server grants; expose complete roles separately. Demo entry stays isolated from live mode.
- PortalContext replaces browser persistence with scoped requests and async operations; adds loading/error/pending/conflict states.
- Clear private caches on logout/identity change. Fetch detail by ID independently of list pagination.
- Do not migrate demo browser records automatically.
- Introduce dedicated assignments/configuration/reporting hooks; do not use a universal raw ideas cache across roles.
- Replace fixture themes/criteria/stages with published configuration; keep stable initial field/theme codes where practical.
- Targeted UI edits: async forms, draft hydration, programme selection, controlled scoring, actual versions/history, server timeline/actions, aggregate reporting and live-mode copy.

## Proposed milestones and validation

1. Approve scope, permissions, example workflow, identity approach and contracts.
2. Foundation: strict TS, Express, Zod, validated env, errors/logging, migrations/test harness.
3. Identity/access: sessions, scoped grants and negative authorization tests.
4. First vertical slice: published programme -> applicant draft -> immutable submission -> owner-only detail/history; retry-safe.
5. Evaluation: assignments, recusal, version-bound scores and finalization.
6. Workflow: revision -> version 2 -> re-review -> authorized decision, preserving evidence.
7. Attachments, notifications, aggregate reporting, exports and audit views.
8. Deployment preparation: container/CI, controlled migration job, secrets, health, backup/restore and integration verification.

Unit-test policy/scoring/transitions. Integration-test real PostgreSQL constraints/transactions/concurrency/access. Include unassigned, conflicted, revoked and cross-programme denial; private feedback leakage; stale revisions; simultaneous duplicate submission/decision commands.

AWS proposal is containerized API/worker + managed PostgreSQL + private S3, with secrets/monitoring and controlled migrations. Select exact services after budget, region and operational needs are known. Do not provision yet.

## Open questions and risks

- Obtain/validate official notice and proposed deck.
- Applicant eligibility; individual vs organisation/team ownership and collaboration.
- Decision versus recommendation/publication authority, delegation and separation of duties.
- Review rounds, reviewer counts/quorum, consensus, blind review and score visibility.
- Conflict timing, reassignment and validity of prior evaluations.
- Scales, weights, rounding, thresholds and incomplete-score handling.
- Revision/re-review semantics and continued validity of scores.
- Time zones, late submission, grace periods, deadline exceptions and appeals.
- Published configuration changes and migration policy.
- Applicant/reviewer identity visibility, feedback publication and intellectual property access.
- CEDA identity provider, SSO, MFA and staff onboarding.
- Retention/deletion, residency, approved privacy/IP terms, encryption policy.
- Reporting definitions and small-group disclosure controls.
- Audit integrity requires restricted DB privileges; application append-only conventions alone are insufficient.
- AWS region/budget/load/recovery objectives and operational ownership.
- Revalidate Node/Vite/runtime compatibility at implementation; no build/lint performed in this analysis.
- AI scoring, public voting, duplicate detection and financial integrations remain deferred.

## Documentation verified during review

- Prisma transactions/concurrency: https://docs.prisma.io/docs/orm/v7/prisma-client/queries/transactions
- Prisma/PostgreSQL check constraints: https://docs.prisma.io/docs/orm/v6/more/troubleshooting/check-constraints
- AWS S3 presigned URL behavior: https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html

## Resume next session

Read this file and the frontend roadmap, check current git status and any new repository instructions, then address the user's architecture feedback. Do not assume architecture approval or start implementation merely because this handoff exists.

Recommended first implementation slice after authorization: authenticated applicant -> published programme -> saved draft -> immutable submission -> owner-only detail/history.
