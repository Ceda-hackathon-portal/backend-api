# Proposed API contract

Phase4B update: the existing Cognito flow is preserved and an explicit development-only local login is documented in AUTH_CONTRACT.md. That contract supersedes proposed authentication rows and credential-login sketches below. Other domain endpoints remain proposals. Current auth/session has no grants yet; see explicit compatibility differences there.

Status: all domain endpoints below remain proposed, not implemented. Foundation health endpoints outside /api/v1 are implemented; see openapi.yaml and FOUNDATION.md. All domain paths prefix /api/v1. Cognito endpoints remain provider-specific; local login is available only with AUTH_MODE=local in development. The session/profile contracts are provider-independent. Attachments are design-only pending policy approval.

## Wire conventions

Success {data:T}; paginated {data:T[],page:{nextCursor:string|null,hasMore:boolean}}. UTC ISO timestamps, server-generated UUIDs, separate human reference. Decimal totals serialize as strings. Unknown DTO keys rejected (Zod strict objects proposed); passwords are never normalized. Draft strings may be empty, final strings nonblank after trim. API repeats HTML UTF-16 length limits. IDs UUID; version positive integer; revisions nonnegative integer. JSON bodies bounded (proposed64KiB except separately approved upload protocol). All protected requests require a freshly validated live session and server authorization; every mutation requires CSRF/origin checks. Capability projection is advisory, never a substitute for command checks.

Confidential responses, auth, mutations and all errors: Cache-Control: no-store. Public responses P: public,max-age=60,s-maxage=300 plus ETag, only published sanitized projections; CDN explicit allowlist, no Set-Cookie/personalization. N means no-store. L means cursor pagination default20/max100, deterministic tie-break id, filters allowlisted. q max100 proposed; do not log private search terms. stage initially accepts configured display label; introduce explicit stageId without silently changing stage meaning.

Errors {error:{code,message,requestId,details?:[{path,code,maximum?}]}}. 400 malformed JSON/query/cursor;401 invalid session;403 general capability/CSRF;404 missing or inaccessible record;409 stale revision/state/idempotency mismatch;413 body size;415 media;422 field/policy input;429 rate limit;503 unavailable. Every protected route inherits401/403; record routes inherit404; body/query routes400/422; commands409; all may503. No stack traces/private values in errors.

Idempotent commands require Idempotency-Key (1..128 chars), scoped actor+operation+key+request hash. Same command returns one result after CURRENT authorization; mismatch409. Retention proposed24h, not approved business retention. Save/submit contract uses application revision shared across draft/state mutations, not an unrelated draft revision.

## DTO dictionary

