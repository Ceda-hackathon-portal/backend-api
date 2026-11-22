# Repo audit — user-supplied main ZIP, 17 Nov 2026

This is a file-archive inspection only, not a GitHub live-branch verification. The ZIP contains 63 entries including folders/assets and no `.git` directory. The connected GitHub account could not access `Batoli19/CedaHackathon`; nothing has been written to remote.

## Evidence from checked files
- `package.json`: `react ^19.2.4`, `react-dom ^19.2.4`, `vite ^8.0.0` exists in the package-lock root while the inspected `package.json` omits a direct `vite` entry (potential manifest/lockfile drift; verify npm CI behavior); `react-router-dom ^7.13.1`, `@tailwindcss/postcss ^4.2.1`, `axios ^1.13.6`, `chart.js`, `react-chartjs-2`, `react-hook-form`, `leaflet`, and `lucide-react`; **frontend is JSX/JavaScript**, not TypeScript.
- `README.md`: explicitly calls repository a Phase 1 frontend skeleton; auth/score/notification/attachment/audit are not connected.
- `docs/BACKEND_ARCHITECTURE_HANDOFF.md`: proposed Node, Express, TS strict, PostgreSQL, Prisma, Zod; backend not yet generated; architecture approval was pending Nov 8.
- `docs/FRONTEND_ROADMAP.md`: page-to-backend mapping and proposed UR-01–UR-17, not confirmed policy.
- `src/context/AuthContext.jsx`: demo identity in memory, role selected at UI only.
- `src/components/shared/ProtectedRoute.jsx`: frontend role gating only.
- `src/context/PortalContext.jsx`: one draft + demo ideas in localStorage key `ceda.prototype.v1`; no ownership.
- `src/pages/SubmitIdeaPage.jsx`: required `title`, `theme`, `problem`, `solution`, `impact`, `team`; demo-only consent and `submitDemo` call.
- `src/pages/ReviewPage.jsx`: all ideas visible in browser; conflict and score controls are not persisted.
- `src/data/portal.js`: demo roles, themes, 4 unweighted illustrative criteria, 5 display stages, 2 sample ideas.
- `vercel.json`: SPA catch-all rewrite to index.html; do not assume same hostname routes `/api/v1` to backend.
- `package.json` lint script references `eslint`, but no direct `eslint` dependency/config is present in the archive; verify/repair only with frontend owner.

## Current absence (in uploaded snapshot)
No `backend/`, `prisma/`, actual REST API routes, auth/session infrastructure, database migrations, worker, automated test suite, OpenAPI document or backend CI workflow. No `.env` example for backend. Presence of `axios` dependency **does not** prove real API integration.

## What is verified vs proposed
- **Verified frontend:** React 19, Vite 8 (lockfile; confirm on live install), React Router 7, JSX, Tailwind 4, existing demo UI.
- **Planned backend:** Node 24, Express, strict TS, PostgreSQL 17, Prisma 7, Zod. These are project choices, **not installed packages** in this ZIP. Verify environment and compatible package versions before writing lockfile.
- **Official requirement evidence:** CEDA notice supplied separately calls for submission, multi-stage evaluations, tracking, RBAC, feedback, reporting, chat, FAQs and hosted browser access. The repo's labels/criteria are proposals and fixtures.

## First live-clone checks
`git status --short`, `git branch -avv`, `git log -3 --oneline`, `git ls-files`, inspect latest `package.json`, `docs/`, any `backend/`, `.github/`, and root `AGENTS.md`; compare to this snapshot. Do not overwrite work that appeared after the ZIP was exported.
