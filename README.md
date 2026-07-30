# Fevex

Agent Engineering Framework for code-first, provider-neutral AI agents in
TypeScript.

Fevex gives you the small contracts needed to define agents, tools, model
adapters, validation and tests without adopting a heavy runtime.

> **Status:** early MVP. Fevex is usable for bounded local agent runs, but
> its API may change before the first stable release.

## Why Fevex

- **Provider-neutral:** application code depends on `ModelGateway`, not a model
  vendor SDK.
- **Typed tools:** Standard Schema validators infer inputs and validate every
  runtime boundary.
- **Small runtime:** one package, ESM, Node.js 20+, no database or service
  required.
- **Observable:** successful and failed runs emit structured events and optional
  local traces.
- **Testable:** `@fevex/core/testing` includes a deterministic model and shared
  model contract checks; `@fevex/core/evals` adds local regression suites.

## Install

```bash
npm install @fevex/core
```

For official model adapters:

```bash
npm install @fevex/core @fevex/openai
npm install @fevex/core @fevex/deepseek
npm install @fevex/core @fevex/mcp
npm install @fevex/core @fevex/openapi
npm install @fevex/core @fevex/sqlite
npm install @fevex/core @fevex/postgres
npm install @fevex/core @fevex/opentelemetry @opentelemetry/api
```

Schemas are optional. The examples use Zod 4, but any Standard
Schema-compatible validator can be used:

```bash
npm install zod
```

## HTTP v3 playground

Run a real OpenAI or DeepSeek agent through the versioned Fetch/SSE protocol:

```bash
FEVEX_PROVIDER=deepseek DEEPSEEK_API_KEY=... bun run dev:nest
bun run dev:next
```

Open `http://localhost:3000`. Routes, sessions, cancellation and reconnection
are documented in
[`examples/nest-api/README.md`](examples/nest-api/README.md).

## Connections, MCP and OpenAPI

Remote tools are registered as explicit connections. Fevex keeps the local
allowlist, timeout, approvals and policies; the provider only handles remote
discovery and calls.

```ts
import { createFevex, defineAgent, defineConnection } from '@fevex/core';
import { createMcpToolProvider } from '@fevex/mcp';

const docs = defineConnection({
  name: 'docs',
  provider: createMcpToolProvider({ url: 'https://example.com/mcp' }),
  allowlist: ['search'],
  tools: {
    search: {
      description: 'Search docs.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
});

createFevex({
  models: {},
  agents: [defineAgent({
    name: 'assistant',
    instructions: 'Help.',
    tools: ['docs__search'],
  })],
  connections: [docs],
});
```

OpenAPI connections turn bundled JSON OpenAPI 3.1 operations into the same
kind of remote tools:

```ts
import { createOpenApiToolProvider } from '@fevex/openapi';

const billing = defineConnection({
  name: 'billing',
  provider: createOpenApiToolProvider({
    document: openApiDocument,
    operations: { allow: ['getInvoice'] },
    headers: () => ({ Authorization: `Bearer ${process.env.BILLING_TOKEN}` }),
  }),
  allowlist: ['getInvoice'],
});
```

`@fevex/openapi` supports JSON OpenAPI 3.1.x, local refs and JSON
request/response bodies. YAML, remote refs, multipart, binary payloads and OAuth
lifecycles stay with the hosting app or later phases.

## Channels core

Channels adapt external message surfaces to Fevex without making the runtime
know about that surface. The hosting app receives the webhook/message, then
passes it through an adapter:

```ts
import { handleChannelInput } from '@fevex/core/channels';

const sessions = new Map<string, string>();

const result = await handleChannelInput(
  { id: 'm1', conversationId: 'c1', text: 'hello' },
  {
    fevex: app,
    agentName: 'assistant',
    adapter: {
      name: 'memory',
      async parse(input) {
        return {
          id: input.id,
          deliveryId: input.id,
          conversationId: input.conversationId,
          content: input.text,
        };
      },
      async deliver(output) {
        return output;
      },
    },
    resolveSessionId(message) {
      return sessions.get(message.conversationId);
    },
  },
);

if (!result.ignored) sessions.set(result.message.conversationId, result.run.sessionId);
```

