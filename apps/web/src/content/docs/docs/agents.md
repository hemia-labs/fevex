---
title: Agents
description: Define typed agents with instructions, tools and an optional output schema.
---

An agent is a typed definition — instructions, the tools it may call, and an
optional `outputSchema` that structures and validates its result.

## Define an agent

```ts
import { defineAgent } from '@fevex/core';
import { z } from 'zod';

const support = defineAgent({
  name: 'support',
  instructions: 'Answer account questions clearly.',
  tools: ['accounts_get'],
  outputSchema: z.object({ answer: z.string() }),
});
```

Agents are registered by name in `createFevex({ agents: [...] })` and reference
tools by name.

## Run an agent

```ts
const result = await app.runAgent('support', {
  input: 'What is the status of account 42?',
});
```

The run executes a bounded multi-step model-tool loop with sequential tool
execution. When `outputSchema` is present, the final output is parsed and
validated locally before it is returned.
