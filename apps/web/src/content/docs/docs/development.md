---
title: Templates & debugging
description: Choose an adaptable example and inspect runs through public Fevex APIs.
---

Start with a runnable TypeScript example and adapt its definitions. The
[example catalog](https://github.com/hemia-labs/fevex/tree/main/examples)
lists requirements, commands and the files to change. Templates use the same
`defineAgent`, `defineTool`, `defineConnection` and `createFevex` contracts as
application code.

## Choose a starting point

From the repository root, after `bun install --frozen-lockfile`:

| Command | Use it for |
| --- | --- |
| `bun run demo:starter` | An agent with a validated local read tool and a metadata trace. |
| `bun run demo:channels` | Paused requests, human/service responses and delivery retries. |
| `bun run demo:connections` | Documentation through MCP and account data through OpenAPI. |
| `bun run demo:research` | Combined research, cited evidence and structured account facts. |
| `bun run eval:research` | Six cases checking tools, evidence, missing information and API failure. |

These examples default to deterministic models. The connections and research
demos make real HTTP requests to a temporary service on localhost; the other
commands need no network.
To use an actual model, replace the registered gateway and keep the agent's
registry name. Configure trusted data access, permissions and persistence in
your host, then add representative evaluation cases.

## Research and evaluations

The [research example](https://github.com/hemia-labs/fevex/tree/main/examples/research)
shares one agent definition with the Nest + Next playground. It combines MCP
documentation search with OpenAPI account reads and returns a structured answer,
cited sources with quotes, and account facts. The playground shows these sources
and its existing tool timeline. Documentation search includes section context
and complete code examples; answers display steps and copyable code.
**Evaluar modelo** explicitly runs seven cases
using the selected provider model.

To use a real model in the standalone example, set the provider key and pass
`--provider openai --model "$MODEL_ID"` or `--provider deepseek --model "$MODEL_ID"`
to `demo:research` or `eval:research`. `MODEL_ID` is a model available in your
provider account. The default fixtures use local repository docs and synthetic
account 42. Both trusted service endpoints can be replaced through
`RESEARCH_MCP_URL` and `RESEARCH_API_URL`; see the example for schemas and
host-owned credentials. Evaluations always use local fixture data and isolated
in-memory runs, even when normal research has external endpoints configured.

The existing `@fevex/core/evals` runner checks tool selection and a custom scorer
compares citations/quotes and structured facts with the tool results received by
the model. A code scorer rejects invented, edited, partial or uncited examples.
Cases cover docs, accounts, combined research, no matches, missing ID, missing
requested code and API failure. The API-failure run intentionally fails; its checks must pass.
A passing suite has twenty-one passed checks, six completed runs and one expected
failed run. These checks assess provenance and structured facts, not every
natural-language claim. Real model evaluations incur provider usage; scripted
results only verify runtime contracts and scorers.

## Inspect state and events

The repository's `inspect` command uses `@fevex/core/http`. It makes GET requests
and prints run state and event metadata as JSON lines:

```bash
bun run inspect RUN_ID --api http://localhost:3001
bun run inspect RUN_ID --api http://localhost:3001 --events
```

The state report includes IDs, run kind, name, revision, timestamps, status,
pause type and token usage when available. Event lines include sequence, event
ID, type, timestamp, step/tool names and connection source when available.
Prompts, outputs, tool inputs and raw event payloads are not printed.

`--events` replays persisted events and follows a running run until it pauses
or finishes. `--after EVENT_ID` reconnects after the last observed event. The
default timeout is ten seconds; a timeout returns a nonzero exit code and leaves
the agent execution unchanged:

```bash
bun run inspect RUN_ID --events --after EVENT_ID --timeout-ms 30000
```

Set `FEVEX_API_TOKEN` in the environment if your host uses bearer authentication.
The host must authorize reads. The command requires a reachable HTTP host with
the same public Fevex protocol; it does not search local databases or start runs.

To try it without a model key, run `bun run demo:starter --serve`. Copy `api` and
`runId` from the final JSON line and inspect that URL from another terminal.
The starter's optional host accepts only GET requests on localhost. Stop it with
Ctrl+C; its in-memory run is not retained afterwards.

## Inspect inside your application

For an in-process app, use the existing public APIs:

```ts
const run = await app.getRun(runId);
const events = await app.listEvents(runId, { limit: 100 });
const nextPage = await app.listEvents(runId, { after: events.at(-1)?.id, limit: 100 });
```

These return the full runtime records. Select metadata before logging them,
and protect any captured content. A snapshot can be `running`; `resumeRun`
schedules continuation and does not imply the run has already completed.

| State | Next check |
| --- | --- |
| `running` | Observe events; inspect model/tool progress and the worker's health. |
| `paused` | Check the pause type; use the matching resolution with an authorized actor. |
| `failed` | Inspect the failure event's code and your protected application logs. |
| `cancelled` | Confirm cancellation was intended before starting a new task. |
| `completed` | Inspect your authorized result and compare evaluation expectations. |

Unknown runs may belong to another store or a stopped in-memory host. An
`INVALID_CURSOR` means the event ID is unknown or belongs to another run.
`RUN_DEFINITION_CHANGED` requires reconciling the definition before resuming;
do not bypass the definition guard. [Channels](/docs/channels/) explains delivery
retries and trusted routing; [Workflows & teams](/docs/workflows/) explains
explicit recovery and scheduling.

## Traces

The starter collects the public `RunTrace` exported through
`observability.exporters`. Traces include model/tool spans and duration, with
metadata only by default. Call `flushObservability()` before shutdown to finish
pending exports. The event journal is the durable run history; an `onEvent`
callback is a local observer. Choose a [persistent store](/docs/adapters/) when
you need history after restarting the host.
