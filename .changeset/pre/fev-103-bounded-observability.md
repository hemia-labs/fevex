---
"@fevex/core": minor
"@fevex/opentelemetry": minor
---

Bound trace export work with a deduplicated queue, configurable concurrency,
queue limits, per-exporter timeouts and retained failure caps. `flushObservability`
accepts a deadline and `getObservabilityStats()` exposes exported, failed and
dropped counts. Workflow and team runs now emit correlated traces with step
spans and `childRunId`; child agent traces carry `parentRunId` and `rootRunId`,
and tool spans are nested under their model call.
