import { writeFileSync } from 'node:fs';
import {
  createFevex,
  defineAgent,
  FevexRunError,
} from '@fevex/core';
import { createSQLiteRunStore } from '@fevex/sqlite';

const [database, runId, evidencePath = 'crash-evidence.json'] = process.argv.slice(2);
if (!database || !runId) {
  throw new TypeError('Usage: node crash-recover.mjs <database> <runId> [evidence]');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = { pilot: 'crash-recovery', pass: false, runId };

const store = createSQLiteRunStore({ filename: database });
const app = createFevex({
  models: {
    default: {
      async *stream() {
        yield { type: 'output.delta', delta: 'recovered' };
        yield { type: 'completed', result: { output: 'recovered' } };
      },
    },
  },
  agents: [defineAgent({
    name: 'crash-pilot',
    instructions: 'Wait for a recoverable checkpoint.',
  })],
  runStore: store,
});

try {
  const startedAt = Date.now();
  let recovered = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await app.recoverRun(runId, { actor: { id: 'pilot-recovery', type: 'service' } });
      recovered = true;
      break;
    } catch (error) {
      if (
        !(error instanceof FevexRunError)
        || (error.code !== 'RUN_CONFLICT' && error.code !== 'RUN_NOT_RECOVERABLE')
      ) {
        throw error;
      }
      await sleep(500);
    }
  }
  if (!recovered) throw new Error('Run was not recoverable');
  evidence.recoveredAfterMs = Date.now() - startedAt;

  let run = await app.getRun(runId);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (run?.status === 'completed') break;
    if (run?.status === 'failed' || run?.status === 'cancelled' || run?.status === 'paused') {
      throw new Error(`Recovered run ended as ${run.status}: ${run.error ?? ''}`);
    }
    await sleep(25);
    run = await app.getRun(runId);
  }
  if (run?.status !== 'completed') {
    throw new Error(`Recovered run did not complete (status ${run?.status ?? 'missing'})`);
  }

  const events = await app.listEvents(runId, { limit: 1_000 });
  evidence.eventTypes = events.map(({ type }) => type);
  evidence.runStarts = events.filter(({ type }) => type === 'run.started').length;
  evidence.recoveredEvent = events.some(({ type }) => type === 'run.recovered');
  evidence.output = run.output;
  evidence.ordered = events.every(
    (event, index) => index === 0 || event.sequence === events[index - 1].sequence + 1,
  );
  evidence.pass = evidence.runStarts === 1
    && evidence.recoveredEvent
    && evidence.ordered
    && run.output === 'recovered';

  const shutdown = await app.shutdown({ timeoutMs: 5_000 });
  evidence.shutdown = { timedOut: shutdown.timedOut, exportError: String(shutdown.exportError ?? '') };
  if (shutdown.timedOut || shutdown.exportError) evidence.pass = false;
  console.log(JSON.stringify({ pilot: evidence.pilot, pass: evidence.pass }));
  if (!evidence.pass) process.exitCode = 1;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(evidence.error);
  console.log(JSON.stringify({ pilot: evidence.pilot, pass: false }));
  process.exitCode = 1;
} finally {
  await store.close();
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
