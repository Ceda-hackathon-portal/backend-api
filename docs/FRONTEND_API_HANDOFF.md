# Implemented frontend integration — 19 November 2026

This handoff preserves the applicant contracts established at `9dd3804` and adds the opt-in officer adapter based on canonical `develop` at `6bbd7b6`. Use `openapi.yaml` and the **Implemented application HTTP contract** at the end of `API_CONTRACT.md`; earlier catalogue rows are proposals. No frontend files are changed by this backend work.

## Base URL and browser requirements

Configure an environment-specific API origin in the frontend build, for example `VITE_API_BASE_URL=https://api.staging.example.org`. This variable is a frontend convention to implement, not an existing connection in the current demo. Append `/api/v1` once. Never put Cognito client secrets, database URLs or encryption keys in `VITE_*` variables.

For staging use HTTPS and same-site custom domains, such as `https://portal.staging.example.org` and `https://api.staging.example.org`. The backend's Secure, HttpOnly, SameSite=Lax cookies cannot support an unrelated `vercel.app` frontend origin. Locally use the same hostname on both ports, not a mixture of localhost and 127.0.0.1. Configure both exact origins in `ALLOWED_ORIGINS`, and set `AUTH_API_ORIGIN` / `AUTH_FRONTEND_ORIGIN` to their respective origins without paths. CORS is not authentication.

Every browser API fetch needs `credentials: 'include'`. Do not read the session cookie or store access tokens in localStorage. Private responses are not cacheable. The existing frontend uses demo localStorage and role toggles; wiring this handoff is frontend-owned work, not completed integration.

## Authentication

1. `GET /api/v1/auth/csrf` with credentials returns `{data:{csrfToken:string}}` and binds CSRF state to cookies.
2. `POST /api/v1/auth/login` with credentials, JSON `{}` and `X-CSRF-Token` returns `{data:{authorizationUrl:string}}`. Navigate the browser to that URL. The browser supplies Origin; do not attempt to forge it.
3. Cognito redirects to the exact registered API `/api/v1/auth/callback`. The backend validates OIDC state, nonce and PKCE, creates a persistent session and redirects to the configured frontend `/workspace`. Do not implement a frontend token-exchange endpoint.
4. Restore state using `GET /api/v1/auth/session`. Success is `{data:{user:{id,name,email,roles:[],role:null},grants:[],expiresAt:ISO}}`. A 401 means signed out. Roles and grants are currently empty projections; never turn a local role toggle into staff authority. The current frontend's `submitter` route guard needs an explicit frontend adaptation for authenticated applicants.
5. Refresh the CSRF token after login before mutations. `POST /api/v1/auth/logout` with credentials and CSRF returns 204 after server-side revocation and cookie clearing. Clear frontend private state after success. Do not treat a network failure as verified server logout.

Registration and password recovery belong to the approved Cognito hosted flow. There are no backend password, registration, refresh-token or staff-provisioning REST endpoints. Live Cognito browser configuration remains environment-dependent; synthetic provider tests do not prove a real staging login.

## Applicant operations

All paths below are under `/api/v1`. The server derives the applicant from the live session. Never send ownerId, roles or grant claims. Every mutation requires CSRF and an allowed browser Origin.

| Method/path | JSON request | Success |
|---|---|---|
| POST `/applications` | `{programmeId:UUID,programmeVersionId:UUID}` | 201 `{data:Application}` |
| GET `/applications/:id` | None | 200 `{data:Application}` |
| PATCH `/applications/:id` | `{expectedRevision:number,fields:Fields}` | 200 `{data:Application}` |
| POST `/applications/:id/submit` | `{expectedRevision:number}` plus `Idempotency-Key` | 200 `{data:Submission}` |
| GET `/applications/:id/submissions/:versionId` | None | 200 `{data:Submission}` |

`Fields` contains all six strings: title (120), theme (100), problem (3000), solution (5000), impact (3000), team (150). Bounds are JavaScript string lengths. PATCH replaces the complete fields object; it is not a partial-field patch. Unknown keys are rejected. Draft strings may be empty. Submit requires all six trimmed strings to be nonempty, a theme allowed by the pinned published programme version, and an open intake window (closing time exclusive).

`Application = {id,ownerId,programmeId,programmeVersionId,revision,stage,fields}`. IDs are UUIDs; stage is `DRAFT` or `SUBMITTED`, representing applicant intake rather than the full review workflow. Revision starts at 0. Use the returned revision for the next command; stale writes return 409. Expected revision is an integer from 0 through 2147483646.

`Submission = {id,applicationId,programmeVersionId,reference,revision,fields,submittedAt}`. `id` is the immutable submission-version UUID used as `versionId` in the retrieval URL. `submittedAt` is UTC ISO text. The current database permits exactly one initial version-1 submission; resubmission is not implemented. The response excludes session data, receipt hashes, audit records and staff findings.

