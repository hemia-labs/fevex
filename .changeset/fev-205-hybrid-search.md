---
"@fevex/core": minor
---

Add hybrid tool retrieval. Configure `toolSearch.semantic` with an
`EmbeddingModel`, optional `ToolEmbeddingCache`, `topK` and `minScore`. Fevex
runs lexical and vector retrieval independently, fuses them with Reciprocal Rank
Fusion and returns the configured limit. If the embedding model or index fails,
search falls back to lexical results. Semantic adapters and vectors stay out of
run checkpoints; only the serializable search options and loaded tool names are
persisted.
