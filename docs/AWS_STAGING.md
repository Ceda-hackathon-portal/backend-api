# AWS staging runbook

Status on 19 November 2026: preparation only. No AWS account, Region, resource, deployment, secret or shared migration has been changed. This branch starts from canonical develop 9dd3804 and excludes pending officer PR #6. Use fictional records.

## Proposed architecture and resource approval

Recommend one Linux/IPv4 Lightsail 2 GB instance for a short-lived demonstration, with Docker Compose running Caddy TLS, compiled Node API and private PostgreSQL 17. API and database have no published host ports. The edge bridge assigns Caddy 172.29.67.2; only that /32 is trusted by Express. Database traffic requires TLS and SCRAM. PostgreSQL volume and Caddy certificate volumes survive container replacement.

This is a single failure domain with operator-managed backup/restore. A managed PostgreSQL service is preferable for longer-lived or real-account use. Build images on a workstation/CI, not on the 2 GB staging VM. Compose limits PostgreSQL to 768 MB, API to 384 MB and proxy to 128 MB; validate real load and disk headroom before demo acceptance.

| Option | Fit and operational cost |
|---|---|
| Lightsail VM + private container DB | Small resource inventory and predictable compute bundle; operator owns patching, recovery and certificate files. Proposed for fictional-data demo only. |
| EC2 + private RDS PostgreSQL | Managed DB recovery and more networking flexibility; additional DB/storage/IP and security-group administration. Obtain a Region-specific quote. |
| ECS Fargate + RDS | Managed application scheduling; task CPU/memory, registry, database, ingress and potentially NAT add cost and setup. Defer for this deadline. |