- Fields = {title:string<=120,theme:string,problem:string<=3000,solution:string<=5000,impact:string<=3000,team:string<=150,eligibilityEvidence?:[{requirementId:string,value:boolean|finite number|null,unit?:string}]}. All six narrative fields required/nonblank on final submit; optional structured evidence is bounded to 200 records and is applicant supplied/unverified. Numeric evidence must use the exact unit configured by its published rule; no unit conversion or free-text inference occurs. Draft permits empty; theme nonempty must match pinned version.
- Session = {user:{id,name,email,roles:string[],role:string},grants:[{role,programmeId:string|null}],authzRevision:number,expiresAt:ISO}. role is default granted UI workspace only, never sole authority.
- Profile = {id,name,email,emailVerified:boolean}. name nonblank<=100. Email changes require separate provider-reviewed verification, not mass-assignment PATCH.
- DraftWrite = {revision:number,fields:Fields,attachmentIds:UUID[]}; attachments remain disabled pending policy. Draft = {applicationId,revision,baseVersionNumber:number|null,fields:Fields,attachmentIds:UUID[],updatedAt}.
- Summary = {id,reference,title,theme,team,status,statusCode,submittedAt:ISO|null,versionNumber:number|null,revision}. Draft summaries may have blank title/theme/team. Submitted list excludes drafts by default.
- Detail = Summary + {programmeId,programmeVersionId,problem,solution,impact,feedback:Feedback[],attachments:AttachmentMetadata[],allowedActions:string[]}. Only safe audience fields, no owner/grants/internal scores leaked.
- SubmissionResult = {id,reference,versionNumber,status,submittedAt,revision}.
- VersionSummary = {id,versionNumber,submittedAt}; VersionDetail = {id,applicationId,versionNumber,submittedAt,title,theme,problem,solution,impact,team,attachments}.
- Feedback = {id,author,message,createdAt,publishedAt,versionNumber}; author is safe display label, not raw reviewer ID. Published text immutable.
- Event = {id,action,status,statusCode,message,occurredAt,versionNumber}; internal audit reason omitted.
- Assignment = {id,applicationId,submissionVersionId,versionNumber,stageRunId,title,theme,status,dueAt:ISO|null,state,revision}.
- Criterion = {id,name,description,minimum:string,maximum:string,weight:string,reasonRequired:boolean}. Range/weights pinned configuration, not invented 1-5 business policy.
- EvaluationWrite = {revision,scores:[{criterionId:UUID,value:number|null,reason:string<=2000}],constructiveFeedback:string<=5000}; proposed feedback bound. Finalize requires configured complete numeric scores/reasons. Unique criterion IDs, exact assigned stage criteria only.
- Evaluation = {id,assignmentId,revision,state,scores,constructiveFeedback,total:string|null,submittedAt:ISO|null}.
- RecommendationWrite = {expectedRevision,outcome,rationale}; initial UI phrases map REQUEST_INFORMATION / RECOMMEND_APPROVAL / RECOMMEND_DECLINE; proposed rationale<=5000/nonblank final. Final-decision outcome codes remain approval-blocked.
- Recommendation = {id,stageRunId,outcome,rationale,state,revision,createdAt,finalizedAt}.
- Decision = {id,stageRunId,recommendationId:null|UUID,outcome,rationale,state,revision,finalizedAt,publishedAt}. Recording/finalizing/publishing use distinct capabilities.
- Notification = {id,kind,title,message,applicationId:UUID|null,createdAt,readAt:ISO|null}. Minimal safe content, reauthorize target.
- ReportSummary = {programmeId,generatedAt,submittedCount,themesRepresented,withReleasedFeedbackCount,byStage:[{stage,statusCode,count}],byTheme:[{theme,count}]}.
- PublicProgramme = {id,code,name,currentVersionId,brief,opensAt,closesAt,timeZone}.
- PublicConfig = {versionId,themes:[{id,number,name,category,description,color,icon}],stages:string[],stageDefinitions:[{id,code,label,position}],fields:[{name,required,maxLength}],guidelines}. Excludes private criteria, permissions and guards.
- PrivateConfig extends config with explicit Criterion/stage/transition policy records; strictly validated only in unpublished version.
- AttachmentMetadata = {id,fileName,mediaType,sizeBytes,versionNumber}; no bucket/key/URLs in ordinary detail.
- Audit = {id,actorId,action,targetType,targetId,reason,occurredAt,requestId}; redacted scoped projection, no raw answers.
- Operation message = {message:string}; CreatedApplication = {id,reference,revision,draft:Draft}.

## Endpoint catalogue

Authorization aliases: Own=current owner; Assigned=active exact-version reviewer without blocking conflict; Decision=explicit scoped evidence/final-decision authority; Recommend=separate recommendation authority; Admin=scoped configuration/assignment capability; Publish=explicit publication capability; Reports=scoped aggregate capability; System=restricted technical/audit capability. Role labels alone do not authorize. Current programme, workflow, deadlines and audience checked where relevant.

