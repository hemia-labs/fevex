# Fevex HTTP v3 playground

The Nest example hosts `@fevex/core/http`; the Next.js playground consumes its
official client. Nest owns HTTP lifecycle and Fevex owns runs, sessions and
events.

## Run

DeepSeek is the default:

```bash
FEVEX_PROVIDER=deepseek DEEPSEEK_API_KEY=... bun run dev:nest
```

OpenAI uses the same agents and protocol:

```bash
FEVEX_PROVIDER=openai OPENAI_API_KEY=... bun run dev:nest
```

Para alternarlos desde el playground, configura ambas claves en el mismo
proceso:

```bash
FEVEX_PROVIDER=deepseek DEEPSEEK_API_KEY=... OPENAI_API_KEY=... bun run dev:nest
```

If both API keys are configured, the playground lets you choose the provider
and reasoning effort per run. Use `DEEPSEEK_MODEL` and `OPENAI_MODEL` to override each model;
`FEVEX_MODEL` remains a shortcut for the provider selected by
`FEVEX_PROVIDER`. OpenAI also accepts `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID`.

`bun run dev` sets `FEVEX_DEMO_AUTH=1`, so anonymous playground requests use
`demo-user`. The compiled `start` script requires a bearer token.

Start the UI separately with `bun run dev:next` and open
`http://localhost:3000`. `NEXT_PUBLIC_NEST_API_URL` defaults to
`http://localhost:3001`.

## Capability demos

The API exposes independent agents for the optional capabilities:

| Agent | Capability | Example prompt |
| --- | --- | --- |
| `mcp-tools` | Local MCP connection named `nest_mcp` | `Use MCP to slugify Hello Fevex Workflows` |
| `research` | Shared MCP docs + OpenAPI account agent with evidence evals | `¿Cómo uso resumeRun y cuál es el estado y plan de la cuenta 42?` |
| `billing-openapi` | Bundled OpenAPI 3.1 connection | `Get invoice INV-10` |
| `refund-approval` | Durable human approval and keyed effect | `Refund account 10 for 250 MXN because of a duplicate charge` |
| `knowledge-support` | Skill, request context and session memory | `What refund policy and customer context apply?` |
| `sandbox-code` | Local development sandbox for allowlisted commands | `Evaluate 2 * (21 + 1) in the sandbox` |
| `elicitation-support` | Durable elicitation for missing information | `Check the status for my account` |

For the MCP demo, start the local MCP server first with `bun run dev:mcp`.
The playground timeline will show rows like `Usando MCP nest_mcp · slugify`
while the tool runs, completes or fails.

The `research` agent uses repository docs and account fixtures in process by
default, so it needs no separate MCP server. The UI displays source quotes and
offers **Evaluar modelo** for seven isolated cases using the selected model.
Documentation results include complete section context and code; the UI renders
steps and copyable examples. Evaluations reject modified or unsupported code.
This explicit action uses the provider API. The API-failure case should fail
its run and pass its checks. Evaluations use the model's default reasoning;
conversation runs retain the playground's reasoning selector. See
[research](../research/) for commands, limits and configurable external services.
Nest resolves local docs relative to its example directory; set
`FEVEX_RESEARCH_DOCS_PATH` when starting it from another working directory.

`bun run --cwd examples/nest-api build` emits ESM, matching the workspace
packages. Use `bun run --cwd examples/nest-api start` to run the compiled host;
its entry includes the shared research definitions.

`sandbox-code` uses `createLocalSandbox` with the current Node/Bun executable
allowlisted, empty env by default, a short timeout and no network capability.
It demonstrates the contract only; use an external provider for production
isolation.

Runs and approval checkpoints persist in
`FEVEX_DB_PATH` (default `.fevex/demo.sqlite`).

## Slack agent

The playground lists a `slack-support` agent. It uses the in-process MCP
account fixture (`accounts_list` and `accounts_get`), the same model catalog and
reasoning-effort selector as every other agent, and the normal playground
streaming/tool timeline. `/slack` rewrites to `/?agent=slack-support` so the
Slack agent is selected on load.

No API key is entered in the page; the existing `OPENAI_API_KEY` or
`DEEPSEEK_API_KEY` in the Nest process is used. Use `examples/slack` when you
need real Slack signatures, retries, SQLite durability or Docker.

## Multi-tenant authorization

The host authenticates demo bearer tokens and passes the resulting actor to
`createFevexHttpHandler`:

| Token | Actor | Tenant |
| --- | --- | --- |
| `alice-token` | `alice` | `tenant-a` |
| `bob-token` | `bob` | `tenant-b` |

Requests without a token use `demo-user` only while `FEVEX_DEMO_AUTH=1`, which
the `dev` script sets so the Next playground and README curl snippets keep
working. The optional `authorize` hook checks every read, event stream,
cancellation, resume, recovery and start (new or existing session), and
`onRunStarted` records run and session owners. Both identities can create runs,
but neither can access the other's resources:

```bash
ALICE_RUN=$(curl -s http://localhost:3001/v1/agents/support/runs \
  -H 'authorization: Bearer alice-token' \
  -H 'content-type: application/json' \
  -d '{"input":"Check account 10"}' | jq -r .id)

# 403: bob cannot read alice's run
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:3001/v1/runs/$ALICE_RUN \
  -H 'authorization: Bearer bob-token'

# 200: alice can
curl -s -o /dev/null -w '%{http_code}\n' \
  http://localhost:3001/v1/runs/$ALICE_RUN \
  -H 'authorization: Bearer alice-token'
```

