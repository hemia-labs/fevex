import { writeFileSync } from 'node:fs';
import {
  createFevex,
  defineAgent,
  defineWorkflow,
} from '@fevex/core';
import { exactOutputScorer, runEvaluation } from '@fevex/core/evals';
import { createSQLiteRunStore } from '@fevex/sqlite';

const evidencePath = process.argv[2] ?? 'research-evidence.json';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = {
  pilot: 'research-workflow',
  pass: false,
  steps: [],
  eventTypes: [],
};

const step = (name, details = {}) => {
  evidence.steps.push({ name, at: new Date().toISOString(), ...details });
};

const researcher = {
  metadata: { provider: 'pilot', model: 'deterministic-research' },
  async *stream() {
    yield { type: 'output.delta', delta: 'draft' };
    yield { type: 'completed', result: { output: 'draft' } };
  },
};

async function waitFor(runId, done) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const run = await app.getRun(runId);
    if (run && done(run)) return run;
    await sleep(10);
  }
  throw new Error(`Run "${runId}" did not reach the expected state`);
}

const store = createSQLiteRunStore({ filename: 'research.sqlite' });
const app = createFevex({
  models: { default: researcher },
  agents: [defineAgent({
    name: 'researcher',
    instructions: 'Produce a concise research draft.',
  })],
  workflows: [defineWorkflow({
    name: 'research-review',
    events: {
      'publish-approval': { requireActor: true },
    },
    async run(step, input) {
      const draft = await step.agent('draft', 'researcher', { input });
      const approval = await step.waitForEvent('approval', 'publish-approval');
      return {
        draft: draft.output,
        approvedBy: approval.actor?.id,
      };
    },
  })],
  runStore: store,
  admission: { maxActiveRuns: 4 },
});

try {
  const started = await app.startWorkflow('research-review', {
    input: 'Summarize the durable execution notes.',
  });
  evidence.runId = started.id;
  step('workflow.start', { runId: started.id, status: started.status });

  const paused = await waitFor(started.id, (run) => run.status === 'paused');
  if (paused.pause?.type !== 'workflow_event') {
    throw new Error(`Expected workflow event pause, received ${paused.pause?.type ?? 'none'}`);
  }
  step('workflow.paused', { eventName: paused.pause.eventName });

  await app.resumeRun(started.id, {
    type: 'event',
    eventName: 'publish-approval',
    payload: { approved: true },
    actor: { id: 'pilot-reviewer', type: 'user' },
  });
  const completed = await waitFor(started.id, (run) => run.status === 'completed');
  evidence.output = completed.output;
  step('workflow.resumed', { status: completed.status });

  evidence.eventTypes = (await app.listEvents(started.id, { limit: 1_000 }))
    .map(({ type }) => type);
  for (const expected of ['workflow.wait.started', 'workflow.wait.completed', 'workflow.run.completed']) {
    if (!evidence.eventTypes.includes(expected)) {
      throw new Error(`Missing event "${expected}"`);
    }
  }

  const evaluation = await runEvaluation({
    app,
    suiteName: 'pilot-research-regression',
    targetVersion: 'alpha.6',
    agentName: 'researcher',
    dataset: {
      name: 'pilot-research',
      version: '1',
      cases: [{ id: 'draft', input: 'Summarize.', expected: { output: 'draft' } }],
    },
    scorers: [exactOutputScorer()],
  });
  evidence.evaluation = {
    cases: evaluation.summary.caseCount,
    failedScores: evaluation.summary.failedScoreCount,
    averageScore: evaluation.summary.averageScore,
  };
  if (evaluation.summary.failedCount !== 0 || evaluation.summary.failedScoreCount !== 0) {
    throw new Error('Research evaluation failed');
  }
  step('evaluation.completed', evidence.evaluation);

  const shutdown = await app.shutdown({ timeoutMs: 5_000 });
  if (shutdown.timedOut || shutdown.exportError) {
    throw new Error(`Shutdown failed: ${String(shutdown.exportError ?? 'timed out')}`);
  }
  step('shutdown', { timedOut: shutdown.timedOut });
  evidence.pass = completed.output?.approvedBy === 'pilot-reviewer'
    && evaluation.summary.failedCount === 0;
  if (!evidence.pass) throw new Error('Unexpected research output or evaluation');
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
