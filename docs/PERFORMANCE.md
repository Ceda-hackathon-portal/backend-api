# Caching, performance and verification plan

Targets are provisional engineering goals, not measured results or CEDA requirements. No Redis in MVP. Do not cache to hide bad queries.

| Resource | Location/key | TTL | Owner/authorization | Invalidation | Stale behavior |
|---|---|---|---|---|---|
| Hashed public assets | Browser/CDN, content-hash URL | 1 year immutable | Frontend deploy; public | New filename | Old build assets valid |
| HTML | URL/ETag | Revalidate | Frontend hosting; public shell only | Deploy/ETag | Must discover new assets |
| Public configuration | Programme/version/representation + canonical filters | Browser60s/CDN300s | Published public projection | Publish/pause/withdraw; purge CDN | Brief public staleness; server intake checks authoritative |
| Session/CSRF/auth | None | 0 | Current session | Login/logout/expiry/revocation | Fail closed, never cached identity fallback |
| Applicant lists/details/profile | In-memory user/session-generation/authz-revision/resource/filter key | <=15s in verified session | Current owner/grants | Mutation/logout/switch/401; route/focus revalidation | No private display before fresh restoration; commands always recheck |
| Draft | Active editor memory | Editor lifetime | Owner/permitted revision | Save/submit/logout/expiry | 409 on stale revision; no silent overwrite |
| Evaluation/decision/conflict/audit | Current view only, no reusable query cache | 0 HTTP | Current scoped assignment/capability | Revocation/recusal/finalize/focus | Clear on denial; refetch before reuse |
| Reports/notifications | User/scope/filter memory | <=15s | Scoped reports/recipient | Publication/read/state change/logout | Display generatedAt; active poll/focus refresh |
| Signed URLs (deferred) | No persistent cache | Candidate60s GET | Reauthorized access | Expiry | Cannot immediately revoke delivered capability; streaming alternative |

All confidential authenticated HTTP responses use Cache-Control: no-store (may additionally use private). Mutations, errors, auth and attachment capability responses no-store. No private HTTP browser/CDN cache, localStorage, IndexedDB or service-worker persistence. Memory query cache is explicit application state, not HTTP caching.

CloudFront authenticated behaviors must have minimum/default/maximum TTL=0. Positive minimum can override no-store: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-key-understand-cache-policy.html . Public configuration behavior must be allowlisted, identical for anonymous/authenticated requests, not Set-Cookie, and never contain unpublished criteria/guards. Include all permitted varying inputs in keys; reject arbitrary host/header/query variation to prevent poisoning. Vary: Origin alone is not a private-data isolation strategy.

Logout: revoke DB session, clear cookie, cancel requests, clear all private memory, broadcast nonsensitive logout signal to other tabs. Switching: increment client session generation; old in-flight responses discarded. Expiry/401: clear identity/private data. Grants: increment authz_revision transactionally, check live DB permissions each request; cache TTL never grants access. Assignment revocation denies next request even with old client cache. Mutations invalidate list/detail/draft/history/summary; feedback publication also invalidates notifications; final evaluations invalidate evidence/workload; new criteria create new pinned config version. Existing screens cannot undisclose delivered content. Focus/route/login/refresh always revalidate before private reuse; active-screen polling can update operational displays without being an authorization mechanism.

Optional future Redis only with measured need: public-config:{programme}:{version}:{representation}, TTL300s, current alias<=60s, commit/outbox invalidation. No permissions/session/evaluation cache. Failure bypasses to bounded DB reads; never allows access. Add jitter/coalescing and size bounds; account for service/monitoring/invalidation cost.

## Measurement

| Operation | Provisional target |
|---|---|
| Simple authenticated API/session restore | p95<200ms |
| Database-backed list (20 rows) | p95<500ms |
| Draft save | p95<300ms |
| Submit excluding upload/scan/email | p95<500ms |
| Unexpected load-test errors | <1%, zero unauthorized successes |
| SQL / pool wait investigation thresholds | p95>50ms / >25ms |
| Browser | p75 LCP<=2.5s, INP<=200ms, CLS<=0.1 |
| Returning usable workspace | Proposed p75<=1.5s under agreed profile; current loader prevents this |

Repeatable future load suite: record commit, fixture seed, Node/DB/image, CPU/memory, region and pool limits. Seed 10k applications/30k versions/20k assignments; growth run100k applications. 50 concurrent users/~25RPS:60% list,20%detail,10%draft,5%session,5%workflow. Warm2min, measure10min, repeat3. Separate cold/warm/burst and auth hashing tests. Report p50/p95/p99, throughput/error rate, pool wait, SQL/lock times, CPU/memory/event-loop delay, outbox lag; distinguish network RTT from server time. No performance claims from compatibility smoke tests.

Browser: production build, fixed browser/device/CPU,4Mbps down/1Mbps up/150ms RTT; fresh context versus valid-session/warm-assets context. Deduplicate restoration/current-view calls; avoid downloading unchanged hashed assets. Frontend owner handles route splitting, loader waits, optimized responsive images and fonts. Current public PNG names unversioned: do not apply year-long immutable caching until fingerprinted. No private prefetch/offline mode.

Queries: keyset pagination default20/max100; stable ID tie-break; allowlist filters/sorts; cursor bound to filter but not trusted authority. Scoped repository queries and bounded select/batched relations prevent N+1. Aggregate reports in SQL; only add materialization after profiling. One pg/Prisma pool per process, initial max5 to be measured; include workers, deploy overlap and reserved maintenance in connection budget. Explicit acquisition/statement/lock/transaction timeouts. No network inside transactions. Use pg_stat_statements/EXPLAIN ANALYZE BUFFERS on safe representative fixtures.

## Future security/performance test matrix

First visitor/public-only; returning verified user; refresh valid session without private flash; expired/revoked session; logout cookie replay; account switching with delayed responses; guessed/cached unauthorized IDs; role removal; reviewer reassignment and recusal; concurrent revisions; duplicate idempotent submit; simultaneous decisions; private-before-public feedback; configuration pinning; N+1/query plans; poisoning and cross-programme caches; DB outage fail-closed503; optional Redis outage DB fallback; outbox retry idempotency; attachment verification/overwrite/quarantine; backup restore/migration rehearsal.

API tests must prove private data cannot be fetched using the old cookie after logout. Previously issued signed file URLs are a separate explicit policy tradeoff. Real PostgreSQL integration, policy unit tests, HTTP tests and coordinated browser tests precede production claims.
