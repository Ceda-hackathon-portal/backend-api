# Phase 2 compatibility results

Historical Phase 2 record: owner subsequently authorized commit103fa6f and Phase3 foundation. See FOUNDATION.md for current implementation status; original compatibility evidence below is unchanged.

Observed 2026-11-09 on Windows x64. PASS for the tested local combination, not production readiness or proof of deployment compatibility.

## Exact environment

- Branch feature/backend; clean at entry; backend/AGENTS.md already tracked and unchanged.
- Host Node26.13.0 used only for npm bootstrap; npm11.20.0 through npm.cmd because PowerShell blocks npm.ps1.
- Actual spike execution: portable Node24.22.2, TypeScript5.9.3 strict NodeNext/ESM.
- prisma / @prisma/client / @prisma/adapter-pg 7.10.1; pg8.23.1.
- PostgreSQL17.11 x86_64-windows, compiler msvc19.44.35228. Portable test package @embedded-postgres/windows-x6417.11.0-beta.19; beta suffix belongs to third-party packaging, not a recommendation for production.
- All package dependencies/lockfile in backend/spikes/prisma7. npm cache backend/.npm-cache. Generated output, compiled JS and disposable clusters ignored under backend.

## Observed checks

| Check | Result |
|---|---|
| Actual Node24 invocation | PASS v24.22.2 |
| Prisma schema validation | PASS |
| ESM prisma-client generator | PASS7.10.1 |
| Fresh PostgreSQL17 migration deploy | PASS two migrations |
| Repeated migration deploy | PASS no pending migrations |
| Migration status | PASS up to date |
| Strict TypeScript compilation | PASS no diagnostics |
| Compiled ESM runtime via PrismaPg | PASS |
| Nullable field / UUID / timestamptz | PASS |
| Decimal precision / JSON / Unicode | PASS |
| Duplicate version unique constraint | PASS rejected P2002 |
| Invalid-parent foreign key | PASS rejected P2003 |
| Transaction rollback | PASS original value preserved |
| Concurrent expected-revision update | PASS exactly one winner |
| SQL immutable snapshot trigger | PASS update/delete rejected; original remains |
| SQL positive-number check | PASS invalid number rejected |
| Process cleanup | PASS pg_ctl reported server stopped; verify no postmaster.pid |

Final runtime output: `RESULT 8 compatibility checks passed; runtime v24.22.2`. Migrations, generation and compile are additional CLI stages rather than part of the eight runtime checks. No API latency/load tests were run or implied.

## Failures and corrections

Initial npm registry access failed EACCES in sandbox; approved network escalation used. First download attempt timed out; retry with bounded parallel downloads succeeded. npm warned three package install scripts were withheld; required native/schema-engine binaries were present and the successful run used them. No global npm configuration or execution policy was changed.

First sandbox cluster initialization reported Windows restricted-token errors; local database execution was retried with approval outside sandbox. Initial readiness also assumed pg_isready.exe existed, but this minimal binary bundle does not include it. Runner now makes a bounded SQL SELECT1 connection probe. Earlier timed-out runs invoked pg_ctl and stopped their clusters. Final run completed and stopped successfully. Native child processes use windowsHide and do not install a Windows service.

## Limits and remaining risks

- No Linux image/runtime/client generation, real RDS certificate validation, production proxy/pooling, failover/backup, or load/latency verification. These remain explicit gates; do not infer support from Windows alone.
- Full CEDA composite-scope FKs, immutable privileges and production migration graph are NOT tested by generic fixtures. They require real-schema integration tests when authorized.
- No provider login/session implementation, HTTP server, application services, attachments or AWS infrastructure.
- Portable trust-authenticated loopback database contains fictional fixtures only. Never copy that auth policy to development shared databases or production.
- No destructive cleanup: ignored UUID-named data retained for inspection; database stopped. Delete only after checking exact resolved directory is inside the spike workspace.
- Dependencies are spike-only dev dependencies. A later production package needs security/engine review and its own lockfile; don't promote the experimental dependency tree unchanged.

Sources consulted: https://www.prisma.io/docs/orm/v7 and https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-pool ; portable binary metadata in the locked package; https://github.com/leinelissen/embedded-postgres .

## Handoff

Phase 1 documentation and Phase 2 Windows compatibility spike completed. Stop here. Phase 3 foundation plan is PHASE3_PLAN.md and requires explicit approval. Identity provider, CEDA policy, attachment policy and AWS approvals remain separate gates. No commit/push/merge authorized; all deliverables remain uncommitted.
