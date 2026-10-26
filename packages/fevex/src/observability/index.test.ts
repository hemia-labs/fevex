import { describe, expect, test } from 'bun:test';
import { defineAgent } from '../agents';
import { createFevex } from '../fevex';
import type { ModelGateway } from '../models';
import type { RunTrace } from './index';
import { defineTool } from '../tools';
import { fakeModel } from '../testing';
import { InMemoryRunStore } from '../runtime';

describe('observability', () => {
  test('attributes an overridden model and its cost after deleting the terminal checkpoint', async () => {
    const traces: RunTrace[] = [];
    const alternate = fakeModel({ output: 'alternate', usage: { totalTokens: 10 } });
    alternate.metadata = { provider: 'alternate-provider', model: 'alternate-model' };
    const defaultModel = fakeModel({ output: 'default' });
    const store = new InMemoryRunStore();
    const app = createFevex({
      models: { default: defaultModel, alternate },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
      runStore: store,
      observability: {
        exporters: [{ export(trace) { traces.push(structuredClone(trace)); } }],
        calculateCost: ({ modelRegistryName, model, usage }) => ({
          amount: modelRegistryName === 'alternate' && model?.model === 'alternate-model'
            ? usage.totalTokens ?? 0 : 0,
          currency: 'USD',
        }),
      },
    });

    const result = await app.runAgent('assistant', { input: 'go', model: 'alternate' });
    await app.flushObservability();

    expect(result.output).toBe('alternate');
    expect(defaultModel.calls).toHaveLength(0);
    expect(await store.getCheckpoint(result.runId)).toBeUndefined();
    expect(await store.getRun(result.runId)).toMatchObject({
      modelName: 'alternate', modelMetadata: alternate.metadata,
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      modelRegistryName: 'alternate',
      model: alternate.metadata,
      cost: { amount: 10, currency: 'USD' },
    });
  });

  test('exports an inline model without requiring a default registry entry', async () => {
    const traces: RunTrace[] = [];
    const model = fakeModel({ output: 'inline' });
    model.metadata = { provider: 'inline-provider', model: 'inline-model' };
    const app = createFevex({
      models: {},
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.', model })],
      observability: {
        exporters: [{ export(trace) { traces.push(structuredClone(trace)); } }],
      },
    });
    await app.runAgent('assistant', { input: 'go' });
    await app.flushObservability();
    expect(traces[0]).toMatchObject({ modelRegistryName: 'default', model: model.metadata });
  });

  test('exports a redacted trace with model steps, tool attempts, usage and cost', async () => {
    const traces: RunTrace[] = [];
    const model = fakeModel(
      {
        toolCalls: [{ id: 'lookup-1', name: 'lookup', input: { query: 'x' } }],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
      {
        output: { answer: 'done', apiKey: 'must-not-leak' },
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      },
    );
    model.metadata = { provider: 'test', model: 'deterministic-v1' };
    let attempts = 0;
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({
          name: 'assistant',
          instructions: 'Help.',
          tools: ['lookup'],
        }),
      ],
      tools: [
        defineTool({
          name: 'lookup',
          idempotency: 'keyed',
          retry: { maxAttempts: 2, backoffMs: 0 },
          execute() {
            attempts += 1;
            if (attempts === 1) throw new Error('temporary private failure');
            return { result: 'found' };
          },
        }),
      ],
      observability: {
        exporters: [{
          export(trace) {
            traces.push(structuredClone(trace));
          },
        }],
        calculateCost: ({ usage }) => ({
          amount: (usage.totalTokens ?? 0) / 1_000,
          currency: 'USD',
        }),
        content: {
          include: ['run.output', 'model.output', 'error.message'],
          redact: ({ value }) =>
            typeof value === 'string' ? value.replace('private', '[PRIVATE]') : value,
        },
      },
    });

    await app.runAgent('assistant', { input: 'go' });
    await app.flushObservability();

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      status: 'completed',
      agentName: 'assistant',
      model: { provider: 'test', model: 'deterministic-v1' },
      usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
      cost: { amount: 0.02, currency: 'USD' },
      attributes: { modelCallCount: 2, toolCallCount: 2 },
      content: [
        {
          kind: 'run.output',
          value: { answer: 'done', apiKey: '[REDACTED]' },
        },
      ],
    });
    expect(traces[0]?.spans.filter(({ kind }) => kind === 'model').map(({ usage }) => usage)).toEqual([
      { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    ]);
    expect(traces[0]?.spans.filter(({ kind }) => kind === 'tool').map(({ status }) => status)).toEqual([
      'failed',
      'completed',
    ]);
    expect(JSON.stringify(traces[0])).not.toContain('private');
    expect(JSON.stringify(traces[0])).not.toContain('must-not-leak');
  });

  test('omits content by default and isolates exporter failures from runs', async () => {
    const traces: RunTrace[] = [];
    const app = createFevex({
      models: { default: fakeModel({ output: { password: 'secret', answer: 'ok' } }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
      observability: {
        exporters: [
          {
            export(trace) {
              traces.push(structuredClone(trace));
            },
          },
          { export: () => Promise.reject(new Error('collector unavailable')) },
        ],
      },
    });

    await expect(app.runAgent('assistant', { input: 'go' })).resolves.toMatchObject({
      output: { password: 'secret', answer: 'ok' },
    });
    await expect(app.flushObservability()).rejects.toThrow('Observability export failed');
    expect(traces).toHaveLength(1);
    expect(traces[0]?.content).toBeUndefined();
    expect(traces[0]?.spans.every(({ content }) => content === undefined)).toBe(true);
  });

  test('exports cancelled and failed terminal runs', async () => {
    const traces: RunTrace[] = [];
    const blocked: ModelGateway = {
      async *stream(input) {
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
            once: true,
          });
        });
        yield { type: 'completed', result: { output: 'unreachable' } };
      },
    };
    const cancelledApp = createFevex({
      models: { default: fakeModel(), alternate: blocked },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
      observability: {
        exporters: [{
          export(trace) {
            traces.push(structuredClone(trace));
          },
        }],
      },
    });
    const started = await cancelledApp.startAgent('assistant', { input: 'wait', model: 'alternate' });
    await cancelledApp.cancelRun(started.id);
    await cancelledApp.flushObservability();

    const failedApp = createFevex({
      models: {
        default: fakeModel(),
        alternate: {
          async *stream() {
            throw new Error('provider failed');
          },
        },
      },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
      observability: {
        exporters: [{
          export(trace) {
            traces.push(structuredClone(trace));
          },
        }],
      },
    });
    await expect(failedApp.runAgent('assistant', { input: 'fail', model: 'alternate' })).rejects.toThrow(
      'provider failed',
    );
    await failedApp.flushObservability();

    expect(traces.map(({ status }) => status)).toEqual(['cancelled', 'failed']);
    expect(traces.map(({ modelRegistryName }) => modelRegistryName)).toEqual(['alternate', 'alternate']);
    expect(traces.every(({ spans }) => spans[0]?.status !== 'completed')).toBe(true);
  });

  test.each([false, true])('reconstructs a trace across durable pause and resume (legacy: %s)', async (legacy) => {
    const traces: RunTrace[] = [];
    const store = new InMemoryRunStore();
    const model = fakeModel(
      { toolCalls: [{ id: 'call-1', name: 'write', input: { value: 1 } }] },
      { output: 'done' },
    );
    model.metadata = { provider: 'test', model: 'resumed-model' };
    const config = {
      models: { default: fakeModel(), alternate: model },
      agents: [
        defineAgent({ name: 'assistant', instructions: 'Help.', tools: ['write'] }),
      ],
      tools: [
        defineTool({
          name: 'write',
          approval: 'required' as const,
          execute: () => ({ saved: true }),
        }),
      ],
      runStore: store,
      observability: {
        exporters: [{
          export(trace: Readonly<RunTrace>) {
            traces.push(structuredClone(trace));
          },
        }],
      },
    };
    const firstRuntime = createFevex(config);
    let runId = '';
    await firstRuntime.runAgent('assistant', { input: 'write', model: 'alternate' }).catch((error) => {
      runId = (error as { runId?: string }).runId ?? '';
    });
    expect(runId).not.toBe('');
    await firstRuntime.flushObservability();
    expect(traces).toHaveLength(0);

    const paused = await firstRuntime.getRun(runId);
    if (!paused || !('agentName' in paused) || paused.pause?.type !== 'approval') {
      throw new Error('Expected agent approval pause');
    }
    if (legacy) {
      delete paused.modelName;
      delete paused.modelMetadata;
      await store.saveRun(paused);
    }
    const secondRuntime = createFevex(config);
    await secondRuntime.resumeRun(runId, {
      type: 'approval',
      approvalId: paused.pause.approval.id,
      decision: 'approve',
      actor: { id: 'reviewer' },
    });
    for (let index = 0; index < 100; index += 1) {
      if ((await secondRuntime.getRun(runId))?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await secondRuntime.flushObservability();

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ modelRegistryName: 'alternate', model: model.metadata });
    expect(traces[0]?.annotations.map(({ name }) => name)).toEqual([
      'approval.requested',
      'run.paused',
      'run.resumed',
      'approval.resolved',
    ]);
    expect(traces[0]?.spans.map(({ kind }) => kind)).toEqual(['model', 'tool', 'model']);
  });
});
