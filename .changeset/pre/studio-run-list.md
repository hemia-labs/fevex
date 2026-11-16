---
"@fevex/core": minor
"@fevex/sqlite": minor
---

Add a public run listing API and a local Studio.

`GET /v1/runs` lists runs newest first with `limit`, `status` and opaque `cursor`
pagination, and filters runs through the host `authorize` hook. `Fevex.listRuns`
and the HTTP client expose the same contract. The in-memory and SQLite stores
implement `RunCatalog`; other stores return `RUN_LIST_UNSUPPORTED`.

`examples/studio` consumes only public endpoints to show runs, event timelines,
tool activity and approvals, and to resolve or cancel runs. It does not read the
database or import server internals.
