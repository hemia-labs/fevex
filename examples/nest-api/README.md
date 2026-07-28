# Fevex HTTP v1 playground

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
`POST /v1/runs/:runId/resume`. Errors use `application/problem+json`; every
response includes `Fevex-Protocol-Version: 1`.

Closing the SSE connection only stops observation. The run continues until it
finishes or is explicitly cancelled. This example intentionally has no auth,
CORS policy, durable store, TLS or server-managed replay.
