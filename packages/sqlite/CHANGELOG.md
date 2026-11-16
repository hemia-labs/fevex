# @fevex/sqlite

## 0.1.0-alpha.14

### Minor Changes

- 6596921: Add a public run listing API and a local Studio.
  
  `GET /v1/runs` lists runs newest first with `limit`, `status` and opaque `cursor`
  pagination, and filters runs through the host `authorize` hook. `Fevex.listRuns`
  and the HTTP client expose the same contract. The in-memory and SQLite stores
  implement `RunCatalog`; other stores return `RUN_LIST_UNSUPPORTED`.
  
  `examples/studio` consumes only public endpoints to show runs, event timelines,
  tool activity and approvals, and to resolve or cancel runs. It does not read the
  database or import server internals.

### Patch Changes

- Updated dependencies [6596921]
  - @fevex/core@0.1.0-alpha.15

## 0.1.0-alpha.13

### Patch Changes

- Updated dependencies [77059a9]
  - @fevex/core@0.1.0-alpha.14

## 0.1.0-alpha.12

### Minor Changes

- 726eb18: Add `createSQLiteChannelStore` for durable channel event deduplication and
  delivery receipts. Schema v5 adds the `channel_events` and `channel_deliveries`
  tables and indexes.

### Patch Changes

- Updated dependencies [726eb18]
  - @fevex/core@0.1.0-alpha.13

## 0.1.0-alpha.11

### Patch Changes

- Updated dependencies [79956a0]
  - @fevex/core@0.1.0-alpha.12

## 0.1.0-alpha.10

### Patch Changes

- Updated dependencies [cea838e]
  - @fevex/core@0.1.0-alpha.11

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies [952e070]
  - @fevex/core@0.1.0-alpha.10

## 0.1.0-alpha.8

### Patch Changes

- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
  - @fevex/core@0.1.0-alpha.9

## 0.1.0-alpha.7

### Patch Changes

- Updated dependencies [5752417]
  - @fevex/core@0.1.0-alpha.8

## 0.1.0-alpha.6

### Patch Changes

- Updated dependencies [1146dcf]
  - @fevex/core@0.1.0-alpha.7

## 0.1.0-alpha.5

### Patch Changes

- 7f203fe: Document the official npm inventory: only `@fevex/core`, `@fevex/openai` and
  `@fevex/deepseek` are published. The other six integrations remain
  repository-validated and are not published by the release pipeline.
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
  - @fevex/core@0.1.0-alpha.6

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
