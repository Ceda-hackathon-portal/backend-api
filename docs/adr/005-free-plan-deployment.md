# ADR 005: AWS Free-plan hackathon deployment

Date checked: 2026-11-09. Status: recommendation for review, NOT deployment authorization. Supersedes the earlier preferred Fargate direction. Keep all development local; synthetic data only. No account API calls, resources, paid upgrades, deployments, provider login or attachments were created.

## Cost and account constraints

User confirms Free plan; balance, creation/expiry dates, Region/service eligibility and exact credits were NOT independently verified. No AWS account connector/credentials were used. Before deployment the owner must supply/read the Billing console evidence. No permanent-free claim. The plan ends after six months or credit exhaustion (whichever first), then account access/resources are lost; export encrypted backups before that deadline. Certain Organizations/Control Tower and other account actions can trigger a Paid upgrade: prohibit these, purchases/commitments/Marketplace and all upgrade actions. Alerts are warnings, not a guaranteed spend cap. Never switch to Paid to keep a demo running. [AWS plan rules](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html).

New-plan EC2 eligibility differs from legacy 750-hour allowances. AWS lists t3.micro/small, t4g.micro/small and some larger types, but verify eligible instance/AMI in selected Region and account before launch; eligible means credit-backed use, not zero credit consumption. [EC2 eligibility](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html).

## Options

| Dimension | A: EC2 + local PostgreSQL17 | B: EC2 + private RDS PostgreSQL17 | C: Lambda + private PostgreSQL17 |
|---|---|---|---|
| Free-plan eligibility | Candidate eligible EC2/AMI/EBS; confirm account/Region | Both EC2 and RDS configurations must be eligible; do not assume old RDS allowance | Lambda/API endpoint and DB all need independent eligibility checks |
| Incremental services | One Linux host + encrypted EBS, independent backup destination | Host + DB instance/storage/backups, subnet/security configuration | Lambda + HTTPS gateway/adapter + persistent RDS or EC2 DB; optional proxy adds cost |
| Security | PostgreSQL Unix socket or loopback only; OS patching/isolation owned by us | Private DB subnet, SG allows only application SG; verified TLS | Private VPC DB; Cognito/internet access from VPC requires justified egress strategy, never automatically add NAT |
| Availability | One failure domain for API, sessions and DB; planned downtime accepted | Separates host/DB failures; Single-AZ still not HA; Multi-AZ costs more | API scales but DB remains bottleneck/single point unless separately upgraded |
| Performance | Warm process, low DB latency; CPU/RAM shared | Warm API, network hop; dedicated DB memory | Cold starts and connection bursts; small bounded pool/container reuse and reserved concurrency needed |
| Operations | Few cloud services; most patch/backup/cert work | Managed DB backups/patching simplify DB operations; higher fixed spend | More packaging/adapter/VPC/concurrency/worker orchestration |
| Recovery | Tested encrypted pg_dump/restore and off-host copies required | Managed backup/PITR within approved retention plus restore rehearsal | Same persistent DB recovery as B; Lambda ephemeral disk cannot host durable PostgreSQL |
| Migration | pg_dump/restore to RDS; change URL/TLS, keep Prisma/API | App can move independently; RDS remains | Express handler adapter required; server listen/shutdown and worker model change |

