import { expect, test } from 'bun:test';
import { createFevex, defineTool, defineWorkflow, defineTeam, RunPausedError, InMemoryRunStore } from './index';
import { agent, streamFrom } from './test-fixtures';

test('reserves a shared session before a competing runtime calls its model', async () => {
  const store = new InMemoryRunStore();
  const now = new Date().toISOString();
  await store.saveSession({ id: 'shared', history: [], createdAt: now, updatedAt: now });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const makeApp = () => createFevex({
    runStore: store,
    agents: [agent('worker')],
    models: { default: { stream: streamFrom(async () => {
      calls += 1;
      entered();
      await gate;
      return { output: 'done' };
    }) } },
  });
  const first = makeApp();
  const second = makeApp();
  const running = first.runAgent('worker', { sessionId: 'shared', input: 'first' });
  await started;
  try {
    // startAgent returns before completion, so a broken reservation cannot deadlock the test.
    await expect(second.startAgent('worker', { sessionId: 'shared', input: 'second' }))
      .rejects.toMatchObject({ code: 'RUN_CONFLICT' });
    await expect(second.compactSession('shared', 'summary')).rejects.toThrow();
    expect(calls).toBe(1);
  } finally {
    release();
    await running;
  }
  await second.runAgent('worker', { sessionId: 'shared', input: 'second' });
  expect((await store.getSession('shared'))?.history.map(({ content }) => content))
    .toEqual(['first', 'done', 'second', 'done']);
});

test('rejects a run prepared from history that changed before reservation', async () => {
  const store = new InMemoryRunStore();
  const now = new Date().toISOString();
  await store.saveSession({ id: 'stale', history: [], createdAt: now, updatedAt: now });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // Delay the store boundary after preparation to deterministically expose stale reads.
  const create = store.createExecution.bind(store);
  let delayed = true;
  store.createExecution = async (value) => {
    if (delayed) {
      delayed = false;
      entered();
      await gate;
    }
    return create(value);
  };
  let calls = 0;
  const makeApp = () => createFevex({
    runStore: store, agents: [agent('worker')],
    models: { default: { stream: streamFrom(() => { calls += 1; return { output: 'done' }; }) } },
  });
  const first = makeApp().runAgent('worker', { sessionId: 'stale', input: 'stale input' });
  const rejected = first.then(() => undefined, (error: unknown) => error);
  await started;
  try {
    await makeApp().runAgent('worker', { sessionId: 'stale', input: 'fresh input' });
  } finally {
    release();
  }
  expect(await rejected).toMatchObject({ code: 'RUN_CONFLICT' });
  expect(calls).toBe(1);
  expect((await store.getSession('stale'))!.history.map(({ content }) => content))
    .toEqual(['fresh input', 'done']);
});

test('keeps paused sessions reserved across runtimes until resume completes', async () => {
  const store = new InMemoryRunStore();
  const makeApp = () => createFevex({
    runStore: store,
    agents: [agent('worker', { tools: ['write'] })],
    tools: [defineTool({ name: 'write', approval: 'required', execute: () => 'saved' })],
    workflows: [defineWorkflow({ name: 'flow', async run() { return 'done'; } })],
    teams: [defineTeam({
      name: 'team', supervisor: 'worker', members: [{ agent: 'worker', role: 'worker' }],
      limits: { maxDelegations: 1, maxParallel: 1 },
      async run() { return 'done'; },
    })],
    models: { default: { stream: streamFrom((input) =>
      input.messages.some(({ role }) => role === 'tool')
        ? { output: 'done' }
        : { toolCalls: [{ id: 'write-1', name: 'write', input: {} }] }) } },
  });
  const first = makeApp();
  let paused!: RunPausedError;
  try {
    await first.runAgent('worker', { input: 'save' });
  } catch (error) {
    expect(error).toBeInstanceOf(RunPausedError);
    paused = error as RunPausedError;
  }
  const sessionId = (await store.getRun(paused.runId))!.sessionId;
  const second = makeApp();
  for (const start of [
    () => second.runAgent('worker', { sessionId, input: 'other' }),
    () => second.runWorkflow('flow', { sessionId, input: 'other' }),
    () => second.runTeam('team', { sessionId, input: 'other' }),
    () => second.compactSession(sessionId, 'summary'),
  ]) {
    await expect(start()).rejects.toMatchObject({ code: 'RUN_CONFLICT' });
  }
  if (paused.pause.type !== 'approval') throw new Error('Expected approval');
  await second.resumeRun(paused.runId, {
    type: 'approval', approvalId: paused.pause.approval.id,
    decision: 'approve', actor: { id: 'reviewer' },
  });
  const deadline = Date.now() + 1000;
  while ((await store.getRun(paused.runId))?.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect((await store.getRun(paused.runId))?.status).toBe('completed');
  await second.runWorkflow('flow', { sessionId, input: 'next' });
  await second.runTeam('team', { sessionId, input: 'next' });
  await second.compactSession(sessionId, 'summary');
  expect((await store.getSession(sessionId))!.history).toEqual([{ role: 'system', content: 'summary' }]);
});
