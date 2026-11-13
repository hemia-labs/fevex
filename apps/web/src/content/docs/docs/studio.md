---
title: Local Studio
description: Inspect runs, event timelines, tools and approvals with a local UI over the public HTTP API.
---

The local Studio is a diagnostics console for Fevex runs. It is not a builder
and not a second runtime: it reads runs and events through the public HTTP API,
resolves approvals through the normal resume endpoint and never imports server
internals or reads the database directly.

It is useful when a tool fails, a run is paused for approval or you need to see
the event sequence without reading raw logs.

## Run it

Start the Nest host, which enables demo auth and persists runs in SQLite:

```bash
bun run dev:nest
```

In another terminal:

```bash
bun run dev:studio
```

Open <http://localhost:3002>. Create a run from the playground at
<http://localhost:3000> and open it in Studio.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_FEVEX_API_URL` | `http://127.0.0.1:3001` | Fevex HTTP API base URL |
| `NEXT_PUBLIC_FEVEX_API_TOKEN` | unset | Optional bearer token |

With `FEVEX_DEMO_AUTH=1` the playground uses `demo-user` and Studio needs no
token. When the API requires authentication, set the token under **Conexión** in
the header; it is stored in that browser's `localStorage`.

## What it shows

- Runs newest first with status, model, duration and result.
- Run detail with output, error, session and token usage.
- Event timeline with streamed model output grouped per step.
- Tool activity with failures, retries and connection source.
- Pending approvals with the tool input and approve/reject actions.
- Cancel for running or paused runs.

## Public API

Studio uses only these endpoints:

```text
GET    /v1/runs
GET    /v1/runs/:id
GET    /v1/runs/:id/events   (SSE)
POST   /v1/runs/:id/resume
DELETE /v1/runs/:id
```

`GET /v1/runs` supports `limit`, `status` and an opaque `cursor`, and returns
`{ runs, next? }`. The host `authorize` callback filters runs the caller cannot
read.

Listing requires a run store that implements `RunCatalog`. The in-memory store
and `@fevex/sqlite` implement it; other stores return `RUN_LIST_UNSUPPORTED`.

## Scope

This first slice covers runs, timelines, tools and approvals. Prompt inspection,
eval runs and replay remain future work. Elicitation and unknown tool executions
are displayed read-only.

Studio does not replace the beta gate: external pilots still validate install,
approval/resume, recovery and upgrades from the published packages.
