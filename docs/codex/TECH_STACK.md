# Tech stack — factual vs decided vs deferred

| Layer | Verified in uploaded ZIP | Backend/prototype target | Deferred / caveat |
|---|---|---|---|
| Frontend | React `^19.2.4`, `react-dom ^19.2.4`; JSX not TS | Frontend team maintains; backend publishes REST contracts | Do not convert frontend to TypeScript |
| Frontend bundler | Vite 8 identified from lockfile; root `npm run dev/build` | Preserve existing root scripts | Do not rewrite root config |
| Routing/UI | React Router `^7.13.1`, Tailwind PostCSS `^4.2.1`, shared CSS, lucide-react | Maintain demo UI and sample DTO compatibility | Role gates in UI are not security |
| Backend runtime | Not present | Node.js 24 LTS target; separate `backend/package.json` | Verify installed Node, npm, package compatibility |
| Web framework | Not present | Express.js, TypeScript `strict: true` | Do not migrate to NestJS during prototype |
| Persistence | Not present | PostgreSQL 17 + Prisma target 7; migrations reviewed | No shared dev database; verify Prisma dependencies |
| Validation | Not present | Zod at API boundary, verified env validation | Client validation insufficient |
| API | None | REST `/api/v1`, OpenAPI contract and typed DTO examples | Use only reviewed endpoints |
| Sessions | Demo role toggle only | Backend-managed opaque HttpOnly Secure SameSite cookie session (plus CSRF for cookie-auth mutations) | No self-assigned staff roles; defer SSO if not configured |
| Documents | Placeholder only | Private S3-compatible storage adapter; quarantined/untrusted uploads | Don't claim malware sandbox/scanning without implementing it |
| Async | None | PostgreSQL transactional outbox + worker in same codebase | RabbitMQ later when justified |
| Testing | No tracked suite | Unit + real PostgreSQL integration + security denials; test runner picked by A | Don't invent pass rates |
| CI | None | GitHub Actions typecheck, build, tests, migration validation after backend created | Jenkins not required for six-day build |
| Deployment | Vercel SPA rewrite only | Containerized backend with documented staging, explicit hosting region, secrets, migration job | AWS/Botswana production infrastructure requires approval |
| Observability | None | Health endpoints, structured redacted logs, request IDs | Prometheus/Grafana/K3s later |
| AI | UI guide only, local, not model-backed | No AI decision pipeline in hackathon MVP | Local AI suggestions and pgvector later |

**Dependency rule:** Backend versions are implementation targets, not repository-verified. Select and pin compatible versions when Developer A creates `backend/`; commit only its backend lockfile. Do not change frontend's root lockfile except through the frontend team's reviewed work. CI must use the same pinned Node version as local development.

**Hosting rule:** The proposal promises Botswana data residency in production, but the competition asks for demonstrable cloud hosting details. Do not state that an international staging deployment fulfills Botswana production residency or legal compliance. Never provision resources without owner approval and spending limits.
