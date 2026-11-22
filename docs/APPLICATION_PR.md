# Application API PR

Base: reviewed canonical backend 9af1779. Target develop after the canonical foundation PR.

Persist authenticated applicant intake in PostgreSQL and expose owner-only draft, revisioned update, idempotent submit and immutable-version read endpoints. Reuse Cognito sessions, origin checks, cookie-bound CSRF and canonical error/request-ID middleware. Every mutation commits state, receipt where applicable, audit and outbox together.

Add the eight-table application migration and a separate runtime identity-guard migration. Supply a least-privilege role provisioning script, tested using a distinct SCRAM-authenticated login. Runtime cannot perform DDL, TRUNCATE, migration-table access or protected-record changes. Role provisioning changes PUBLIC database/schema privileges and requires target-specific review.

Validation: strict TypeScript, Prisma validation/generation, production build, 20 unit/HTTP tests, two compiled smoke tests, five PostgreSQL integration suites, clean replay twice. OpenAPI YAML parses, all local references resolve and five application operations are documented. Fault-injection triggers are scoped to individual fixtures to keep parallel suites isolated.

Limitations: no shared deployment or migration execution; real Cognito browser flow, target role inventory and backups still require approval. Current session role/grant arrays remain empty. Tenant isolation is enforced through the service/repository and endpoints; no database per-applicant RLS. Eligibility-specific tables and policy changes await B's review. Delivery worker and later workflow stages remain subsequent work.

Changes are backend-local. Foundation changes are inherited through ancestry, while this application PR's incremental diff is against 9af1779. Shared develop remains 5888eca and the canonical merge check is clean. Confirm existing PR queue with repository maintainer before publication because the connector cannot retrieve it.
