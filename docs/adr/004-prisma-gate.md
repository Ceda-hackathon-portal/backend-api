# ADR 004: Prisma compatibility and delivery gates

Date: 2026-11-09
Status: Accepted for tested combination; deployment checks open

## Context

ORM7 requires explicit ESM, configuration and driver adapter integration.

## Decision

Windows spike passed Node24.22.2, Prisma7.10.1, PostgreSQL17.11 and strict TS5.9.3. Keep spike generic/separate. Production package requires new Phase3 approval.

## Consequences and alternatives

Windows does not establish Linux/RDS/TLS/performance compatibility. No provider login, attachment storage, CEDA business modules or AWS resources authorized.

User-specific approval gates override this record. See ../DECISIONS.md and ../PHASE3_PLAN.md. Never modify frontend-owned files or files outside backend/ without explicit user approval.
