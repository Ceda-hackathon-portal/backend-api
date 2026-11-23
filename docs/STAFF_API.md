# Staff workflow API

Implemented 22 November 2026. Where older documents here say staff sign-in, assignment, screening or staff lists are "not mounted" or "not implemented", this document is newer.

No schema change was needed. The routes drive the existing eligibility, assignment, workflow, evaluation and decision services.

## Roles

A role is derived from live programme grants. It is never stored on the account or accepted from a client.

| Role | Identifying grant | Other grants it needs |
| --- | --- | --- |
| `administrator` (programme manager) | `decision.publish` | `assignment.manage`, `eligibility.screen`, `eligibility.read-submission` |
| `eligibility-officer` | `eligibility.verify` | `assignment.manage`, `eligibility.read-submission` |
| `evaluator` | `evaluation.write` | `evaluation.submit`, `eligibility.read-submission` |
| `adjudicator` | `adjudication.decide` | `adjudication.read`, `eligibility.read-submission` |

A session holds one account. Every `/staff` route except `/me` returns 403 to an account without staff grants.

## Routes (under `/api/v1`)

All writes need the session cookie, an allowed Origin and `X-CSRF-Token`. A token lasts ten minutes and belongs to the session that requested it, so fetch a new one after sign-in.

| Method and path | Body | Who |
| --- | --- | --- |
| `GET /programmes` | | Anyone: open programmes, newest first, with rule ids |
| `GET /progress/:applicationId` | | The applicant: stage, confirmed eligibility, released outcome |
| `GET /staff/me` | | Any session: `{ role }`, null for an applicant |
| `GET /staff/applications` | | Managers see the programme's submissions, others their assignments |
| `GET /staff/applications/:id` | | Same scope, shaped for the caller |
| `GET /staff/applications/:id/documents/:documentId` | | A cleared assignee |
| `POST /staff/applications/:id/assignments` | `{ userId }` | `assignment.manage` |
| `POST /staff/applications/:id/assignments/:assignmentId/revoke` | `{ reason }` | `assignment.manage` |
| `POST /staff/applications/:id/declaration` | `{ hasConflict }` | The assignee |
| `POST /staff/applications/:id/declarations/:disclosureId/confirm` | `{}` | `assignment.manage`, never the person who declared |
| `POST /staff/applications/:id/eligibility` | `{ outcome, reason }` | The cleared officer. `outcome` is `ELIGIBLE` or `NOT_ELIGIBLE` |
| `POST /staff/applications/:id/send-to-review` | `{}` | The cleared officer |
| `POST /staff/applications/:id/start-evaluation` | `{}` | A cleared reviewer |

These existing routes complete the workflow. Each needs an `Idempotency-Key`:

- `PUT /assignments/:assignmentId/evaluation`
- `POST /applications/:id/workflow/lock-scores`
- `POST /applications/:id/workflow/open-adjudication`
- `POST /applications/:id/decisions`
- `POST /decisions/:decisionId/publish`

## Order of work

1. The applicant submits. Screening records findings against the published rules and decides nothing.
2. The manager assigns an officer. The officer declares, the manager confirms, and the idea opens.
3. The officer confirms eligibility. `NOT_ELIGIBLE` ends the process and its reason goes to the applicant.
4. Reviewers (two by default) are assigned and cleared. The officer sends the application to review.
5. Each reviewer scores alone. Closing scoring needs every assigned review to be final.
6. A cleared adjudicator, who was not a reviewer, opens adjudication and records the decision.
7. The manager, cleared by someone else and not the adjudicator, releases the outcome and feedback.

## Who sees what

- Nobody assigned sees content, and non-managers see no title, until their declaration is confirmed.
- Reviewers and adjudicators get no applicant, company, team or contact fields, and only proposal and supporting documents. The documents themselves are not redacted.
- Marks reach the adjudicator after scoring locks. Managers see progress only.
- Applicants get released feedback and a final not-eligible reason, never internal notes.

## Deployment requirements

- Re-run the grant in `ops/runtime-role.sql` on existing databases: `GRANT SELECT, INSERT ON officer_reviews TO ceda_runtime`.
- Apply `ops/assignment-provisioner-role.sql`, create a separate login in that role and set `ASSIGNMENT_DATABASE_URL`. Never grant that role to the `DATABASE_URL` login. Without it, assignment commands return 503.
- Publish a programme version with `reviewPolicy` and `decisionPolicy`, an eligibility rule version, and staff grants. For development, `scripts/provision-local.mjs` does all of this with fictional data. `AUTH_LOCAL_ACCOUNTS_FILE` then points at the accounts file it writes.
- Hosted staff identities and grant provisioning are not implemented.

## Known limits

- No correction or resubmission loop. `submission_versions` permits version 1 only.
- No removal of an uploaded draft document.
- No programme editing, management reporting or system-administration API.
- Applicant documents use local private storage and are not malware scanned.
- The applicant front end sends evidence for the `botswana-citizen` rule only. Other rules will screen as unknown until it does.
