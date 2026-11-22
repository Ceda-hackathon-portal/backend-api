# Phase 4A/4B security verification

Date: 2026-11-09. Recommendation: **NO-GO for Phase5 protected business development until the authorization persistence/integration gaps are resolved and reviewed. NO-GO for deployment/real accounts.** Local remediation/testing can continue only under approved scope. No Phase5, production fixes, frontend changes, AWS provisioning, deployment, commits or pushes performed.

## 1. Implementation inventory and repository evidence

Branch feature/backend; HEAD c1f91f3 (Phase3). Recent commits103fa6f (Phase1/2),81c67b0 (backend instructions). **There are no Phase4A/4B commits.** Their source/docs/package changes were already uncommitted at entry and preserved. Earlier verification report also pre-existed. This review adds only tests/run-phase4-verification.mjs, tests/phase4-security.integration.test.ts and this report; ignored .runtime evidence/generated outputs are backend-local. No pre-existing tests or production behavior changed.

| Component | Actual state |
|---|---|
| Provider | CognitoProvider implemented with openid-client6.8.9; opt-in AUTH_ENABLED; no local password authentication |
| OIDC | Code grant,PKCE S256,state,nonce,issuer/audience/expiry,explicit JWKS signature checks implemented; synthetic-response tests only |
| Users/identities/sessions | Prisma7.10.1 schema/migration and PostgreSQL-backed store implemented |
| Login attempts | AES256-GCM payload,hashed browser-binding identifier,single-use consume,expiry implemented |
| Session verification | Cookie -> hash -> DB active/unrevoked/unexpired check with bounded idle renewal; verifier exported |
| Authorization | ScopedAuthorization policy engine and reader interface; unit fixtures test owner/programme/assignment/version checks |
| Roles/permissions/scoped grants | **NO database tables,seed,persistence,real reader or administrative grant endpoints**; not completed operational RBAC |
| Auth response | roles=[];role=null;grants=[] explicitly; no authzRevision |
| Protected resource APIs | Not implemented; test-only route used to exercise real session verifier + deny-default policy |
| CSRF | Bound timestamped HMAC,exact Origin checks for login/logout; CORS independently restrictive |
| Security audit | HTTP request/error logger exists; **no durable security audit events for identity/session/grant changes** |

## 2. Actual provider / real integration status

Code/config identify Amazon Cognito user-pool OIDC, not assumed from prose. Cognito Lite is the intended tier; tier cannot be verified from this adapter and no live pool exists in test configuration. No AUTH_/COGNITO_ environment variable names or backend/.env were present in the inspection (values never printed). No dedicated live test identity or authorized safe pool supplied. **Real-provider sign-in,registration,recovery,MFA,hosted logout and real browser callback cookies: UNVERIFIED/BLOCKED**, not passed. No AWS calls/resources were made to substitute for missing setup.

## 3. Static commands and outputs

From backend, process-local PATH prepended with spikes/prisma7/node_modules/node-win-x64/bin (Node24.22.2), no system changes:

| Command | Observed result |
|---|---|
| npm.cmd run typecheck | prisma generate + tsc --noEmit;exit0,no diagnostics |
| npm.cmd run build | prebuild prisma generate then strict tsc;exit0 |
| npm.cmd run db:validate | `The schema at prisma\\schema.prisma is valid`;exit0 |
| Prisma client generation (typecheck/build) | `Generated Prisma Client (7.10.1)`;123/324/148ms across executed stages |
| npm.cmd ls --depth=0 | exit0;installed direct versions consistent,no missing/invalid packages |
| npm.cmd test |17tests,17pass,0fail,0skip;1330.1014ms |
| npm.cmd audit --json --cache .npm-cache --fetch-retries=0 --fetch-timeout=30000 | Initial sandbox endpoint error;approved registry retry exit0,zero advisories |
| node node_modules/typescript/bin/tsc | New verification test compilation;exit0 |
| portable Node24 tests/run-phase4-verification.mjs | Fresh local cluster,identity migration deploy/replay/status,3integration tests pass,0fail/skip |
| portable Node24 run.mjs from spikes/prisma7 | validate/generate/deploy twice/status/strict compile,8runtime checks pass,cluster stopped |

Portable Node24 means .\\spikes\\prisma7\\node_modules\\node-win-x64\\bin\\node.exe from backend (inside spike omit spikes/prisma7). Verification wrapper reuses existing safe disposable harness, adds the security suite and repeats migration deployment; it does not modify the normal test script. Lint: NOT RUN, no configured script/config. Phase1 is documentation, no executable suite. No package upgrades/reinstall occurred. No tests were weakened to conceal findings.

## 4. Test types and results

| Evidence type | Count / result | Limits |
|---|---|---|
| Existing unit/HTTP/policy/crypto tests |17pass,0fail,0skip | HTTP auth test uses memory store + mocked identity; policy snapshots are fixtures |
| Existing foundation/auth-store PostgreSQL integration |2pass | Actual users/identities/sessions,not actual grants/provider |
| Added HTTP + real DB verification |1pass,26HTTP status/header checks plus DB/concurrency/privacy probes | Provider is mocked; completion of diagnostic probe is NOT a pass for every security requirement |
| Phase2 Prisma regression |8checks pass | Generic fixtures,not production RBAC |
| Real Cognito / manual browser |0executed | Unverified; no safe configured identity/pool |

