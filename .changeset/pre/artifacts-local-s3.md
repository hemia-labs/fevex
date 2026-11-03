---
"@fevex/core": minor
"@fevex/sqlite": minor
"@fevex/postgres": minor
---

Add `@fevex/core/artifacts` with artifact descriptors, in-memory and local filesystem stores, an S3-compatible adapter boundary, and an optional metadata catalog. `@fevex/sqlite` and `@fevex/postgres` add artifact catalogs for listing, authorizing and deleting artifacts by tenant, run, session or actor. `@fevex/core/http` exposes `GET`/`HEAD`/`DELETE /v1/artifacts/:id` and `GET /v1/runs/:runId/artifacts`, with `authorizeArtifact` and client helpers. Tools receive `context.artifacts` and emit `artifact.created`.
