---
"@fevex/anthropic": minor
---

Add `@fevex/anthropic`, a `ModelGateway` adapter over the native Messages API.
It streams text, tool calls and thinking, keeps native thinking/tool blocks in
opaque `providerState` between tool rounds, maps core reasoning effort to
`output_config.effort`, and supports strict JSON outputs and strict tool schemas
through `output_config.format` and `strict: true`. Unsupported strict schemas
fail before HTTP with `PROVIDER_SCHEMA_UNSUPPORTED`.