For submit, generate a unique key (for example `crypto.randomUUID()`), retain it together with application ID and expected revision until the outcome is known, and reuse that exact command on transport failure. Keys accept 1–128 ASCII letters, digits, `_` or `-`. Identical retries return the original result with 200, including after intake closes; conflicting reuse returns 409. Do not generate a new key for each automatic retry. Draft creation has no idempotency guarantee; an uncertain create response needs reconciliation rather than blind retry. There is currently no application-list API.

The programme/version IDs and allowed themes must come from approved published configuration supplied by the backend team. No programme browsing, publication or grant-provisioning endpoint is mounted yet. A staging operator must provision the reviewed demonstration configuration before the applicant lifecycle can be demonstrated.

## Minimal browser adapter example

```js
const origin = import.meta.env.VITE_API_BASE_URL;
async function api(path, { method = 'GET', body, csrfToken, idempotencyKey } = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined;
  const payload = await response.json();
  if (!response.ok) {
    const failure = new Error(payload.error?.message ?? 'Request failed');
    failure.status = response.status;
    failure.code = payload.error?.code;
    failure.requestId = payload.error?.requestId;
    throw failure;
  }
  return payload.data;
}
const { csrfToken } = await api('/auth/csrf');
const draft = await api('/applications', {
  method: 'POST', csrfToken,
  body: { programmeId: approvedProgrammeId, programmeVersionId: approvedVersionId },
});
// Save all six fields using draft.revision. Submit the returned revision with
// one retained idempotency key, then retrieve submissions/:returnedSubmissionId.
```

## Errors and unavailable APIs

Errors use `{error:{code,message,requestId}}`, with safe validation details where provided. Show the message and retain requestId for support; do not log private answers, cookies or authorization URLs. 401 requires sign-in; 403 indicates CSRF/origin or authorization failure; 404 conceals missing and other applicants' records; 409 requires state/revision reconciliation; 422 indicates invalid IDs, fields or command input; oversized JSON returns 413. Infrastructure errors return sanitized 500. Never convert a failed save into a success toast or overwrite a newer revision automatically.

Authentication-disabled deployments fail closed: auth/application routes are unmounted and return 404. `/health/live` and `/health/ready` are operational probes, not authentication or migration-status checks.

Eligibility screening, workflow transitions, evaluator assignments, scoring, adjudication, released feedback, attachments, notifications and application lists are **not implemented public APIs**. Do not integrate against proposal routes or infer officer authorization from a frontend role selector.

## Opt-in officer submission read — 20 November 2026

`GET /api/v1/officer/submissions/:submissionVersionId` is implemented behind server-only `OFFICER_READ_API_ENABLED=false`. Only literal `true` and `false` are accepted. Both authentication and this flag must be enabled for registration; otherwise the route returns 404. This is not a frontend feature toggle or an authorization claim.

After explicit environment enablement, use the same configured API origin and `credentials: 'include'`. The path is a UUID. No body, owner/role/assignment claims or mutation CSRF token are needed for this read-only GET. Existing CORS and secure-cookie rules remain unchanged. Mutations elsewhere still require CSRF.

Success is `{data:{submissionVersionId,applicationId,programmeId,programmeVersionId,submissionVersionNumber:1,reference,submittedAt,submissionFields:{title,theme,problem,solution,impact}}}`. The response is strictly validated and no-store. Team text, arbitrary JSON, sessions, findings and scores are excluded. Use the returned immutable version ID; a programme grant alone does not grant access.

401 means no valid current session; 403 means an origin failure; 404 conceals missing, unassigned, revoked, expired, conflicted, ambiguous, cross-programme or self-review records; 422 means a malformed UUID; 500 is sanitized. Do not distinguish missing from denied records in the UI. Error envelopes and server-generated request IDs follow the existing conventions.

Before enabling in a shared environment, separately approve migrations/role provisioning and operational conflict-resolution authority. The runtime needs its reviewed SELECT-only assignment/conflict privileges. Assignment-manager credentials must never enter the applicant-facing server. An assignment needs controlled issuer metadata, an active programme grant, exact submission binding and recorded conflict clearance; missing clearance denies access. No assignment-management or conflict-resolution API is mounted. This GET neither records officer verification nor advances workflow state.

## Joint staging acceptance

After explicit AWS/database authorization, verify a real browser login, session restoration, CSRF denial, create/save/submit/retrieve, identical retry, cross-user denial, logout/revocation and restart persistence against the same staging URL. Backend automated HTTP/database tests pass independently; real Cognito, DNS/TLS and deployed frontend integration are not yet verified.
