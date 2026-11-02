import { expect, test } from 'bun:test';
import { defineAgent } from './agents';
import type { AgentEvent, JsonObject } from './core';
import { createFevex, type FevexAdmissionRequest } from './fevex';
import type { ModelGateway } from './models';
import { RunPausedError } from './run-error';
import { InMemoryRunStore, type AgentRun, type RunStore, type WorkflowCheckpoint } from './runtime';
import { fakeModel } from './testing';
import { lookupCall, streamFrom } from './test-fixtures';
import { defineTool } from './tools';
import { defineWorkflow } from './workflows';

const agent = defineAgent({ name: 'assistant', instructions: 'Answer.' });

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

function approvalApp(limits: { maxEventsPerRun?: number; maxActiveRuns?: number } = {}) {
  const store = new InMemoryRunStore();
  const app = createFevex({
    models: {
      default: {
        stateCodec: {
          serialize: (state) => structuredClone(state) as JsonObject,
          restore: (state) => structuredClone(state),
        },
        stream: streamFrom(async (input) => input.providerState === undefined
          ? { toolCalls: [lookupCall], providerState: { turn: 1 } }
          : { output: 'approved' }),
      },
      blocking: blockingModel(),
    },
    agents: [
      defineAgent({ name: 'approval', instructions: 'Answer.', tools: ['lookup'] }),
      defineAgent({ name: 'waiter', instructions: 'Wait.', model: 'blocking' }),
    ],
    tools: [defineTool({
      name: 'lookup',
      approval: 'required',
      execute() {
        return 'found';
      },
    })],
    runStore: store,
    ...(limits.maxEventsPerRun === undefined
      ? {}
      : { limits: { maxEventsPerRun: limits.maxEventsPerRun } }),
    ...(limits.maxActiveRuns === undefined
      ? {}
      : { admission: { maxActiveRuns: limits.maxActiveRuns } }),
  });
  return { app, store };
}

async function pauseApproval(app: ReturnType<typeof createFevex>): Promise<RunPausedError> {
  try {
    await app.runAgent('approval', { input: 'hello' });
  } catch (error) {
    if (error instanceof RunPausedError) return error;
    throw error;
  }
  throw new Error('Expected the approval run to pause');
}

function approve(paused: RunPausedError) {
  return {
    type: 'approval' as const,
    approvalId: paused.pause.type === 'approval' ? paused.pause.approval.id : '',
    decision: 'approve' as const,
    actor: { id: 'reviewer' },
  };
}

test('admits a bounded number of concurrent runs', async () => {
  const app = createFevex({
    models: { default: blockingModel() },
    agents: [agent],
    admission: { maxActiveRuns: 1 },
  });
  const first = await app.startAgent('assistant', { input: 'one' });
  await expect(app.startAgent('assistant', { input: 'two' }))
    .rejects.toMatchObject({ code: 'ADMISSION_DENIED' });
  await app.cancelRun(first.id);

  const next = await app.startAgent('assistant', { input: 'three' });
  expect(next.id).not.toBe(first.id);
  await app.cancelRun(next.id);
});

test('admits concurrent runs per tenant and forwards custom admission', async () => {
  const decisions: FevexAdmissionRequest[] = [];
  const app = createFevex({
    models: { default: blockingModel() },
    agents: [agent],
    admission: {
      maxActiveRunsPerTenant: 1,
      authorize(request) {
        decisions.push(request);
        return request.activeRuns < 2;
      },
    },
  });
  const alice = await app.startAgent('assistant', {
    input: 'alice one',
    context: { actor: { id: 'alice' }, attributes: { tenantId: 'tenant-a' } },
  });
  await expect(app.startAgent('assistant', {
    input: 'alice two',
    context: { actor: { id: 'alice' }, attributes: { tenantId: 'tenant-a' } },
  })).rejects.toMatchObject({ code: 'ADMISSION_DENIED' });

  const bob = await app.startAgent('assistant', {
    input: 'bob one',
    context: { actor: { id: 'bob' }, attributes: { tenantId: 'tenant-b' } },
  });
  expect(bob.id).not.toBe(alice.id);
  expect(decisions[0]).toMatchObject({
    kind: 'agent',
    name: 'assistant',
    activeRuns: 0,
    activeTenantRuns: 0,
  });

  await app.cancelRun(alice.id);
  await app.cancelRun(bob.id);
});

