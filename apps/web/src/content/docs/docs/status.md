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
- Trajectory evaluations over tool attempts, approval and elicitation decisions
  and non-allow policy decisions, with risk guardrails, unused-fixture warnings
  and a minimum-scorecard release gate that also compares against a checked-in
  baseline, both from source and from the built package.
- `policy.evaluated` events for local traces and OpenTelemetry span events,
  successful and failed memory search/write spans, plus a built-in
  `riskGuardrail` policy for sensitive and destructive tools with optional
  fail-closed handling for tools that omit `risk`.
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
- On-demand lexical or hybrid semantic tool search with an optional reranker,
  plus per-tool result byte limits for large outputs.
- Artifact descriptors with local filesystem and S3-compatible stores,
  SQLite and PostgreSQL metadata catalogs, authenticated HTTP delivery, and
  `context.artifacts` for tools with `artifact.created` events.
- [Channel contracts and external resolvers](/docs/channels/) for elicitation,
  with correlated requests and stable keys for delivery retries.
- [Slack Events API adapter](/docs/slack/) with signature verification, thread
  mapping, idempotent delivery and elicitation prompts. Repository-only until
  it joins the npm release inventory.
- Durable workflows and explicit team delegation, parallel work, and handoffs.
- Graceful shutdown with a deadline, crash recovery after `SIGKILL`, and a
  repeatable load/soak harness with memory, history and overhead gates.
- Stateless MCP `2026-07-28` connections with `server/discover`, MRTR
  elicitation, Tasks polling and `subscriptions/listen`; legacy `2025-11-25`
  servers fail with an actionable version error.
- Three official packages in the npm release pipeline: `@fevex/core`,
  `@fevex/openai` and `@fevex/deepseek`. MCP, OpenAPI, SQLite, PostgreSQL,
  OpenTelemetry, browser, Anthropic, Slack and Docker sandbox integrations are
  built, tested and tarball-smoked in CI but are not published by the release
  pipeline.
- Anthropic Messages API adapter with native streaming, thinking and `tool_use`
  replay, strict JSON outputs and tool schemas, and reasoning effort mapping.
- Docker-backed production sandbox with one long-lived container and isolated
  workspace per run, no network by default, dropped capabilities, resource
  limits, forced termination and automatic cleanup. `LocalSandbox` remains
  development-only.

The default run store is in memory. Use a [persistent store](/docs/adapters/)
to retain runs and sessions across process restarts. [Workflow recovery](/docs/workflows/#recovery)
is explicit: applications provide their own recovery worker and timer scheduler.

## Roadmap

| Area | Status | Direction |
| --- | --- | --- |
| Sandbox isolation | Available | Docker provider with per-run containers and workspaces; E2B and snapshots remain future work. |
| Messaging channels | Available (repo-only) | Slack adapter, SQLite delivery store and playground MCP agent are validated with fixtures and a real OpenAI model; a real Slack workspace test and a Postgres channel store remain deferred. Discord, Teams, WhatsApp, and Telegram are future work. |
| Developer experience | In progress | Adaptable templates, repository inspection and shared research/evals in the playground are available; Studio and builder contracts remain open. |
| Agent builder ecosystem | Planned | Templates, catalogs, and products built on top of the FEVEX runtime. |

These are planned capabilities, with no committed release dates. Agent builders,
marketplaces, and tenant management belong to products built on FEVEX; they are
not part of the core package.

## Beta gate

Beta is not declared yet. The remaining gate is two external applications that
install from the published packages and exercise approval/resume, failure
recovery and upgrade through public APIs. That gate is intentionally deferred
until there are real consumers.

## Out of scope

The MVP intentionally does **not** include:

- a standalone CLI package;
- a hosted observability service;
- model-judge evals;
- human evaluation workflows.

## License

FEVEX is licensed under Apache-2.0.
