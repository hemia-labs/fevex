# @fevex/postgres

PostgreSQL 16 `DurableRunStore` adapter for Fevex.

```bash
npm install @fevex/core @fevex/postgres
```

```ts
import { createPostgresRunStore } from '@fevex/postgres';

const runStore = createPostgresRunStore({
  connectionString: process.env.DATABASE_URL!,
});

await runStore.migrate();
```

Pass `runStore` to `createFevex`. Migrations are never run automatically. The
adapter uses the fixed `fevex` schema and persists sessions, runs, private
checkpoints, events, leases and tool execution records.

`close()` closes only a pool created from `connectionString`. When a `pg.Pool`
is supplied, pool lifecycle remains owned by the application.

## Integration tests

The `Framework validation` GitHub Actions workflow starts a temporary PostgreSQL
16 service and runs the full test suite with `FEVEX_POSTGRES_URL` configured.
No production database or repository secrets are needed. The service is discarded
after the job. `FEVEX_REQUIRE_POSTGRES=1` makes a missing connection URL fail
instead of silently skipping the integration tests.

The real PostgreSQL tests cover the durable store contract, concurrent approval
resolution across two runtimes, persistence of team runs, and session ownership
between independent processes. The process test races two workers, checks
compaction, kills the owner and recovers its run without losing history.
They use fake models and do not require model API keys. A second process test verifies that stale generations cannot commit, renew or
release a newer lease, even when the owner ID and run revision are unchanged.

Locally, `bun run test` skips those five integration tests unless
`FEVEX_POSTGRES_URL` points to a dedicated test database. Browser preview tests
use a simulated sandbox and run as part of the source suite without a browser binary.

## Shared sessions

Session reservation uses a short transaction with a row lock on the session,
an active-run lookup, and a revision check. No transaction stays open while
waiting for a model, tool or approval. Paused and orphaned runs retain ownership
until completion, failure or cancellation; recover the existing run after a crash.

Run `migrate()` before upgrading workers. The additive migration indexes active
and paused runs by session; histories without a revision start at zero.
Upgrade core and adapters on every worker together.

## Lease fencing

Migrations add a persistent generation column to `fevex.leases`. Each acquisition
advances it, including reuse of an owner ID. Commits lock the lease row, then
check owner, generation and expiry using the database clock in the same
transaction as the data changes. Renewals check expiry after obtaining the row
lock; release expires the token without removing its generation.

Stop old workers before upgrading. Legacy leases start at generation zero;
they cannot commit or renew and must expire before a new worker recovers the run.

### Event pagination

Use `listEvents(runId, { after: eventId, limit: 100 })` to read incremental pages.
The store resolves the cursor's sequence and uses the existing `(run_id, sequence)`
index to filter and limit rows in SQL before decoding event payloads. An unknown
cursor or one from another run raises `INVALID_CURSOR`. To read only the latest
event, pass `{ order: 'desc', limit: 1 }`. Without a limit, existing full-log reads
remain supported. No schema migration is needed for pagination.
