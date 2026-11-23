# CEDA Innovation Portal: backend-api

REST API for the CEDA Innovation Portal hackathon: Node.js 24, Express 5, TypeScript, Prisma 7 and PostgreSQL 17. It runs as a container on AWS.

Related repositories:

- [front-end](https://github.com/Ceda-hackathon-portal/front-end): web client that calls this API
- [infra--devops](https://github.com/Ceda-hackathon-portal/infra--devops): Terraform for the AWS resources

## Runtime contract

Deployment and CI rely on these rules:

| Item | Value |
| --- | --- |
| Node.js | `24.22.2` (`.node-version`); the server refuses to start on any other major version |
| Container port | `3001` (`PORT`); set `HOST=0.0.0.0` inside a container |
| Liveness | `GET /health/live`: process is up, never touches the database. Use this for load balancer or container health checks |
| Readiness | `GET /health/ready`: checks PostgreSQL, returns 503 while draining or when the database is unreachable |
| API prefix | `/api/v1` |
| Configuration | Environment variables only (see `.env.example`). Invalid values stop startup and report only the field name |
| Production rules | `NODE_ENV=production` requires `DATABASE_SSL=true` and `https://` entries in `ALLOWED_ORIGINS`. Behind a load balancer, set `TRUST_PROXY` to its explicit IPs or CIDRs |
| Migrations | Never run on server startup. Run `npm run db:migrate` (`prisma migrate deploy`) as a separate, reviewed step before rolling out a release that needs it |
| Secrets | Injected at runtime from Secrets Manager or SSM. Never baked into the image or committed |

## Local development

```powershell
npm.cmd ci
Copy-Item .env.example .env
# Point DATABASE_URL in .env at your own development PostgreSQL database.
npm.cmd run dev
```

Verification:

```powershell
npm.cmd run db:validate
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:smoke
npm.cmd run test:database
```

`test:database` is Windows-only: install the pinned portable tools as described in `spikes/prisma7/README.md`. It starts and stops its own loopback PostgreSQL 17 cluster and ignores any configured database URL.

### Signing in locally

Local password sign-in is for development only. Run `npm run auth:hash-local-password` in an interactive terminal, then set `AUTH_MODE=local`, `AUTH_ENABLED=false`, `AUTH_LOCAL_EMAIL`, the generated `AUTH_LOCAL_PASSWORD_HASH` and a random 64-hex `AUTH_ENCRYPTION_KEY` in the ignored `.env`. Keep `HOST=127.0.0.1` and use the same loopback hostname for the API and front-end origins. The server refuses this mode anywhere else. It grants no roles.

Export the reviewed `DATABASE_URL` before migrating. The runtime uses the restricted role in `ops/runtime-role.sql`.

More: [staff workflow API](docs/STAFF_API.md), [implemented front-end API handoff](docs/FRONTEND_API_HANDOFF.md), [OpenAPI](docs/openapi.yaml), [browser authentication](docs/AUTH_CONTRACT.md), [AWS staging preparation](docs/AWS_STAGING.md).

## Branching and reviews

- `main` is production. Every push to `main` deploys once deployment is configured.
- Work on short-lived branches: `feature/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Open a pull request into `main`. CI must pass and one teammate approves before merging.
- Agree request and response shapes with the front-end before building an endpoint, and keep `docs/openapi.yaml` current.

## CI/CD

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | Every PR and push to `main` | **verify** (Linux and Windows): Prisma validate, typecheck, unit and smoke tests. **postgres**: applies migrations twice against PostgreSQL 17 and runs the integration tests. **container**: builds the image and checks `GET /health/live` |
| `deploy.yml` | Push to `main`, or run manually | Pushes the image to ECR tagged with the commit SHA and rolls out a new ECS task definition |

All CI jobs are skipped until the code is migrated in. The deploy job is skipped until the `production` environment is configured. It authenticates with GitHub OIDC, so no AWS keys are stored in GitHub.

**Hosting decision pending:** `deploy.yml` targets ECS. The backend team's ADR 005 recommends an AWS Free-plan option (EC2, no load balancer or NAT) to protect credits. Confirm the target with `infra--devops` before configuring the `production` environment; if EC2 is chosen, `deploy.yml` changes to an SSM-based rollout.

### Production environment settings (ECS target)

Create a GitHub environment named `production` (Settings → Environments) and add:

| Kind | Name | Value comes from |
| --- | --- | --- |
| Secret | `AWS_DEPLOY_ROLE_ARN` | `infra--devops` output: API deploy role |
| Variable | `AWS_REGION` | `af-south-1` unless infra says otherwise |
| Variable | `ECR_REPOSITORY` | `infra--devops` output: repository name (not the full URI) |
| Variable | `ECS_CLUSTER` | `infra--devops` output |
| Variable | `ECS_SERVICE` | `infra--devops` output |
| Variable | `ECS_TASK_DEFINITION` | `infra--devops` output: task definition family |
| Variable | `ECS_CONTAINER_NAME` | Container name inside that task definition |
| Variable | `API_URL` | Public URL of the API (shown on each deployment) |

## Origin of this code

Migrated without history from `backend/` of `Batoli19/CedaHackathon` at `002af63` (22 November 2026). Paths in older documents that start with `backend/` refer to this repository's root.

## Requirements this API serves

From the CEDA competition guidelines: idea submission with mandatory fields, multi-level evaluation (evaluators then adjudicators), real-time status tracking, role-based access, feedback and iteration, and basic reporting. Permissions are enforced here on the server, not only in the front-end. Personal data handling must follow Botswana's Data Protection Act, 2024.
