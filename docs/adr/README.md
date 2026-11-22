# Architecture decision records

Detailed records: [001 boundaries](001-boundaries.md), [002 snapshots](002-snapshots.md), [003 access/cache](003-access-cache.md), [004 Prisma gate](004-prisma-gate.md).

2026-11-09 conditional approval. Accepted engineering decisions below do not resolve business policy.

| ADR | Status | Decision / consequence |
|---|---|---|
| 001 | Accepted | Isolated backend package and modular monolith. Never modify frontend-owned files without explicit approval. Worker separated only when required |
| 002 | Accepted, compatibility gate | Node 24 LTS, TS strict, Express, PostgreSQL 17, Prisma 7. Pin tested versions; generated code/migrations under backend; Phase 2 is not production schema |
| 003 | Accepted | Application -> mutable incomplete Draft -> immutable SubmissionVersions. API /api/v1/applications; database submissions; six existing field names preserved |
| 004 | Accepted | Identity-independent Principal, database grants and opaque server sessions, configurable 30m/8h limits. Provider implementation remains blocked |
| 005 | Accepted | No-store confidential HTTP; private client memory scoped by identity/session generation/authz revision; no Redis without evidence |
| 006 | Accepted | Assignment -> StageRun -> exact version; final evaluations immutable; feedback authoring/publication separate; recommendation/final decision/publication separate |
| 007 | Accepted | Transactional revision checks/history/audit/outbox/idempotency; no network calls in transactions |
| 008 | Deferred | Identity provider, attachment implementation, business policies and AWS provisioning require further approval |

Context, alternatives and risks: separate services/distributed caches add operations before measured need; storing only mutable submissions loses evidence; browser-selected roles cannot enforce access; tokens in localStorage increase credential exposure. Provider abstraction preserves SSO flexibility. Cost: relational constraints and immutable-version migrations need explicit SQL review; client memory cannot undisclose already delivered data. See linked architecture, data, workflow, performance and decisions documents for verification criteria.
