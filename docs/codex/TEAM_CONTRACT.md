# Two-developer team contract — minimize merge conflicts

## Branches
`main`: stable frontend/demo release; `develop`: integration/staging. Each feature uses a fresh short-lived branch from updated `develop` (e.g., `feat/a-auth-foundation`, `feat/b-eligibility-policy`). PRs target `develop`, not `main`. Integrate at least once daily. Do not keep one 6-day branch per developer. Separate personal Codex/GitHub identities and local databases. No direct pushes to protected branches, no force pushes, no automated merges.

## Authoritative file ownership
| Area/file path | Editor | Other developer interface |
|---|---|---|
| `backend/package*.json`, `tsconfig*`, bootstrap `src/app.ts`, `server.ts`, `worker.ts`, CI, Docker | Developer A | B requests additions, A reviews/integrates |
| `backend/prisma/schema.prisma`, `migrations/**`, `seed.ts` | **A only** as merge integrator | B submits model/change request with relation/constraint/test needs |
| `backend/src/shared/**`, `infrastructure/**`, `config/**`, `modules/{auth,users,programmes,applications,attachments,audit}/**` | A | B uses published interfaces |
| `backend/src/modules/{eligibility,workflow,assignments,evaluations,decisions,feedback,notifications,reporting,chat,content}/**` | B | A uses published interfaces; wiring via reviewed integration PR |
| `backend/docs/openapi.yaml` or approved equivalent, shared `contracts/**` | A publishes; B reviews | No unilateral breaking edits; contract change request |
| `backend/tests/**` | Both, non-overlapping fixtures/files | B owns workflow tests; A owns auth/application/security shared tests |
| Root `src/**`, `public/**`, package files, `vite.config.js`, `vercel.json` | **Frontend team** | Neither backend developer edits without separate coordination |
| `docs/codex/**`, `AGENTS.md` | Shared by reviewed PR | Discuss significant process changes |

## Day-1 handoff (freeze before parallel feature work)
- A publishes interface shapes and Prisma IDs for User, scoped grants, Programme/ProgrammeVersion, Application/SubmissionVersion, `AuditEvent`, `OutboxEvent` plus service method signatures.
- B supplies exact requirements for OfficerReview, StageRun/WorkflowEvent, Assignment, ConflictDeclaration, Evaluation/Score, Decision, Feedback, Notification and Reporting.
- A integrates schema/migration in a single PR to `develop`; B waits for merge before Prisma-dependent integration tests. **B can implement pure eligibility/scoring/transition tests with fixtures immediately.**
- Both sign off agreed status keys, API names, audience-specific serializers, errors, idempotency and role grants. No client-controlled ownerId or permission.

## Daily cadence
At start: sync branch, check tree status, agree touched-file list and blockers. Midday: submit small PRs that compile/test. Evening: run integrated happy-path + negative auth tests in `develop`. Keep PRs < ~300 net changed lines when practical; schema/bootstrap PRs can be larger but focus narrowly. Use feature flags/disabled route exports for incomplete features; never leave exposed stubs.

## Avoid collisions
- Do not simultaneously edit root/shared `app.ts`, Prisma schema, shared DTO contract, lockfiles or migration history. Declare required integration edits in PR description; A performs wiring after merging B's self-contained module.
- Do not cherry-pick overlapping migrations between feature branches. Treat applied migration files as immutable.
- Keep external calls outside DB transactions; commit business state, stage event, audit and outbox together.
- Never claim passing tests without running them. Use conventional commits and PR template; human reviews and CI required.

## Unblock procedure
If B is blocked by A's auth/schema: implement a pure service against an agreed interface and fake repository, with unit tests; post a narrowly scoped contract/schema request. If A is blocked by B's workflow: implement the allowed-actions interface returning controlled `NOT_IMPLEMENTED` **only in tests/internal scaffolding**, not publicly as a fake finished endpoint.
