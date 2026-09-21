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

The `Fevex Quality Gate` GitHub Actions workflow starts a temporary PostgreSQL
16 service and runs the full test suite with `FEVEX_POSTGRES_URL` configured.
No production database or repository secrets are needed. The service is discarded
after the job. `FEVEX_REQUIRE_POSTGRES=1` makes a missing connection URL fail
instead of silently skipping the integration tests.

The real PostgreSQL tests cover the durable store contract, concurrent approval
resolution across two runtimes, and persistence of team runs. They use fake models
and do not require model API keys. They do not yet cover independent worker
processes, process crashes, or the session and lease issues identified in the audit.

Locally, `bun run test` skips those three integration tests unless
`FEVEX_POSTGRES_URL` points to a dedicated test database. Browser preview tests
use a simulated sandbox and run as part of the source suite without a browser binary.