The helper emits `channel.received`, `channel.delivered` and `channel.failed`
events through its local `onEvent` callback. Durable redelivery/deduplication
and Slack-specific signature checks stay for the Slack adapter phase.

## Knowledge and memory

Knowledge adds prompt context without changing the run/session store:

```ts
import {
  InMemoryMemoryStore,
  createFevex,
  defineAgent,
  defineContextProvider,
  defineSkill,
} from '@fevex/core';

const memoryStore = new InMemoryMemoryStore();

const app = createFevex({
  models,
  memoryStore,
  contextProviders: [
    defineSkill({
      name: 'refunds',
      instructions: 'Refunds are allowed for 30 days after purchase.',
    }),
    defineContextProvider({
      name: 'account',
      async read({ context }) {
        return [{ id: 'tier', content: `Plan: ${context?.attributes?.plan ?? 'free'}` }];
      },
    }),
  ],
  agents: [
    defineAgent({
      name: 'support',
      instructions: 'Answer with the available business context.',
      skills: ['refunds'],
      context: ['account'],
      memory: { read: true, write: true, limit: 5 },
    }),
  ],
});
```

Sessions keep conversation history; context providers add fresh business
context; memory stores searchable prior facts. The built-in memory store is a
local substring search only—vector DBs and durable storage belong in optional
adapters.

## Quickstart

This example executes a complete model-tool-model cycle without network access:

```ts
import { createFevex, defineAgent, defineTool } from '@fevex/core';
import { fakeModel } from '@fevex/core/testing';
import { z } from 'zod';

const accountInput = z.object({
  accountId: z.number(),
});

const accountOutput = z.object({
  accountId: z.number(),
  status: z.literal('active'),
});

const getAccount = defineTool({
  name: 'accounts_get',
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
      name: 'accounts_get',
      input: { accountId: 42 },
    }],
  },
  { output: { answer: 'Account 42 is active.' } },
);

const app = createFevex({
  models: { default: model },
  agents: [defineAgent({
    name: 'support',
    instructions: 'Answer account questions clearly.',
    tools: ['accounts_get'],
    outputSchema: z.object({ answer: z.string() }),
  })],
  tools: [getAccount],
});

const result = await app.runAgent<string, { answer: string }>('support', {
  input: 'What is the status of account 42?',
});

console.log(result.output.answer);
// Account 42 is active.
```

`fakeModel` returns its configured responses in order and records every input in
`model.calls`.

## Durable workflows

Workflows require a `DurableRunStore`. Their definition owns the input, output,
event and limit contracts:

```ts
const review = defineWorkflow({
  name: 'review',
  version: '2',
  inputSchema: z.object({ draft: z.string() }),
  outputSchema: z.string(),
  events: {
    'review.approved': {
      payloadSchema: z.object({ approved: z.literal(true) }),
      requireActor: true,
    },
  },
  limits: { maxSteps: 8, maxToolCalls: 12 },
  async run(step, input) {
    const draft = await step.agent('draft', 'writer', { input });
    const approval = await step.waitForEvent('approval', 'review.approved');
    return `${draft.output} (${approval.actor?.id}, ${approval.receivedAt})`;
  },
});
```

Input is validated and transformed before the initial checkpoint is stored.
Output is always validated with the definition schema, including after a pause
or recovery. Effective workflow limits combine definition and request limits;
agent steps additionally combine their own agent/request limits. These values
are checkpointed so recovery cannot silently widen a budget.

`stepId` is the durable identity of a step: keep it stable while its meaning is
stable. Increment `version` when replay order, business rules or step meanings
change. Completed agent steps are reused on replay and `step.agent` always
returns `{ runId, sessionId, output, usage? }`, without a transient `events`
field.

