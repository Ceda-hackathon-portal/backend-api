# Integration & PR checklist — CEDA backend

## Before starting each branch
- [ ] Latest `develop` fetched, clean worktree and correct branch.
- [ ] Small scoped task assigned with owner and touched-file list.
- [ ] Contracts/Prisma schema that task depends on are already merged, or a mock interface is explicitly agreed.
- [ ] Local PostgreSQL database is unique to this developer; no one shares dev/test DB credentials.

## Before PR into `develop`
- [ ] Files changed match ownership matrix; frontend assets/root package untouched.
- [ ] Schema change drafted by B was integrated by A, not duplicated.
- [ ] Types compile, backend builds, relevant tests passed; list exact commands in PR.
- [ ] Negative authorization tests cover missing permission, cross-owner, cross-programme, unassigned, conflicted, revoked and score-before-closure.
- [ ] State transitions, audit, outbox and business writes are atomic where required.
- [ ] No hidden API changes: OpenAPI updated, example requests/responses included.
- [ ] No secret committed or confidential data logged; temporary data fictional.
- [ ] Human reviewer approval; CI checks green; no auto-merge/push unless approved.

## Daily integrated journey
- [ ] New applicant registration/login with no self-assigned privileged role.
- [ ] Complete programme configuration and draft submission yields a unique reference; duplicate `Idempotency-Key` does not produce duplicate records.
- [ ] Applicant B cannot read Applicant A's application, files, history or released feedback.
- [ ] Eligibility `UNKNOWN` is flagged for review instead of rejected by unavailable data.
- [ ] Reviewer can see only assigned exact submission version; conflict blocks view/score.
- [ ] Evaluator scores privately; before scoring closes, peer scores are hidden; submitted scores locked.
- [ ] Decision requires authorized actor/reason; publication requires proper release authority.
- [ ] Applicant sees only published feedback; management receives safe aggregate metrics.
- [ ] Audit includes actor/time/reason, and notification failures don't roll back committed decisions.
- [ ] Real PostgreSQL integration path and clean migration replay pass.

## Release gate
No high severity auth/privacy defects; secure cookie settings; redacted logs; health/readiness; known hosting region; seeded sample data; clear 'prototype' limitations; runbook and reproducible deploy instructions; smoke test after staging deploy.
