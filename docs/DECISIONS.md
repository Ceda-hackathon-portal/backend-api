# Decisions requiring approval

| Decision | Current status / next action |
|---|---|
| Local credentials vs managed OIDC | OPEN. Choose after assurance, SSO, MFA, onboarding and operating-cost review; no provider-specific login authorized |
| Eligibility | OPEN. Configure published requirements once validated; do not invent nationality/entity rules |
| Quorum/review rounds | OPEN. Configure count/consensus/re-review semantics |
| Scales/weights/rounding | OPEN. Frontend 1-5 and four named criteria are illustrative only |
| Conflicts | OPEN. Define timing, resolution authority, reassignment and validity of prior evaluations |
| Feedback/reviewer visibility | OPEN. Decide audiences, release authority, anonymity and replies |
| Revision deadlines | OPEN. Define time zone, windows, late exceptions and editable fields |
| Appeals | OPEN. Do not assume unsupported or design a fabricated process |
| Retention/deletion | OPEN. No destructive cleanup of business evidence until approved |
| Residency | OPEN. Determines region, backups, logging and processing locations |
| AWS | OPEN region/budget/availability/RPO/RTO; ECS Fargate candidate only; no provisioning/costs |
| Local password policy | OPEN if local credentials selected; frontend min 8 is not an approved production policy |
| Collaborative ownership | OPEN. Current team field is text, not team membership/access |

## Attachment proposal: NOT approved for implementation

Candidate allowlist: PDF, PNG, JPEG; initially exclude SVG, HTML, scripts, archives and executable/macro-enabled office files. Proposed limit 10 MiB/file, five files/application, 50 MiB aggregate. Business owner must approve types, sizes, count, scanning service and retention before storage implementation.

Private bucket, public access blocked, task-role least privilege, server-generated unique keys, signature/checksum/size verification, MIME sniffing, malware quarantine and scan. Never equate extension or declared Content-Type with verified type. Scan failure stays quarantined; no download/submission link until clean. Submitted versions bind exact scanned object versions or immutable promoted objects; reusable signed PUT must not overwrite submitted evidence.

Candidate upload URL 5m, download URL 60s; authorize every issuance and use no-store headers. A previously issued signed URL remains a bearer capability until expiry despite logout. If immediate logout/revocation protection is required for file bytes, use authenticated streaming downloads instead. Force safe download disposition/filename; do not log URLs. No S3 SDK/storage code or AWS resources yet.

Reference: https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html .
