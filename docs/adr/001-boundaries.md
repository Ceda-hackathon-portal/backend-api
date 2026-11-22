# ADR 001: Isolation and modular monolith

Date: 2026-11-09
Status: Accepted

## Context

Shared frontend is actively maintained by another developer.

## Decision

All writes remain backend-local. REST /api/v1/applications, Node24/TS/Express/PostgreSQL17, worker entry only when needed. No frontend integration or shared configuration changes without explicit approval.

## Consequences and alternatives

A separate package avoids root dependency conflicts. Shared hosting routing still needs frontend-owner review. Microservices add coordination without measured benefit.

User-specific approval gates override this record. See ../DECISIONS.md and ../PHASE3_PLAN.md. Never modify frontend-owned files or files outside backend/ without explicit user approval.