Child execution context inherits the workflow context. Namespace, attributes
and prompt values are merged; an authenticated parent actor cannot be replaced
by a child. `parallel` waits for every declared task to settle, records durable
child successes, reports multiple failures in declaration order and resolves
multiple pauses one at a time. Arbitrary promises used in `parallel` must be
pure or replay-safe; side effects belong in durable agent/tool steps.

External events must be declared. `waitForEvent` returns
`{ payload, actor, receivedAt }`; payload and required actor are checked before
the checkpoint changes. Cancelling a workflow first cancels its running or
paused children. Compensation runs in reverse completed-step order; if both the
workflow and compensation fail, the terminal error is a stable
`AggregateError`.

Durable executions start with a checkpoint v2 and lease in the same atomic
store operation. An external worker may recover an orphaned `running` run after
its lease expires:

```ts
await app.recoverRun(runId, { actor: { id: 'recovery-worker', type: 'service' } });
```

Paused runs use `resumeRun`; terminal runs and older checkpoints are rejected.
Fevex does not poll globally: deployments need an external orphan detector and
a scheduler that calls `resumeRun` for elapsed timers. Exactly-once protection
is limited to keyed/idempotent tools and durable steps.

## Advanced teams

`defineTeam` adds explicit supervisor coordination, parallel delegation and
traced handoffs without a second runtime:

```ts
const team = defineTeam({
  name: 'software-team',
  supervisor: 'planner',
  members: [
    { agent: 'researcher', role: 'research' },
    { agent: 'reviewer', role: 'review' },
  ],
  limits: { maxDelegations: 8, maxParallel: 2 },
  async run(step, input) {
    const research = await step.delegate('research', {
      agent: 'researcher',
      task: input,
    });
    return step.handoff('review', {
      from: 'researcher',
      to: 'reviewer',
      reason: 'Final review',
      task: research.output,
    });
  },
});

const app = createFevex({ models, agents, teams: [team] });
await app.runTeam('software-team', { input: 'Implement the change.' });
```

Team runs reuse workflow durability, approvals, budgets, stores and recovery.
Automatic network/graph routing, quorum, blackboards and nested teams remain
deferred.

## Connect A Model

Real providers connect through the small `ModelGateway` contract:

```ts
import type { ModelGateway } from '@fevex/core/models';

export const model: ModelGateway = {
  async *stream(input) {
    for await (const event of yourProvider.stream(input)) {
      if (event.type === 'text.delta') {
        yield { type: 'output.delta', delta: event.text };
      } else if (event.type === 'completed') {
        yield {
          type: 'completed',
          result: {
            output: event.output,
            toolCalls: event.toolCalls,
            usage: event.usage,
            providerState: event.providerState,
          },
        };
      }
    }
  },
};
```

The stream must emit visible text or JSON fragments as `output.delta` followed
by exactly one `completed` event. Fevex rejects missing or duplicate terminals,
post-terminal events and a final output that does not match the accumulated
deltas.

