---
"@fevex/core": minor
---

Add automatic context compaction. Agents can declare a `contextBudget` with
`contextWindow`, `reserveOutputTokens`, `compactAt`, `targetTokens` and
`safetyFactor`, or the runtime can provide a default budget. Before each model
call Fevex estimates the prompt, replaces older completed turns and earlier
tool batches with a summary, preserves system instructions, the current request
and the latest tool batch, emits `context.compacted` and persists the summary in
the run checkpoint. Summaries are cached on the session and reused across runs;
the original history remains the source of truth. The compactor and token
estimator are injectable through `compaction`; the default compactor is a
deterministic digest with no extra model calls.
