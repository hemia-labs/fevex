---
"@fevex/core": minor
---

Add automatic context compaction. Agents can declare a `contextBudget` with
`maxInputTokens`, `reserveOutputTokens`, `compactAt` and `targetTokens`, or the
runtime can provide a default budget. Before each model call Fevex estimates
the prompt, replaces older completed turns with a summary above the threshold,
preserves system instructions and the current turn, emits `context.compacted`
and persists the summary in the run checkpoint. The compactor and token
estimator are injectable through `compaction`; the default compactor is a
deterministic digest with no extra model calls.