`providerState` is opaque, provider-specific continuation data. Fevex carries
it between model steps within one run and never adds it to agent messages,
events or `RunResult`. A direct `ModelGateway` consumer must pass it unchanged
to the next call; it is ephemeral and should not be inspected or persisted.

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
  schemaPolicy: 'best-effort',
})('deepseek-v4-flash');
```

Applications can still implement `ModelGateway` directly as shown above.

Official adapters preserve ordinary model text exactly. JSON-looking text is
still a string unless `outputSchema` is present; structured output is then
parsed as JSON and validated locally by Fevex. Tool names must match
`[A-Za-z0-9_-]{1,64}`.

`modelOptions` remains a provider escape hatch, but Fevex-owned request fields
take precedence: model, messages, tools, tool choice, schema format,
parallelism and preventive token limits cannot be replaced. Compatible options
such as temperature, metadata and provider-only reasoning settings are kept.

## Validation

`createFevex` validates the complete composition before returning the app,
including JavaScript values that bypass TypeScript. Invalid registrations throw
`FevexConfigurationError` with a stable `code` such as `INVALID_TOOL`,
`DUPLICATE_AGENT` or `MISSING_MODEL`, while preserving a readable message.

The app captures a shallow snapshot of registered definitions, tool lists,
limits, model options and `onEvent`. Mutating those caller-owned containers
after `createFevex` does not reconfigure a running app. Model gateways, schemas,
tool functions and nested provider-option values remain cooperative runtime
references and are not frozen.

Fevex accepts
[`StandardSchemaV1`](https://github.com/standard-schema/standard-schema)
validators for:

- agent and workflow input before it is persisted;
- tool input before `execute`;
- tool output before it is returned to the model;
- final agent and workflow output before it is returned to the application;
- declared workflow event payloads before a wait is resolved.

Schemas may transform values. The transformed result must still be JSON-safe.
Schemas belong to agent/workflow definitions; requests cannot replace an output
contract. Plain JSON Schema objects are not executable validators and are not
accepted by these fields.

When a model adapter needs schemas, Fevex converts authoring schemas that also
implement Standard JSON Schema into JSON Schema 2020-12 before calling
`ModelGateway.stream`. Adapters receive transportable JSON Schema in
`ToolSpec.inputSchema` and `ModelInput.outputSchema`; they never receive
the application's executable validators. If a run needs a schema at the model
boundary and the schema cannot be converted, Fevex fails before invoking the
model with `SCHEMA_NOT_TRANSPORTABLE`.

Transportable does not mean supported by every provider. Official adapters use
`schemaPolicy: "strict"` by default and validate their provider's documented
subset before making an HTTP request. Unsupported schemas fail with
`PROVIDER_SCHEMA_UNSUPPORTED`. Use `schemaPolicy: "best-effort"` explicitly
when local validation is sufficient and provider-level schema adherence is not
required; invalid model output can still fail locally and may require a retry
owned by the caller.

| Boundary | OpenAI strict | DeepSeek strict | Best effort |
| --- | --- | --- | --- |
| Tool input | Structured Outputs subset | Strict tools subset on `/beta` | Forwarded without provider guarantee |
| Final output | Structured Outputs subset | Unsupported | JSON instruction plus local validation |

Use `testModelGateway` to verify a custom model adapter against the shared
contract:

```ts
import { testModelGateway } from '@fevex/core/testing';

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
model.started
model.output.delta
model.completed
tool.started
tool.completed
tool.failed
run.completed
run.failed
run.cancelled
```

`streamAgent` yields each persisted event as it happens. Use
`model.output.delta` to render output incrementally:

```ts
for await (const event of app.streamAgent('support', { input: 'Hello' })) {
  if (event.type === 'model.output.delta') {
    process.stdout.write(event.payload.delta);
  }
}
```

Successful runs also return their events in `RunResult.events`.
Every event has a unique `id` and a run-local `sequence` starting at `1`.
`model.completed` includes the current step and accumulated usage.
Tool events include the current step, tool call ID and tool name.
`run.completed` includes the final JSON output and accumulated usage.

`onEvent` is a best-effort observer isolated from execution. Its exceptions do
not fail the run, and it continues receiving later events. Fevex does not await
a Promise returned by the observer, but absorbs its rejection to avoid an
unhandled rejection.

Consume the same execution incrementally with `streamAgent`:

```ts
for await (const event of app.streamAgent('support', {
  input: 'What is the status of account 42?',
})) {
  console.log(event.type, event.payload);
}
```

The stream emits `run.failed` before propagating the original error.
Cancellation emits `run.cancelled` with a safe `aborted` or `timeout` reason,
then propagates the original abort reason. `streamAgent` applies backpressure:
the run advances only while the consumer requests events, and abandoning the
iterable cancels and persists that local execution.

## Sessions and consultable runs

Every run belongs to a session. Omit `sessionId` to create one, then pass the
returned ID to continue the conversation:

```ts
const first = await app.runAgent('support', {
  input: 'What is the status of account 42?',
});

