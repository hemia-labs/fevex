---
title: Quickstart
description: Run a complete model to tool to model cycle with no network access using the deterministic fake model.
---

This example runs a complete model → tool → model cycle without network access,
using the deterministic `fakeModel` from `@fevex/core/testing`.

## Define a tool

```ts
import { defineTool } from '@fevex/core';
import { z } from 'zod';

const getAccount = defineTool({
  name: 'accounts_get',
  description: 'Get an account by ID.',
  inputSchema: z.object({ accountId: z.number() }),
  outputSchema: z.object({
    accountId: z.number(),
    status: z.literal('active'),
  }),
  execute({ accountId }) {
    return { accountId, status: 'active' };
  },
});
```

## Compose the app

```ts
import { createFevex, defineAgent } from '@fevex/core';
import { fakeModel } from '@fevex/core/testing';
import { z } from 'zod';

const model = fakeModel(
  {
    toolCalls: [
      { id: 'call-1', name: 'accounts_get', input: { accountId: 42 } },
    ],
  },
  { output: { answer: 'Account 42 is active.' } },
);

const app = createFevex({
  models: { default: model },
  agents: [
    defineAgent({
      name: 'support',
      instructions: 'Answer account questions clearly.',
      tools: ['accounts_get'],
      outputSchema: z.object({ answer: z.string() }),
    }),
  ],
  tools: [getAccount],
});
```

## Run the agent

```ts
const result = await app.runAgent('support', {
  input: 'What is the status of account 42?',
});

console.log(result.output.answer);
// Account 42 is active.
```

`createFevex` validates the complete composition before returning the app.
Invalid registrations throw `FevexConfigurationError` with a stable `code`.
`fakeModel` returns its configured responses in order and records every input in
`model.calls`.
