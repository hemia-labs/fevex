import { createFevex, defineAgent, type ModelGateway } from '@fevex/core';
import { createSQLiteRunStore } from '@fevex/sqlite';

const database = process.argv[2];
if (!database) throw new TypeError('Usage: bun run soak-recovery-worker.ts <database>');

const runStore = createSQLiteRunStore({ filename: database });
const model: ModelGateway = {
  async *stream() {
    console.log('READY');
    await new Promise<never>(() => {});
  },
};

const app = createFevex({
  models: { default: model },
  agents: [defineAgent({
    name: 'recovery-worker',
    instructions: 'Wait for a recoverable checkpoint.',
  })],
  runStore,
});

const run = await app.startAgent('recovery-worker', { input: 'recover me' });
console.log(`RUN_ID ${run.id}`);

await new Promise<never>(() => {});
