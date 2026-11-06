---
"@fevex/core": minor
---

Add semantic tool indexing primitives. `EmbeddingModel` lives in
`@fevex/core/models`; `@fevex/core/tools` exposes `ToolEmbeddingCache`,
`InMemoryToolEmbeddingCache`, `buildToolEmbeddingIndex`,
`searchToolEmbeddingIndex`, `toolEmbeddingText`, `toolEmbeddingKey` and
`cosineSimilarity`. Indexed text covers the tool name, description and schema
keywords. Cache keys are `sha256(embeddingModel.id + text)`, the in-memory cache
is a bounded LRU, and durable adapters can implement the same `get`/`set`
contract plus optional `getMany`/`setMany` batches. Vectors are derived data and
are never stored in run checkpoints.