Fargate bills selected CPU/memory duration. EC2 and RDS pricing depends on instance/storage/Region choices. These alternatives are not zero-cost assumptions. [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/) · [RDS pricing](https://aws.amazon.com/rds/postgresql/pricing/) · [Fargate pricing](https://aws.amazon.com/fargate/pricing/)

Proposed inventory requires explicit approval:
- One VM, one attached static IPv4, existing domain/subdomains, three persistent volumes and an encrypted backup destination.
- One approved Cognito pool and confidential web app client, or reviewed existing resources. No AWS credentials are required inside the API for OIDC.
- Cost budget/alert recipients, approved Region, resource owner and deletion date after the hackathon.
- Existing frontend hosting with a custom same-site domain, or a separately approved frontend host. This PR does not deploy frontend code.

Use Ireland eu-west-1 as an example only. Lightsail's published Region list does not include Cape Town. Region selection needs owner approval; international staging is not a Botswana data-residency commitment. [Supported Regions](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-regions-and-availability-zones-in-amazon-lightsail.html)

## Costs and safeguards

Current published Linux/IPv4 bundle is USD 12/month for 2 GB, 2 vCPU, 60 GB disk and 3 TB transfer. A rough compute-only seven-day estimate is USD 2.8 using 730 hours/month; confirm the actual hourly quote and Region. Taxes, snapshots, transfer excess, DNS/domain and identity delivery can add charges. Snapshot storage is USD 0.05/GB-month. Stopped instances continue billing; unattached static IP beyond one hour is USD 0.005/hour. [Bundle pricing](https://aws.amazon.com/lightsail/pricing/) · [Billing details](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html)

AWS Free Tier eligibility depends on account date and plan. New accounts can receive USD 100 initial credits and earn up to USD 200 total, with the Free plan bounded by six months/credit exhaustion. Older accounts have different offers. Verify account credits and whether Lightsail is available in that plan before approving spend; do not upgrade plans implicitly. [AWS Free Tier](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html) · [Plan FAQs](https://aws.amazon.com/free/free-tier-faqs/)

Cognito Lite/Essentials currently offer 10,000 direct/social MAUs under stated conditions, with different federation/legacy rules. Plus has no MAU free tier. SMS and email delivery may be charged separately. Explicitly select the approved tier and recovery/MFA settings; new-pool default tier is Essentials. [Cognito pricing](https://aws.amazon.com/cognito/pricing/)

Propose USD 10 actual and forecast budget alerts for this short staging period, with an owner-approved total cap. Alerts can lag and do not stop spend. Use a single instance, no autoscaling/NAT/load balancer, bounded logs and a deletion reminder. Record the console estimate before creation and review billing daily. [Budget caveats](https://docs.aws.amazon.com/cost-management/latest/userguide/bcm-lite-use-budget.html)

## Actual runtime contract

Node 24.22.2, npm ci, npm run typecheck and npm run build; prebuild generates Prisma Client. Runtime command is node dist/src/server.js, listening on HOST/PORT (container defaults 0.0.0.0:3001). The runtime image is non-root and excludes Prisma CLI/dev dependencies. A separate migration target retains CLI tooling and defaults to migrate status.

GET /health/live is process liveness. GET /health/ready is bounded SELECT 1 plus drain status. Docker health uses readiness, so missing DB yields unhealthy. Readiness is not a schema-version check. Review migration status before enabling accounts. Node startup never migrates. SIGTERM drains requests and closes the shared pool; Compose permits 20 seconds for the default 10-second shutdown limit.

Application logs include request UUID, method, status and duration. Bodies, raw URLs, cookies, headers, signed callbacks and driver errors are excluded. Caddy access logging is disabled; runtime log formatting removes request URI and headers. Keep proxy config and retention as provided; do not enable debug/request logging during sign-in.

Environment templates are in `ops/staging/*.env.example`; optional timeout/session settings and validation rules remain in `.env.example` and `src/config/`.

| Setting | Staging requirement |
|---|---|
| DATABASE_URL | Restricted `ceda_app` URL for API; different owner login for migration tools. |
| DATABASE_SSL / DATABASE_CA_FILE | `true` and mounted trusted CA; verification stays enabled. |
| NODE_ENV / HOST / PORT | Compose sets `production`, `0.0.0.0`, `3001`; no published API port. |
| ALLOWED_ORIGINS | Exact approved HTTPS frontend and API origins; no wildcard. |
| TRUST_PROXY | Only the private Caddy address; never universal trust. |
| AUTH_ENABLED | `false` during preparation, `true` after approved Cognito setup. Private APIs fail closed while false. |
| COGNITO_ISSUER / COGNITO_CLIENT_ID | Approved regional pool issuer and web client; optional client secret stays server-side. |
| AUTH_API_ORIGIN / AUTH_FRONTEND_ORIGIN | Exact same-site HTTPS origins, matching callback and workspace redirect. |
| AUTH_ENCRYPTION_KEY | Server-only 64 hexadecimal characters, persisted securely across restarts. |
| DATABASE_POOL_MAX / LOG_LEVEL | Example pool 5; logging `info`, no private debugging. |

Local database certificates expire after 14 days. Rotate them deliberately before extending this short demo, verify trust and restart affected services. The CA signing key stays host-only and is never an application image layer.

## Host and AWS setup after authorization

The following commands are templates only. Obtain approval for account, Region, VM bundle, DNS changes, pool/client, budgets, backup destination, runtime credentials and migrations separately.

~~~sh
aws sts get-caller-identity
aws lightsail get-regions
aws lightsail get-bundles --region eu-west-1
aws lightsail get-blueprints --region eu-west-1
~~~

Choose the current Linux Ubuntu blueprint, x86_64 2 GB IPv4 bundle and approved availability zone from that output. Do not guess stale bundle IDs. With approved variables set:

~~~sh
aws lightsail create-instances --region "$AWS_REGION" --instance-names ceda-staging --availability-zone "$AWS_ZONE" --blueprint-id "$APPROVED_BLUEPRINT" --bundle-id "$APPROVED_BUNDLE" --tags key=Project,value=CEDA key=Environment,value=staging
aws lightsail allocate-static-ip --region "$AWS_REGION" --static-ip-name ceda-staging-ip
aws lightsail attach-static-ip --region "$AWS_REGION" --static-ip-name ceda-staging-ip --instance-name ceda-staging
~~~

Configure instance firewall for TCP 80/443 and SSH only from approved operator /32 addresses. Do not expose 3001 or 5432. Restrict IPv6 similarly or leave it disabled. Install supported Docker Engine and Compose v2 using official packages after approval. Keep the host updated, use operator keys and MFA-protected AWS access, and avoid long-lived AWS keys on the VM.

Point api.staging.example.org to the static IP. Use portal.staging.example.org for the independently hosted frontend. Caddy obtains/renews certificates over approved public DNS and ports 80/443. Inspect subnet 172.29.67.0/24 for host/Docker conflicts before launch; changing it requires matching API TRUST_PROXY and another security review.

## Prepare reviewed images and private files

From backend on a build host with Docker, use the exact approved commit as RELEASE_SHA:

~~~sh
docker build --target runtime -t ceda-backend:"$RELEASE_SHA" .
docker build --target migration -t ceda-migration:"$RELEASE_SHA" .
docker save -o ceda-images.tar ceda-backend:"$RELEASE_SHA" ceda-migration:"$RELEASE_SHA"
~~~

Transfer the image archive and reviewed ops/staging, ops/runtime-role.sql to the VM over authenticated SSH. Use docker load there. Pin PostgreSQL and Caddy image digests after approval/pull and record them with the API image ID. No registry/ECR resource is required for this small option.

From backend on the VM:

~~~sh
umask 077
mkdir -p ops/staging/private
cp ops/staging/staging.env.example ops/staging/private/compose.env
cp ops/staging/api.env.example ops/staging/private/api.env
cp ops/staging/migration.env.example ops/staging/private/migration.env
openssl rand -hex 32 > ops/staging/private/postgres_password
sh ops/staging/create-db-tls.sh ops/staging/private/tls
~~~

Edit private files securely. Set images and DNS in compose.env. Database runtime password and migration password must be different. Use strong URL-encoded passwords and never paste files or resolved Compose output into chat/logs. Generate AUTH_ENCRYPTION_KEY with openssl rand -hex 32 and inject it only into private/api.env after approval. The example defaults AUTH_ENABLED=false. No secret file enters Git or the Docker build context.

PostgreSQL requires server.key owned by its container user with mode 0600. Discover IDs using docker run --rm --entrypoint id postgres:17-bookworm -u postgres and -g postgres, then use sudo chown with those numeric IDs and chmod 600 on private/tls/server.key. The TLS directory is 0755 and certs public-readable; the private parent is 0700 and CA private key stays 0600. Only the TLS subdirectory is mounted into PostgreSQL, and only CA certificate into the API.

All Compose commands below run from backend and select the same project:

~~~sh
docker compose --env-file ops/staging/private/compose.env -f ops/staging/compose.yml config --quiet
docker compose --env-file ops/staging/private/compose.env -f ops/staging/compose.yml up -d --wait postgres
~~~

Create a separate migration login and runtime login from an interactive peer-authenticated administrator session:

~~~sh
docker compose --env-file ops/staging/private/compose.env -f ops/staging/compose.yml exec --user postgres postgres psql -d ceda_staging
~~~

At the psql prompt, create roles with no superuser/CREATEDB/CREATEROLE/replication powers and set passwords interactively:

~~~sql
CREATE ROLE ceda_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ceda_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER SCHEMA public OWNER TO ceda_migrator;
~~~

Use psql's hidden password prompt for each role, then put the corresponding URL-encoded values in the two private env files. PostgreSQL administrator credentials never enter the runtime environment.

## Explicit migration gate

Before migration, confirm exact database, source revision, backup/recovery owner and SQL checksums. Migrate only the approved fictional staging target. Inspect additive application_foundation and runtime_guards SQL and existing objects first.

The migration tool's DATABASE_URL uses sslmode=require, sslaccept=strict and sslcert=/run/db/ca.crt. Runtime URLs contain no query overrides and use DATABASE_SSL=true plus DATABASE_CA_FILE. [Prisma TLS parameters](https://docs.prisma.io/docs/orm/core-concepts/supported-databases/postgresql)

After explicit database approval:

~~~sh
docker compose --profile tools --env-file ops/staging/private/compose.env -f ops/staging/compose.yml run --rm migration
docker compose --profile tools --env-file ops/staging/private/compose.env -f ops/staging/compose.yml run --rm migration node node_modules/prisma/build/index.js migrate deploy
docker compose --profile tools --env-file ops/staging/private/compose.env -f ops/staging/compose.yml run --rm migration
~~~

The first/last commands inspect status. Deploy is a distinct operator invocation and never part of API startup or compose up.

As administrator, apply the reviewed runtime-role.sql after migration, then GRANT ceda_runtime TO ceda_app. The role script revokes PUBLIC schema/database CREATE/TEMP and table permissions; review existing consumers before execution. The migrator owns new tables/functions, runtime owns none, and runtime cannot disable triggers or access _prisma_migrations. Readiness alone does not establish these privileges. Run the restricted-role acceptance tests before accounts are enabled.

## Start and validate staging

~~~sh
docker compose --env-file ops/staging/private/compose.env -f ops/staging/compose.yml up -d --wait api proxy
curl --fail https://api.staging.example.org/health/live
curl --fail https://api.staging.example.org/health/ready
~~~

Confirm TLS verification, runtime login, correct migration status, no public DB port, API non-root identity, live session/CSRF and applicant isolation using fictional data. Provision a reviewed published programme separately; there is no public programme-management endpoint. Local/CI synthetic OIDC coverage does not replace live browser verification.

## Cognito and browser origins

Owner configures a reviewed pool/client and exact callback https://api.staging.example.org/api/v1/auth/callback, authorization-code flow, openid/email/profile scopes, S256 PKCE and verified email. The adapter requests prompt=login and validates signed claims. Hosted signup/recovery belong to Cognito. The API always redirects to https://portal.staging.example.org/workspace.

Set AUTH_API_ORIGIN and AUTH_FRONTEND_ORIGIN to those exact origins and include both in ALLOWED_ORIGINS. HTTPS produces Secure, HttpOnly, SameSite=Lax, host-only cookies. Both origins must be same-site; a default vercel.app frontend against this API is cross-site and fails this cookie design. Browser requests use credentials=include and mutations send X-CSRF-Token. CORS cannot repair cross-site cookie restrictions. Staff MFA/onboarding must be approved; OIDC alone makes no MFA claim. [Cognito callback and PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)

## Backup, rollback and cleanup

Before any approved migration, create a PostgreSQL custom-format dump through the local admin socket and encrypt/transfer it to the approved backup destination. Do not pipe an unencrypted dump into shared logs or commit it. Restore a copy into an isolated database and verify row counts and sign-in/submission fixtures. A VM snapshot alone is not evidence of transaction-consistent recovery.

Keep the previous API image and private configuration. To roll back code, change only API_IMAGE to the previous reviewed immutable tag and recreate api after checking migration compatibility. Do not reverse applied migration files. A database rollback requires a separately approved restore/maintenance procedure, not automatic down migrations.

After the hackathon, obtain data-retention confirmation and export the approved encrypted backup. Revoke demo sessions, disable the demo client, remove DNS, delete VM and release static IP, and review remaining snapshots/disks/volumes, registry images, log stores, backup objects and Cognito resources for ongoing charges. Deletion and data destruction require separate owner authorization. Record successful cleanup and billing checks. Stopping the VM alone does not end Lightsail charges.
