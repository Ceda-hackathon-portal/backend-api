# Phase 3 foundation handoff

Authorized by owner after Phase1/2 commit103fa6f on feature/backend. Owner subsequently authorized committing Phase3; no push or merge authorized or performed. Only backend-owned files changed.

## Implemented

- Backend-local package/lock, Node24 engine, strict TypeScript ESM and development environment example. Express5.3.0, Zod4.6.7, pg8.23.1, Pino10.4.0, Helmet8.3.0 pinned.
- App factory separated from executable server; JSON-only bounded uncompressed input; no-store defaults including errors; security headers; server-generated request IDs; safe error envelope.
- Exact credentialed CORS origins and bounded preflight. Proxy trust defaults false and only accepts configured IP/CIDR values, not true or hop counts.
- No request URL/query/header/body or external error logging. Application logging emits generated ID/method/status/duration and fixed safe error codes. Future modules must maintain allowlisted logging.
- Validated configuration with secret-free failure messages. PostgreSQL URL query overrides rejected to prevent TLS settings being replaced. Production TLS requires rejectUnauthorized:true with system trust or approved CA file. Pool max/acquisition/query/statement/lock timeouts explicit.
- Public GET/HEAD /health/live (process only) and /health/ready (bounded SELECT1,503 when unavailable/draining). No database/topology details exposed.
- Signal-driven draining; HTTP connections finish before pool closes; deadline forces connections closed and nonzero exit. Listen failures close pool with bounded deadline.
- Identity-independent Principal, SessionVerifier and AuthorizationPolicy interfaces. No adapters installed; default deny. Middleware verifies on every invocation. No login/session/grant storage functionality implemented.
- Generic Zod body validator plus foundation HTTP/config tests; separate real-PostgreSQL integration harness. Production domain schema/Prisma client/migrations deferred rather than inventing placeholder tables.

## Verification

Node24.22.2 portable executable used for strict compilation and tests (host npm bootstrap used Node26 and emitted expected backend engine warning). Eight foundation tests: live/ready/error headers, CORS, bounded parsing/unknown fields, sanitized async errors, configuration/TLS overrides, fresh authorization calls, draining/outage and graceful shutdown/deadline. One PostgreSQL17.11 integration test verifies real connectivity, statement/lock settings, server cancellation SQLSTATE57014 and clean shutdown/rejection after pool end. Disposable database stopped, no service/AWS created; ignored fixture data retained under backend/.runtime.

Run commands in ../README.md. These are correctness checks, not performance benchmarks, authentication tests or proof of production TLS. Existing Phase2 generic Prisma migration/constraint tests remain documented separately; no domain schema has been promoted from the spike.

## Contract changes and boundaries

openapi.yaml describes implemented health routes outside /api/v1. All /api/v1 domain endpoints remain proposals and currently404. No change to title/theme/problem/solution/impact/team or any frontend DTO field. No client integration/cache changes. CSRF/session restoration must be implemented and tested with the selected identity approach before protected mutations exist; this foundation must not be treated as functioning authentication.

## Files created/modified

New: backend/.env.example, README.md, package.json, package-lock.json, tsconfig.json; src/app.ts, server.ts, config/env.ts, infrastructure/database.ts; src/shared/{authorization,errors,logging,shutdown,validation}.ts; tests/foundation.test.ts, database.integration.test.ts, run-database.mjs; docs/FOUNDATION.md, openapi.yaml.

Modified: docs/API_CONTRACT.md (health/domain status), docs/PHASE3_PLAN.md (approval status), docs/README.md (index), docs/COMPATIBILITY.md (historical handoff clarification). No root/React/public/shared deployment edits. backend/AGENTS.md unchanged.

## Remaining gates

Identity provider; eligibility/quorum/scales/weights/conflicts/feedback visibility/revisions/appeals/retention/residency; attachment policy; AWS region/budget/availability/RPO/RTO. Linux container/RDS/TLS/failover/load and full production schema constraints unverified. No Redis. Production Prisma wiring will use the previously tested7.10.1 adapter once the approved schema exists; current readiness uses pg only and the spike dependency tree is not the production package.

Proposed next increment for review: choose identity approach, approve production schema/migration slice, then implement real sessions and scoped grants with negative authorization tests before the applicant flow. Do not interpret Phase3 foundation approval as approval for provider-specific login, domain modules, storage or deployment.

Technical references checked during implementation: https://expressjs.com/en/5x/guide/error-handling/ ; https://node-postgres.com/features/ssl ; https://zod.dev/api .
