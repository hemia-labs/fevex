import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFevex,
  defineAgent,
  defineTool,
  defineTeam,
  defineWorkflow,
  RunPausedError,
  type JsonObject,
  type ModelGateway,
} from '@fevex/core';
import type { WorkflowCheckpoint } from '@fevex/core/runtime';
import { testRunStore } from '@fevex/core/testing';
import { createSQLiteRunStore, type SQLiteRunStore } from './index';

const toolCall = {
  id: 'sqlite-call',
  name: 'write',
  input: { value: 1 },
};

function model(): ModelGateway {
  return {
    stateCodec: {
      serialize: (state) => structuredClone(state) as { turn: number },
      restore: (state) => structuredClone(state),
    },
    async *stream(input) {
      const result = input.messages.some(({ role }) => role === 'tool')
        ? { output: 'done' }
        : { toolCalls: [toolCall], providerState: { turn: 1 } };
      if (result.output) yield { type: 'output.delta' as const, delta: result.output };
      yield { type: 'completed' as const, result };
    },
  };
}

function app(store: SQLiteRunStore, execute: Parameters<typeof defineTool>[0]['execute']) {
  return createFevex({
    models: { default: model() },
    agents: [
      defineAgent({
        name: 'worker',
        instructions: 'Work.',
        tools: ['write'],
      }),
    ],
    tools: [
      defineTool({
        name: 'write',
        approval: 'required',
        idempotency: 'keyed',
        execute,
      }),
    ],
    runStore: store,
  });
}

async function pause(store: SQLiteRunStore): Promise<RunPausedError> {
  let paused!: RunPausedError;
  await app(store, () => ({ ok: true }))
    .runAgent('worker', {
      input: 'start',
    })
    .catch((error) => {
      paused = error;
    });
  expect(paused).toBeInstanceOf(RunPausedError);
  return paused;
}

