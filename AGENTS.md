# CEDA backend development instructions

These instructions apply to all work inside `backend/`, including future Codex sessions. The repository is shared with an actively developed React frontend. Preserve other developers' work.

## Authorization and workspace boundaries

- Create, edit, rename, move, or delete files only inside `backend/` unless the user explicitly approves a particular change outside it.
- Frontend files may be read to understand interfaces, roles, data structures, and expected behavior. Modifying frontend-owned files without the user's explicit approval is prohibited.
- In particular, do not modify `src/`, `public/`, `docs/`, `index.html`, root `package.json`, root `package-lock.json`, root `vite.config.*`, React components, frontend authentication, routing, context providers, state management, or frontend configuration without explicit approval.
- Do not create or modify a repository-root `AGENTS.md` without explicit approval. Keep these instructions in `backend/AGENTS.md`.
- Keep dependencies, lockfiles, environment examples, migrations, tests, documentation, and backend deployment configuration inside `backend/`. Run dependency installation from `backend/`, never the repository root.
- Do not modify shared GitHub Actions workflows, Docker configuration, or deployment settings outside `backend/` without explicit approval.
- If necessary work requires a change outside `backend/`, stop that work, explain the exact change and reason, and wait for explicit approval. Do not work around this restriction with generated files, scripts, or tools that write outside the boundary.
- Do not integrate or change the frontend automatically. Document integration requirements for the frontend developer.

## Git and collaboration

- Backend development belongs on `feature/backend`. Before implementation, inspect the current branch and `git status`, identify existing uncommitted changes, and explain the implementation plan and backend-only scope.
- Never implement directly on `main`. If necessary, create or switch to `feature/backend` only when doing so safely preserves existing work. Do not switch branches in a way that carries another developer's changes into backend work.
- Never overwrite, revert, move, or delete another developer's work. Recheck status before editing files that may have changed concurrently.
- Never run `git reset --hard`, `git clean -fd`, force pushes, or automatic branch merges.
- Do not commit or push without the user's explicit permission. Creating a file in a branch's working tree does not persist it in branch history; report when a file remains uncommitted.
- Stage only explicitly authorized backend files when committing is approved; do not stage unrelated changes.
- After each implementation increment, list changed files, verify that no frontend-owned files were modified by the work, run relevant backend checks, describe API contract changes, and report unresolved integration issues.
- If unexpected non-backend changes appear, report them and preserve them. Do not assume they were made by this session.

## Architecture and implementation standards

- Use Node.js, strict TypeScript, Express.js, PostgreSQL, and Prisma ORM. Prepare for eventual AWS deployment without provisioning resources unless explicitly authorized.
- Maintain an isolated modular monolith with REST APIs under `/api/v1` and a backend-local package boundary. Preserve the existing frontend.
- Organize capabilities into authentication, users/access, programmes, applications/submissions, assignments, evaluations, workflow, feedback/decisions, notifications, audit, and reporting modules.
- Keep controllers thin, business rules in services/policies, and database queries in repositories or equivalent database-access boundaries. Services must not depend on Express request/response types.
- Validate environment configuration and external inputs. Use Zod, reject unknown input fields where appropriate, centralize errors, and avoid leaking implementation details.
- Use migrations for schema changes and transactions for related domain changes, workflow history, audit records, and outbox events. Keep external service calls outside database transactions.
- Use immutable submission versions and published programme configuration, optimistic concurrency, and idempotency for retry-sensitive commands such as submission and decisions.
- Keep programme rules, criteria, stages, deadlines, and permissions configurable. Treat existing frontend fixtures as proposed demo behavior, not confirmed CEDA policy.
- Use supported declarative workflow rules, never administrator-uploaded executable code.
- Add meaningful unit tests for business rules and real PostgreSQL integration tests for constraints, transactions, authorization, and concurrency. Run checks appropriate to each change and report any checks that could not run.

## Security requirements

- Authenticate on the server and authorize every protected operation using verified identity, server-owned grants, programme scope, ownership or assignment, conflict status, workflow state, deadlines, and data audience as applicable.
- Never trust client-supplied roles, ownership identifiers, scores/totals, or workflow authority. Public registration must never grant staff roles.
- Preserve the existing role identifiers where practical: `submitter`, `evaluator`, `adjudicator`, `administrator`, `management`, and `system-administrator`. Roles alone do not bypass record-level access checks.
- Applicants access their own records and released feedback. Evaluators access active assigned versions and permitted evaluations. Enforce recusal and revocation. Programme administration is scoped; management receives authorized aggregates; technical administration does not automatically grant access to idea content.
- Prefer backend-managed opaque sessions with hashed tokens at rest and HttpOnly, Secure production cookies. Apply explicit expiry, rotation/revocation, CSRF protection for cookie-authenticated mutations, and an explicit CORS allowlist. Do not place session credentials in localStorage.
- If local passwords are implemented, use maintained password hashing, verification, rate limiting, and hashed single-use recovery tokens. Do not store plaintext passwords or recovery tokens.
- Keep secrets out of source control and logs. Use backend-local ignored environment files and non-secret `.env.example` placeholders. Redact credentials, confidential content, and signed URLs from logs.
- Keep S3 attachments private. Authorize upload/download access, generate object keys on the server, enforce limits, verify actual content, quarantine/scan uploads, and bind submissions to exact verified immutable object versions. Reauthorize downloads before issuing short-lived signed URLs.
- Return audience-specific DTOs rather than raw universal entities. Protect private feedback, reviewer information, audit data, reports, and exports from unauthorized disclosure.
- Record sensitive state changes with actor, timestamp, action, target, and reason where applicable. Do not claim audit immutability based solely on application conventions.
- Test denied access, including cross-user, cross-programme, unassigned, conflicted, and revoked access; stale updates; duplicate commands; and private-feedback leakage.

## API contracts and frontend coordination

- Maintain `backend/docs/API_CONTRACT.md` as endpoints are implemented or changed. Distinguish implemented behavior from proposals.
- Document endpoint URLs, HTTP methods, headers, request bodies, response bodies, pagination, authentication, authorization, workflow preconditions, validation/errors, concurrency, and retry/idempotency behavior as applicable.
- Preserve the initial idea field names through DTOs where practical: `title`, `theme`, `problem`, `solution`, `impact`, and `team`. Document any differences from frontend expectations and propose mappings for team review; never modify frontend files to resolve a mismatch without explicit user approval.
- Document the distinction between internal IDs and human-readable references, asynchronous draft/submission behavior, programme configuration, version history, and released feedback.
- Use consistent success and error envelopes, UTC timestamps, bounded pagination, and allowlisted filtering/sorting. Document 401, 403, 404, 409, and 422 behavior where relevant; avoid exposing inaccessible record existence.
- Frontend session restoration, API clients, asynchronous handlers, loading/error states, cache clearing, and hosting/proxy changes are integration work for team review. They do not authorize edits outside `backend/`.
- Do not automatically migrate browser demo records into the database or treat the demo checkbox as production privacy/IP consent.

## Completion and handoff

- Explain what changed, why, relevant test results, contract changes, and remaining decisions or risks.
- Keep handoff and architecture documentation inside `backend/docs/`.
- Do not claim production readiness, compliance, AWS deployment, or successful checks without evidence.
- User instructions and explicitly approved scope take precedence over these defaults. Permission for backend implementation never implies permission to modify frontend-owned files.
