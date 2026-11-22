# Backend architecture baseline

- [Phase 4B implementation and remaining gates](PHASE4B.md)
- [Current Cognito/session API contract](AUTH_CONTRACT.md)

- [Phase 4A local authorization status](PHASE4A.md)
- [AWS Free-plan deployment decision](adr/005-free-plan-deployment.md)

Status: conditionally approved by the backend owner on 2026-11-09. Domain contracts remain proposed. Phase 2 contains an isolated compatibility experiment; Phase 3 foundation was subsequently authorized and implemented (see below).

- [Implemented foundation and verification](FOUNDATION.md)
- [Implemented health OpenAPI contract](openapi.yaml)

- [Architecture and ownership](ARCHITECTURE.md)
- [Frontend field inventory](FIELD_INVENTORY.md)
- [API contract](API_CONTRACT.md)
- [Data model](DATA_MODEL.md)
- [Authorization matrix](AUTHORIZATION_MATRIX.md)
- [Workflow proposal](WORKFLOW.md)
- [Caching, performance and tests](PERFORMANCE.md)
- [Unresolved decisions and attachment proposal](DECISIONS.md)
- [Architecture decision records](adr/README.md)
- [Compatibility results and Phase 3 gate](COMPATIBILITY.md)

All changes must stay inside backend/. Never modify frontend-owned files, root configuration, shared deployment settings or root instructions without explicit user approval. Owner authorized the Phase1/2 commit103fa6f, Phase3 foundation and its commit. No push, merge, AWS provisioning or paid resources authorized. Further provider/domain/storage work requires approval.
