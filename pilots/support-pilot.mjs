import { writeFileSync } from 'node:fs';
import { createFevex, defineAgent, defineTool } from '@fevex/core';
import { createFevexHttpClient, createFevexHttpHandler } from '@fevex/core/http';
import { createSQLiteRunStore } from '@fevex/sqlite';

const evidencePath = process.argv[2] ?? 'support-evidence.json';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = {
  pilot: 'support-api',
  pass: false,
  steps: [],
  eventTypes: [],
};

const step = (name, details = {}) => {
  evidence.steps.push({ name, at: new Date().toISOString(), ...details });
};

function supportModel() {
  let calls = 0;
  return {
    metadata: { provider: 'pilot', model: 'deterministic-support' },
    async *stream() {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'completed',
          result: {
            toolCalls: [{
              id: 'refund-1',
              name: 'refund',
              input: { account: '42', amount: 10 },
            }],
          },
        };
        return;
      }
      yield { type: 'output.delta', delta: '{"status":"refunded"}' };
      yield { type: 'completed', result: { output: { status: 'refunded' } } };
    },
  };
}

async function waitFor(client, runId, done) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = await client.getRun(runId);
    if (done(run)) return run;
    await sleep(10);
  }
  throw new Error(`Run "${runId}" did not reach the expected state`);
}

const store = createSQLiteRunStore({ filename: 'support.sqlite' });
const app = createFevex({
  models: { default: supportModel() },
  agents: [defineAgent({
    name: 'support',
    instructions: 'Answer account questions and refund within policy.',
    tools: ['refund'],
  })],
  tools: [defineTool({
    name: 'refund',
    risk: 'write',
    approval: 'required',
    idempotency: 'keyed',
    execute: () => ({ refunded: true }),
  })],
  runStore: store,
  admission: { maxActiveRuns: 4 },
});

const handler = createFevexHttpHandler({
  fevex: app,
  authorize(access) {
    const actor = access.context?.actor?.id;
    if (access.action === 'start') return actor === 'pilot-user';
    return actor === 'pilot-user' || actor === 'pilot-reviewer';
  },
});

const fetchAs = (actor) => (input, init) =>
  handler(new Request(input, init), {
    context: { actor: { id: actor, type: 'user' } },
  });

const userClient = createFevexHttpClient({
  baseUrl: 'http://pilot.local',
  fetch: fetchAs('pilot-user'),
});
const reviewerClient = createFevexHttpClient({
  baseUrl: 'http://pilot.local',
  fetch: fetchAs('pilot-reviewer'),
});

try {
  const started = await userClient.startRun('support', {
    input: 'Refund account 42 for 10.',
  });
  evidence.runId = started.id;
  step('http.start', { runId: started.id, status: started.status });

  const paused = await waitFor(userClient, started.id, (run) => run.status === 'paused');
  if (paused.pause?.type !== 'approval') {
    throw new Error(`Expected approval pause, received ${paused.pause?.type ?? 'none'}`);
  }
  evidence.approvalId = paused.pause.approval.id;
  step('approval.requested', { approvalId: evidence.approvalId });

  await reviewerClient.resumeRun(started.id, {
    type: 'approval',
    approvalId: evidence.approvalId,
    decision: 'approve',
  });
  const completed = await waitFor(
    reviewerClient,
    started.id,
    (run) => run.status === 'completed',
  );
  step('approval.resolved', { status: completed.status });
  evidence.output = completed.output;

  for await (const event of reviewerClient.observeRun(started.id)) {
    evidence.eventTypes.push(event.type);
  }
  for (const expected of ['approval.requested', 'approval.resolved', 'run.completed']) {
    if (!evidence.eventTypes.includes(expected)) {
      throw new Error(`Missing event "${expected}"`);
    }
  }

  const shutdown = await app.shutdown({ timeoutMs: 5_000 });
  if (shutdown.timedOut || shutdown.exportError) {
    throw new Error(`Shutdown failed: ${String(shutdown.exportError ?? 'timed out')}`);
  }
  step('shutdown', { timedOut: shutdown.timedOut });
  evidence.pass = completed.output?.status === 'refunded';
  if (!evidence.pass) throw new Error('Unexpected support output');
  console.log(JSON.stringify({ pilot: evidence.pilot, pass: evidence.pass }));
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(evidence.error);
  console.log(JSON.stringify({ pilot: evidence.pilot, pass: false }));
  process.exitCode = 1;
} finally {
  await store.close();
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
