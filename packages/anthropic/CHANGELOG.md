# @fevex/anthropic

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

### Minor Changes

- cea838e: Add `@fevex/anthropic`, a `ModelGateway` adapter over the native Messages API.
  It streams text, tool calls and thinking, keeps native thinking/tool blocks in
  opaque `providerState` between tool rounds, maps core reasoning effort to
  `output_config.effort`, and supports strict JSON outputs and strict tool schemas
  through `output_config.format` and `strict: true`. Unsupported strict schemas
  fail before HTTP with `PROVIDER_SCHEMA_UNSUPPORTED`.

### Patch Changes

- Updated dependencies [cea838e]
  - @fevex/core@0.1.0-alpha.11
