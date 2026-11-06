---
title: Tools
description: Tools are named functions with input and output schemas validated at every runtime boundary.
---

A tool is a named function with input and output schemas. Inputs are validated
before `execute` runs, and outputs are validated before returning to the model,
so every runtime boundary is typed.

## Define a tool

```ts
import { defineTool } from '@fevex/core';
import { z } from 'zod';

const getAccount = defineTool({
  name: 'accounts_get',
  description: 'Get an account by ID.',
  inputSchema: z.object({ accountId: z.number() }),
  outputSchema: z.object({ accountId: z.number(), status: z.string() }),
  execute({ accountId }) {
    return { accountId, status: 'active' };
  },
});
```

## Rules

- Tool names must match `[A-Za-z0-9_-]{1,64}`.
- Inputs are validated before `execute`; outputs are validated before they
  return to the model.
- Register tools in `createFevex({ tools: [...] })` and reference them from an
  agent's `tools` array by name.

## Large results

Return compact JSON from tools. Set `maxResultBytes` on a tool or
`limits.maxToolResultBytes` on an agent or run; Fevex rejects larger serialized
results with `TOOL_RESULT_TOO_LARGE`. The default cap is 1 MiB; set either
option to `false` to disable it. Store large payloads in `context.artifacts` and
return the descriptor instead:

```ts
defineTool({
  name: 'export_report',
  maxResultBytes: 64 * 1024,
  async execute(input, context) {
    const artifact = await context.artifacts?.put({
      filename: 'report.csv',
      mimeType: 'text/csv',
      content: buildCsv(input),
    });
    return artifact;
  },
});
```

## Tool search

Agents with large tool catalogs can expose `fevex__search_tools` instead of
sending every schema on every turn:

```ts
defineAgent({
  name: 'support',
  instructions: 'Answer with the available tools.',
  tools: [...],
  toolSearch: {
    mode: 'auto',
    threshold: 30,
    pinned: ['accounts_get'],
  },
});
```

- `off`: expose every tool.
- `on`: expose pinned tools plus `fevex__search_tools`; matched tools load on
  the next turn.
- `auto` (default): enable search when the tool count exceeds `threshold` or
  the estimated tool tokens exceed `tokenThreshold`.

Search only indexes the agent's own `tools`. Allowlists, policies and approvals
still apply when a loaded tool executes; loading is context management, not
authorization. Set `pinned` for tools the model should always see.

## Semantic index and cache

The package also exposes the building blocks for semantic tool retrieval:

```ts
import {
  buildToolEmbeddingIndex,
  InMemoryToolEmbeddingCache,
  searchToolEmbeddingIndex,
} from '@fevex/core/tools';
import type { EmbeddingModel } from '@fevex/core/models';

const cache = new InMemoryToolEmbeddingCache();
const index = await buildToolEmbeddingIndex({
  tools,
  embeddings, // implements EmbeddingModel
  cache,
});

const [queryVector] = await embeddings.embed({ texts: [query] });
const matches = searchToolEmbeddingIndex(index, queryVector, 5, 0.2);
```

The indexed text is the tool name, description and schema keywords. Cache keys
are `sha256(embeddingModel.id + text)`, so changing the model or the tool
definition invalidates only that vector.

`ToolEmbeddingCache` is intentionally small; a host can back it with SQLite,
PostgreSQL plus `pgvector`, Redis or object storage for multi-process
deployments. Implement the optional `getMany`/`setMany` methods to batch
durable reads and writes. Vectors are derived data and are never stored in run
checkpoints.

Set a runtime-wide cache with `createFevex({ toolSearchCache: myCache })`; an
agent can override it inside `toolSearch.semantic.cache`.

To enable hybrid retrieval, configure the embedding model on the agent or the
runtime:

```ts
defineAgent({
  name: 'support',
  instructions: 'Answer with the available tools.',
  tools: [...],
  toolSearch: {
    mode: 'auto',
    semantic: {
      embeddings,
      topK: 20,
      minScore: 0.2,
    },
  },
});
```

Fevex retrieves lexical and vector candidates independently, fuses them with
Reciprocal Rank Fusion and returns the final `limit`. If the embedding model or
vector index fails, search falls back to lexical results. The runtime reuses
`toolSearchCache` (or the agent cache) so unchanged tools are embedded once.

The evaluation harness in `scripts/tool-search-eval.ts` can measure any
`ToolSearchStrategy`, including a hybrid strategy with your embedding model.