const second = await app.runAgent('support', {
  input: 'What should I do next?',
  sessionId: first.sessionId,
});
```

Only completed interactions enter session history. Failed and cancelled runs do
not affect the next prompt. Replace old history with an application-provided
summary when needed:

```ts
await app.compactSession(first.sessionId, 'Account 42 is active.');
```

Use `startAgent` when execution must continue without consuming a stream:

```ts
const started = await app.startAgent('support', {
  input: 'Check account 42.',
});

const run = await app.getRun(started.id);
const events = await app.listEvents(started.id);
const laterEvents = await app.listEvents(started.id, {
  after: events.at(-1)?.id,
});

await app.cancelRun(started.id);
```

`AgentRun`, `Session` and events are serializable snapshots. `listEvents` orders
by `sequence`; `after` accepts an event ID from the same run as a stable cursor.
Unknown cursors fail instead of silently replaying events.

`createFevex` uses `InMemoryRunStore` by default. Supply `runStore` to replace
it. The default survives only while the process lives, and one run at a time
may update a session.

## Approvals and durable runs

Tools can declare risk, approval, idempotency, retries and credential names.
Approval pauses before credentials are resolved or the effect starts:

```ts
const charge = defineTool({
  name: 'charge',
  risk: 'sensitive',
  approval: 'required',
  idempotency: 'keyed',
  credentials: ['payments-api-key'],
  retry: { maxAttempts: 3, backoffMs: 200, maxBackoffMs: 2_000 },
  async execute(input, context) {
    const apiKey = await context.getCredential('payments-api-key');
    return chargeCustomer(input, {
      apiKey,
      idempotencyKey: context.idempotencyKey,
    });
  },
});
```

`runAgent` throws `RunPausedError`, `streamAgent` emits `run.paused`, and
`startAgent` leaves the paused snapshot consultable. Continue an approval from
any runtime sharing the durable store:

```ts
await app.resumeRun(runId, {
  type: 'approval',
  approvalId,
  decision: 'approve',
  actor: { id: 'reviewer-42' },
});
```

Use `InMemoryRunStore` for ephemeral runs, `@fevex/sqlite` for local durability,
or `@fevex/postgres` across multiple processes:

```ts
import { createSQLiteRunStore } from '@fevex/sqlite';

const runStore = createSQLiteRunStore({
  filename: '.fevex/runs.db',
});
```

SQLite creates and migrates its local file automatically. PostgreSQL migrations
remain explicit and are intended for server deployments.

Policies run before approval resolution, credentials and each effect or retry.
Credential values are not stored or sent to the model, and tool outputs that
contain a resolved value are rejected.

## Limits

Agent runs default to 8 model steps and 16 sequential tool calls. Override
them on the agent:

```ts
defineAgent({
  name: 'support',
  instructions: 'Answer account questions clearly.',
  limits: {
    maxSteps: 4,
    maxToolCalls: 6,
    maxInputTokens: 10_000,
    maxOutputTokens: 2_000,
  },
});
```

Input token limits are cumulative run budgets checked from provider usage after
each model response. Output token limits are also sent to model gateways as the
remaining preventive cap, then verified from reported usage. A configured token
limit fails explicitly when the gateway does not report the corresponding usage
field. Set a token limit to `false` to leave it unlimited.

Cancellation is immediate from the caller's perspective. Models, tools and
schema validators still need to honor the supplied `AbortSignal` to stop their
underlying work. External systems must enforce the supplied idempotency key to
make keyed retries safe. Repeated tool call IDs are rejected within a run before
Fevex repeats an effect.

## Observability

Add trace exporters to the application configuration; agent definitions stay
unchanged:

```ts
import { createOpenTelemetryExporter } from '@fevex/opentelemetry';