| Method/path | Request DTO / query | Response data / status | Authorization | Validation/preconditions / additional errors | Cache/page |
|---|---|---|---|---|---|
| POST /auth/local-login | {email,password}; only with AUTH_MODE=local in development | {authenticated:true} /200 | Existing opaque DB session | Exact Origin + CSRF; loopback only; no role/grant creation | N |
| GET /auth/session | None | Session /200 | Current session | 401 expiry/revocation; no cached restoration | N |
| GET /auth/csrf | None | {csrfToken} /200 | Session or approved anonymous binding | Origin/bootstrap; adapter details pending | N |
| POST /auth/logout | None | 204 | Current session/idempotent cookie cleanup | CSRF; revoke before clear; DB failure not success | N |
| GET /me | None | Profile /200 | Own identity | Standard protected errors | N |
| PATCH /me | {name} | Profile /200 | Own identity | name<=100; no role/email/owner input | N |
| GET /programmes | cursor,limit | PublicProgramme[] /200 | Public | Published only | P,L |
| GET /programmes/:id | None | PublicProgramme /200 | Public | Published-only404 | P |
| GET /programmes/:id/configuration | None | PublicConfig /200 | Public | No private/unpublished config | P |
| POST /applications | {programmeId} | CreatedApplication /201 | Own/new | Server owner/config; intake; idempotency | N |
| GET /applications | cursor,limit,q,theme,stage | Summary[] /200 | Own | Server owner scope; submitted-only default | N,L |
| GET /applications/drafts | cursor,limit | Summary[] /200 | Own | Register static route before :id | N,L |
| GET /applications/:id | None | Detail /200 | Own | Not a universal staff detail endpoint | N |
| GET /applications/:id/draft | None | Draft /200 | Own | 404 absent; revision permissions | N |
| PUT /applications/:id/draft | DraftWrite | Draft /200 | Own+editable window | Incomplete allowed; parent revision atomically increments;409 stale | N |
| POST /applications/:id/submit | {expectedRevision} | SubmissionResult /201 | Own+intake | Saved complete draft; transactional snapshot; idempotency | N |
| GET /applications/:id/versions | cursor,limit | VersionSummary[] /200 | Own or scoped evidence | No automatic staff content access | N,L |
| GET /applications/:id/versions/:number | None | VersionDetail /200 | Own or scoped version evidence | Positive number; reviewer exact assigned version | N |
| GET /applications/:id/events | cursor,limit | Event[] /200 | Own or scoped history | Audience-filtered | N,L |
| GET /applications/:id/allowed-actions | None | {revision,actions:string[]} /200 | Record access | Advisory; commands reauthorize | N |
| GET /me/application-summary | None | {submittedCount,inReviewCount,withReleasedFeedbackCount,draftCount} /200 | Own | Aggregate entire owner scope, not loaded page | N |
| GET /assignments | cursor,limit,programmeId,q,theme,stage | Assignment[] /200 | Assigned | Only caller active assignments | N,L |
| GET /assignments/:id | None | {assignment,submission:VersionDetail,criteria:Criterion[]} /200 | Assigned | Exact version; revoked404 | N |
| POST /assignments/:id/conflict-declarations | {conflicted:true,reason?:string} | {id,assignmentId,createdAt} /201 | Assigned reviewer | Durable blocking recusal; cannot casually send false | N |
| GET /assignments/:id/evaluation | None | Evaluation /200 | Assigned reviewer | Own scorecard;404 absent | N |
| PUT /assignments/:id/evaluation | EvaluationWrite | Evaluation /200 | Assigned+editable | Ranges/stage;409 stale/final/conflicted | N |
| POST /assignments/:id/evaluation/submit | {expectedRevision} | Evaluation /200 | Assigned+finalize | Complete criteria/reasons; deadline; idempotency | N |
| GET /applications/:id/evidence | None | {version:VersionDetail,stageRunId,evaluations:Evaluation[],recommendations:Recommendation[],allowedActions} /200 | Scoped evidence | Score/conflict/identity visibility policy applies | N |
| POST /applications/:id/recommendations | RecommendationWrite | Recommendation /201 | Recommend | Nonbinding; exact stage/version; idempotency | N |
| POST /applications/:id/decisions | {expectedRevision,recommendationId?,outcome,rationale} | Decision /201 | Decision | Outcome/quorum policy not yet approved; cannot fabricate | N |
| POST /decisions/:id/finalize | {expectedRevision} | Decision /200 | Explicit final-decision authority | Workflow/quorum; idempotency; freezes decision | N |
| POST /decisions/:id/publish | {expectedRevision} | Decision /200 | Publish | Final only; transaction/history/outbox; idempotency | N |
| POST /applications/:id/transitions | {expectedRevision,action,reason?} | {revision,event:Event} /200 | Configured transition authority | Declarative guards; idempotency | N |
| GET /applications/:id/feedback | cursor,limit | Feedback[] /200 | Own or feedback scope | Released/audience filtering | N,L |
| POST /applications/:id/feedback | {versionNumber,message,audience} | Feedback draft /201 | Feedback author | Same application/version; message proposed<=5000 | N |
| PATCH /feedback/:id | {revision,message} | Feedback draft /200 | Author+current permission | Unpublished only;409 stale/published | N |
| POST /feedback/:id/publish | {expectedRevision} | Feedback /200 | Feedback Publish | Audience; notification; idempotency | N |
| POST /feedback/:id/replies | {message} | {id,feedbackId,author,message,createdAt} /201 | Conversation participant | Published/audience rules; proposed<=5000 | N |
| POST /applications/:id/revision-requests | {expectedRevision,versionNumber,reason,allowedFields,dueAt} | {id,baseVersionNumber,reason,allowedFields,dueAt} /201 | Revision authority | One actionable request; deadline policy unresolved | N |
| POST /applications/:id/revision-drafts | {expectedRevision,revisionRequestId} | Draft /201 | Own+active request | Copy base; never overwrite submitted version | N |
| POST /applications/:id/resubmit | {expectedRevision} | SubmissionResult /201 | Own+active request | Complete saved draft; allowed changes/deadline; idempotency | N |
| POST /programmes | {code,name} | {id,code,name} /201 | Programme-create capability | Unique code; no published default | N |
| POST /programmes/:id/versions | {basedOnVersionId?} | PrivateConfig /201 | Admin | Source same programme | N |
| PATCH /programme-versions/:id | {revision,...PrivateConfig editable fields} | PrivateConfig /200 | Admin | Unpublished; strict nested schema; graph/weights on publish | N |
| POST /programme-versions/:id/publish | {expectedRevision} | PrivateConfig /200 | Programme Publish | Complete validated config; idempotency | N |
| POST /applications/:id/assignments | {expectedRevision,stageRunId,reviewerId,dueAt?} | Assignment /201 | Assignment Admin | Scoped active reviewer; conflict and exact version | N |
| POST /assignments/:id/revoke | {expectedRevision,reason} | Assignment /200 | Assignment Admin | Durable revoke; locks coordinate finalization | N |
| GET /roles | None | {id,label,description}[] /200 | Access administration | Definition not grants | N |
| GET /users | cursor,limit,q | Profile[] /200 | Restricted directory capability | Minimal identity fields | N,L |
| POST /programmes/:id/role-grants | {userId,role,expiresAt?} | {id,userId,programmeId,role,expiresAt} /201 | Delegated grant authority | No privilege escalation; authz revision bump | N |
| DELETE /programmes/:id/role-grants/:grantId | None | 204 | Grant revoke authority | Soft revoke/audit/authz bump | N |
| GET /notifications | cursor,limit,unread? | Notification[] /200 | Recipient | Safe target data only | N,L |
| PATCH /notifications/:id | {read:true} | Notification /200 | Recipient | No recipient/content mass assignment | N |
| GET /reports/summary | programmeId,from?,to? | ReportSummary /200 | Reports | Bounded dates/scopes; no raw ideas | N |
| GET /reports/review-workload | programmeId,from?,to? | {programmeId,generatedAt,assignedCount,completedCount,overdueCount} /200 | Workload capability | Definitions/quorum approved before implementation | N |
| GET /reports/outcomes | programmeId,from?,to? | {programmeId,generatedAt,byOutcome:[{outcome,count}]} /200 | Outcome-report capability | Released/internal audience explicit | N |
| GET /audit-events | cursor,limit,programmeId?,action? | Audit[] /200 | System/scoped audit | Redacted; no automatic idea content | N,L |
| GET /system/summary | None | {generatedAt,serviceState,outboxLagSeconds} /200 | System | No secrets/internal topology or idea content | N |
| POST /reports/exports (deferred) | {programmeId,report,filters} | {jobId} /202 | Separate export permission | Field allowlist; approval/retention pending | N |
| GET /reports/exports/:id (deferred) | None | {id,state,expiresAt,downloadUrl?} /200 | Requester+current scope | Reauthorize download; expiry | N |
| POST /applications/:id/attachments/upload-intents (blocked) | {fileName,mediaType,sizeBytes,checksum} | {attachmentId,uploadUrl,requiredHeaders,expiresAt} /201 | Own+editable | Types/limits/scanning policy approval required | N |
| POST /attachments/:id/complete (blocked) | {checksum} | {id,state} /202 | Own uploader | Actual byte metadata/scan; quarantine | N |
| GET /attachments/:id/download-url (blocked) | None | {url,expiresAt} /200 | Current record/version access | Clean exact version; signed-URL caveat | N |
| DELETE /attachments/:id (blocked) | None | 204 | Own+editable | Cannot delete submitted evidence | N |

