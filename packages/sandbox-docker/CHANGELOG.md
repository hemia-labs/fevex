# @fevex/sandbox-docker

## 0.1.0-alpha.15

### Patch Changes

- Updated dependencies [6596921]
  - @fevex/core@0.1.0-alpha.15

## 0.1.0-alpha.14

### Patch Changes

- Updated dependencies [77059a9]
  - @fevex/core@0.1.0-alpha.14

## 0.1.0-alpha.13

### Patch Changes

- Updated dependencies [726eb18]
  - @fevex/core@0.1.0-alpha.13

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies [79956a0]
  - @fevex/core@0.1.0-alpha.12

## 0.1.0-alpha.11

### Patch Changes

- Updated dependencies [cea838e]
  - @fevex/core@0.1.0-alpha.11

## 0.1.0-alpha.10

### Minor Changes

- 952e070: Add Docker-backed production sandbox provider. Each run gets a long-lived
  container and isolated workspace with `--network none` by default, dropped
  capabilities, read-only root, PID/memory/CPU limits, explicit environment only,
  forced termination and multibyte-safe output caps. Add optional
  `Sandbox.cleanupRun` and `Sandbox.dispose` lifecycle hooks so the runtime
  releases per-run resources after terminal runs and provider resources during
  shutdown. Paused runs keep their container and workspace for resume.

### Patch Changes

- Updated dependencies [952e070]
  - @fevex/core@0.1.0-alpha.10
