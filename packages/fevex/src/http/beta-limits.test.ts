import { describe, expect, test } from 'bun:test';
import { defineAgent } from '../agents';
import { createFevex } from '../fevex';
import type { AgentRun } from '../runtime';
import type { ModelGateway } from '../models';
import { fakeModel } from '../testing';
import { createFevexHttpHandler, type FevexHttpHandler } from './index';

const agent = defineAgent({ name: 'assistant', instructions: 'Wait.' });

function blockingModel(): ModelGateway {
  return {
    async *stream(input) {
      yield { type: 'output.delta' as const, delta: 'working' };
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(input.signal?.reason ?? new Error('aborted'));
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };
}

function start(handler: FevexHttpHandler, body: unknown) {
  return handler(new Request('http://local/v1/agents/assistant/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('HTTP operational limits', () => {
  test('forwards deadlineMs and rejects invalid deadlines', async () => {
    const app = createFevex({
      models: { default: fakeModel({ output: 'ok' }) },
      agents: [agent],
    });
    const handler = createFevexHttpHandler({ fevex: app });
    const response = await start(handler, { input: 'hello', deadlineMs: 5_000 });
    expect(response.status).toBe(202);
    expect(typeof (await response.json() as AgentRun).deadlineAt).toBe('string');

    const invalid = await start(handler, { input: 'hello', deadlineMs: 0 });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_REQUEST' });

    const huge = await start(handler, {
      input: 'hello',
      deadlineMs: Number.MAX_SAFE_INTEGER,
    });
    expect(huge.status).toBe(400);
    expect(await huge.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('returns 429 when admission denies a start', async () => {
    const app = createFevex({
      models: { default: blockingModel() },
      agents: [agent],
      admission: { maxActiveRuns: 1 },
    });
    const handler = createFevexHttpHandler({ fevex: app });
    const first = await start(handler, { input: 'one' });
    expect(first.status).toBe(202);
    const run = await first.json() as AgentRun;

    const second = await start(handler, { input: 'two' });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: 'ADMISSION_DENIED' });
    await app.cancelRun(run.id);
  });

  test('limits concurrent SSE connections and releases them on cancel', async () => {
    const app = createFevex({
      models: { default: blockingModel() },
      agents: [agent],
    });
    const handler = createFevexHttpHandler({
      fevex: app,
      maxConnections: 1,
      pollIntervalMs: 1,
    });
    const first = await start(handler, { input: 'one' });
    const run = await first.json() as AgentRun;

    const stream = await handler(new Request(`http://local/v1/runs/${run.id}/events`));
    expect(stream.status).toBe(200);
    const denied = await handler(new Request(`http://local/v1/runs/${run.id}/events`));
    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({ code: 'CONNECTION_LIMIT' });

    await stream.body?.cancel();
    const next = await handler(new Request(`http://local/v1/runs/${run.id}/events`));
    expect(next.status).toBe(200);
    await next.body?.cancel();
    await app.cancelRun(run.id);
  });

  test('rejects invalid connection limits at construction', () => {
    const app = createFevex({
      models: { default: fakeModel({ output: 'ok' }) },
      agents: [agent],
    });
    expect(() => createFevexHttpHandler({ fevex: app, maxConnections: 0 }))
      .toThrow('maxConnections');
  });
});
