# Adaptable agent starter

Run from the repository root after installing workspace dependencies:

```bash
bun run demo:starter
```

This runs a complete model → tool → model cycle, asserts the tool result and
prints a run ID plus a metadata-only trace. No keys, browser or network are
required. `agent.ts` contains the reusable definitions; `index.ts` composes the
runtime, supplies a deterministic model and checks the demonstration.

## What to change

| File or setting | Adaptation |
| --- | --- |
| `support.instructions` | Your agent's purpose and how it should use tools. |
| `support.tools` | The explicit tools that this agent may call. |
| `support.limits` | Step and tool-call budgets for your task. |
| `getAccount.execute` | Replace the synthetic account with an authorized lookup. |
| `accountInput` | Update the JSON schema and its runtime validation together. |
| `models.primary` | Replace `fakeModel` with a model gateway; the definition keeps the same registry name. |
| `observability.exporters` | Replace the in-memory trace collector with your exporter. |

The starter explicitly forbids elicitation and denies approval so it runs
without waiting for external interaction. For interactive agents, start with
the [channel example](../channel-elicitation/). For services described by MCP or
OpenAPI, start with the [connections example](../connections/).

`inputJsonSchema` describes model inputs; the tool calls
`compileFevexJsonSchema(...).validate(input)` before reading data. A Standard
Schema validator can instead be supplied as `inputSchema`. Keep validation at
the data boundary when adapting the tool.

Copy `agent.ts` and the `createFevex` composition into your application. The
assertions and fixture model belong to this example: retain them as deterministic
regression checks and use representative evals for a real model. Copying this
starter does not require a template registry or a separate runtime.

## Inspect locally

```bash
bun run demo:starter --serve
```

The final line contains `api` and `runId`. In another terminal:

```bash
bun run inspect RUN_ID --api http://127.0.0.1:PORT --events
```

The optional debug host serves only GET requests on localhost. Its in-memory
run lasts until you stop it with Ctrl+C. The inspector prints metadata; the
starter's own first report also prints its synthetic answer. A production host
must authorize resource access and choose a persistent store when needed.

Check the starter and inspector types:

```bash
bun x tsc -p examples/starter/tsconfig.json
```
