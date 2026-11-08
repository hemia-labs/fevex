# @fevex/opentelemetry

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

### Minor Changes

- 7f203fe: Bound trace export work with a deduplicated queue, configurable concurrency,
  queue limits, per-exporter timeouts and retained failure caps. `flushObservability`
  accepts a deadline and `getObservabilityStats()` exposes exported, failed and
  dropped counts. Workflow and team runs now emit correlated traces with step
  spans and `childRunId`; child agent traces carry `parentRunId` and `rootRunId`,
  and tool spans are nested under their model call.

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
