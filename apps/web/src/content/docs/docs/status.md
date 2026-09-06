---
title: Status & scope
description: What the FEVEX MVP supports today, and what is intentionally out of scope.
---

FEVEX is an early MVP. The API may change before the first stable release.

## Supported today

- Bounded multi-step model-tool loops with sequential tool execution.
- Native provider streaming and durable, consultable runs.
- Synchronous event observers and `AsyncIterable` event streaming.
- Local traces, OpenTelemetry export and deterministic evaluation suites.
- Optional Standard Schema validation.
- Immediate `AbortSignal` cancellation with cooperative underlying work.
- Conversation sessions, tool approval checkpoints, and resumable runs.
- Durable workflows and explicit team delegation, parallel work, and handoffs.
- Official OpenAI and DeepSeek model adapters, MCP and OpenAPI connections,
  and SQLite and PostgreSQL stores.

The default run store is in memory. Use a [persistent store](/docs/adapters/)
to retain runs and sessions across process restarts. [Workflow recovery](/docs/workflows/#recovery)
is explicit: applications provide their own recovery worker and timer scheduler.

## Roadmap

| Area | Status | Direction |
| --- | --- | --- |
| Messaging channels | Next | Connect messaging surfaces such as Slack, Discord, WhatsApp, and Telegram through channel adapters. |
| Agent builder ecosystem | Planned | Templates, catalogs, and products built on top of the FEVEX runtime. |

These are planned capabilities, with no committed release dates. Agent builders,
marketplaces, and tenant management belong to products built on FEVEX; they are
not part of the core package.

## Out of scope

The MVP intentionally does **not** include:

- a CLI;
- a hosted observability service;
- model-judge evals;
- human evaluation workflows.

## License

FEVEX is licensed under Apache-2.0.