test('cancels a run when its deadline expires', async () => {
  const app = createFevex({
    models: { default: blockingModel() },
    agents: [agent],
  });
  const events = await collectEvents(app.streamAgent('assistant', { input: 'wait', deadlineMs: 30 }));
  const runId = events[0]!.runId;
  expect(events.find(({ type }) => type === 'run.cancelled')).toMatchObject({
    payload: { reason: 'timeout' },
  });
  const run = await app.getRun(runId);
  expect(run?.status).toBe('cancelled');
  expect(typeof run?.deadlineAt).toBe('string');
});

test('rejects invalid deadlines and purges terminal runs through the runtime', async () => {
  const store = new InMemoryRunStore();
  const app = createFevex({
    models: { default: fakeModel({ output: 'ok' }) },
    agents: [agent],
    runStore: store,
  });
  await expect(app.startAgent('assistant', { input: 'x', deadlineMs: 0 }))
    .rejects.toThrow('deadlineMs');

  const old = new Date(Date.now() - 86_400_000).toISOString();
  await store.saveSession({
    id: 'session-old',
    history: [],
    createdAt: old,
    updatedAt: old,
  });
  await store.saveRun({
    id: 'run-old',
    sessionId: 'session-old',
    agentName: 'assistant',
    status: 'completed',
    revision: 1,
    createdAt: old,
    updatedAt: old,
  });
  expect(await app.purgeRuns({ before: new Date().toISOString() })).toEqual({
    runs: 1,
    sessions: 1,
  });
  expect(await store.getRun('run-old')).toBeUndefined();
  expect(await store.getSession('session-old')).toBeUndefined();
});

test('enforces maxEventsPerRun without hiding the terminal event', async () => {
  const app = createFevex({
    models: {
      default: {
        async *stream() {
          yield { type: 'output.delta' as const, delta: 'a' };
          yield { type: 'output.delta' as const, delta: 'b' };
          yield { type: 'completed' as const, result: { output: 'done' } };
        },
      },
    },
    agents: [agent],
    limits: { maxEventsPerRun: 2 },
  });
  const events = await collectEvents(app.streamAgent('assistant', { input: 'x' }));
  expect(events.find(({ type }) => type === 'run.failed')?.payload).toMatchObject({
    error: expect.stringContaining('maxEventsPerRun'),
    errorCode: 'EVENT_LIMIT_EXCEEDED',
  });
  expect(events.at(-1)?.type).toBe('run.failed');
});

test('rejects resume after the absolute deadline', async () => {
  const store = new InMemoryRunStore();
  const app = createFevex({
    models: {
      default: {
        stateCodec: {
          serialize: (state) => structuredClone(state) as JsonObject,
          restore: (state) => structuredClone(state),
        },
        stream: streamFrom(async (input) => input.providerState === undefined
          ? { toolCalls: [lookupCall], providerState: { turn: 1 } }
          : { output: 'approved' }),
      },
    },
    agents: [defineAgent({
      name: 'assistant',
      instructions: 'Answer.',
      tools: ['lookup'],
    })],
    tools: [defineTool({
      name: 'lookup',
      approval: 'required',
      execute() {
        return 'found';
      },
    })],
    runStore: store,
  });

  let paused: RunPausedError | undefined;
  try {
    await app.runAgent('assistant', { input: 'hello', deadlineMs: 100 });
  } catch (error) {
    paused = error as RunPausedError;
  }
  expect(paused).toBeInstanceOf(RunPausedError);
  await Bun.sleep(150);
  const cancelled = await app.resumeRun(paused!.runId, {
    type: 'approval',
    approvalId: paused!.pause.type === 'approval' ? paused!.pause.approval.id : '',
    decision: 'approve',
    actor: { id: 'reviewer' },
  });
  expect(cancelled.status).toBe('cancelled');
  expect((await app.listEvents(paused!.runId)).at(-1)).toMatchObject({
    type: 'run.cancelled',
    payload: { reason: 'timeout' },
  });
});

