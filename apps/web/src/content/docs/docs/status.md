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

## Out of scope

The MVP intentionally does **not** include:

- a CLI;
- a hosted observability service;
- model-judge evals;
- human evaluation workflows.

## License

FEVEX is licensed under Apache-2.0.
