# ADR 003: Identity-independent access and no private HTTP caching

Date: 2026-11-09
Status: Accepted; provider deferred

## Context

Returning users need responsive access without stale authority or cross-account leaks.

## Decision

Opaque DB sessions, configurable30m/8h; fresh server checks and scoped grants. Confidential HTTP no-store. Client private caches memory-only, user/session generation scoped. No Redis.

## Consequences and alternatives

Auth adapter remains open. Late responses must be discarded on switch; logout revokes database session. Previously delivered content cannot be retracted.

User-specific approval gates override this record. See ../DECISIONS.md and ../PHASE3_PLAN.md. Never modify frontend-owned files or files outside backend/ without explicit user approval.
