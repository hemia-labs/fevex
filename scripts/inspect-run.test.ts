import { expect, test } from 'bun:test';
import { createFevex, defineAgent, RunPausedError } from '@fevex/core';
import { createFevexHttpHandler, type FevexHttpFetch } from '@fevex/core/http';
import { fakeModel } from '@fevex/core/testing';
import { inspectRun } from './inspect-run';

test('inspects completed and paused runs through read-only public HTTP APIs without content', async () => {
  const app = createFevex({
    models: { demo: fakeModel(
      { output: 'private output' },
      { toolCalls: [{ id: 'ask', name: 'fevex__elicit', input: {
        prompt: 'private prompt', responseSchema: { type: 'object' },
      } }] },
    ) },
    agents: [defineAgent({ name: 'demo', model: 'demo', instructions: 'private instructions', elicitation: 'pause' })],
  });
  const completed = await app.runAgent('demo', { input: 'private input' });
  const handler = createFevexHttpHandler({ fevex: app, pollIntervalMs: 1 });
  const methods: string[] = [];
  const fetchImpl: FevexHttpFetch = (input, init) => {
    const request = new Request(input, init);
    methods.push(request.method);
    return handler(request);
  };
  const lines: string[] = [];
  await inspectRun([completed.runId, '--api', 'http://local', '--events'], fetchImpl, (line) => lines.push(line));
  expect(JSON.parse(lines[0]!).run.status).toBe('completed');
  expect(lines.some((line) => JSON.parse(line).event?.type === 'run.completed')).toBe(true);
  expect(lines.join('\n')).not.toContain('private');
  expect(methods.every((method) => method === 'GET')).toBe(true);
  const lastEvent = (await app.listEvents(completed.runId)).at(-1)!;
  const after: string[] = [];
  await inspectRun([completed.runId, '--api', 'http://local', '--events', '--after', lastEvent.id], fetchImpl, (line) => after.push(line));
  expect(after).toHaveLength(2);
  let pausedId = '';
  try {
    await app.runAgent('demo', { input: 'private input' });
  } catch (error) {
    if (!(error instanceof RunPausedError)) throw error;
    pausedId = error.runId;
  }
  const paused: string[] = [];
  await inspectRun([pausedId, '--api', 'http://local', '--events'], fetchImpl, (line) => paused.push(line));
  expect(JSON.parse(paused[0]!).run).toMatchObject({ status: 'paused', pauseType: 'elicitation' });
  expect(paused.join('\n')).not.toContain('private');
  expect((await app.getRun(pausedId))?.status).toBe('paused');
});

test('validates arguments before fetching and provides help without a host', async () => {
  let calls = 0;
  const fetchImpl: FevexHttpFetch = async () => { calls += 1; throw new Error('Unexpected fetch'); };
  for (const args of [[], ['one', 'two'], ['run', '--after', 'event'], ['run', '--timeout-ms', '0'],
    ['run', '--api', 'file:///tmp'], ['run', '--api', 'http://user:password@local']]) {
    await expect(inspectRun(args, fetchImpl)).rejects.toBeInstanceOf(TypeError);
  }
  const help: string[] = [];
  await inspectRun(['--help'], fetchImpl, (line) => help.push(line));
  expect(help[0]).toContain('RUN_ID');
  expect(calls).toBe(0);
});

test('bounds stalled network reads and preserves public protocol errors', async () => {
  const stalled: FevexHttpFetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  });
  await expect(inspectRun(['run', '--timeout-ms', '5'], stalled)).rejects.toMatchObject({ name: 'TimeoutError' });
  const app = createFevex({ models: {}, agents: [] });
  const handler = createFevexHttpHandler({ fevex: app });
  await expect(inspectRun(['missing', '--api', 'http://local'], (input, init) => handler(new Request(input, init))))
    .rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
});
