import { createFevex, defineAgent } from '../packages/fevex/src/index';
import { createSQLiteRunStore } from '../packages/sqlite/src/index';
import { createPostgresRunStore } from '../packages/postgres/src/index';

const [backend, location, sessionId, input, leaseMs] = process.argv.slice(2);
const store = backend === 'sqlite'
  ? createSQLiteRunStore({ filename: location! })
  : createPostgresRunStore({ connectionString: location! });
// A short lease makes crash recovery testable without a 30-second sleep.
const create = store.createExecution.bind(store);
store.createExecution = (value) => {
  value.lease.expiresAt = new Date(Date.now() + Number(leaseMs ?? 30_000)).toISOString();
  return create(value);
};
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
process.on('message', (message: unknown) => {
  if ((message as { type?: string })?.type === 'release') release();
});
let runId = '';
const app = createFevex({
  runStore: store,
  agents: [defineAgent({ name: 'worker', instructions: 'Work.' })],
  onEvent(event) {
    if (event.type === 'run.started') runId = event.runId;
  },
  models: { default: {
    async *stream() {
      process.send?.({ type: 'entered', runId });
      await gate;
      yield { type: 'output.delta' as const, delta: 'done' };
      yield { type: 'completed' as const, result: { output: 'done' } };
    },
  } },
});
try {
  const result = await app.runAgent('worker', { sessionId, input });
  process.send?.({ type: 'completed', runId: result.runId });
} catch (error) {
  process.send?.({ type: 'error', code: (error as { code?: string }).code, message: String(error) });
} finally {
  await store.close();
  process.disconnect?.();
}
