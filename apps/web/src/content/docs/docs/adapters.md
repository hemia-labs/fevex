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
| `@fevex/anthropic` | Anthropic Messages API model adapter |
| `@fevex/mcp` | Model Context Protocol tools and connections |
| `@fevex/openapi` | Tools generated from an OpenAPI spec |
| `@fevex/sqlite` | SQLite run, session and channel state store |
| `@fevex/postgres` | Postgres run and session store |
| `@fevex/opentelemetry` | OpenTelemetry trace export |
| `@fevex/browser` | Browser automation tools |
| `@fevex/sandbox-docker` | Docker-backed production sandbox provider |
| `@fevex/slack` | Slack Events API channel adapter |

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

## Anthropic

`@fevex/anthropic` implements the `ModelGateway` contract over the native
Messages API. It streams text, tool calls and thinking, replays native thinking
and `tool_use` blocks through `providerState`, and maps core reasoning effort to
`output_config.effort`:

```ts
import { createAnthropic } from '@fevex/anthropic';

const model = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  schemaPolicy: 'strict',
})('claude-opus-5-5');
```

`strict` uses `output_config.format` for JSON outputs and `strict: true` for
tool schemas. The adapter rejects unsupported schemas, recursive references,
external `$ref`, `oneOf`, numeric constraints and array constraints beyond
`minItems` 0 or 1 before HTTP with `PROVIDER_SCHEMA_UNSUPPORTED`. Use
`schemaPolicy: 'best-effort'` to send a schema instruction and validate locally.
The default `anthropic-version` is `2026-10-21`; pass `apiVersion` to use another
version. Anthropic is available from this repository until it is published.

## Slack

`@fevex/slack` implements `ChannelAdapter` for the Slack Events API, including
signature verification, mention and DM parsing, thread replies, event
deduplication and elicitation prompts. Use `createSQLiteChannelStore` from
`@fevex/sqlite` to persist event claims and delivery receipts across restarts.
See [Slack](/docs/slack/) for setup.

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
