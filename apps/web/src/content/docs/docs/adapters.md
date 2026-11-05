---
title: Adapters
description: Provider integrations live outside the core package, so your app installs only what it uses.
---

Provider integrations live outside the core package, so your app installs only
what it uses.

## Official published packages

The npm release pipeline publishes `@fevex/core` plus these official adapters:

| Package | Purpose |
| --- | --- |
| `@fevex/openai` | OpenAI model adapter over the native HTTP API |
| `@fevex/deepseek` | DeepSeek model adapter |

## Repository-only integrations

These packages are built, typechecked, tested and tarball-smoked in CI, but
they are **not published to npm** by the release pipeline. Use them from this
repository until they are published:

| Package | Purpose |
| --- | --- |
| `@fevex/mcp` | Model Context Protocol tools and connections |
| `@fevex/openapi` | Tools generated from an OpenAPI spec |
| `@fevex/sqlite` | SQLite run and session store |
| `@fevex/postgres` | Postgres run and session store |
| `@fevex/opentelemetry` | OpenTelemetry trace export |
| `@fevex/browser` | Browser automation tools |

The MCP adapter targets stateless protocol `2026-07-28`: it calls
`server/discover`, sends per-request `_meta`, supports MRTR elicitation, Tasks
polling and `subscriptions/listen`. Servers implementing only the legacy
`2025-11-25` handshake fail with `MCP_VERSION_UNSUPPORTED`.

The [MCP documentation and OpenAPI account examples](https://github.com/hemia-labs/fevex/tree/main/examples/connections)
run both adapters through Fevex agents against a temporary local HTTP service.
They demonstrate discovery, read-only allowlists, tool results and event sources
with a deterministic model, without API keys:

```bash
bun run examples/connections/index.ts
```

## Bring your own

Any provider can be wired in by implementing the `ModelGateway` contract
directly — see [Models](/docs/models/). Stores and tools follow the same pattern:
depend on the core contract, keep the provider-specific code in its own package.

Message transports implement `ChannelAdapter` from `@fevex/core/channels`.
See [Channels & resolvers](/docs/channels/) for request delivery, correlation,
retries and human or automated responses.
