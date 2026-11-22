# Six-day delivery schedule (17–22 November 2026)

**CEDA submission:** 23 November 2026, 17:00 CAT per provided notice. Daily gates are goals, not completed work. Team has two backend developers; frontend team works separately.

| Day | Developer A (foundation/application) | Developer B (workflow/evaluation) | Acceptance gate |
|---|---|---|---|
| **Tue 17 Nov** | Live repo audit; agree stack; backend skeleton plan; package + TypeScript/Zod env/health; schema foundation after approval; API conventions | Audit and enumerate workflow states; roles/permissions; eligibility/evaluation/schema contract requests; pure scoring/state-machine tests | Contracts frozen; first small scaffold PR reviewed; backend starts locally if authorized |
| **Wed 18 Nov** | Auth/register/login/session/recovery core; programme read/config; draft CRUD and submit command; owner denial tests | Pure eligibility engine, officer evidence review service, correction rules; first DB-backed workflows after A schema merge | Applicant can submit and get reference; officer can screen without automatic adverse decision |
| **Thu 19 Nov** | Scoped grants, secure application/version reads, audit+outbox implementation, storage metadata/adapter | Stage history, assignment/recusal, assigned-only queries, scorecard persistence, locking and conflict tests | Two independent reviewers can score only their own assigned records |
| **Fri 20 Nov** | Harden auth, idempotency, API contracts; schema/migration changes for remaining B models; request/response tests; staging preparation | Adjudication, release reasons, feedback, revision command boundaries, notification outbox consumers; P1 reports | End-to-end API journey from applicant to released feedback passes tests; check CEDA clarification outcomes |
| **Sat 21 Nov** | CI, clean migration replay, security denial tests, staging deploy with approval, operational and log checks | End-to-end workflow tests, duplicate commands, concurrency, notification failure/retry, report totals; minimum FAQ/chat if P0 green | No P0 critical defects; staging API works with seeded fictional records |
| **Sun 22 Nov** | Freeze and tag release candidate; OpenAPI, runbook, environment/host disclosure, restore procedure, PR review | Rehearse evaluator/adjudicator demo; document workflow/limitations; complete report/test fixtures | Frontend team can exercise stable documented backend APIs; run final demo rehearsal |

**23 Nov:** submission-day smoke test, no new architecture; submit before 17:00 CAT. If P0 is late on 20 Nov, cut optional chat, AI, advanced search, SMS, elaborate infrastructure before compromising security or core workflow.

## Daily shared practices
- Start: review open PRs and current `develop` contracts, declare touched files.
- Midday: integrate one small tested slice each.
- End: run an integrated actor-by-actor smoke test and record blockers.
- Share contract changes within the team as a PR comment before implementation, not as an undocumented surprise.

## Minimum demo story
`submitter` creates draft/submits -> officer screens -> manager assigns evaluator A/B -> conflict gate -> score locked -> adjudicator decides -> manager releases -> applicant views feedback -> management sees safe aggregates -> authorized audit record.