test('reserves admission slots for concurrent starts', async () => {
  const app = createFevex({
    models: { default: blockingModel() },
    agents: [agent],
    admission: { maxActiveRuns: 1 },
  });
  const results = await Promise.allSettled([
    app.startAgent('assistant', { input: 'one' }),
    app.startAgent('assistant', { input: 'two' }),
  ]);
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<AgentRun> => result.status === 'fulfilled',
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.reason).toMatchObject({ code: 'ADMISSION_DENIED' });
  await app.cancelRun(fulfilled[0]!.value.id);
});

test('does not strand a paused run at the event limit', async () => {
  const { app } = approvalApp({ maxEventsPerRun: 3 });
  const paused = await pauseApproval(app);
  expect(await app.getRun(paused.runId)).toMatchObject({ status: 'paused' });

  await app.resumeRun(paused.runId, approve(paused));
  await Bun.sleep(50);
  expect(await app.getRun(paused.runId)).toMatchObject({ status: 'failed' });
  expect((await app.listEvents(paused.runId)).at(-1)).toMatchObject({
    type: 'run.failed',
    payload: { errorCode: 'EVENT_LIMIT_EXCEEDED' },
  });
});

test('admits resumed runs against the same limit', async () => {
  const { app } = approvalApp({ maxActiveRuns: 1 });
  const paused = await pauseApproval(app);
  const waiter = await app.startAgent('waiter', { input: 'wait' });

  await expect(app.resumeRun(paused.runId, approve(paused)))
    .rejects.toMatchObject({ code: 'ADMISSION_DENIED' });
  await app.cancelRun(waiter.id);

  const resumed = await app.resumeRun(paused.runId, approve(paused));
  expect(resumed.status).toBe('running');
});

test('honors a step deadline shorter than the parent deadline', async () => {
  const app = createFevex({
    models: { blocking: blockingModel() },
    agents: [defineAgent({ name: 'waiter', instructions: 'Wait.', model: 'blocking' })],
    workflows: [defineWorkflow({
      name: 'step-deadline',
      async run(step, input) {
        return (await step.agent('wait', 'waiter', { input, deadlineMs: 30 })).output;
      },
    })],
  });
  const run = await app.startWorkflow('step-deadline', { input: 'x', deadlineMs: 500 });
  const final = await waitForTerminal(app, run.id);
  expect(final.status).toBe('failed');
  expect((await app.listEvents(run.id)).at(-1)).toMatchObject({
    type: 'workflow.run.failed',
  });
});

test('cancels a workflow when its child hits the parent deadline', async () => {
  const app = createFevex({
    models: { blocking: blockingModel() },
    agents: [defineAgent({ name: 'waiter', instructions: 'Wait.', model: 'blocking' })],
    workflows: [defineWorkflow({
      name: 'blocking-flow',
      async run(step, input) {
        return (await step.agent('wait', 'waiter', { input })).output;
      },
    })],
  });
  const run = await app.startWorkflow('blocking-flow', { input: 'x', deadlineMs: 50 });
  const final = await waitForTerminal(app, run.id);
  expect(final.status).toBe('cancelled');
  expect((await app.listEvents(run.id)).at(-1)).toMatchObject({
    type: 'workflow.run.cancelled',
    payload: { reason: 'timeout' },
  });
});

