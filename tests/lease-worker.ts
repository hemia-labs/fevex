import { createSQLiteRunStore } from '../packages/sqlite/src/index';
import { createPostgresRunStore } from '../packages/postgres/src/index';
import type { RunLease } from '../packages/fevex/src/runtime';

const [backend, location, encoded] = process.argv.slice(2);
const lease = JSON.parse(encoded!) as RunLease;
const store = backend === 'sqlite'
  ? createSQLiteRunStore({ filename: location! })
  : createPostgresRunStore({ connectionString: location! });
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
process.on('message', () => release());
try {
  const run = (await store.getRun(lease.runId))!;
  process.send?.({ type: 'ready' });
  await gate;
  const committed = await store.commitExecution({
    lease, expectedRevision: run.revision, run: { ...run, status: 'failed', error: 'stale worker' },
  });
  const renewed = await store.renewLease(lease);
  await store.releaseLease(run.id, lease.ownerId, lease.generation);
  process.send?.({ type: 'result', committed, renewed });
} finally {
  await store.close();
  process.disconnect?.();
}