async function waitForCompletion(store: SQLiteRunStore, runId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while ((await store.getRun(runId))?.status !== 'completed') {
    if (Date.now() >= deadline) throw new Error('SQLite resumed run did not complete');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('SQLiteRunStore', () => {
  test('passes the durable store contract in memory', async () => {
    const store = createSQLiteRunStore({ filename: ':memory:' });
    try {
      await testRunStore(store);
    } finally {
      await store.close();
      await store.close();
    }
  });

  test('resumes from another process view and grants one concurrent lease', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fevex-sqlite-'));
    const filename = join(directory, 'runs.db');
    const firstStore = createSQLiteRunStore({ filename });
    let executions = 0;
    const keys: string[] = [];
    try {
      const paused = await pause(firstStore);
      const checkpoint = (await firstStore.getCheckpoint(paused.runId))!;
      const expectedKey = checkpoint.pendingTools[checkpoint.pendingIndex]!.idempotencyKey;
      expect(
        await firstStore.getSession((await firstStore.getRun(paused.runId))!.sessionId),
      ).toBeDefined();
      await firstStore.close();

      const storeA = createSQLiteRunStore({ filename });
      const storeB = createSQLiteRunStore({ filename });
      try {
        expect((await storeA.getCheckpoint(paused.runId))?.pendingTools[0]?.idempotencyKey).toBe(
          expectedKey,
        );
        const execute = (_input: unknown, context: { idempotencyKey: string }) => {
          executions += 1;
          keys.push(context.idempotencyKey);
          return { ok: true };
        };
        const runtimeA = app(storeA, execute);
        const runtimeB = app(storeB, execute);
        const approval = paused.pause.type === 'approval' ? paused.pause.approval : undefined;
        const resolution = {
          type: 'approval' as const,
          approvalId: approval!.id,
          decision: 'approve' as const,
          actor: { id: 'sqlite-test' },
        };
        const claims = await Promise.allSettled([
          runtimeA.resumeRun(paused.runId, resolution),
          runtimeB.resumeRun(paused.runId, resolution),
        ]);
        expect(claims.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        await waitForCompletion(storeA, paused.runId);

        expect(executions).toBe(1);
        expect(keys).toEqual([expectedKey]);
        expect(await storeA.getToolExecution(paused.runId, toolCall.id)).toMatchObject({
          status: 'completed',
          idempotencyKey: expectedKey,
        });
        const events = await storeA.listEvents(paused.runId);
        expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index + 1));
      } finally {
        await Promise.all([storeA.close(), storeB.close()]);
      }
    } finally {
      await firstStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('reuses a completed tool ledger entry after reopening the database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fevex-sqlite-'));
    const filename = join(directory, 'runs.db');
    const firstStore = createSQLiteRunStore({ filename });
    let executions = 0;
    try {
      const paused = await pause(firstStore);
      const run = (await firstStore.getRun(paused.runId))!;
      const checkpoint = (await firstStore.getCheckpoint(paused.runId))!;
      const pending = checkpoint.pendingTools[checkpoint.pendingIndex]!;
      expect(
        await firstStore.commitExecution({
          expectedRevision: run.revision,
          run,
          toolExecution: {
            runId: run.id,
            toolCallId: pending.call.id,
            toolName: pending.call.name,
            input: pending.input,
            status: 'completed',
            attempt: 1,
            idempotencyKey: pending.idempotencyKey,
            output: 'already-done',
            updatedAt: new Date().toISOString(),
          },
        }),
      ).toBe(true);
      await firstStore.close();

      const secondStore = createSQLiteRunStore({ filename });
      try {
        const runtime = app(secondStore, () => {
          executions += 1;
          return 'executed';
        });
        const approval = paused.pause.type === 'approval' ? paused.pause.approval : undefined;
        await runtime.resumeRun(run.id, {
          type: 'approval',
          approvalId: approval!.id,
          decision: 'approve',
          actor: { id: 'sqlite-test' },
        });
        await waitForCompletion(secondStore, run.id);
        expect(executions).toBe(0);
        expect((await secondStore.getRun(run.id))?.output).toBe('done');
      } finally {
        await secondStore.close();
      }
    } finally {
      await firstStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('persists workflow waits, compensation state and inherited budget across reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fevex-sqlite-'));
    const filename = join(directory, 'runs.db');
    const firstStore = createSQLiteRunStore({ filename });
    const workflow = defineWorkflow({
      name: 'durable-wait-flow',
      limits: { maxOutputTokens: 5 },
      events: { release: {} },
      async run(step, input) {
        await step.agent('write', 'writer', { input }, { compensate() {} });
        const event = await step.waitForEvent<JsonObject>('release', 'release');
        return (await step.agent('finish', 'finisher', { input: event.payload })).output;
      },
    });
    const makeRuntime = (store: SQLiteRunStore) =>
      createFevex({
        models: {
          default: {
            stream: async function* (input) {
              const output = input.messages[0]!.content;
              yield { type: 'output.delta' as const, delta: output };
              yield {
                type: 'completed' as const,
                result: { output, usage: { inputTokens: 1, outputTokens: 2 } },
              };
            },
          },
        },
        agents: [
          defineAgent({ name: 'writer', instructions: 'written' }),
          defineAgent({ name: 'finisher', instructions: 'finished' }),
        ],
        workflows: [workflow],
        runStore: store,
      });

    try {
      let paused!: RunPausedError;
      await makeRuntime(firstStore).runWorkflow('durable-wait-flow', { input: 'go' }).catch(
        (error) => {
          paused = error as RunPausedError;
        },
      );
      expect(paused.pause).toMatchObject({ type: 'workflow_event', eventName: 'release' });
      const checkpoint = (await firstStore.getCheckpoint<WorkflowCheckpoint>(paused.runId))!;
      expect(checkpoint.steps.write).toMatchObject({
        type: 'agent',
        status: 'completed',
        compensation: { status: 'pending' },
      });
      expect(checkpoint.steps.release).toMatchObject({
        type: 'wait',
        status: 'running',
        wait: { type: 'event', eventName: 'release' },
      });
      expect(checkpoint.budget).toMatchObject({
        usage: { inputTokens: 1, outputTokens: 2 },
        steps: 1,
      });
      expect(await firstStore.getRun(paused.runId)).toMatchObject({
        status: 'paused',
        usage: { inputTokens: 1, outputTokens: 2 },
      });
      await firstStore.close();

      const secondStore = createSQLiteRunStore({ filename });
      try {
        await makeRuntime(secondStore).resumeRun(paused.runId, {
          type: 'event',
          eventName: 'release',
          payload: { ok: true },
        });
        await waitForCompletion(secondStore, paused.runId);
        expect(await secondStore.getRun(paused.runId)).toMatchObject({
          status: 'completed',
          output: 'finished',
        });
      } finally {
        await secondStore.close();
      }
    } finally {
      await firstStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('persists team runs without a schema migration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fevex-sqlite-'));
    const filename = join(directory, 'runs.db');
    const firstStore = createSQLiteRunStore({ filename });
    const team = defineTeam({
      name: 'sqlite-team',
      supervisor: 'worker',
      members: [],
      async run(step, input) {
        return (await step.delegate('work', { agent: 'worker', task: input })).output;
      },
    });
    try {
      const runtime = createFevex({
        models: {
          default: {
            async *stream() {
              yield { type: 'output.delta' as const, delta: 'done' };
              yield { type: 'completed' as const, result: { output: 'done' } };
            },
          },
        },
        agents: [defineAgent({ name: 'worker', instructions: 'Work.' })],
        teams: [team],
        runStore: firstStore,
      });
      const result = await runtime.runTeam('sqlite-team', { input: 'go' });
      await firstStore.close();

      const secondStore = createSQLiteRunStore({ filename });
      try {
        expect(await secondStore.getRun(result.runId)).toMatchObject({
          kind: 'team',
          teamName: 'sqlite-team',
          status: 'completed',
          output: 'done',
        });
        expect((await secondStore.listEvents(result.runId)).at(-1)?.type).toBe(
          'team.run.completed',
        );
      } finally {
        await secondStore.close();
      }
    } finally {
      await firstStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
