# @fevex/mcp

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies [1146dcf]
  - @fevex/core@0.1.0-alpha.7

## 0.1.0-alpha.8

### Minor Changes

- e28ef93: Add MCP `2026-07-28` MRTR, Tasks and subscription support. The adapter handles
  `input_required` elicitation through `onElicitation`, echoes opaque
  `requestState`, retries with `inputResponses`, polls `tasks/get`, supplies task
  input through `tasks/update`, and opens `subscriptions/listen` streams with an
  `onNotification` callback. Sampling and roots input requests remain unsupported.

## 0.1.0-alpha.7

### Minor Changes

- 6af174c: Migrate the MCP adapter to the stateless `2026-07-28` Streamable HTTP revision.
  Remove `initialize`, `notifications/initialized` and `Mcp-Session-Id`; send
  per-request `_meta`, `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`; verify
  servers through `server/discover`. Legacy `2025-11-25` servers now fail with an
  actionable `MCP_VERSION_UNSUPPORTED` error, and `input_required` results fail
  with `MCP_INPUT_REQUIRED` until MRTR support lands.

## 0.1.0-alpha.6

### Patch Changes

- 7f203fe: Document the official npm inventory: only `@fevex/core`, `@fevex/openai` and
  `@fevex/deepseek` are published. The other six integrations remain
  repository-validated and are not published by the release pipeline.
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
  - @fevex/core@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies [1a68a1d]
- Updated dependencies [1a68a1d]
- Updated dependencies [1a68a1d]
  - @fevex/core@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- f4f8020: Enforce local sandbox timeout/cancellation with forced process termination and
  bound Unicode output by UTF-8 bytes. Persist effective model identity on agent
  runs so terminal and resumed traces and costs respect model overrides.
  
  Invalidate expired MCP sessions on HTTP 404 and reinitialize on the next call,
  without replaying failed tool calls or invalidating a replacement session when
  an old request finishes late.
- Updated dependencies [f4f8020]
- Updated dependencies [f4f8020]
  - @fevex/core@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies [c5595c5]
  - @fevex/core@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies [d6322c3]
  - @fevex/core@0.1.0-alpha.2
