import { describe, expect, test } from 'bun:test';
import { defineAgent } from '../agents';
import type { AgentEvent } from '../core';
import { createFevex, type Fevex } from '../fevex';
import { fakeModel } from '../testing';
import type { AgentRun, ResumeRunResolution } from '../runtime';
import { defineWorkflow } from '../workflows';
import { defineTeam } from '../teams';
import {
  createFevexHttpClient,
  createFevexHttpHandler,
  FevexHttpError,
  FEVEX_HTTP_PROTOCOL_VERSION,
} from './index';

describe('Fevex HTTP v3', () => {
  test('selects a registered model per run', async () => {
    const defaultModel = fakeModel({ output: 'default' });
    const alternateModel = fakeModel({ output: 'alternate' });
    const app = createFevex({
      models: { default: defaultModel, alternate: alternateModel },
      agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
    });
    const client = clientFor(app);

    const run = await client.startRun('assistant', {
      input: 'hello',
      model: 'alternate',
      reasoning: 'high',
    });
    await collect(client.observeRun(run.id));

    expect(alternateModel.calls).toHaveLength(1);
    expect(alternateModel.calls[0]?.reasoning).toBe('high');
    expect(defaultModel.calls).toHaveLength(0);
    expect((await client.getRun<string>(run.id)).output).toBe('alternate');
  });

  test('starts, observes, reconnects and continues one session without duplicate execution', async () => {
    const model = fakeModel({ output: 'first' }, { output: 'second' });
    const app = createFevex({
      models: { default: model },
      agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
    });
    const client = clientFor(app);

    const first = await client.startRun('assistant', { input: 'one' });
    const firstEvents = await collect(client.observeRun(first.id));
    expect(firstEvents.map(({ type }) => type)).toContain('model.output.delta');
    expect(firstEvents.at(-1)?.type).toBe('run.completed');

    const cursor = firstEvents[1]!.id;
    const reconnected = await collect(client.observeRun(first.id, { after: cursor }));
    expect(reconnected).toEqual(firstEvents.slice(2));
    expect(model.calls).toHaveLength(1);

    const second = await client.startRun('assistant', {
      input: 'two',
      sessionId: first.sessionId,
    });
    await collect(client.observeRun(second.id));
    expect(second.sessionId).toBe(first.sessionId);
    expect(model.calls).toHaveLength(2);
    expect((await client.getRun<string>(second.id)).output).toBe('second');
  });

  test('disconnecting observation does not cancel, while DELETE does', async () => {
    const app = createFevex({
      models: {
        default: {
          async *stream(input) {
            yield { type: 'output.delta' as const, delta: 'working' };
            await waitForAbort(input.signal!);
          },
        },
      },
      agents: [defineAgent({ name: 'assistant', instructions: 'Wait.' })],
    });
    const client = clientFor(app);
    const run = await client.startRun('assistant', { input: 'work' });

    for await (const event of client.observeRun(run.id)) {
      expect(event.type).toBe('run.started');
      break;
    }
    expect((await client.getRun(run.id)).status).toBe('running');

    await client.cancelRun(run.id);
    const events = await collect(client.observeRun(run.id));
    expect(events.at(-1)?.type).toBe('run.cancelled');
    expect(events.some(({ type }) => type === 'run.completed')).toBe(false);
  });

  test('starts and observes workflow runs', async () => {
    const app = createFevex({
      models: { default: fakeModel({ output: 'done' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
      workflows: [
        defineWorkflow({
          name: 'flow',
          async run(step, input) {
            return (await step.agent('answer', 'assistant', { input })).output;
          },
        }),
      ],
    });
    const client = clientFor(app);

    const run = await client.startWorkflow('flow', { input: 'hello' });
    expect(run).toMatchObject({ kind: 'workflow', workflowName: 'flow' });
    const events = await collect(client.observeRun(run.id));

    expect(events.map(({ type }) => type)).toEqual([
      'workflow.run.started',
      'workflow.step.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'workflow.step.completed',
      'workflow.run.completed',
    ]);
    expect(events.find(({ type }) => type === 'model.output.delta')).toMatchObject({
      payload: {
        workflowStepId: 'answer',
        workflowAgentName: 'assistant',
      },
    });
    expect(await client.getRun<string>(run.id)).toMatchObject({
      kind: 'workflow',
      status: 'completed',
      output: 'done',
    });
  });

  test('starts and observes team runs', async () => {
    const app = createFevex({
      models: { default: fakeModel({ output: 'done' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
      teams: [
        defineTeam({
          name: 'team',
          supervisor: 'assistant',
          members: [],
          async run(team, input) {
            return (await team.delegate('answer', { agent: 'assistant', task: input })).output;
          },
        }),
      ],
    });
    const client = clientFor(app);

    const run = await client.startTeam('team', { input: 'hello' });
    expect(run).toMatchObject({ kind: 'team', teamName: 'team' });
    const events = await collect(client.observeRun(run.id));
    expect(events.map(({ type }) => type)).toEqual([
      'team.run.started',
      'team.agent.assigned',
      'model.started',
      'model.output.delta',
      'model.completed',
      'team.task.completed',
      'team.run.completed',
    ]);
  });

  test('injects the hosting actor when resuming', async () => {
    let resolution: ResumeRunResolution | undefined;
    const paused = {
      id: 'run-1',
      sessionId: 'session-1',
      agentName: 'assistant',
      status: 'paused',
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies AgentRun;
    const app = {
      async getRun() {
        return paused;
      },
      async resumeRun(_runId: string, value: ResumeRunResolution) {
        resolution = value;
        return { ...paused, status: 'running' as const };
      },
    } as unknown as Fevex;
    const handler = createFevexHttpHandler({ fevex: app, pollIntervalMs: 1 });
    const response = await handler(
      new Request('http://local/v1/runs/run-1/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'approval',
          approvalId: 'approval-1',
          decision: 'approve',
          actor: { id: 'spoofed' },
        }),
      }),
      { context: { actor: { id: 'trusted' } } },
    );

    expect(response.status).toBe(202);
    expect(resolution).toMatchObject({ actor: { id: 'trusted' } });

    await handler(
      new Request('http://local/v1/runs/run-1/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'tool_execution',
          toolCallId: 'call-1',
          decision: 'use_output',
          output: { ok: true },
        }),
      }),
      { context: { actor: { id: 'trusted' } } },
    );
    expect(resolution).toMatchObject({
      type: 'tool_execution',
      actor: { id: 'trusted' },
      output: { ok: true },
    });

    await handler(
      new Request('http://local/v1/runs/run-1/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'timer' }),
      }),
      { context: { actor: { id: 'trusted' } } },
    );
    expect(resolution).toMatchObject({ type: 'timer', actor: { id: 'trusted' } });

    await handler(
      new Request('http://local/v1/runs/run-1/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'event', eventName: 'release', payload: { ok: true } }),
      }),
      { context: { actor: { id: 'trusted' } } },
    );
    expect(resolution).toMatchObject({
      type: 'event',
      eventName: 'release',
      payload: { ok: true },
      actor: { id: 'trusted' },
    });

    await handler(
      new Request('http://local/v1/runs/run-1/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'elicitation',
          requestId: 'request-1',
          value: { accountId: 'account-42' },
        }),
      }),
      { context: { actor: { id: 'trusted' } } },
    );
    expect(resolution).toMatchObject({
      type: 'elicitation',
      requestId: 'request-1',
      value: { accountId: 'account-42' },
      actor: { id: 'trusted' },
    });
  });

  test('recovers only with the hosting actor', async () => {
    let recoveryActor: { id: string; type?: string } | undefined;
    const running = {
      id: 'run-recovery',
      sessionId: 'session-recovery',
      agentName: 'assistant',
      status: 'running',
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies AgentRun;
    const app = {
      async getRun() {
        return running;
      },
      async recoverRun(_runId: string, options: { actor: { id: string; type?: string } }) {
        recoveryActor = options.actor;
        return running;
      },
    } as unknown as Fevex;
    const handler = createFevexHttpHandler({ fevex: app });
    const unauthorized = await handler(
      new Request('http://local/v1/runs/run-recovery/recover', { method: 'POST' }),
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ code: 'ACTOR_REQUIRED' });

    const response = await handler(
      new Request('http://local/v1/runs/run-recovery/recover', {
        method: 'POST',
        headers: { 'x-actor-id': 'spoofed' },
      }),
      { context: { actor: { id: 'trusted-worker', type: 'service' } } },
    );
    expect(response.status).toBe(202);
    expect(recoveryActor).toEqual({ id: 'trusted-worker', type: 'service' });
  });

  test('rejects unknown sessions, active-session conflicts and invalid cursors', async () => {
    const app = createFevex({
      models: {
        default: {
          async *stream(input) {
            yield { type: 'output.delta' as const, delta: 'waiting' };
            await waitForAbort(input.signal!);
          },
        },
      },
      agents: [defineAgent({ name: 'assistant', instructions: 'Wait.' })],
    });
    const client = clientFor(app);

    await expect(client.startRun('assistant', {
      input: 'missing',
      sessionId: 'missing',
    })).rejects.toMatchObject({ status: 404, code: 'SESSION_NOT_FOUND' });

    const run = await client.startRun('assistant', { input: 'first' });
    await expect(client.startRun('assistant', {
      input: 'second',
      sessionId: run.sessionId,
    })).rejects.toMatchObject({ status: 409, code: 'RUN_CONFLICT' });
    await expect(collect(client.observeRun(run.id, {
      after: 'missing-event',
    }))).rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
    await client.cancelRun(run.id);
  });

  test('returns versioned safe Problem Details', async () => {
    const app = createFevex({
      models: { default: fakeModel({ output: 'unused' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
    });
    const handler = createFevexHttpHandler({ fevex: app });
    const response = await handler(new Request('http://local/v1/agents/missing/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input":"hello"}',
    }));
    const problem = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.headers.get('fevex-protocol-version')).toBe(FEVEX_HTTP_PROTOCOL_VERSION);
    expect(problem).toMatchObject({ code: 'AGENT_NOT_FOUND', status: 404 });
    expect(JSON.stringify(problem)).not.toContain('stack');

    const missingWorkflow = await handler(
      new Request('http://local/v1/workflows/missing/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"input":"hello"}',
      }),
    );
    expect(missingWorkflow.status).toBe(404);
    expect(await missingWorkflow.json()).toMatchObject({ code: 'WORKFLOW_NOT_FOUND' });

    const malformed = await handler(new Request('http://local/v1/agents/assistant/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: 'INVALID_REQUEST' });

    const missingRun = await handler(new Request('http://local/v1/runs/missing'));
    expect(missingRun.status).toBe(404);
    expect(await missingRun.json()).toMatchObject({ code: 'RUN_NOT_FOUND' });

    const changedDefinition = createFevexHttpHandler({
      fevex: {
        async startAgent() {
          throw {
            name: 'FevexRunError',
            code: 'RUN_DEFINITION_CHANGED',
            message: 'Definition for agent "assistant" changed',
          };
        },
      } as unknown as Fevex,
    });
    const changed = await changedDefinition(new Request('http://local/v1/agents/assistant/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input":"hello"}',
    }));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      code: 'RUN_DEFINITION_CHANGED',
      detail: 'Definition for agent "assistant" changed',
    });
  });

  test('reports internal protocol errors to the host', async () => {
    const internal = new Error('database path leaked');
    let reported: { error: unknown; problem: unknown } | undefined;
    const handler = createFevexHttpHandler({
      fevex: {
        async startAgent() {
          throw internal;
        },
      } as unknown as Fevex,
      onError(error, problem) {
        reported = { error, problem };
      },
    });
    const response = await handler(new Request('http://local/v1/agents/assistant/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input":"hello"}',
    }));
    const problem = await response.json();

    expect(response.status).toBe(500);
    expect(problem).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(JSON.stringify(problem)).not.toContain('database path leaked');
    expect(reported).toMatchObject({
      error: internal,
      problem: { code: 'INTERNAL_ERROR', instance: '/v1/agents/assistant/runs' },
    });
  });

  test('client parses fragmented SSE and Problem Details', async () => {
    const event = {
      id: 'event-1',
      sequence: 1,
      runId: 'run-1',
      timestamp: new Date().toISOString(),
      type: 'run.started',
    } satisfies AgentEvent;
    const frame = new TextEncoder().encode(
      `id: event-1\r\nevent: run.started\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame.slice(0, 11));
        controller.enqueue(frame.slice(11));
        controller.close();
      },
    });
    const client = createFevexHttpClient({
      baseUrl: 'http://local',
      fetch: async () => new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'fevex-protocol-version': '3',
        },
      }),
    });

    expect(await collect(client.observeRun('run-1'))).toEqual([event]);

    const failing = createFevexHttpClient({
      baseUrl: 'http://local',
      fetch: async () => new Response(JSON.stringify({
        type: 'urn:fevex:problem:run_not_found',
        title: 'Not Found',
        status: 404,
        code: 'RUN_NOT_FOUND',
      }), {
        status: 404,
        headers: {
          'content-type': 'application/problem+json',
          'fevex-protocol-version': '3',
        },
      }),
    });
    await expect(failing.getRun('missing')).rejects.toMatchObject({
      name: 'FevexHttpError',
      status: 404,
      code: 'RUN_NOT_FOUND',
    } satisfies Partial<FevexHttpError>);

    const incompatible = createFevexHttpClient({
      baseUrl: 'http://local',
      fetch: async () => new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'fevex-protocol-version': '1',
        },
      }),
    });
    await expect(incompatible.getRun('run-1')).rejects.toThrow(
      'Unsupported Fevex HTTP protocol version "1"',
    );
  });
});

function clientFor(app: Fevex) {
  const handler = createFevexHttpHandler({ fevex: app, pollIntervalMs: 1 });
  return createFevexHttpClient({
    baseUrl: 'http://local',
    fetch: (input, init) => handler(new Request(input, init)),
  });
}

async function collect<T>(values: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function waitForAbort(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
