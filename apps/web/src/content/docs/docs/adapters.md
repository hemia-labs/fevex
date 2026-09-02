---
title: Adapters
description: Provider integrations live outside the core package, so your app installs only what it uses.
---

Provider integrations live outside the core package, so your app installs only
what it uses.

## Available adapters

| Package | Purpose |
| --- | --- |
| `@fevex/openai` | OpenAI model adapter over the native HTTP API |
| `@fevex/deepseek` | DeepSeek model adapter |
| `@fevex/mcp` | Model Context Protocol tools and connections |
| `@fevex/openapi` | Tools generated from an OpenAPI spec |
| `@fevex/sqlite` | SQLite run and session store |
| `@fevex/postgres` | Postgres run and session store |
| `@fevex/opentelemetry` | OpenTelemetry trace export |
| `@fevex/browser` | Browser automation tools |

## Bring your own

Any provider can be wired in by implementing the `ModelGateway` contract
directly — see [Models](/docs/models/). Stores and tools follow the same pattern:
depend on the core contract, keep the provider-specific code in its own package.
