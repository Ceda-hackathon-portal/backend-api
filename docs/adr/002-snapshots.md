# ADR 002: Drafts, snapshots and version-bound review

Date: 2026-11-09
Status: Accepted

## Context

Incomplete work must be saved while submitted evidence remains traceable.

## Decision

Application maps submissions; draft nullable; complete submitted versions immutable. StageRun pins version; assignments pin run; evaluations pin assignment. Recommendations, final decisions and publication distinct.

## Consequences and alternatives

More relational constraints and SQL review, but no mutable historical evidence. Do not duplicate authoritative parent answers or silently reuse old-version scores.

User-specific approval gates override this record. See ../DECISIONS.md and ../PHASE3_PLAN.md. Never modify frontend-owned files or files outside backend/ without explicit user approval.
