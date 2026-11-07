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
| `@fevex/sandbox-docker` | Docker-backed production sandbox provider |

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

## Docker sandbox

`@fevex/sandbox-docker` implements the `Sandbox` contract with one long-lived
container and workspace per run:

```ts
import { createDockerSandbox } from '@fevex/sandbox-docker';

const sandbox = createDockerSandbox({
  image: 'oven/bun:1-alpine',
  commands: ['bun', 'sh'],
  workspaceRoot: '/var/lib/fevex/sandboxes',
  memory: '512m',
  cpus: 1,
});
```

Containers use `--network none` by default, drop Linux capabilities, run with a
read-only root and a private `/tmp`, and only receive explicitly configured
environment variables. The runtime calls `cleanupRun` after terminal runs and
`dispose` during shutdown; paused runs keep their container so a resume can
continue. `LocalSandbox` remains development-only and does not provide
operating-system isolation.

## Bring your own

Any provider can be wired in by implementing the `ModelGateway` contract
directly — see [Models](/docs/models/). Stores and tools follow the same pattern:
depend on the core contract, keep the provider-specific code in its own package.

Message transports implement `ChannelAdapter` from `@fevex/core/channels`.
See [Channels & resolvers](/docs/channels/) for request delivery, correlation,
retries and human or automated responses.
