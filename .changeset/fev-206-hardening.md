---
"@fevex/core": minor
---

Harden context compaction and tool results. Add `createModelContextCompactor`
for semantic summaries with transcript chunking, `compaction.redactSummary` for
event redaction, `getCompactionStats()` counters, cached tool-token estimates
and compressed session summaries. Add per-tool `maxResultBytes` and
per-agent/run `limits.maxToolResultBytes` with a 1 MiB default, `false` opt-out
and a `TOOL_RESULT_TOO_LARGE` error so large outputs move to artifacts instead
of the context window.