## Examples

Draft request: {"revision":0,"fields":{"title":"Working title","theme":"","problem":"","solution":"","impact":"","team":""},"attachmentIds":[]}. Response: {"data":{"applicationId":"uuid","revision":1,"baseVersionNumber":null,"fields":{"title":"Working title","theme":"","problem":"","solution":"","impact":"","team":""},"attachmentIds":[],"updatedAt":"2026-11-09T12:00:00.000Z"}}.

Submit: POST /applications/{id}/submit, Idempotency-Key header and {"expectedRevision":1}; no owner/status/timestamp/client score fields accepted. Detail keeps all six answer names top-level to match existing idea reads. Draft wraps the same names under fields; explicit adapter documented, not frontend renaming.

Error: {"error":{"code":"REVISION_CONFLICT","message":"The record changed. Reload before saving.","requestId":"uuid"}} with409 and no-store. Validation error422 details path fields.title, code too_long, maximum120. Inaccessible IDs return404, no existence confirmation.

## Provider gate and team integration

No register/login/password/reset/OIDC endpoints may be implemented until provider decision. Conditional local request sketches: register{name,email,password}, login{email,password}, reset-request{email}, reset{token,password}; provider-specific policies/outputs intentionally not frozen. Public registration must never accept staff roles. Document selected adapter with OpenAPI/Zod before implementation.

