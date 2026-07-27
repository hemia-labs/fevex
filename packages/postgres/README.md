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
