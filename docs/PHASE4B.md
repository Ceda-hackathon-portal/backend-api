# Phase 4B local identity/session implementation

Scope approval: owner said "proceed to 4B"; Cognito Lite selected for local provider adapter. No AWS resources/changes, no deployment, no frontend edits, no commit/push. Existing Phase4A and verification uncommitted files preserved.

## Delivered

- Maintained openid-client6.8.9 code flow with S256 PKCE, state, nonce, JWKS signature checks, issuer/audience/time validation,5s network timeout. Tests use local synthetic HTTPS responses and signed JWTs, not AWS.
- Browser-bound single-use login attempts, payload AES256-GCM encrypted with a server-owned32-byte key; hashed random cookie identifiers; five-minute expiry. No verifier/provider token plaintext in database/logs.
- Minimal Prisma7.10.1 identity/session schema and reviewed migration, runtime shared pg pool with health adapter (no new cloud service). Explicit users/identities/sessions tables map the earlier architecture; auth_attempts is the new ephemeral login table. Models AuthUser/AuthIdentity/AuthSession are scoped Prisma names, NOT parallel authoritative user tables. status ACTIVE/SUSPENDED; future user audit/profile/grants columns remain deferred and must be added via migrations.
- Unique issuer/subject mapping; new verified identity creates internal user, no email-only linking and no staff grant. Same email/different issuer/subject fails closed for administrative review; do not bypass uniqueness or auto-link.
- Opaque256-bit session cookies; SHA256 token hashes; transactional session creation and previous-cookie rotation; PostgreSQL current-time idle extension bounded by absolute expiry; UTC connections. Revoked/expired/suspended sessions deny. No refresh-token persistence or provider-dependent application grants.
- CSRF bootstrap and timestamped HMAC token bound to browser cookie; mutations verify token and exact Origin. Auth routes opt-in only. Safe errors, no-store, no URL/body/header logging unchanged. Shared pool disposal has one owner: Prisma leaves external pool open, shutdown closes it after Prisma disconnect.

## Verification and observed failures

Prisma validate and generate passed under Node24.22.2/TypeScript5.9.3; migration deployed only to disposable PostgreSQL17.11 and status up to date. Strict TS compile and17 unit/HTTP/crypto/OIDC tests passed.2 real DB tests passed (foundation timeouts/pool + auth persistence/revocation/expiry/rotation/suspension/no-email-link/atomic attempt consume). No skipped assertions and no weakened expiry tests.

One randomized tamper test initially replaced a base64 character with the same character; changed it to flip an actual decoded byte, so tampering is guaranteed. Database test initially rejected a newly created session due to timestamp/timezone mismatch; fixed by setting shared connections UTC and using database CURRENT_TIMESTAMP for session expiry creation/checks. An explicit returned-expiry UTC check protects against offset regression. No live user-pool/browser hosted-UI test performed. Disposable database stopped after each run. These results are not a production or cloud security claim.

## Configuration/run gates

Default AUTH_ENABLED=false. When enabled require issuer https://cognito-idp.REGION.amazonaws.com/POOL_ID, client ID, optional server-only secret, exact API/frontend origins, and64-hex AUTH_ENCRYPTION_KEY in protected environment. Generate key locally; never commit it. Production HTTPS required; HTTP allowed only explicit localhost/127.0.0.1 in nonproduction. No AWS credentials needed by the OIDC adapter. COGNITO_CLIENT_SECRET and key must never enter frontend, Git or user-data/log output.

Existing/new user pool configuration (ONLY after separate resource approval): Lite tier, approved callback API_ORIGIN/api/v1/auth/callback, authorization-code flow,openid/email/profile,PKCE,required email verification,reviewed MFA/recovery/signup settings. Cost/tier/Region/expiry review remains mandatory. Current issuer validation supports standard commercial AWS domains only; other partitions need reviewed validation changes. No user-pool creation commands/IaC added.

backend-local npm run build generates client automatically; npm run typecheck generates then checks. npm run db:validate validates schema. npm run db:migrate is MANUAL and requires explicitly reviewed DATABASE_URL; NEVER point at shared/unknown/production DB in tests. No auto-migration on startup. tests/run-database.mjs creates its own local cluster, applies identity migration, runs both integration suites and stops it. Build before running direct harness. Tests use the existing portable Node24/PG17 tooling; no system install needed.

## Risks / remaining work before deployment

- Real Cognito Lite registration/recovery/PKCE/MFA/callback/browser-cookie behavior and Linux/RDS/TLS remain unverified; no configured pool/IDs were supplied. All enablement remains local/disabled by default.
- Persistent application grants, authzRevision, staff onboarding/MFA assurance, real ScopedAuthorization reader and protected business integration are not included. No invented business role/eligibility/quorum policy.
- Expired auth_attempt/session rows need approved bounded housekeeping/retention before a public demo; no automatic destructive cleanup on shared data. Current single-process rate limiter resets on restart.
- Session lookup extends idle per request; measure row contention and use primary DB clock. Critical future workflow/grant revocation needs transactional locks, not a stale policy check. Cross-device revocation/admin suspension operations not exposed yet.
- Backend logout is distinct from hosted SSO logout; Cognito disable does not itself revoke our independent DB sessions. No provider admin credentials or token revocation calls used.
- Session endpoint roles=[]/role=null is intentional and documented in AUTH_CONTRACT.md; frontend integration requires owner review. Domain fields title/theme/problem/solution/impact/team untouched. No local password endpoints or /me mutation.
- Identity mutation audit records and deployment-grade abuse controls need review before real accounts. Synthetic data only until security/backups verified. No live deployment/production-readiness claim.

New files: prisma.config.ts, prisma/schema.prisma, prisma/migrations/{migration_lock.toml,202611090001_identity/migration.sql}; src/modules/auth/{config,crypto,provider,routes,store}.ts; tests/auth.test.ts,auth-provider.test.ts,auth-store.integration.test.ts; docs/AUTH_CONTRACT.md,PHASE4B.md. Updated backend package/lock/env example, database/server/test harness and documentation indexes/contracts. All writes remain backend-local.

Primary references: https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html ; https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html ; https://github.com/panva/openid-client/blob/main/examples/oidc.ts .
