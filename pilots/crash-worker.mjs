import { createFevex, defineAgent } from '@fevex/core';
import { createSQLiteRunStore } from '@fevex/sqlite';

const database = process.argv[2];
if (!database) throw new TypeError('Usage: node crash-worker.mjs <database>');

const store = createSQLiteRunStore({ filename: database });
const app = createFevex({
  models: {
    default: {
      async *stream() {
        console.log('READY');
        await new Promise(() => {});
      },
    },
  },
  agents: [defineAgent({
    name: 'crash-pilot',
    instructions: 'Wait for a recoverable checkpoint.',
  })],
  runStore: store,
});

const run = await app.startAgent('crash-pilot', { input: 'recover me' });
console.log(`RUN_ID ${run.id}`);

await new Promise(() => {});
