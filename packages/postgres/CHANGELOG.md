# @fevex/postgres

## 0.1.0-alpha.4

### Minor Changes

- 1a68a1d: Add `@fevex/core/artifacts` with artifact descriptors, in-memory and local filesystem stores, an S3-compatible adapter boundary, and an optional metadata catalog. `@fevex/sqlite` and `@fevex/postgres` add artifact catalogs for listing, authorizing and deleting artifacts by tenant, run, session or actor. `@fevex/core/http` exposes `GET`/`HEAD`/`DELETE /v1/artifacts/:id` and `GET /v1/runs/:runId/artifacts`, with `authorizeArtifact` and client helpers. Tools receive `context.artifacts` and emit `artifact.created`.
- 1a68a1d: Add per-runtime admission limits, per-run deadlines, event caps and terminal
  run retention through `purgeRuns`. SQLite and PostgreSQL implement the new
  retention capability.

### Patch Changes

- Updated dependencies [1a68a1d]
- Updated dependencies [1a68a1d]
- Updated dependencies [1a68a1d]
  - @fevex/core@0.1.0-alpha.5

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies [f4f8020]
- Updated dependencies [f4f8020]
  - @fevex/core@0.1.0-alpha.4

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies [c5595c5]
  - @fevex/core@0.1.0-alpha.3

## 0.1.0-alpha.1

### Patch Changes

- Updated dependencies [d6322c3]
  - @fevex/core@0.1.0-alpha.2
