---
"@fevex/core": minor
---

Add an optional tool reranker. `ToolSearchSemanticOptions.reranker` receives the
query, the fused lexical/vector candidates with their scores, and the final
limit. Fevex validates that the reranker only returns tools from the candidate
set and falls back to the fused ranking when it throws, returns unknown tools or
duplicates. The reranker remains optional and is never stored in run
checkpoints.
