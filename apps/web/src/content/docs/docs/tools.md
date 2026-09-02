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
