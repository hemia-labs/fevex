import { expect, spyOn, test } from 'bun:test';
import { InMemoryRunStore } from '../runtime';
import type { RunCheckpoint, RunLease } from '../runtime';
import { agent, modelWithOutput } from '../test-fixtures';
import { createComposition } from './configuration';
import { createRunCore } from './run-core';
import type { ExecutionState } from './run-state';

async function execution(ttlMs = 30_000) {
  const store = new InMemoryRunStore();
  const now = new Date().toISOString();
  const lease: RunLease = { generation: 0, runId: 'run', ownerId: 'owner', expiresAt: new Date(Date.now() + ttlMs).toISOString() };
  const state: ExecutionState = {
    run: { id: 'run', agentName: 'worker', sessionId: 'session', revision: 0, status: 'running', createdAt: now, updatedAt: now },
    session: { id: 'session', history: [], createdAt: now, updatedAt: now },
    controller: new AbortController(), request: { input: 'hello', signal: new AbortController().signal },
    lease, eventSequence: 0, advancing: false,
  };
  state.request.signal = state.controller.signal;
  const checkpoint: RunCheckpoint = {
    version: 2, runId: 'run', definitionHash: 'test', messages: [], inputContent: 'hello',
    step: 1, toolCallCount: 0, seenToolCallIds: [], pendingTools: [], pendingIndex: 0,
  };
  await store.createExecution({ run: state.run, session: state.session, checkpoint, lease, events: [] });
  const core = createRunCore(createComposition({
    runStore: store, agents: [agent('worker')], models: { default: modelWithOutput('done') },
  }));
  let tick!: () => void;
  const original = globalThis.setInterval;
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    tick = callback;
    return original(() => {}, 60_000);
  }) as typeof setInterval);
  try {
    core.startLease(state, store);
  } finally {
    interval.mockRestore();
  }
  return { core, state, store, tick };
}

for (const failure of ['false', 'reject', 'throw'] as const) {
  test(`lease renewal ${failure} aborts and prevents further commits`, async () => {
    const { core, state, store, tick } = await execution();
    store.renewLease = () => {
      if (failure === 'throw') throw new Error('connection lost');
      return failure === 'reject' ? Promise.reject(new Error('connection lost')) : Promise.resolve(false);
    };
    try {
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.request.signal.aborted).toBe(true);
      expect(state.request.signal.reason).toMatchObject({ code: 'RUN_CONFLICT' });
      expect(state.leaseLost).toBe(true);
      expect(state.leaseTimer).toBeUndefined();
      expect(state.leaseExpiryTimer).toBeUndefined();
      await expect(core.commit(state)).rejects.toMatchObject({ code: 'RUN_CONFLICT' });
      expect((await store.getRun('run'))?.revision).toBe(1);
    } finally {
      await core.releaseExecution(state);
    }
  });
}

test('renewals do not overlap or revive a released execution', async () => {
  const { core, state, store, tick } = await execution();
  let renew!: (value: boolean) => void;
  let calls = 0;
  store.renewLease = () => {
    calls += 1;
    return new Promise<boolean>((resolve) => { renew = resolve; });
  };
  try {
    tick();
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    // The watchdog must remain armed while renewal is unresolved.
    expect(state.leaseExpiryTimer).toBeDefined();
    await core.releaseExecution(state);
    renew(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.leaseExpiryTimer).toBeUndefined();
    expect(state.leaseTimer).toBeUndefined();
  } finally {
    await core.releaseExecution(state);
  }
});

test('the local expiry watchdog aborts without waiting for a renewal response', async () => {
  const { core, state, store, tick } = await execution(20);
  try {
    store.renewLease = () => new Promise<boolean>(() => {});
    tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(state.request.signal.aborted).toBe(true);
    expect(state.leaseLost).toBe(true);
    await expect(core.commit(state)).rejects.toMatchObject({ code: 'RUN_CONFLICT' });
  } finally {
    await core.releaseExecution(state);
  }
});

test('a stale runtime cannot execute tools or persist output after takeover', async () => {
  const { createFevex, defineTool } = await import('../index');
  const { streamFrom } = await import('../test-fixtures');
  const store = new InMemoryRunStore();
  let initialLease!: RunLease;
  const create = store.createExecution.bind(store);
  store.createExecution = async (value) => {
    const created = await create(value);
    initialLease = { ...value.lease };
    return created;
  };
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let effects = 0;
  const app = createFevex({
    runStore: store,
    agents: [agent('worker', { tools: ['write'] })],
    tools: [defineTool({ name: 'write', execute: () => { effects += 1; return 'saved'; } })],
    models: { default: { stream: streamFrom(async () => {
      entered();
      await gate;
      return { toolCalls: [{ id: 'write', name: 'write', input: {} }] };
    }) } },
  });
  const running = app.runAgent('worker', { input: 'hello' }).then(
    () => undefined, (error: unknown) => error,
  );
  await started;
  const original = (await store.getRun(initialLease.runId))!;
  const nextLease = { ...initialLease };
  try {
    await store.releaseLease(initialLease.runId, initialLease.ownerId, initialLease.generation);
    expect(await store.acquireLease(nextLease)).toBe(true);
    release();
    expect(await running).toMatchObject({ code: 'RUN_CONFLICT' });
    expect(effects).toBe(0);
    expect(await store.getRun(original.id)).toEqual(original);
    expect((await store.getSession(original.sessionId))?.history).toEqual([]);
    expect(await store.renewLease(nextLease)).toBe(true);
  } finally {
    release();
    await running;
    await store.releaseLease(nextLease.runId, nextLease.ownerId, nextLease.generation);
  }
});

for (const kind of ['agent', 'workflow'] as const) {
  test(`${kind} surfaces renewal errors without persisting cancellation`, async () => {
    const { createFevex, defineWorkflow } = await import('../index');
    const { streamFrom } = await import('../test-fixtures');
    const store = new InMemoryRunStore();
    const cause = new Error('database connection interrupted');
    store.renewLease = async () => { throw cause; };
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const work = async () => { entered(); await gate; return 'done'; };
    let runId = '';
    const create = store.createExecution.bind(store);
    store.createExecution = async (value) => { runId = value.run.id; return create(value); };
    const app = createFevex({
      runStore: store, agents: [agent('worker')],
      models: { default: { stream: streamFrom(async () => ({ output: await work() })) } },
      workflows: [defineWorkflow({ name: 'worker', run: work })],
    });
    let tick!: () => void;
    const original = globalThis.setInterval;
    const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
      tick = callback;
      return original(() => {}, 60_000);
    }) as typeof setInterval);
    const running = (kind === 'agent' ? app.runAgent('worker', { input: 'hello' })
      : app.runWorkflow('worker', { input: 'hello' })).then(() => undefined, (error: unknown) => error);
    try {
      await started;
      interval.mockRestore();
      const before = await store.getRun(runId);
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      expect(await running).toMatchObject({ code: 'RUN_CONFLICT', cause });
      expect(await store.getRun(runId)).toEqual(before);
    } finally {
      interval.mockRestore();
      release();
      await running;
    }
  });
}