PrivateConfig is design-level and needs full nested OpenAPI schemas before its module begins. No OpenAPI or Zod executable application code is introduced during this documentation phase. HTTP contracts must gain request/response fixture tests before integration. See FIELD_INVENTORY.md for UI controls with no names, DTO conversions and all frontend-owner changes. /api/v1/applications is approved; recommendations are a distinct resource, never overloaded final-decision endpoints.

## Independent application service increment

ApplicationService in src/modules/applications/service.ts now implements create, owner-only read, full draft replacement and submit as repository-backed commands. These methods are internal services and are not mounted HTTP endpoints. The repository transaction contract requires current session validation, row locking, a database clock, unique receipts, immutable submitted snapshots and audit writes in the same transaction. The focused tests use a serialized transactional fixture and prove service behavior; PostgreSQL durability remains pending the reviewed foundation schema and concrete adapter.

Drafts retain title, theme, problem, solution, impact and team. Empty draft fields are allowed; submission requires all six nonempty fields, a configured theme and an open published intake window. Closing time is exclusive. Updates require the current nonnegative revision. Submissions use an actor/application/key receipt and compare expected revision on retry. An identical retry returns the original receipt, including after intake closes. New submissions after SUBMITTED and stale updates return 409. Other owners receive 404.

Persistent grants and programme/application tables remain proposed in DOMAIN_HANDOFF.md. The prior schema-review checkpoint covers shared domain migrations, so this increment supplies tested services and repository interfaces while approval is pending. It makes no claim of database persistence or live role access.

## Implemented persistence candidate

Application Prisma models and additive migration 202611190001_application_foundation are now implemented locally. Application.stage is intake state only (DRAFT/SUBMITTED); B's full workflow will use its separate reviewed history/state design. Initial submission is protected by CHECK version=1 plus unique application_id. Future resubmission must explicitly revise those constraints.

