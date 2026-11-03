---
title: Install
description: Install the official published FEVEX packages and understand which integrations ship only in the repository.
---

## Core package

```bash
npm install @fevex/core
```

FEVEX targets Node.js 20+ and ships as ESM only.

## Official packages

The npm release pipeline publishes exactly three official packages:

| Package | Purpose |
| --- | --- |
| `@fevex/core` | Runtime, definitions and contracts |
| `@fevex/openai` | OpenAI model adapter |
| `@fevex/deepseek` | DeepSeek model adapter |

```bash
npm install @fevex/core @fevex/openai
npm install @fevex/core @fevex/deepseek
```

CI builds, typechecks, tests and tarball-smokes all nine packages.

## Repository-only integrations

These packages are **not published to npm** by the release pipeline. Use them
from this repository until they are published:

| Package | Purpose |
| --- | --- |
| `@fevex/mcp` | Model Context Protocol tools and connections |
| `@fevex/openapi` | Tools generated from an OpenAPI document |
| `@fevex/sqlite` | SQLite run and session store |
| `@fevex/postgres` | PostgreSQL run and session store |
| `@fevex/opentelemetry` | OpenTelemetry trace and metric export |
| `@fevex/browser` | Browser automation tools |

See [Adapters](/docs/adapters/) for the full integration list. Before upgrading a
durable deployment, read [Compatibility & releases](/docs/compatibility/).

## Schemas

Schemas are optional. The examples use Zod 4, but any Standard
Schema-compatible validator works:

```bash
npm install zod
```