The example persists owners in `FEVEX_OWNERS_PATH` (default
`.fevex/owners.json`) so restarts keep access. Use a database-backed store for
multiple processes. The core stores runs and events but does not assign
tenants. Replace the demo tokens with your identity provider and require
authentication before exposing the API.

The browser preview is dev-only for token-owned runs: `EventSource` cannot send
the `Authorization` header, so it uses the demo identity enabled by the dev
script. Use a cookie-based session for previews in a token-authenticated
deployment.

Runs started outside the HTTP handler (channels, schedulers or direct
`startAgent` calls) must be claimed in the same ownership store, or their HTTP
resources will be denied. A process crash between starting a run and writing its
owner also leaves it unowned; treat unowned runs as inaccessible or reserve
ownership before starting.

`elicitation-support` demonstrates the same durable pause mechanism for missing
information. Ask without an account ID, answer the generated form in the
playground, and the run resumes through `POST /v1/runs/:runId/resume`.

To approve a refund, start the run and observe its events:

```bash
curl -s http://localhost:3001/v1/agents/refund-approval/runs \
  -H 'content-type: application/json' \
  -d '{"input":"Refund account 10 for 250 MXN because of a duplicate charge"}'

curl -N http://localhost:3001/v1/runs/RUN_ID/events
```

Use the `approvalId` from `approval.requested`:

```bash
curl -s http://localhost:3001/v1/runs/RUN_ID/resume \
  -H 'content-type: application/json' \
  -d '{"type":"approval","approvalId":"APPROVAL_ID","decision":"approve"}'
```

The workflow list also includes `review-workflow`, a durable wait/event demo.
It drafts an answer, pauses on `review.approved`, then resumes through the same
run endpoint:

```bash
curl -s http://localhost:3001/v1/workflows/review-workflow/runs \
  -H 'content-type: application/json' \
  -d '{"input":"Prepare a reviewed answer for account 10"}'

curl -s http://localhost:3001/v1/runs/RUN_ID/resume \
  -H 'content-type: application/json' \
  -d '{"type":"event","eventName":"review.approved","payload":{"approved":true,"comment":"Looks good"}}'
```

## Retention, admission and deadlines

The host applies these operational limits per runtime process:

| Variable | Default | Effect |
| --- | --- | --- |
| `FEVEX_MAX_ACTIVE_RUNS` | `8` | Concurrent top-level runs |
| `FEVEX_MAX_ACTIVE_RUNS_PER_TENANT` | `4` | Concurrent top-level runs per `tenantId` |
| `FEVEX_MAX_EVENTS_PER_RUN` | `10000` | Non-control events persisted per run |
| `FEVEX_MAX_CONNECTIONS` | `64` | Concurrent SSE streams |

Start requests accept `deadlineMs`:

```bash
curl -s http://localhost:3001/v1/agents/support/runs \
  -H 'content-type: application/json' \
  -d '{"input":"Check account 10","deadlineMs":60000}'
```

An expired deadline cancels the run with `run.cancelled` reason `timeout`.
Resuming or recovering after the absolute deadline persists that cancellation
instead of continuing.

Purge terminal runs from a scheduled host job:

```ts
const result = await fevex.purgeRuns({
  before: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  limit: 1000,
});
// { runs, sessions }
```

Only `completed`, `failed` and `cancelled` runs are purged; running or paused
runs and their sessions are kept. Artifact retention is separate. Admission
counts are local to one runtime process; use `admission.authorize` for
distributed quotas.

## Protocol

The protocol examples below assume the dev server (`FEVEX_DEMO_AUTH=1`). With
the compiled `start` script or token-owned runs, add
`-H 'authorization: Bearer alice-token'` to each request.

Start a run:

```bash
curl -s http://localhost:3001/v1/agents/support/runs \
  -H 'content-type: application/json' \
  -d '{"input":"Check account 10"}'
```

The same request accepts `model` (`deepseek` or `openai`) and `reasoning`
(`provider-default`, `none`, `low`, `medium`, `high`, `xhigh` or `max`,
depending on the selected provider). Add `deadlineMs` to cap the run's
wall-clock time.

The `202` response is an `AgentRun` containing `id` and `sessionId`. Pass that
session ID when starting another run to continue the conversation.

Observe without starting another execution:

```bash
curl -N http://localhost:3001/v1/runs/RUN_ID/events
```

Each frame uses the persisted core event:

```text
id: <event.id>
event: <event.type>
data: {"id":"...","sequence":1,"runId":"...","timestamp":"...","type":"run.started"}

```

Reconnect with `Last-Event-ID` to receive only later events:

```bash
curl -N http://localhost:3001/v1/runs/RUN_ID/events \
  -H 'Last-Event-ID: EVENT_ID'
```

Inspect with `GET /v1/runs/:runId`, cancel with
`DELETE /v1/runs/:runId`, and resume paused work with
`POST /v1/runs/:runId/resume`. An authenticated worker can explicitly recover
an orphaned running execution with `POST /v1/runs/:runId/recover`; Fevex does
not run a global recovery poller. Errors use `application/problem+json`; every
response includes `Fevex-Protocol-Version: 3`.

Inspect an existing run without changing its state from the repository root:

```bash
bun run inspect RUN_ID --api http://localhost:3001 --events
```

See the [example catalog](../README.md) for event cursors, timeouts and metadata
output.

Closing the SSE connection only stops observation. The run continues until it
finishes or is explicitly cancelled. This example uses demo bearer tokens and
file-backed demo ownership, not a production identity provider, CORS policy,
TLS or server-managed replay.
