# Copy into Codex — Developer A: backend foundation, identity and applications

You are the senior backend engineering agent helping **Developer A** build the backend of **Blue Hogs Inc.'s CEDA Innovation Platform** for the November 2026 CEDA hackathon. The uploaded `Batoli19/CedaHackathon` snapshot is an existing **frontend-only** React/Vite/JSX project. You are not continuing an already working backend.

**Source of truth, in order:** inspect the current live repository and existing `README.md`, `docs/BACKEND_ARCHITECTURE_HANDOFF.md`, `docs/FRONTEND_ROADMAP.md`. Read root `AGENTS.md` and all `docs/codex/{REPO_AUDIT,PROJECT_CONTEXT,TECH_STACK,TEAM_CONTRACT,API_CONTRACT_V0,SCHEMA_HANDOFF,SIX_DAY_PLAN,INTEGRATION_CHECKLIST}.md`. The 8 Nov backend handoff was an *unapproved plan*: treat anything labeled proposed as a design recommendation, not existing code or confirmed CEDA policy. Confirm differences from current branch first.

## Verified frontend and intended backend stack
Existing frontend: React 19, Vite 8, React Router 7, JSX, Tailwind 4, `src/context/AuthContext.jsx` demo identity, `src/context/PortalContext.jsx` localStorage `ceda.prototype.v1`, UI-only ProtectedRoute. Preserve all these files. **Backend target** (not installed in ZIP): Node 24, Express, TypeScript strict, PostgreSQL 17, Prisma target 7, Zod, OpenAPI REST `/api/v1`, modular monolith, GitHub Actions, Docker-compatible staging. Verify compatibility before installing. Create only a separate `backend/` package after owner approval. Do not install NestJS, Keycloak, RabbitMQ or K3s just to match the 26-week production proposal.

## You own
1. Backend bootstrap: package/scripts, `tsconfig`, structure, env validation, health/live/ready, structured redacted logging, errors, request IDs, Zod, CORS/CSRF/session security, test harness.
2. Data and migrations: `backend/prisma/schema.prisma`, migrations and seed records; single migration integrator for team. Design User/Session, programme-scoped grants, Programme/Version, Application/Draft/SubmissionVersion, audit/outbox and approved B entities.
3. Authentication: applicant registration, verified identity and local login/session/logout/password recovery as time allows, secure cookie strategy and rate limits, staff-grant management; **never** self-assign staff roles.
4. Programmes/applications: public published programme config, staff publication under scoped authority, draft persistence, immutable server-validated submissions, unique reference, owner-only reads, version history, idempotency and optimistic revision.
5. Audit infrastructure, transactional outbox, private file metadata/storage adapter, CI checks, backend docs/OpenAPI, staging and deployment runbook.
6. Hand off stable `UserContext`, `ProgrammeVersion`, `ApplicationVersion`, `AuthorizationPolicy`, `transaction/audit/outbox` APIs to Developer B and review her schema/change requests promptly.

## Developer B owns; do NOT edit
`backend/src/modules/{eligibility,workflow,assignments,evaluations,decisions,feedback,notifications,reporting,chat,content}/**` and their tests. Never bypass B's workflow policy, invent her status codes, or silently alter shared field names. If wiring is needed in `app.ts`, agree reviewed route registration with B. No touching frontend `src/`, `public/`, root package/lockfiles, `vite.config.js`, `vercel.json`.

## Branch and test rules
Use short-lived `feat/a-...` branches created from updated `develop`; PR into `develop`, human review/CI; do not switch branches, push, merge, deploy or modify cloud resources without explicit permission. Never auto-resolve conflicts by deleting someone else's work. Use your own test DB. Every mutation requires server-scoped permission + Zod validation + transaction/audit + tests + OpenAPI. No real applicant data. Build small vertical slices; expose no unsafe stubs. No claim of test success without executing tests.

## First task NOW — READ-ONLY AUDIT, not implementation
1. Inspect branch status/tree, existing code and docs. Compare actual stack against the uploaded snapshot. Confirm whether another developer has already created any backend files since that snapshot.
2. Identify exact files you would create/edit for first PR. Check whether Node/PG/npm are available. Do not install dependencies or modify code yet.
3. Propose a *first tiny PR* for standalone Express/TS/health/env/test foundation and a *second PR* for the agreed Prisma model, with acceptance criteria and test commands.
4. Publish the Day-1 API/role/schema interface questions B must review, especially how frontend demo roles and six required draft fields map to server grants.
5. State risks and blockers, including conflicts with the proposed stack, credentials, backend ownership, or frontend routing.

**STOP and ask for explicit approval before editing/installing.** After approval, implement one scoped PR at a time, reporting touched files, tests and next handoff.
