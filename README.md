# CEDA Innovation Portal: backend-api

REST API for the CEDA Innovation Portal hackathon. It runs as a container on AWS ECS Fargate behind an Application Load Balancer.

Related repositories:

- [front-end](https://github.com/Ceda-hackathon-portal/front-end): web client that calls this API
- [infra--devops](https://github.com/Ceda-hackathon-portal/infra--devops): Terraform for ECR, ECS, the load balancer, RDS and IAM

## Container contract

The pipeline and the load balancer rely on these four rules, whatever language the API is written in:

1. A `Dockerfile` at the repository root builds the production image.
2. The server listens on the port given in `PORT` (default `8080`).
3. `GET /health` returns HTTP 200 without needing the database or other services, so a cold container can pass its health check.
4. All configuration comes from environment variables (see `.env.example`). Secrets are injected by ECS from Secrets Manager or SSM; they are never baked into the image.

## Local development

```powershell
Copy-Item .env.example .env
docker build -t backend-api .
docker run --rm -p 8080:8080 --env-file .env backend-api
```

Then open `http://localhost:8080/health`.

## Branching and reviews

- `main` is production. Every push to `main` deploys.
- Work on short-lived branches: `feature/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Open a pull request into `main`. CI must pass and one teammate approves before merging.
- Agree request and response shapes with the front-end before building an endpoint, and record them in `docs/` or an OpenAPI file.

## CI/CD

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | Every PR and push to `main` | Runs Node or Python tests if that stack is present; builds the image and checks `GET /health` |
| `deploy.yml` | Push to `main`, or run manually | Pushes the image to ECR tagged with the commit SHA, registers a new task definition and waits for the ECS service to stabilise |

The deploy job authenticates with GitHub OIDC (no AWS keys in GitHub) and stays skipped until the `production` environment is configured.

### Production environment settings

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

## Requirements this API serves

From the CEDA competition guidelines: idea submission with mandatory fields, multi-level evaluation (evaluators then adjudicators), real-time status tracking, role-based access, feedback and iteration, and basic reporting. Permissions must be enforced here on the server, not only in the front-end. Personal data handling must follow Botswana's Data Protection Act, 2024.
