---
title: Status & scope
description: What the FEVEX MVP supports today, and what is intentionally out of scope.
---

FEVEX is an early MVP. The API may change before the first stable release.
See [Compatibility & releases](/docs/compatibility/) for the public API,
checkpoint, upgrade and support guarantees.

## Supported today

- Bounded multi-step model-tool loops with sequential tool execution.
- Native provider streaming and durable, consultable runs.
- Synchronous event observers and `AsyncIterable` event streaming.
- Local traces, OpenTelemetry export and deterministic evaluation suites, with
  bounded export queues, timeouts and workflow → agent → tool correlation.
- [Adaptable examples and repository run inspection](/docs/development/) through
  the public HTTP protocol.
- Optional Standard Schema validation.
- Immediate `AbortSignal` cancellation with cooperative underlying work.
- Per-runtime admission limits, per-run deadlines, event caps and terminal-run
  retention through `purgeRuns`.
- Conversation sessions, tool approval checkpoints, and resumable runs.
- Code-first skills plus explicit `SKILL.md` files with progressive disclosure,
  on-demand resources and optional `AGENTS.md` context.
- Automatic context compaction with per-agent or runtime context budgets, an
  injectable or model-backed compactor, and runtime compaction counters.
- On-demand tool search with `fevex__search_tools`, plus per-tool result byte
  limits for large outputs and semantic embedding index/cache primitives.
- Artifact descriptors with local filesystem and S3-compatible stores,
  SQLite and PostgreSQL metadata catalogs, authenticated HTTP delivery, and
  `context.artifacts` for tools with `artifact.created` events.
- [Channel contracts and external resolvers](/docs/channels/) for elicitation,
  with correlated requests and stable keys for delivery retries.
- Durable workflows and explicit team delegation, parallel work, and handoffs.
- Graceful shutdown with a deadline, crash recovery after `SIGKILL`, and a
  repeatable load/soak harness with memory, history and overhead gates.
- Stateless MCP `2026-07-28` connections with `server/discover`, MRTR
  elicitation, Tasks polling and `subscriptions/listen`; legacy `2025-11-25`
  servers fail with an actionable version error.
- Three official packages in the npm release pipeline: `@fevex/core`,
  `@fevex/openai` and `@fevex/deepseek`. MCP, OpenAPI, SQLite, PostgreSQL,
  OpenTelemetry and browser integrations are built, tested and tarball-smoked
  in CI but are not published by the release pipeline.

The default run store is in memory. Use a [persistent store](/docs/adapters/)
to retain runs and sessions across process restarts. [Workflow recovery](/docs/workflows/#recovery)
is explicit: applications provide their own recovery worker and timer scheduler.

## Roadmap

| Area | Status | Direction |
| --- | --- | --- |
| Messaging channels | Next | Connect messaging surfaces such as Slack, Discord, WhatsApp, and Telegram through channel adapters. |
| Developer experience | In progress | Adaptable templates, repository inspection and shared research/evals in the playground are available; Studio and builder contracts remain open. |
| Agent builder ecosystem | Planned | Templates, catalogs, and products built on top of the FEVEX runtime. |

These are planned capabilities, with no committed release dates. Agent builders,
marketplaces, and tenant management belong to products built on FEVEX; they are
not part of the core package.

## Out of scope

The MVP intentionally does **not** include:

- a standalone CLI package;
- a hosted observability service;
- model-judge evals;
- human evaluation workflows.

## License

FEVEX is licensed under Apache-2.0.
