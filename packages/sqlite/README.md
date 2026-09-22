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

## Shared sessions

Run creation reserves the session inside a `BEGIN IMMEDIATE` transaction,
checking its history revision and existing active or paused runs. A competing
run or compaction receives `RUN_CONFLICT`. The transaction ends before model
and tool execution.

Paused and orphaned runs retain ownership until terminal status; recover or
cancel the original run before reusing its session. Migration v2 adds the
active-session index without rewriting history. Upgrade all workers together.

Migration v3 adds the lease generation counter. Commits and renewals check the
owner, generation and expiry inside `BEGIN IMMEDIATE`; the expiry check happens
after obtaining the write lock. Release preserves the counter for the next
acquisition. Legacy generation-zero leases must expire before recovery.

### Event pagination

Use `listEvents(runId, { after: eventId, limit: 100 })` to read incremental pages.
The store resolves the cursor's sequence and uses the existing `(run_id, sequence)`
index to filter and limit rows in SQL before decoding event payloads. An unknown
cursor or one from another run raises `INVALID_CURSOR`. To read only the latest
event, pass `{ order: 'desc', limit: 1 }`. Without a limit, existing full-log reads
remain supported. No schema migration is needed for pagination.
