# Proposed API contract v0 — review together on Day 1

This is a coordination proposal, not implemented endpoints or CEDA-approved policy. Base URL `/api/v1`. Finalize in checked-in OpenAPI once A's backend skeleton exists. Frontend current JS/JSX pages can mock these DTOs without changing UI source prematurely.

## Conventions
- Success `{ "data": ... }`; collections `{ "data": [...], "page": { "nextCursor": null } }`; error `{ "error": { "code": "FORBIDDEN", "message": "...", "requestId": "...", "details": [] } }`.
- 401 unauthenticated; 403 forbidden capability; 404 unavailable/hidden object; 409 state or optimistic revision conflict; 422 invalid input; 429 rate limited.
- RFC3339 UTC timestamps; programme timezone stored separately. UUID internal IDs; human-readable submission reference separate. Authentication via server-managed cookie and CSRF header for cookie-authenticated mutations, subject to same-origin deployment decision. Browser clients send credentials only to allowed origin.
- Public data, applicant detail, evaluator-assigned detail, adjudicator detail and management aggregates use separate response serializers. Never expose unsubmitted idea details, raw score sheets or private comments via universal serialization.
- `Idempotency-Key` required for submit and outcome publication; compare actor, operation and request hash. Version checks (`expectedRevision`) prevent stale writes.

## Initial submission fields (actual existing frontend keys)
`{ "title": "...", "theme": "digital", "problem": "...", "solution": "...", "impact": "...", "team": "..." }` with existing UI max lengths: 120, theme from published config, 3000, 5000, 3000, 150. `theme` is a category under a programme, not the programme itself. Server should store `programmeId` and pin published `programmeVersionId`. Frontend's demo-only checkbox is **not** live consent.

## Proposed endpoints and owner
| Endpoint | Owner | Authorization/notes |
|---|---|---|
| `POST /auth/register`, `/auth/login`, `/auth/logout`; `GET /auth/session`; `POST /auth/password-reset-requests`, `/auth/password-resets` | A | Applicant signup only; no role choosing |
| `GET /programmes`, `GET /programmes/{id}/configuration` | A | Published public view; no secret settings |
| `POST /programmes`; `POST /programme-versions/{id}/publish` | A | Scoped programme manager, two-person approval as roadmap if feasible |
| `POST /applications`; `GET /applications`; `GET /applications/{id}` | A | Owner list/detail; server-derived owner |
| `GET/PUT /applications/{id}/draft`; `POST /applications/{id}/submit` | A | Own draft; validation, expected revision, idempotency, receipt |
| `GET /applications/{id}/versions`, `/applications/{id}/events` | A/B | A publishes owner-safe reads, B writes workflow events; agree interface |
| `POST /eligibility/screen`; `POST /applications/{id}/officer-reviews` | B | Rules version, human evidence confirmation; screening not final judgment |
| `GET /applications/{id}/allowed-actions`; `POST /applications/{id}/transitions` | B | Scoped finite-state machine, actor/reason/audit |
| `POST /applications/{id}/assignments`, `GET /assignments`, `POST /assignments/{id}/conflict-declarations` | B | Programme assignment access; conflicts block idea access |
| `GET/PUT /assignments/{id}/evaluation`, `POST /assignments/{id}/evaluation/submit` | B | Bound to submission version, own scores only; lock on submit |
| `POST /applications/{id}/decisions`; `POST /decisions/{id}/publish` | B | Authorization/separation of duties, rationale, audit |
| `POST /applications/{id}/revision-requests`; `POST /applications/{id}/resubmit` | B/A | B authorizes request; A creates immutable version; agree command boundary |
| `GET /applications/{id}/feedback`; `POST /feedback/{id}/publish` | B | Owner sees released feedback only |
| `GET /notifications`; `PATCH /notifications/{id}` | B | Own notifications; no idea contents in messages |
| `GET /reports/summary`, `/reports/outcomes`, `/reports/review-workload` | B | Aggregate only; access-scoped, avoid small-cell leaks |
| `GET /audit-events`, `GET /system/summary` | A | Audited privileged access; ops not automatically idea access |
| `/faq` and `/chat/**` | B | P1 minimal; staffing-hours and queue/availability semantics |

## Role mappings
Frontend: `submitter`, `evaluator`, `adjudicator`, `administrator`, `management`, `system-administrator`. Keep these in demo adapters; secure server grants can be named capabilities with programme/record scopes. Eligibility officer is a capability/assignment, not an assumed frontend role until agreed. Staff roles must be invited/granted, never chosen by an applicant.

## Workflows must be agreed, not hardcoded from sample UI
Sample visible labels `Submitted`, `Under review`, `Feedback`, `Approved`, `Award` are **illustrative**. Backend uses a versioned internal state graph with guards; `StageRun` tracks repeated rounds. Scores/criteria are configured by programme; four demo criteria in `src/data/portal.js` lack weights and do not determine backend scoring policy.

## Example accepted application response (proposed)
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000123",
    "referenceNumber": "CEDA-2026-000123",
    "programmeId": "00000000-0000-4000-8000-000000000001",
    "title": "Rural enterprise toolkit",
    "status": "UNDER_ELIGIBILITY_REVIEW",
    "revision": 2,
    "submittedAt": "2026-11-18T10:30:00Z"
  }
}
```
