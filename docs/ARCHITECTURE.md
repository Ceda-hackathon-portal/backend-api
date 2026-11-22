# Architecture and scope

Current deployment policy: ADR005 (adr/005-free-plan-deployment.md) supersedes the earlier Fargate preference with a Free-plan EC2/local PostgreSQL candidate. No cloud deployment or provider-specific implementation is authorized. See PHASE4A.md for the current local authorization increment.

## Evidence and approval

Inspected feature/backend with a clean working tree before changes. The existing tracked backend/AGENTS.md is preserved. Frontend sources are read-only. Existing code is a React/Vite browser prototype, not a verified identity or API client. PortalContext stores all demo roles' records in ceda.prototype.v1; AuthContext only selects an in-memory role. No demo record will be migrated automatically.

Approved baseline: Node 24 LTS, strict TypeScript, Express, PostgreSQL 17, Prisma 7 subject to verification; modular monolith; separately executable worker when needed; /api/v1/applications; immutable versions and separate incomplete drafts; opaque sessions; scoped server authorization; no Redis; no-store confidential HTTP responses; memory-only user-scoped private client caches; transactional workflows.

Identity provider and attachment policy are NOT approved. Do not implement provider-specific login or attachment storage. CEDA operating rules and AWS region/budget/availability/recovery remain undecided.

## Boundaries

Future flow: route -> session validation/input validation -> application service/policy -> repository/transaction -> Prisma/PostgreSQL. Controllers stay thin. Business services do not depend on Express types. Modules: access, programmes, applications, assignments, evaluations, workflow, feedback/decisions, notifications, audit, reporting. Identity/email/storage are infrastructure ports. Worker uses the same domain services with a restricted system actor and durable outbox, not an HTTP backdoor.

Authorization consumes an internal Principal { userId, sessionId, authnLevel } from a verified identity adapter. Grants are database-owned. Local credentials and OIDC must map to the same internal user, without automatic email-only account linking. A browser role is a workspace hint, never a permission source.

Future backend-local layout: src/{app,server,worker}.ts, src/config, src/shared, src/infrastructure, src/modules, prisma/{schema.prisma,migrations}, tests/{unit,integration}, docs. No application code is authorized in Phases 1/2. spikes/prisma7 is deliberately a separate disposable package, not the production schema.

Critical changes commit state, history, audit and outbox together. External calls happen after commit. Use optimistic revisions and idempotency, bounded retries and short transactions. No secrets, private answers or signed URLs in logs. Errors expose safe codes and request IDs.

## Frontend coordination only

Frontend owner must add async draft hydration, server session loading states, scoped query caches, controlled scorecards, stable criterion IDs, independent detail fetching and real history. Do not change their contexts/components/routes. The Vercel SPA catch-all requires team review before same-origin API hosting. Local API may use a separate port and explicit origin allowlist without changing Vite. PageLoader imposes 1800ms first-load and 500ms route minimums plus hide transitions; eager page imports and roughly 1.7MB/1.8MB PNGs constrain loading independently of API latency. Public images currently have unversioned names.

## AWS candidate, not authorization

Containerized API/worker on ECS Fargate; ECS Express Mode can simplify setup. Private RDS PostgreSQL, private S3, CloudWatch, Secrets Manager and optionally CloudFront static hosting. No Redis/ElastiCache or RDS Proxy until measured need. App Runner is closed to new customers; see https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html .

Estimate task, worker, database/storage/backup, load-balancer, NAT/endpoints, transfer, scanning, secrets and log costs after region/load selection. Single-AZ demo versus Multi-AZ availability is a user decision. Keep warm capacity to avoid request-time cold starts; measure scale-out separately. Use controlled migration jobs, compatible expand/contract changes, readiness, graceful draining and rollback. Do not deploy, provision or edit shared CI/CD.