const app = createFevex({
  models,
  agents,
  tools,
  observability: {
    exporters: [createOpenTelemetryExporter()],
    calculateCost({ usage }) {
      return {
        amount: (usage.totalTokens ?? 0) * 0.000_001,
        currency: 'USD',
      };
    },
  },
});

await app.runAgent('support', { input: 'Hello' });
await app.flushObservability();
```

Traces contain only metadata by default. Output and safe error capture require
an explicit `content.include` policy; sensitive object keys are redacted before
an optional application redactor runs. Exporters run outside the run path: their
errors never change the run result, and `flushObservability()` reports pending
export failures. OpenTelemetry SDK setup, OTLP export and shutdown remain
application responsibilities.

## Evaluations

`@fevex/core/evals` runs local datasets sequentially with fresh sessions:

```ts
import {
  exactOutputScorer,
  runEvaluation,
  toolSelectionScorer,
} from '@fevex/core/evals';

const report = await runEvaluation({
  app,
  suiteName: 'support-regression',
  targetVersion: 'v2',
  agentName: 'support',
  dataset: {
    name: 'support',
    version: '1',
    cases: [{
      id: 'active-account',
      input: 'Check account 42',
      expected: {
        output: { answer: 'Account 42 is active.' },
        tools: ['accounts_get'],
      },
    }],
  },
  scorers: [exactOutputScorer(), toolSelectionScorer()],
});
```

Built-in deterministic scorers cover exact output, ordered or unordered tool
selection, forbidden tools, max latency, max tokens and max cost. Use
`serializeEvalReport` for a canonical, versionable JSON baseline, `jsonReporter`
or `textReporter` with your own write callback, and `compareEvaluationReports`
to fail CI when cases disappear, passing scores fail or scores drop beyond the
configured tolerance.

## Public Exports

| Import | Purpose |
| --- | --- |
| `@fevex/core` | Common runtime, definitions and contracts |
| `@fevex/core/agents` | Agent definitions |
| `@fevex/core/channels` | Channel adapters and message handling |
| `@fevex/core/knowledge` | Context providers, skills and memory contracts |
| `@fevex/core/models` | Provider-neutral model contracts |
| `@fevex/core/tools` | Tool definitions and execution context |
| `@fevex/core/workflows` | Durable workflow definitions |
| `@fevex/core/teams` | Multiagent team definitions |
| `@fevex/core/runtime` | Runs, sessions and store contracts |
| `@fevex/core/sandbox` | Sandbox contract and local development sandbox |
| `@fevex/core/policies` | Authorization policy contracts |
| `@fevex/core/observability` | Trace, redaction and cost contracts |
| `@fevex/core/evals` | Datasets, scorers, reporters and regressions |
| `@fevex/core/testing` | Deterministic testing helpers |

All subpaths ship in the same `@fevex/core` package.

## Current Scope

The MVP intentionally supports:

- bounded multi-step model-tool loops with sequential tool execution;
- native provider streaming and durable, consultable runs;
- synchronous event observers and `AsyncIterable` event streaming;
- local traces, OpenTelemetry export and deterministic evaluation suites;
- optional Standard Schema validation;
- immediate `AbortSignal` cancellation with cooperative underlying work.

It does not include a CLI, hosted observability service, model-judge evals or
human evaluation workflows.

## Documentation

- [Core MVP roadmap](docs/fevex_core_mvp_roadmap.md)
- [Integrations roadmap](docs/fevex_integrations_roadmap.md)
- [Release guide](docs/fevex_release_guide.md)
- [Foundational brief](docs/fevex_brief_fundacional.md)

## Development

```bash
bun install
bun run test
bun run typecheck
bun run build
```

Bug reports and focused proposals are welcome in
[GitHub Issues](https://github.com/hemia-labs/fevex/issues).

## License

[Apache License 2.0](LICENSE)
