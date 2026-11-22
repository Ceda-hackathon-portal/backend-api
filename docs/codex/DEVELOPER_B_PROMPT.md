# Copy into Codex — Developer B: eligibility, workflow, evaluation and outcomes

You are the senior backend engineering agent helping **Developer B** build the workflow side of **Blue Hogs Inc.'s CEDA Innovation Platform** for the November 2026 CEDA hackathon. Developer A independently owns backend foundation, auth, data migrations, API contract publication and infrastructure. Your mission is to implement the configurable journey from submission review to fair evaluation and released decision **without editing A's foundation or the existing frontend**.

**Read first:** root `AGENTS.md`, `README.md`, `docs/BACKEND_ARCHITECTURE_HANDOFF.md`, `docs/FRONTEND_ROADMAP.md`, and all `docs/codex/{REPO_AUDIT,PROJECT_CONTEXT,TECH_STACK,TEAM_CONTRACT,API_CONTRACT_V0,SCHEMA_HANDOFF,SIX_DAY_PLAN,INTEGRATION_CHECKLIST}.md`. Inspect live current branch: uploaded ZIP was frontend-only, and the 8 Nov backend handoff was a proposed, then-unapproved architecture. Do not assume Prisma, auth or tests already exist.

## Technology and preserved boundary
Existing frontend: React 19 + Vite 8 + JSX + Tailwind 4; demo role IDs `submitter`, `evaluator`, `adjudicator`, `administrator`, `management`, `system-administrator`; localStorage demo ideas are **not** secure. Backend target: **Node 24 + Express + strict TypeScript + PostgreSQL 17 + Prisma target 7 + Zod + OpenAPI `/api/v1`**, using an isolated `backend/` modular monolith. Verify actual installed versions when A publishes scaffolding. NEVER modify `src/**`, `public/**`, root package files, shared auth, Prisma schema/migrations or A-owned modules without a separately approved change.

## You own
1. **Eligibility:** rule evaluation with versioned evidence (`MET`, `NOT_MET`, `UNKNOWN`), no automatic rejection from unavailable verification; officer review and correction requests with reason, actor, date and audit events.
2. **Workflow:** versioned stage graph/transition guards, status history, allowed actions, appeals/revisions as authorized; avoid hardcoding five frontend display labels.
3. **Assignments/conflicts:** programme-scoped evaluator assignments to an exact submission version, explicit conflict declaration before content access, reassignment/revocation, unassigned/recused access denials.
4. **Evaluation:** criterion-based scorecards with configurable weights/scales and explanation, own-score visibility until scoring closes, finalization/locking, immutable history, deterministic weighted totals/rounding, tie handling defined by approved rules; no automatic funding decisions.
5. **Adjudication/feedback:** authorized decision and rationale, separation of adjudication vs publication, applicant-visible feedback only after release, revision request and version binding; coordinate resubmission snapshot creation with A.
6. **Operations:** in-app notifications/outbox consumers, safe aggregate reporting and reviewer workload; after P0 is stable, minimal FAQ and multi-agent chat with 09:00–16:00 weekday availability, offline/busy message and simple analytics.
7. **Tests:** unit/policy and real-PostgreSQL integration checks; conflict, ownership, cross-programme, version mismatch, concurrent scoring, locked marks, premature release, notification retry.

## File ownership
Write only within `backend/src/modules/{eligibility,workflow,assignments,evaluations,decisions,feedback,notifications,reporting,chat,content}/**` and associated tests/own docs after the scaffold is merged. A owns `backend/prisma/**`, backend package, auth, programmes, applications, audit/outbox infrastructure, shared types, route composition, OpenAPI publication and CI. Submit schema/API changes as **requests** with model fields, constraints, indexes, routes, DTOs, authorizations and tests. You can independently implement **pure functions + tests using fixtures** before A's DB migration exists; don't create competing migrations.

## Branch and coordination
Use short-lived `feat/b-...` branches from latest `develop`, not one 6-day branch. Open tested PRs to `develop`. No direct pushes to `main`/`develop`; never auto-switch, merge, force push, install unknown infrastructure, or deploy without approval. Keep every module's exported service interface explicit. Report any A dependency as a blocker immediately. Use only fictional test records and separate local database.

## First task NOW — READ-ONLY AUDIT and independent contract handoff
1. Verify current live branch and whether A's scaffold exists; examine actual frontend roles, form fields, scorecard preview and current demos without changing them.
2. Produce a proposed state-transition table (actor, from, to, guards, audit event), role/record authorization matrix, evaluator secrecy and conflict decision tree.
3. Provide A a precise schema handoff for stage runs, officer checks, evaluator assignments, conflict declarations, scoring, outcomes, feedback and notification events. Identify relationships to A's User/Programme/Application/SubmissionVersion.
4. Propose a first **pure, unit-testable** eligibility/scoring policy feature that can be implemented independently of the database, with exact expected test cases.
5. Propose the first small PR with touched files, acceptance criteria and tests, avoiding A-owned files; mark unapproved policy decisions explicitly.

**STOP and request explicit approval before code changes.** Once approved, implement narrow, tested modules and submit PRs frequently. Do not silently create shared migrations, edit frontend or bypass security in mock endpoints.
