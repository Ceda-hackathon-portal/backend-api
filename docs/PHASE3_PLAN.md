# Phase 3 approval gate

Authorized by the owner after committing Phase 1/2 as 103fa6f on 2026-11-09. Foundation work is now implemented; see FOUNDATION.md for actual scope/checks. Further domain/provider/storage/deployment work remains gated.

Proposed foundation only (no automatic identity provider/business/storage/AWS implementation):

1. Recheck branch feature/backend and git status; preserve teammate changes; edits strictly backend/.
2. Create backend-local production package with approved Node24/strict TS/ESM/Express/Zod, separate from spike package; pin compatibility-tested versions.
3. Validated environment, app/server separation, safe request IDs/structured logs, centralized errors and no-store defaults, bounded JSON input, explicit CORS/trust-proxy policy, liveness/readiness, graceful shutdown.
4. One bounded database adapter per process with certificate validation and timeouts; backend-local migration/test harness. No production schema or credentials copied from disposable trust-authenticated spike.
5. Define identity-independent Principal/authorization ports and fail-closed interfaces, but no provider-specific login or self-selected live roles.
6. Add meaningful foundation HTTP/config tests and PostgreSQL integration harness; contract/OpenAPI validation before business module integration. No arbitrary empty module scaffolding.
7. Report backend-only changed files, checks and outstanding policy gates. Identity, applications, attachment storage and deployment need their separate approved scope.

Compatibility is not security certification or a performance benchmark. Linux container generation/runtime/TLS/RDS verification remain deployment gates even after Windows spike passes. Never modify frontend files, shared workflows or root configuration to make foundation work. No commit/push/merge/provision without user approval.
