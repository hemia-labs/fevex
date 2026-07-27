import { describe, expect, test } from 'bun:test';
import {
  createFevex,
  defineAgent,
  defineTool,
  RunPausedError,
  type ModelGateway,
} from '@fevex/core';
import { testRunStore } from '@fevex/core/testing';
import { createPostgresRunStore } from './index';

const connectionString = process.env.FEVEX_POSTGRES_URL;
const integration = connectionString ? describe : describe.skip;

integration('PostgresRunStore', () => {
  test('passes the durable store contract', async () => {
    const store = createPostgresRunStore({ connectionString: connectionString! });
    try {
      await store.migrate();
      await testRunStore(store);
    } finally {
      await store.close();
    }
  });

  test('resumes from a second runtime and deduplicates concurrent approval', async () => {
    const firstStore = createPostgresRunStore({ connectionString: connectionString! });
    const secondStore = createPostgresRunStore({ connectionString: connectionString! });
    await firstStore.migrate();
    let executions = 0;
    const model = (): ModelGateway => ({
      stateCodec: {
        serialize: (state) => structuredClone(state) as { turn: number },
        restore: (state) => structuredClone(state),
      },
      async *stream(input) {
        const result =
          input.providerState === undefined
            ? {
                toolCalls: [{ id: 'postgres-call', name: 'write', input: { value: 1 } }],
                providerState: { turn: 1 },
              }
            : { output: 'done' };
        if (result.output) yield { type: 'output.delta' as const, delta: result.output };
        yield { type: 'completed' as const, result };
      },
    });
    const create = (store: typeof firstStore) =>
      createFevex({
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
            execute() {
              executions += 1;
              return { ok: true };
            },
          }),
        ],
        runStore: store,
      });
    try {
      const first = create(firstStore);
      let paused!: RunPausedError;
      await first.runAgent('worker', { input: 'start' }).catch((error) => {
        paused = error;
      });
      expect(paused).toBeInstanceOf(RunPausedError);
      const approval = paused.pause.type === 'approval' ? paused.pause.approval : undefined;
      const runtimeA = create(firstStore);
      const runtimeB = create(secondStore);
      const resolution = {
        type: 'approval' as const,
        approvalId: approval!.id,
        decision: 'approve' as const,
        actor: { id: 'postgres-test' },
      };
      const claims = await Promise.allSettled([
        runtimeA.resumeRun(paused.runId, resolution),
        runtimeB.resumeRun(paused.runId, resolution),
      ]);
      expect(claims.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);

      const deadline = Date.now() + 5_000;
      while ((await firstStore.getRun(paused.runId))?.status !== 'completed') {
        if (Date.now() >= deadline) throw new Error('PostgreSQL resumed run did not complete');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(executions).toBe(1);
      expect((await firstStore.getRun(paused.runId))?.output).toBe('done');
    } finally {
      await Promise.all([firstStore.close(), secondStore.close()]);
    }
  });
});
