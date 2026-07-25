# Fevex

Agent Engineering Framework for code-first, provider-neutral AI agents in
TypeScript.

Fevex gives you the small contracts needed to define agents, tools, model
adapters, validation and tests without adopting a heavy runtime.

> **Status:** early MVP. Fevex is usable for local, single-tool agent runs, but
> its API may change before the first stable release.

## Why Fevex

- **Provider-neutral:** application code depends on `ModelGateway`, not a model
  vendor SDK.
- **Typed tools:** Standard Schema validators infer inputs and validate every
  runtime boundary.
- **Small runtime:** one package, ESM, Node.js 20+, no database or service
  required.
- **Observable:** successful and failed runs emit structured events.
- **Testable:** `fevex/testing` includes a deterministic model and shared model
  contract checks.

## Install

```bash
npm install fevex
```

For official model adapters:

```bash
npm install fevex @fevex/openai
npm install fevex @fevex/deepseek
```

Schemas are optional. The examples use Zod 4, but any Standard
Schema-compatible validator can be used:

```bash
npm install zod
```

## Quickstart

This example executes a complete model-tool-model cycle without network access:

```ts
import { createFevex, defineAgent, defineTool } from 'fevex';
import { fakeModel } from 'fevex/testing';
import { z } from 'zod';

const accountInput = z.object({
  accountId: z.number(),
});

const accountOutput = z.object({
  accountId: z.number(),
  status: z.literal('active'),
});

const getAccount = defineTool({
  name: 'accounts.get',
  description: 'Get an account by ID.',
  inputSchema: accountInput,
  outputSchema: accountOutput,
  execute({ accountId }) {
    return { accountId, status: 'active' };
  },
});

const model = fakeModel(
  {
    toolCalls: [{
      id: 'call-1',
      name: 'accounts.get',
      input: { accountId: 42 },
    }],
  },
  { output: 'Account 42 is active.' },
);

const app = createFevex({
  models: { default: model },
  agents: [defineAgent({
    name: 'support',
    instructions: 'Answer account questions clearly.',
    tools: ['accounts.get'],
    outputSchema: z.string(),
  })],
  tools: [getAccount],
});

const result = await app.runAgent<string, string>('support', {
  input: 'What is the status of account 42?',
});

console.log(result.output);
// Account 42 is active.
```

`fakeModel` returns its configured responses in order and records every input in
`model.calls`.

## Connect A Model

Real providers connect through the small `ModelGateway` contract:

```ts
import type { ModelGateway } from 'fevex/models';

export const model: ModelGateway = {
  async generate({ messages, tools, outputSchema, signal }) {
    const response = await yourProvider.generate({
      messages,
      tools,
      outputSchema,
      signal,
    });

    return {
      output: response.output,
      toolCalls: response.toolCalls,
      usage: response.usage,
    };
  },
};
```

Provider integrations remain outside the core package. The first official
adapter is `@fevex/openai`, authored by Fevex over the native OpenAI HTTP API:

```ts
import { createOpenAI } from '@fevex/openai';

const model = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  organization: process.env.OPENAI_ORG_ID,
  project: process.env.OPENAI_PROJECT_ID,
})('gpt-5.6');
```

DeepSeek follows the same shape:

```ts
import { createDeepSeek } from '@fevex/deepseek';

const model = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY!,
})('deepseek-chat');
```

Applications can still implement `ModelGateway` directly as shown above.

## Validation

Fevex accepts
[`StandardSchemaV1`](https://github.com/standard-schema/standard-schema)
validators for:

- tool input before `execute`;
- tool output before it is returned to the model;
- final agent output before it is returned to the application.

Schemas may transform values. The transformed result must still be JSON-safe.
The schema passed to `runAgent` takes precedence over the agent schema for that
run. Plain JSON Schema objects are not executable validators and are not
accepted by these fields.

When a model adapter needs schemas, Fevex converts authoring schemas that also
implement Standard JSON Schema into JSON Schema 2020-12 before calling
`ModelGateway.generate`. Adapters receive transportable JSON Schema in
`ToolSpec.inputSchema` and `ModelGenerateInput.outputSchema`; they never receive
the application's executable validators. If a run needs a schema at the model
boundary and the schema cannot be converted, Fevex fails before invoking the
model with `SCHEMA_NOT_TRANSPORTABLE`.

Use `testModelGateway` to verify a custom model adapter against the shared
contract:

```ts
import { testModelGateway } from 'fevex/testing';

await testModelGateway(model);
```

## Events

Pass `onEvent` to observe success and failure without wrapping provider or tool
errors:

```ts
const app = createFevex({
  models,
  agents,
  tools,
  onEvent(event) {
    console.log(event.type, event.runId, event.payload);
  },
});
```

The MVP emits:

```text
run.started
model.completed
tool.completed
tool.failed
run.completed
run.failed
```

Successful runs also return their events in `RunResult.events`.

## Public Exports

| Import | Purpose |
| --- | --- |
| `fevex` | Common runtime, definitions and contracts |
| `fevex/agents` | Agent definitions |
| `fevex/models` | Provider-neutral model contracts |
| `fevex/tools` | Tool definitions and execution context |
| `fevex/runtime` | Run request and result contracts |
| `fevex/testing` | Deterministic testing helpers |

All subpaths ship in the same `fevex` package.

## Current Scope

The MVP intentionally supports:

- one model response, or one model-tool-model cycle;
- an in-memory runtime;
- synchronous event observers;
- optional Standard Schema validation;
- `AbortSignal` cancellation.

It does not yet include streaming, retries, persistence, approvals, a CLI or
official provider adapters. `AgentDefinition.limits` is reserved and has no
runtime effect yet.

## License

Apache-2.0
