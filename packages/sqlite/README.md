# @fevex/sqlite

Local durable storage for Fevex on Node and Bun.

```bash
npm install @fevex/core @fevex/sqlite
```

```ts
import { createSQLiteRunStore } from '@fevex/sqlite';

const runStore = createSQLiteRunStore({
  filename: '.fevex/runs.db',
});
```

Pass `runStore` to `createFevex`. The adapter creates and migrates its local
database automatically, uses WAL for safe concurrent access, and persists
sessions, runs, private checkpoints, events, leases and tool executions.
Node uses `better-sqlite3`; Bun uses its compatible built-in `bun:sqlite`
driver because Bun does not load the `better-sqlite3` native addon.

Call `close()` during application shutdown. It is safe to call more than once.