PrismaApplicationRepository supplies current authenticated-session validation, consistent user/session/application locks, owner-filtered reads, compare-and-update revisions, receipt lookup before stage rejection, immutable submission persistence, and nested audit/outbox creation. Construct it with a server-derived Principal and UUID requestId. Internal transaction.requireProgrammePermission checks a live exact programme grant under a shared row lock. Applicant intake requires active identity and ownership; no staff grant. The adapter is not mounted as an HTTP application API yet.

Audit request IDs match the UUIDs generated by canonical createApp. Audit actor is checked against the repository principal. Existing AuthUser scalar fields and authentication relations remain semantically unchanged; only inverse relations were added. Historical migrations remain unchanged.

The SQL uses ordinary checks for row-local invariants, partial uniqueness for unrevoked grants, immutable-record triggers, intake update guards, and DEFERRABLE INITIALLY DEFERRED constraint triggers for cross-table commit consistency. Audit/outbox events are one per application command revision. Future workflow history is separate.

Tests use fresh PostgreSQL 17 clusters only. Runtime-role permissions, TRUNCATE denial, admin grant provisioning, live Cognito and shared environment configuration remain unverified. This candidate has not been approved for shared application. The migration owner can bypass normal protections; production runtime credentials must not own tables or have trigger/DDL/TRUNCATE privileges. Deployment-specific role provisioning requires a separate reviewed operational change.

## Implemented application HTTP contract — 19 November

This section supersedes earlier proposed application paths and unmounted-adapter status.

| Method and path | Input | Success |
|---|---|---|
| POST /api/v1/applications | {programmeId,programmeVersionId} | 201 {data:Application} |
| GET /api/v1/applications/{id} | UUID path | 200 {data:Application} |
| PATCH /api/v1/applications/{id} | {expectedRevision,fields:{title,theme,problem,solution,impact,team}} | 200 {data:Application} |
| POST /api/v1/applications/{id}/submit | {expectedRevision}; Idempotency-Key header | 200 {data:Submission} for first success and identical retry |
| GET /api/v1/applications/{id}/submissions/{versionId} | UUID paths | 200 {data:Submission} |

Application DTO contains id, ownerId, programmeId, programmeVersionId, revision, stage and fields. Submission DTO contains id, applicationId, programmeVersionId, reference, revision, fields and submittedAt (UTC). Schema serialization excludes internal audit, receipt hashes, sessions and grants.

Canonical server mounts these routes with configured Cognito (AUTH_ENABLED=true) or explicit local mode (AUTH_MODE=local, development and loopback only). With auth disabled, routes return 404. Every request verifies the existing cookie-backed session; mutations additionally require exact allowed Origin and X-CSRF-Token from GET /api/v1/auth/csrf. The Prisma transaction rechecks session/user validity under row locks. All mutations use the server-generated request UUID in durable audit records.

Unknown properties, invalid IDs/revisions/keys and DTO errors return 422. Missing or revoked authentication returns 401. CSRF failure returns 403. Hidden and missing resources both return 404. Revision mismatch, intake closure and conflicting idempotency retry return 409. Infrastructure failures return a sanitized 500. Existing body limits and CORS apply. No client owner ID or role is accepted.

Example lifecycle: obtain browser session and CSRF token; create a draft for a published programme version; PATCH the complete fields with revision 0; submit revision 1 with a unique key; retrieve the returned immutable version ID. Retry submit with the same key and revision to receive the original result. Submission survives recreating HTTP app and database connections.

Persistent programme.manage grants are available to trusted transaction consumers. Applicant intake uses identity and owner checks without requiring a staff grant. Programme publication has no HTTP mutation yet. Staff grant provisioning is a separate privileged operational task. Current auth/session roles and grants remain empty pending a reviewed frontend capability projection.


## Implemented service centre

Implemented service endpoints under `/api/v1/service` are documented in [SERVICE_CENTER.md](SERVICE_CENTER.md). See [SERVICE_CENTER_READINESS.md](SERVICE_CENTER_READINESS.md) for verified behavior and outstanding provider and retention requirements. These implemented routes supersede proposed service/reporting sketches below.
