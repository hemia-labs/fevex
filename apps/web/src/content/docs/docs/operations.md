---
title: Operations & soak tests
description: Graceful shutdown, crash recovery and long-running load validation.
---

This page covers runtime lifecycle and the repeatable load harness used to verify
long-running operation.

## Graceful shutdown

`shutdown` stops admission, waits for active runs, cancels what remains at the
deadline, and flushes queued trace exports:

```ts
const result = await app.shutdown({ timeoutMs: 30_000 });

console.log(result.timedOut, result.cancelledRunIds);
console.log(result.observability);
```

Behavior:

1. New starts, resumes and recoveries fail with `RUNTIME_CLOSED`; HTTP hosts map
   that code to `503`.
2. Existing runs get up to `timeoutMs` to finish.
3. If the deadline expires, active workflows and agents are cancelled. Shutdown
   allows up to 5 additional seconds for forced cancellation and the final trace
   flush.
4. The host closes its HTTP server, stores and external adapters after
   `shutdown` returns. FEVEX does not close resources it does not own.

`shutdown` is idempotent. The result reports `timedOut`, the run IDs that were
cancelled, an optional `exportError`, and final observability counters.

## Crash recovery

A killed process leaves its durable run and lease behind. After the 30 second
lease expires, a new runtime can recover the checkpoint:

```ts
await app.recoverRun(runId, {
  actor: { id: 'recovery-worker', type: 'service' },
});
```

Recovery preserves the event history and does not start a second run. A changed
agent, workflow, team, tool or model definition is rejected with
`RUN_DEFINITION_CHANGED`. Keyed tools are retried with the same idempotency key;
non-keyed tools that were interrupted can pause as `tool_execution_unknown` and
require an explicit resolution.

The repository includes a real kill/recovery check:

```bash
bun run soak:recovery
```

It starts a child worker with SQLite, waits for a checkpoint, sends `SIGKILL`,
waits for the lease to expire and recovers the run. It takes about 30 seconds.

## Load and soak tests

Run the harness against the in-memory store:

```bash
bun run soak -- \
  --duration-ms 3600000 \
  --concurrency 8 \
  --model-delay-ms 1 \
  --tool-delay-ms 1 \
  --report soak-memory.json
```

Against PostgreSQL 16:

```bash
FEVEX_POSTGRES_URL=postgresql://user:pass@localhost:5432/fevex_soak \
bun run soak -- \
  --store postgres \
  --duration-ms 3600000 \
  --concurrency 8 \
  --model-delay-ms 1 \
  --tool-delay-ms 1 \
  --overhead-budget-ms 50 \
  --report soak-postgres.json
```

The SQLite variant uses `--store sqlite --database .fevex/soak.sqlite`.

The report includes:

- completed, failed and per-second run counts;
- run latency and runtime overhead percentiles, subtracting the configured model
  and tool delays;
- event-loop delay, RSS and heap after forced garbage collection;
- history checks that verify the terminal event and contiguous sequence numbers;
- retention sweeps through `purgeRuns`;
- observability exported, failed and dropped counts;
- shutdown result and gate status.

Default gates fail the command when a run fails, history checks fail, p95
overhead exceeds 10 ms for memory or 50 ms for persistent stores, heap grows by
more than 64 MB after warm-up, RSS grows by more than 512 MB, or shutdown does
not complete. Use `--duration-ms` for a 1–8 hour run and `--report` to retain the
JSON evidence. Forced GC and retention sweeps can create isolated latency spikes;
compare percentiles, not the maximum.

The short harness itself is covered by `bun test scripts/soak.test.ts`.
Repository maintainers can run the longer checks from **Actions → Soak and
recovery**, choosing memory or PostgreSQL, the duration, concurrency, and
whether to run the real `SIGKILL` recovery check.