test('cancels a workflow when a resumed child outlives the parent deadline', async () => {
  const store = new InMemoryRunStore();
  const app = createFevex({
    models: {
      default: {
        stateCodec: {
          serialize: (state) => structuredClone(state) as JsonObject,
          restore: (state) => structuredClone(state),
        },
        async *stream(input) {
          if (input.providerState === undefined) {
            yield {
              type: 'completed' as const,
              result: { toolCalls: [lookupCall], providerState: { turn: 1 } },
            };
            return;
          }
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(input.signal?.reason ?? new Error('aborted'));
            if (input.signal?.aborted) abort();
            else input.signal?.addEventListener('abort', abort, { once: true });
          });
        },
      },
    },
    agents: [defineAgent({
      name: 'approval',
      instructions: 'Answer.',
      tools: ['lookup'],
    })],
    tools: [defineTool({
      name: 'lookup',
      approval: 'required',
      execute() {
        return 'found';
      },
    })],
    workflows: [defineWorkflow({
      name: 'approval-flow',
      async run(step, input) {
        return (await step.agent('approve', 'approval', { input })).output;
      },
    })],
    runStore: store,
  });

  let paused: RunPausedError | undefined;
  try {
    await app.runWorkflow('approval-flow', { input: 'hello', deadlineMs: 200 });
  } catch (error) {
    if (error instanceof RunPausedError) paused = error;
    else throw error;
  }
  expect(paused).toBeInstanceOf(RunPausedError);
  await Bun.sleep(50);
  const childPause = paused!.pause.type === 'workflow_child'
    ? paused!.pause.childPause
    : undefined;
  const result = await app.resumeRun(paused!.runId, {
    type: 'approval',
    approvalId: childPause?.type === 'approval' ? childPause.approval.id : '',
    decision: 'approve',
    actor: { id: 'reviewer' },
  });
  expect(result.status).toBe('cancelled');
  expect((await app.listEvents(paused!.runId)).at(-1)).toMatchObject({
    type: 'workflow.run.cancelled',
    payload: { reason: 'timeout' },
  });
});

test('cancels all paused children when a resumed parallel workflow times out', async () => {
  const store = new InMemoryRunStore();
  const app = createFevex({
    models: {
      default: {
        stateCodec: {
          serialize: (state) => structuredClone(state) as JsonObject,
          restore: (state) => structuredClone(state),
        },
        async *stream(input) {
          if (input.providerState === undefined) {
            yield {
              type: 'completed' as const,
              result: { toolCalls: [lookupCall], providerState: { turn: 1 } },
            };
            return;
          }
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(input.signal?.reason ?? new Error('aborted'));
            if (input.signal?.aborted) abort();
            else input.signal?.addEventListener('abort', abort, { once: true });
          });
        },
      },
    },
    agents: [defineAgent({
      name: 'approval',
      instructions: 'Answer.',
      tools: ['lookup'],
    })],
    tools: [defineTool({
      name: 'lookup',
      approval: 'required',
      execute() {
        return 'found';
      },
    })],
    workflows: [defineWorkflow({
      name: 'parallel-approval',
      async run(step, input) {
        return step.parallel('parallel', {
          first: () => step.agent('first', 'approval', { input }),
          second: () => step.agent('second', 'approval', { input }),
        });
      },
    })],
    runStore: store,
  });

  let paused: RunPausedError | undefined;
  try {
    await app.runWorkflow('parallel-approval', { input: 'hello', deadlineMs: 200 });
  } catch (error) {
    if (error instanceof RunPausedError) paused = error;
    else throw error;
  }
  expect(paused).toBeInstanceOf(RunPausedError);
  const children = paused!.pause.type === 'workflow_children'
    ? paused!.pause.children
    : [];
  expect(children).toHaveLength(2);
  const first = children[0]!;
  await Bun.sleep(50);
  const result = await app.resumeRun(paused!.runId, {
    type: 'approval',
    approvalId: first.childPause.type === 'approval' ? first.childPause.approval.id : '',
    decision: 'approve',
    actor: { id: 'reviewer' },
  });
  expect(result.status).toBe('cancelled');
  for (const child of children) {
    expect((await store.getRun(child.childRunId))?.status).toBe('cancelled');
  }
});