Lambda is technically a candidate for the Express app factory and Prisma7/pg, but NOT a drop-in deployment of server.ts. Verify supported Node24 runtime, Linux generation/package paths, HTTPS adapter/cookies/multiple Set-Cookie headers, pool budget and cold starts. Never run PostgreSQL in /tmp or persist sessions in Lambda memory. No NAT/proxy/provisioned concurrency assumed; inability to reach identity services securely without extra costs is a design blocker. The current runtime tables and pricing must be rechecked at launch. [Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html), [Lambda pricing](https://aws.amazon.com/lambda/pricing/), [HTTP API pricing](https://aws.amazon.com/api-gateway/pricing/).

## Transparent monthly model, not an account quote

USD list-price equivalents consumed from credits AFTER any applicable account-specific allowances. Region unresolved; use illustrative US-East reference inputs only, not a residency recommendation. 730 host-hours/month,20GB EBS, small synthetic DB,100 demo users,10k API requests/month,1GB backup target,low logs/egress. No domain purchase, NAT, load balancer, Fargate, Redis, SMS, advanced identity security, custom KMS key or CPU-surplus charges included. Taxes/unsupported services/transfer can change totals. Do not deploy from these estimates.

Known reference inputs: t3.micro $0.0104/h; t3.small $0.0209/h (Linux on-demand example); one IPv4 $0.005/h = $3.65/730h. [EC2 T3 pricing](https://aws.amazon.com/ec2/instance-types/t3/), [IPv4 pricing](https://aws.amazon.com/vpc/pricing/). EBS model assumes $0.08/GB-month (20GB=$1.60), from a pricing example, not verified selected-Region quote. [EBS](https://aws.amazon.com/ebs/pricing/).

| Model | Calculation / monthly credit-consumption estimate |
|---|---|
| A, t3.small preferred memory | $15.26 compute + $3.65 IPv4 + $1.60 EBS + provisional $1.50 backup/log/request reserve = about $22/month before extra egress |
| A, t3.micro only after memory test | $7.59 compute + same $6.75 other inputs = about $14.34/month;1GB may OOM with API+DB, not recommended without measurement |
| A, demo-only40h/month | $0.84 t3.small compute + $0.20 active IPv4 + $1.60 full-month EBS + $1.50 reserve = about $4.14; release idle Elastic IP or it continues charging |
| B | About $14.34 EC2micro base + RDS hours/storage: provisionally model $0.016–0.03/h ($11.68–21.90) +20GB at assumed $0.115/GB ($2.30): about $28.32–38.54/month, excluding extra backup/cross-AZ charges |
| C, Lambda + private RDS | Same provisional RDS floor $13.98–24.20 + low request/compute/log costs: planning range $15–27/month; more if egress/proxy/endpoint components required |

RDS unit rates above are explicit budgeting assumptions, NOT independently verified chosen-Region prices; they must be replaced with calculator/export evidence before approval. [RDS pricing](https://aws.amazon.com/rds/postgresql/pricing/). Lambda at10k requests,1GB,200ms uses2000GB-seconds, within published request/compute free limits if available and unused by other workloads; persistent DB does NOT scale to zero. Pricing below allowances does not establish Free-plan service access.

Backup/log $1.50 is a reserve assumption, not a cap. Check S3 regional storage/PUT/GET/restore/transfer and version retention, EBS snapshot changed-block storage, log ingestion/retention/custom metrics/alarms, email delivery and public egress. Prefer basic EC2 metrics and bounded rotating logs; detailed monitoring/custom dashboards only when justified. [S3 pricing](https://aws.amazon.com/s3/pricing/), [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/). Do not silently create S3 even for backup; approve destination first. No attachment store is authorized.

## Identity/session candidate

Cognito Lite is preferred candidate, NOT approved provider implementation. Base direct/social sign-in has10k MAU allowance for eligible accounts; SAML/OIDC federation has a different allowance and SMS/email/add-ons can cost extra. New pools default to Essentials: explicitly verify Lite if chosen. Lite lacks newer managed-login/passwordless/threat features; confirm classic hosted sign-in, required MFA/recovery and staff onboarding meet needs. Avoid paid advanced-security or SMS dependencies unless explicitly approved. [Cognito pricing](https://aws.amazon.com/cognito/pricing/), [feature comparison](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html).

Keep provider issuer/subject -> internal user mapping separate from database RBAC. Later use OIDC code+PKCE/state/nonce verification if approved; create opaque backend session with hashed token, PostgreSQL persistence, Secure/HttpOnly/host-only SameSite cookie, idle30m/absolute8h configurable, CSRF token+Origin checks. Do not treat Cognito groups/token roles as sole application authority. Do not cache session validity/permissions. One indexed session lookup plus grants/record checks per request, small shared pool, measured load; bounded expiry cleanup. PostgreSQL is suitable provisionally; review session lookup/last-seen write contention before cloud. No Redis. No provider SDK, login callback, user pool or live session table implemented here.

## Recommendation and security gates

Recommend A on eligible t3.small Linux x86 (2GB) for short scheduled synthetic demos; t4g.small may consume fewer credits but needs ARM/Linux verification. Build locally/approved Linux build environment; do not compile Prisma/TS on a memory-constrained live host. Pool initially2–5 total per process, bound worker/overlap; burstable standard CPU mode to avoid surplus charges (accept throttling; confirm setting). Stop outside agreed demo windows. If adequate RAM/eligibility/HTTPS/backup cannot be satisfied within balance, stay local rather than upgrade Paid or deploy insecurely.

Before launch: prove HTTPS through a host reverse proxy (Caddy/Nginx candidate), existing controlled hostname and renewable certificate; HTTPS only API; Node listens127.0.0.1, exact trusted proxy, approved frontend origin. Port80 only if certificate challenge/redirect requires. PostgreSQL Unix socket or127.0.0.1; no public5432/3001. Distinct least-privilege app DB role, restricted migration role, OS user; no public superuser/trust auth. Secrets in protected environment/system service credentials, never Git or instance user-data logs. IAM instance profile narrowly scoped, IMDSv2, root MFA; administration via approved restricted access, never SSH open to world. Avoid accidentally upgrading via Organizations.

Encrypt EBS/backups; consider AWS-managed encryption versus custom-key charges. Independently stored encrypted logical backup, integrity verification and restore to a fresh local PostgreSQL17 before any real data. Proposed daily dump/7-day retention and demo RPO24h/RTO4h are review targets, not accepted guarantees; memory/synthetic data loss accepted only explicitly. Restore tests must include schema, role restoration and access/audit integrity. Keep logs7days max initially, no answers/tokens/URLs, rotation/disk ceiling; monitor RAM/disk/CPU/burst credits, health and credit balance daily. HTTPS/IAM/backups are deployment gates, not implemented cloud controls.

Returning users: hashed public assets long-lived browser/CDN cache where existing hosting supports; do not add a CDN unnecessarily. Private API no-store. User-scoped memory query cache, fresh session restoration and server checks; cache cleared on logout/account switch/denial; optimize queries/indexes/pagination before infrastructure. Frontend owner must review integration; zero frontend edits here.

## Mandatory predeployment evidence / stop procedure

Record Free plan and no-upgrade status; available credit amount/expiry and account end date; eligible Region/AMI/type;730h versus scheduled hours; EBS/snapshot and CPU-credit settings; IPv4 active/idle; network egress/cross-AZ; Cognito tier/MFA/email/SMS; S3 operations/retention; monitoring/backup costs; hostname/certificate; approved recovery targets and restore evidence. AWS pricing calculator export + Billing console check before any resource request. Balance and expiration remain UNKNOWN in this review. Proposed buffer: stop before projected remaining lifetime ends, with at least7days lead for export; obtain exact thresholds from owner. Do not earn credits by deploying unnecessary resources.

Shutdown: notify owner, stop intake, drain API/worker, capture and VERIFY encrypted off-host backup, stop DB cleanly, stop instance, release Elastic IP if not required; verify retained EBS/snapshots/logs still consume credits. For full teardown explicitly approve deletion after restore/export verification; terminate instance and review volumes/snapshots/IP/logs/buckets/versions/DB backups/identity resources, then confirm Billing inventory. Never delete evidence automatically. RDS stop is temporary and restarts after7days; it is NOT a permanent cost stop. [RDS stop behavior](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html). Near plan expiry finish export/teardown rather than upgrading. No shutdown/deletion commands executed.