**A failed security expectation was observed despite passing suite execution:** old sessions survive suspension and work again after account reactivation. Diagnostic output records this as a finding; no pass is claimed for irreversible suspension revocation. No functional test failures/cancellations/skips occurred in these executed suites. Scope-blocked scenarios below were not registered as skipped tests and must not be counted as passed.

## 5. Positive authentication

Existing synthetic OIDC test uses generated RSA key/JWKS and the real openid-client adapter to validate a signed token. New integration uses a deliberately mocked provider with real Prisma persistence to exercise callback -> user/identity/session -> /auth/session. Valid local callback303 and authenticated session200 executed. Neither proves a real Cognito pool works. Existing tests verify PKCE verifier sent to the synthetic token endpoint; real provider rejection of bad PKCE remains unverified.

## 6. Negative authentication / authorization

Executed missing/malformed/duplicate session cookie401; missing browser callback binding401; single-use replay401; wrong OIDC state/nonce/signature/issuer/audience/expiry/unverified email rejected by synthetic adapter tests. Same-email/different-subject mapping rejected in real DB; no automatic account linking. Suspended user denied session lookup and new session creation. Existing unit policy tests reject revoked/expired grants,wrong user/programme/record,unassigned/revoked/conflicted/wrong-version evaluator,unknown permission and unavailable reader.

New HTTP tests submit each role value (submitter,evaluator,adjudicator,administrator,management,system-administrator) in login JSON: all422, no privilege accepted. Real-session test-only protected route returns403 under deny-default even with forged userId/programmeId/role query; no session returns401. These are anti-forgery/default-denial results, **not positive tests of six operational roles**. Actual applicant/evaluator/adjudicator/admin/management/system permissions and revocation from database grants are BLOCKED because grant persistence/reader/resource APIs are absent. No simulated grants are reported as database-backed authorization.

## 7. Session lifecycle

Executed creation,opaque43-character token cookie/hash persistence,restoration,rotation invalidating previous token,idle/absolute expiry rejection,renewal capped at absolute limit,logout server revocation/replay rejection,independent concurrent sessions and concurrent find/revoke followed by final denial.1000 locally generated random tokens were unique; this is a smoke property, not entropy proof. Source uses cryptographic32-byte random generation. DB stores SHA256 token hash,not raw token; test confirms lookup hash differs from cookie. User FK rejects nonexistent identity owner. New explicit transaction rollback leaves user count unchanged. Existing unique identity/email/session constraints exercised.

Idle/absolute expiry tests expire isolated rows; production timeout defaults30m/8h were not reduced or bypassed. Renewal uses current PostgreSQL time and UTC connections. Session updates can contend on a row; sampled concurrent validation completed. Permission-change session behavior and concurrent grant revocations are NOT TESTABLE against actual grants yet. Session fixation rotation passed existing DB test; automatic Cognito-wide signout/session invalidation on provider account changes unverified/not implemented.

Observed suspension reactivation: suspend ->401; attempt session creation while suspended rejects; reactivate -> old unrevoked session becomes valid again. High-priority lifecycle decision/fix: transactionally revoke sessions when disabling identity,or adopt per-user session epoch and explicitly define reactivation semantics. No production fix made here.

## 8. CSRF / cookies / CORS

Executed missing/invalid CSRF403;anonymous token used with authenticated session403;wrong Origin403;Origin:null403;trusted Origin success;timestamp-expired/cross-cookie token rejected by crypto tests. Login/logout validate strict empty-body schema;extra role keys422. Production cookie headers assert Secure,HttpOnly,SameSite=Lax,Path=/ and __Host- names. Actual browser SameSite/site-boundary behavior remains UNVERIFIED: Node fetch manually supplies cookies and does not enforce browser cookie policy. Different localhost/127.0.0.1 origins must not be mistaken for same site. CORS is not the CSRF mechanism.

## 9. Database / concurrency

Only newly initialized UUID-named loopback PostgreSQL17.11 clusters used. Wrapper ignores caller DB URL,applies identity migration,repeats deploy (`No pending migrations to apply.`),checks status (`Database schema is up to date!`),then stops cluster. Separate Phase2 cluster applies both generic migrations/replay. No shared/unknown/production database access/reset. Users,issuer/subject identities,session/attempt persistence tested. Atomic concurrent attempt consume has one winner;concurrent session validation/revocation final lookup denies. Unique/FK/rollback/immutability checks pass across actual auth and spike fixtures. Roles/grants tables/transactions are absent,not tested. All clusters reported stopped; final PID-file check is part of isolation verification.

## 10. Cache / privacy / API errors

All26 new checked responses (200/303/401/403/422/500) asserted Cache-Control:no-store;rate-limit429 also checked. Existing foundation tests cover malformed JSON400,unsupported type415,oversized body413,unknown route404 and strict validation422. Injected store outage produces sanitized500 without private marker. Captured application log call sites did not contain raw session token,email or private error marker. Logger sink is test-controlled; production redaction config also inspected,not every future log call proven safe. Provider tokens/verifier never appear in auth JSON; session token only in expected HttpOnly cookie. Other-account access protected by server cookie lookup; full browser account-switch/cache clearing is frontend work and NOT verified.

