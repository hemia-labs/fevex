# Fevex HTTP v2 playground

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

`FEVEX_MODEL` overrides `deepseek-v4-flash` or `gpt-5.6`. OpenAI also accepts
`OPENAI_ORG_ID` and `OPENAI_PROJECT_ID`.

Start the UI separately with `bun run dev:next` and open
`http://localhost:3000`. `NEXT_PUBLIC_NEST_API_URL` defaults to
`http://localhost:3001`.

## Capability demos

The API exposes independent agents for the optional capabilities:

| Agent | Capability | Example prompt |
| --- | --- | --- |
| `mcp-tools` | Local MCP connection named `nest_mcp` | `Use MCP to slugify Hello Fevex Workflows` |
| `billing-openapi` | Bundled OpenAPI 3.1 connection | `Get invoice INV-10` |
| `refund-approval` | Durable human approval and keyed effect | `Refund account 10 for 250 MXN because of a duplicate charge` |
| `knowledge-support` | Skill, request context and session memory | `What refund policy and customer context apply?` |
| `sandbox-code` | Local development sandbox for allowlisted commands | `Evaluate 2 * (21 + 1) in the sandbox` |

For the MCP demo, start the local MCP server first with `bun run dev:mcp`.
The playground timeline will show rows like `Usando MCP nest_mcp · slugify`
while the tool runs, completes or fails.

`sandbox-code` uses `createLocalSandbox` with the current Node/Bun executable
allowlisted, empty env by default, a short timeout and no network capability.
It demonstrates the contract only; use an external provider for production
isolation.

Runs and approval checkpoints persist in
`FEVEX_DB_PATH` (default `.fevex/demo.sqlite`). The example uses the fixed
actor `demo-user` to make approval runnable without adding fake authentication.
Do not copy that actor setup into production.

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

## Protocol

Start a run:

```bash
curl -s http://localhost:3001/v1/agents/support/runs \
  -H 'content-type: application/json' \
  -d '{"input":"Check account 10"}'
```

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
response includes `Fevex-Protocol-Version: 2`.

Closing the SSE connection only stops observation. The run continues until it
finishes or is explicitly cancelled. This example intentionally has no real
auth, production CORS policy, TLS or server-managed replay.
