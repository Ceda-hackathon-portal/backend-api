# Application migration verification

Candidate SQL: prisma/migrations/202611190001_application_foundation/migration.sql.
Scope: eight new domain tables, generated FK/index definitions and reviewed intake/immutability/deferred consistency protections. No historical migration changed.

Validation commands from backend with Node 24.22.2:
- npm.cmd run db:validate — passed.
- npm.cmd run typecheck — passed.
- npm.cmd test — 20 passed, zero failed/skipped; includes production build.
- npm.cmd run test:smoke — 2 passed, zero failed/skipped.
- .spikesprisma7
ode_modules
ode-win-x64in
ode.exe tests/run-database.mjs — final fresh cluster replay and four integration suites passed, zero failed/skipped. Runner deploys twice and checks migration status before testing, then stops the cluster.

Application DB assertions cover own draft reads, other-owner denial, programme mismatch, invalid submit, stale revision, identical concurrent retry, different retry key, immutable snapshot/configuration, audit UUID/actor/outbox correlation, audit failure rollback, outbox failure rollback, grant scope/absence/revocation/duplicate protection, missing commit events, forbidden additional version, immutable audit/receipt deletion, expired/revoked/suspended session denial. Existing auth/session regressions pass.

Status: verified disposable-database candidate, awaiting SQL review and deployment privilege verification before shared migration. No shared, staging or production database was contacted. API routes are not mounted. No live-provider browser or least-privilege role acceptance test performed. The integration fixture uses a database owner to create fault-injection triggers, so it does not prove role hardening.

Before shared execution inspect SQL, confirm target URL privately, establish distinct runtime/migration roles and backups, run clean replay and tests in the target-like environment, and approve the migration. Application APIs and CSRF integration are the next implementation slice.

Request hash uses canonical [submit,applicationId,expectedRevision], and receipt lookup returns the stored immutable revision before checking current intake state. Service compares expectedRevision against receipt revision; no client-supplied fields enter the submit command.

Application.stage is intake only. The exclusive deadline is enforced by service after database-time read; no external verification or notification delivery occurs inside the database transaction.

## HTTP and restricted-role follow-up — 19 November

The application HTTP integration and runtime-role test is now part of the disposable runner, taking the PostgreSQL total to five suites. Final total is 20 unit/HTTP tests, two compiled smoke tests and five PostgreSQL suites, zero skipped. SCRAM authentication rejects a wrong runtime password. Four additive/history migrations replay cleanly. See RUNTIME_ROLE_VERIFICATION.md for exact scope. The prior application foundation migration remains unchanged; runtime identity guards are a separate additive migration.