No /me/resource CRUD API exists,so UUID/path-ID validation on such endpoints is pending. Existing record-policy tests cover manipulated string identifiers independently. Login/callback per-IP rate limit429 executed. No durable audit trail,global rate-limit state or deployment abuse tests; CORS/request errors do not prove those capabilities.

## 11. Read-only dependency audit

Backend audit: exit0,info0,low0,moderate0,high0,critical0,total0;246dependency entries reported. Separate spikes/prisma7 audit also exit0/all0;159entries. Initial sandbox registry attempt failed,then explicitly approved network retry succeeded. No audit fix/upgrade command used. Findings represent registry-known advisories for installed lockfiles at test time,not proof of no vulnerabilities in application code or dependencies. Raw ignored evidence .runtime/phase4-audit.json and spikes/prisma7/.runtime/phase4-spike-audit.json.

## 12. Authenticated local performance

Windows10.0.26300,Intel Core i3-10110U2.10GHz,4logical CPUs,7.84GiB RAM,Node24.22.2,PostgreSQL17.11,Prisma7.10.1,loopback HTTP,no TLS. App factory + actual auth router/Prisma store,synthetic identity bootstrap; shared test load with other integration suites and spike; logging enabled. Each endpoint10warmups,100measured calls,5concurrent workers,body consumed. Single run,not AWS/production/load-capacity evidence. Error rate below means unexpected status relative to intentionally selected200/403/401.

| Endpoint / expected response | Median | p95 | Requests/concurrency | Unexpected errors |
|---|---:|---:|---:|---:|
| GET /api/v1/auth/session200 |17.37ms |34.10ms |100/5 |0% |
| GET /api/v1/verification-only/denied403 |20.57ms |81.28ms |100/5 |0% |
| GET /api/v1/auth/session401,no cookie |28.25ms |54.41ms |100/5 |0% |

The denied route exists ONLY in the test router,using real session verifier + default-deny policy. It is not a production resource or successful grant lookup. Session response includes current user profile; separate /me,allowed protected resource and DB-grant performance are pending. No real provider latency measured. Raw sanitized results backend/.runtime/phase4-security-results.json; no tokens/PII in artifact.

## 13. Regression / isolation

Existing17tests and8spikechecks pass;2existingintegration tests pass plus new verification test. Strict typecheck/build/schema generation/validation pass. Health/no-store/shutdown regression covered existing suite. No frontend/root/shared deployment changes; pre-existing backend changes preserved. This verification introduced only two backend test files and this report,not production fixes. No test automatically discovered via existing npm test script; reproduce added suite explicitly through tests/run-phase4-verification.mjs after build. No commits/pushes/deployments/resources.

## 14–16. Findings, unverified work and recommended fixes

| Severity | Finding | Action |
|---|---|---|
| BLOCKER | Actual roles/permissions/scoped grants and live reader are not persisted/wired; all role responses empty; six real role tests cannot execute | Complete reviewed RBAC persistence/reader and negative DB-backed tests before protected Phase5 flows |
| BLOCKER for real-provider acceptance | Cognito pool,tier,test identity/callback flow not verified | Owner supplies approved safe configuration and test identity; run real HTTPS/browser flow without provisioning implicitly |
| HIGH | Old sessions resume after suspension/reactivation | Decide explicit policy,then atomic revoke/session-epoch remediation and regression; no silent fix in verification |
| HIGH before real accounts | Security audit logging absent for identity/session/grant changes | Implement reviewed durable/redacted actor/action/result audit events and tests |
| MEDIUM | Cognito deactivation/global logout not synchronized with independent local sessions | Define revocation propagation/maximum exposure and test it;do not advertise immediate provider disable |
| MEDIUM | Real browser SameSite/account switching/HTTPS,staff MFA,proxy/limiter behavior,Linux/RDS/TLS/backups unverified | Coordinate separate approved integration/deployment verification,synthetic data until proven |
| MEDIUM | Retention/expiry cleanup absent;limiter resets on restart and is per-process | Approve bounded cleanup/retention and abuse-control operating policy before public service |
| LOW | Lint unconfigured;default test command omits new verification suite;some spike rejections accept generic errors | Add reviewed CI/test discovery/lint and more specific error assertions later; no changes made here |

No claim of hardcoded live secrets discovered; only fixture/example values reviewed. No claim that unknown credentials are safe or no vulnerabilities exist beyond tests. AWS Free-plan controls remain documented constraints,not deployed/verifiable account controls; no Paid upgrade/cost incurred by AWS actions.

## 17. Decision

**NO-GO for Phase5 as an authenticated/authorized application feature increment.** Foundational local tests are green,but missing operational grants/audit and unverified real provider prevent security sign-off. Diagnostic suspension finding is a failed security property,not hidden by green harness completion. Request approval for targeted remediation/real-provider test setup; stop here. Production behavior intentionally unchanged.
