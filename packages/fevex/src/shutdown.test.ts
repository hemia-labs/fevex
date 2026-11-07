import { describe, expect, test } from 'bun:test';
import { defineAgent } from './agents';
import { createFevex } from './fevex';
import { createFevexHttpHandler } from './http';
import type { ModelGateway } from './models';
import type { RunTrace } from './observability';
import { defineWorkflow } from './workflows';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function blockingModel(started: () => void): ModelGateway {
  return {
    async *stream(input) {
      started();
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener(
          'abort',
          () => reject(input.signal?.reason),
          { once: true },
        );
      });
    },
  };
}

describe('shutdown', () => {
  test('drains active runs, flushes traces and stops admission', async () => {
    const modelStarted = deferred();
    const modelRelease = deferred();
    const traces: RunTrace[] = [];
    const model: ModelGateway = {
      async *stream() {
        modelStarted.resolve();
        await modelRelease.promise;
        yield { type: 'output.delta', delta: 'ok' };
        yield { type: 'completed', result: { output: 'ok' } };
      },
    };
    const app = createFevex({
      models: { default: model },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
      observability: {
        exporters: [{ export(trace) { traces.push(structuredClone(trace)); } }],
      },
    });

    const run = app.runAgent('assistant', { input: 'go' });
    await modelStarted.promise;
    const closing = app.shutdown({ timeoutMs: 1_000 });
    modelRelease.resolve();

    await expect(run).resolves.toMatchObject({ output: 'ok' });
    await expect(closing).resolves.toMatchObject({
      timedOut: false,
      cancelledRunIds: [],
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ status: 'completed' });

    await expect(
      app.runAgent('assistant', { input: 'after close' }),
    ).rejects.toMatchObject({ code: 'RUNTIME_CLOSED' });
    await expect(
      app.resumeRun('missing', {
        type: 'approval',
        approvalId: 'missing',
        decision: 'approve',
        actor: { id: 'reviewer' },
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_CLOSED' });
    await expect(app.shutdown()).resolves.toMatchObject({
      timedOut: false,
      cancelledRunIds: [],
    });
  });

  test('disposes the sandbox provider during shutdown', async () => {
    let disposed = 0;
    const model: ModelGateway = {
      async *stream() {
        yield { type: 'output.delta', delta: 'ok' };
        yield { type: 'completed', result: { output: 'ok' } };
      },
    };
    const app = createFevex({
      models: { default: model },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
      sandbox: {
        async run() {
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false };
        },
        dispose() {
          disposed += 1;
        },
      },
    });

    await app.runAgent('assistant', { input: 'go' });
    await app.shutdown();

    expect(disposed).toBe(1);
  });

  test('cancels an active agent when the deadline expires', async () => {
    const modelStarted = deferred();
    const app = createFevex({
      models: { default: blockingModel(() => modelStarted.resolve()) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
    });
    const run = await app.startAgent('assistant', { input: 'wait' });
    await modelStarted.promise;

    const result = await app.shutdown({ timeoutMs: 10 });

    expect(result.timedOut).toBe(true);
    expect(result.cancelledRunIds).toContain(run.id);
    expect(await app.getRun(run.id)).toMatchObject({ status: 'cancelled' });
  });

  test('cancels a workflow and its child at the deadline', async () => {
    const modelStarted = deferred();
    const app = createFevex({
      models: { default: blockingModel(() => modelStarted.resolve()) },
      agents: [defineAgent({ name: 'worker', instructions: 'Work.' })],
      workflows: [
        defineWorkflow({
          name: 'flow',
          async run(step, input) {
            return (await step.agent('work', 'worker', { input })).output;
          },
        }),
      ],
    });
    const workflow = await app.startWorkflow('flow', { input: 'wait' });
    await modelStarted.promise;

    const result = await app.shutdown({ timeoutMs: 10 });

    expect(result.timedOut).toBe(true);
    expect(result.cancelledRunIds).toContain(workflow.id);
    expect(await app.getRun(workflow.id)).toMatchObject({ status: 'cancelled' });
  });

  test('rejects HTTP starts with 503 after shutdown', async () => {
    const app = createFevex({
      models: { default: { async *stream() {
        yield { type: 'output.delta', delta: 'ok' };
        yield { type: 'completed', result: { output: 'ok' } };
      } } },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
    });
    const handler = createFevexHttpHandler({ fevex: app });
    await app.shutdown();

    const response = await handler(new Request('http://local/v1/agents/assistant/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'go' }),
    }));

    expect(response.status).toBe(503);
  });

  test('bounds the trace flush by the shutdown deadline', async () => {
    const app = createFevex({
      models: { default: { async *stream() {
        yield { type: 'output.delta', delta: 'ok' };
        yield { type: 'completed', result: { output: 'ok' } };
      } } },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
      observability: {
        exportQueue: { timeoutMs: 60_000 },
        exporters: [{ export: () => new Promise<void>(() => {}) }],
      },
    });
    await app.runAgent('assistant', { input: 'go' });

    const startedAt = Date.now();
    const result = await app.shutdown({ timeoutMs: 20 });

    expect(result.exportError).toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
