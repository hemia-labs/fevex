# Fevex Studio

Local diagnostics UI for Fevex runs. It is a client of the public HTTP API, not
a second runtime: it does not read the database, import server internals or
re-execute runs.

## Run

Start the Nest API (it enables demo auth and persists runs in SQLite):

```bash
bun run dev:nest
```

Then start Studio:

```bash
bun run dev:studio
```

Open <http://localhost:3002>. Create a run from the playground at
<http://localhost:3000>, then open it in Studio.

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_FEVEX_API_URL` | `http://127.0.0.1:3001` | Fevex HTTP API base URL |
| `NEXT_PUBLIC_FEVEX_API_TOKEN` | unset | Optional bearer token |

The playground starts Nest with `FEVEX_DEMO_AUTH=1`, so Studio needs no token
for local use. When the API requires authentication, use **Conexión** in the
header; the token is stored in `localStorage` for that browser.

## What it shows

- Runs newest first, with status, model, duration and result.
- Run detail with status, output, error, usage and session.
- Event timeline, grouped streamed model output and JSON payloads.
- Tool activity with failures, retries and connection source.
- Pending approvals with the tool input and approve/reject actions.
- Cancel for running or paused runs.

Approvals use the normal resume API, so the actor comes from the bearer token
(or `demo-user` in demo mode).

## Data source

Studio calls only these public endpoints:

```text
GET  /v1/runs
GET  /v1/runs/:id
GET  /v1/runs/:id/events   (SSE)
POST /v1/runs/:id/resume
DELETE /v1/runs/:id
```

`GET /v1/runs` requires a run store that implements `RunCatalog`. The in-memory
store and `@fevex/sqlite` implement it today; other stores return
`RUN_LIST_UNSUPPORTED`. The Postgres store is not wired to listing yet.

## Scope

This is the first FEV-306 slice. It covers runs, events, tools and approvals.
Prompt inspection, eval runs and replay remain future work. Elicitation and
unknown tool executions are shown read-only; resolve them from the host UI or a
dedicated form when needed.