test('propagates workflow deadlines to child runs and cancels an expired workflow', async () => {  const store = new InMemoryRunStore();
  const app = createFevex({
    models: {
      default: {
        stateCodec: {
          serialize: (state) => structuredClone(state) as JsonObject,
          restore: (state) => structuredClone(state),
        },
        stream: streamFrom(async (input) => input.providerState === undefined
          ? { toolCalls: [lookupCall], providerState: { turn: 1 } }
          : { output: 'approved' }),
      },
    },
    agents: [defineAgent({
      name: 'approval',
      instructions: 'Answer.',
      tools: ['lookup'],
    })],
    tools: [defineTool({
      name: 'lookup',
      approval: 'required',
      execute() {
        return 'found';
      },
    })],
    workflows: [defineWorkflow({
      name: 'approval-flow',
      async run(step, input) {
        return (await step.agent('approve', 'approval', { input })).output;
      },
    })],
    runStore: store,
  });

  let paused: RunPausedError | undefined;
  try {
    await app.runWorkflow('approval-flow', { input: 'hello', deadlineMs: 100 });
  } catch (error) {
    if (error instanceof RunPausedError) paused = error;
    else throw error;
  }
  expect(paused).toBeInstanceOf(RunPausedError);

  const checkpoint = await store.getCheckpoint<WorkflowCheckpoint>(paused!.runId);
  const step = checkpoint?.steps.approve;
  expect(step?.type).toBe('agent');
  if (step?.type !== 'agent') throw new Error('Expected an agent step');
  expect(typeof (await store.getRun(step.childRunId))?.deadlineAt).toBe('string');

  await Bun.sleep(150);
  const childPause = paused!.pause.type === 'workflow_child'
    ? paused!.pause.childPause
    : undefined;
  expect(childPause?.type).toBe('approval');
  const cancelled = await app.resumeRun(paused!.runId, {
    type: 'approval',
    approvalId: childPause?.type === 'approval' ? childPause.approval.id : '',
    decision: 'approve',
    actor: { id: 'reviewer' },
  });
  expect(cancelled.status).toBe('cancelled');
  expect((await store.getRun(step.childRunId))?.status).toBe('cancelled');
});

test('retains unrelated empty sessions during purge', async () => {  const store = new InMemoryRunStore();
  const old = new Date(Date.now() - 86_400_000).toISOString();
  const now = new Date().toISOString();
  await store.saveSession({ id: 'unrelated', history: [], createdAt: now, updatedAt: now });
  await store.saveSession({ id: 'old-session', history: [], createdAt: old, updatedAt: old });
  await store.saveRun({
    id: 'old-run',
    sessionId: 'old-session',
    agentName: 'assistant',
    status: 'completed',
    revision: 1,
    createdAt: old,
    updatedAt: old,
  });
  await store.purgeRuns({ before: now });
  expect(await store.getSession('unrelated')).toBeDefined();
  expect(await store.getSession('old-session')).toBeUndefined();
});

test('validates admission and event-limit configuration', () => {
  expect(() => createFevex({
    models: { default: fakeModel({ output: 'ok' }) },
    agents: [agent],
    admission: { maxActiveRuns: 0 },
  })).toThrow('admission.maxActiveRuns');
  expect(() => createFevex({
    models: { default: fakeModel({ output: 'ok' }) },
    agents: [agent],
    limits: { maxEventsPerRun: 0 },
  })).toThrow('limits.maxEventsPerRun');
});

test('reports retention unsupported for legacy stores', async () => {
  const memory = new InMemoryRunStore();
  const legacy = {
    getRun: memory.getRun.bind(memory),
    saveRun: memory.saveRun.bind(memory),
    getSession: memory.getSession.bind(memory),
    saveSession: memory.saveSession.bind(memory),
    appendEvent: memory.appendEvent.bind(memory),
    listEvents: memory.listEvents.bind(memory),
  } as unknown as RunStore;
  const app = createFevex({
    models: { default: fakeModel({ output: 'ok' }) },
    agents: [agent],
    runStore: legacy,
  });
  await expect(app.purgeRuns()).rejects.toMatchObject({
    code: 'RETENTION_UNSUPPORTED',
  });
});

async function collectEvents(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  try {
    for await (const event of iterable) events.push(event);
  } catch {
    // Cancellation and failure paths yield their terminal event before throwing.
  }
  return events;
}

async function waitForTerminal(app: ReturnType<typeof createFevex>, runId: string) {
  const timeout = Date.now() + 2_000;
  while (Date.now() < timeout) {
    const run = await app.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'paused') return run;
    await Bun.sleep(10);
  }
  throw new Error(`Run "${runId}" did not reach a terminal status`);
}
