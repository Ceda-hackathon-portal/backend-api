# Service centre API and operational handoff

All endpoints live under `/api/v1/service`. Cookie sessions, CSRF on mutations, live
programme grants and record ownership are enforced on the server. This work does not
replace the concurrent account/CMS implementation. Apply the additive migration, then
`ops/service-center-role.sql` as the migration owner for an existing runtime role.
Service tables and relations are represented in the Prisma schema. Critical queue/claim
operations use parameterized SQL for row locking. Preserve partial indexes, SQL check
constraints and the append-only audit trigger in future generated migrations.

## Permissions

`support.manage`: consultant inbox, claims, internal notes, replies and support metrics.
`report.read`: aggregate programme reports. `audit.read`: scoped activity history.
Existing `decision.publish` holders may use these programme operations. An assignment
to a support conversation grants no application/document access. Account provisioning
belongs to the separate authentication/access workstream.

## Endpoints

- GET `/availability`: office/busy/offline state, configured email and call-relay flags.
- GET `/capabilities`, `/programmes`: current service scopes and programme selectors.
- GET `/insights?from=YYYY-MM-DD&to=YYYY-MM-DD&programmeId=UUID`: inclusive UTC calendar
  range, at most 366 days; participation by day, workflow state, released outcomes,
  submission-to-publication elapsed days and consultant response/resolution time.
  No unpublished decisions or individual application answers are exported.
- GET `/audit?action=substring&before=ISO&offset=0`: at most 50 rows, `hasMore`.
  A fixed before timestamp prevents new inserts shifting pagination.
- POST `/agent` `{available:boolean}`: heartbeat every 15 seconds, expires after 45.
  Capacity defaults to four concurrent conversations per consultant.
- GET/POST `/conversations`: list bounded to 100 most recently updated authorised
  conversations; create `{clientId:UUID,programmeId,applicationId?,subject}`. A linked
  application must belong to the applicant and the same programme. GET supports
  `paged=1&offset=0&status=OPEN|RESOLVED|ALL&q=term`; paged output is `{items,hasMore}`.
  Existing calls without `paged=1` retain their array response. Search is server-side
  across the authorised queue, including conversations beyond the first page.
- GET `/conversations/:id?beforeId=UUID`: newest 200 visible messages,
  `hasMoreMessages` and latest call. The composite database timestamp/ID cursor avoids
  losing messages with identical timestamps. `before=ISO` remains supported.
- POST `/conversations/:id/messages`: `{clientId:UUID,body,internal?:boolean}`.
  Retry with the same UUID/body; changed body under that key returns 409. Applicants
  never receive internal notes. Public consultant replies only during office hours.
- POST `/conversations/:id/read`, `/claim`: `{}`. Claims serialize against capacity.
- POST `/conversations/:id/status`: `{status:OPEN|RESOLVED}`.
- POST `/conversations/:id/calls`: `{clientId:UUID}`; one active call per conversation.
- GET `/calls/:id?after=sequence`: participant-only state, bounded signals and temporary
  TURN REST credentials. POST `/state`: ACCEPTED/DECLINED (callee), ENDED (either).
  POST `/signals`: `{clientId,kind:offer|answer|candidate,payload}` after acceptance.
  No audio is recorded. Microphone access requires HTTPS or localhost.
- GET/PUT `/preferences`: `{inApp:boolean,email:boolean,consent:boolean}`; notice version
  and consent time persist. Email opt-in returns 503 until its provider is configured.
- GET `/notifications`; POST `/notifications/:id/read`: applicant-only inbox.
- GET/POST `/privacy/requests`: POST `{kind:EXPORT|DELETE}`. Repeated pending requests
  are deduplicated. Review/fulfilment requires the privacy owner; a request is not deletion.

Validation failures: 422; missing/unauthorised conversation/call: 404; no workspace
permission: 403; stale/closed/busy/retry conflict: 409; expired session: 401;
unavailable configured service: 503. Error envelopes include request IDs.

## Delivery and scanning

Worker derives notices from persisted submissions, public workflow states and published
outcomes. In-app notices are account-backed. Email uses an HTTPS Resend-compatible API,
stable provider idempotency keys, bounded retries/backoff and FAILED state. Provider
acceptance is not proof of recipient inbox delivery. No SMS provider is implemented.
TURN_URL/TURN_SECRET configure Coturn REST credentials. No relay means remote calling
reliability is unverified. Configure authorised network/private ClamD and fresh signatures;
production fails closed without a scanner. Development without a scanner is not a clean
antivirus result. Existing downloads are rescanned when scanning is enabled.

## Retention and unresolved operational ownership

Signalling is purged after one day. Database audit remains append-only. No destructive
purge of submitted applications or identities is enabled without an approved retention
schedule and legal-hold procedure. CEDA must approve the privacy notice, hosting fault
contact/turnaround targets, holiday calendar, service providers and deployment region.
The UI distinguishes requests, queueing, provider acceptance and actual delivery.

## Windows antivirus adapter

`UPLOAD_SCANNER=defender` uses the existing Windows Defender custom-scan command on
private temporary upload bytes with `-DisableRemediation`. It changes no security settings
and invokes no shell. A nonzero exit, missing file or content change refuses the upload;
code 2 is deliberately not described as a confirmed infection because it also means a scan
error. Linux deployments use private ClamD. Never configure an unprivileged API to depend
on a scanner command it cannot run: check under the actual runtime account.
Source: https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus

## Purpose-specific consent and data copies

POST `/privacy/consent` `{version:"2026-11-23",accepted:true}` records the application
processing declaration. The application submit endpoint requires it in the connected
server. Alert preference consent has its own version/time. Disabling both alert channels
never requires renewed consent and does not erase a prior application declaration.
GET `/privacy/export` returns the account holder’s data copy without staff-only notes or
private decisions. A pending EXPORT request is completed by preparing this copy. A DELETE
request remains pending review; no submitted data is erased without a retention decision.

Windows development defaults to the existing Defender adapter when ClamD is not configured.
The real local service returned a clean verdict for benign test bytes during verification.
This is not evidence of Linux deployment, malware-corpus testing or an approved retention policy.

An offline consultant’s conversation can be taken over by another authorised consultant with a required reason. The reason is an internal immutable message, reassignment is audited, capacity is rechecked, and any old call is ended. Online consultants cannot have their active conversation silently taken away.


## Parallel account/CMS integration
Keep service routes mounted after authentication and before the catch-all decision router.
Expose `support.manage`, `report.read` and `audit.read` in the account/grant provisioning
work. Existing programme `decision.publish` holders retain compatibility. Application
navigation is derived from actual application permissions; consultant-only roles use
`/admin/support`. The new opaque sessions/CSRF paths reuse the established auth contract.
Apply both service migrations, including `20261123130000_contact_consent`, and preserve
the other agent's account/CMS migration. Do not publish development account files.

Operational/provider documentation consulted:
- https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling
- https://github.com/coturn/coturn/wiki/turnserver
- https://resend.com/docs/api-reference/emails/send-email
- https://docs.clamav.net/manual/Usage/Scanning.html
- https://gov.bw/public-holidays
- https://www.ceda.co.bw/index.php/help-center
- https://www.burs.org.bw/index.php/contact-burs-offices
- https://www.nbfira.org.bw/contact-us/
- https://www.wipo.int/en/web/country-profiles/contact?code=bw
