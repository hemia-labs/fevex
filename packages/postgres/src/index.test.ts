import { describe, expect, test } from 'bun:test';
import {
  createFevex,
  defineAgent,
  defineTool,
  defineTeam,
  RunPausedError,
  type ModelGateway,
} from '@fevex/core';
import { testRunStore } from '@fevex/core/testing';
import type {
  AgentRun,
  RunCheckpoint,
  Session,
  ToolExecutionRecord,
} from '@fevex/core/runtime';
import { createPostgresRunStore } from './index';
import { createFakePool } from './fake-pool';

const connectionString = process.env.FEVEX_POSTGRES_URL;
const integration = connectionString ? describe : describe.skip;

const now = new Date().toISOString();

function buildRun(id: string): AgentRun {
  return {
    id,
    sessionId: `${id}-session`,
    agentName: 'worker',
    status: 'running',
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function buildSession(id: string): Session {
  return { id: `${id}-session`, history: [], createdAt: now, updatedAt: now };
}

function buildCheckpoint(id: string): RunCheckpoint {
  return {
    version: 2,
    runId: id,
    definitionHash: 'hash',
    messages: [{ role: 'user', content: 'input' }],
    inputContent: 'input',
    step: 1,
    toolCallCount: 0,
    seenToolCallIds: [],
    pendingTools: [],
    pendingIndex: 0,
  };
}

function buildLease(id: string) {
  return {
    runId: id,
    ownerId: `${id}-owner`,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

function buildEvent(id: string, sequence: number) {
  return {
    id: `${id}-event-${sequence}`,
    sequence,
    type: 'run.started' as const,
    runId: id,
    timestamp: now,
  };
}

/**
 * Runs against an in-memory stand-in for `pg.Pool`. This covers how the store
 * reacts to PostgreSQL responses; the `FEVEX_POSTGRES_URL` suite below remains
 * the source of truth for PostgreSQL actually producing them.
 */
describe('PostgresRunStore (fake pool)', () => {
  test('passes the durable store contract', async () => {
    const pool = createFakePool();
    const store = createPostgresRunStore({ pool });
    await store.migrate();
    await testRunStore(store);
    expect(pool.leakedClients).toBe(0);
  });

  test('applies the migration and stays idempotent', async () => {
    const pool = createFakePool();
    const store = createPostgresRunStore({ pool });
    await store.migrate();
    await store.migrate();
    const run = buildRun('migrate-run');
    await store.saveRun(run);
    expect(await store.getRun('migrate-run')).toMatchObject({ id: 'migrate-run' });
  });

  test('close does not end an injected pool', async () => {
    const pool = createFakePool();
    const store = createPostgresRunStore({ pool });
    await store.close();
    expect(pool.ended).toBe(false);
    await store.saveRun(buildRun('after-close'));
    expect(await store.getRun('after-close')).toBeDefined();
  });

  test('rolls back and reports false when the run id already exists', async () => {
    const pool = createFakePool();
    const store = createPostgresRunStore({ pool });
    const create = {
      run: buildRun('duplicate-run'),
      session: buildSession('duplicate-run'),
      checkpoint: buildCheckpoint('duplicate-run'),
      lease: buildLease('duplicate-run'),
      events: [buildEvent('duplicate-run', 1)],
    };
    expect(await store.createExecution(create)).toBe(true);

    const second = {
      ...create,
      run: buildRun('duplicate-run'),
      events: [buildEvent('duplicate-run', 2)],
    };
    expect(await store.createExecution(second)).toBe(false);
    expect(pool.statements).toContain('ROLLBACK');
    expect(await store.listEvents('duplicate-run')).toHaveLength(1);
    expect(pool.leakedClients).toBe(0);
  });

  test('rolls back and rethrows when a statement inside the transaction fails', async () => {
    const pool = createFakePool();
    const store = createPostgresRunStore({ pool });
    pool.failNext('INSERT INTO fevex.checkpoints');
    await expect(
      store.createExecution({
        run: buildRun('failing-run'),
        session: buildSession('failing-run'),
        checkpoint: buildCheckpoint('failing-run'),
        lease: buildLease('failing-run'),
        events: [buildEvent('failing-run', 1)],
      }),
    ).rejects.toThrow(/Fake PostgreSQL failure/);
    expect(pool.statements).toContain('ROLLBACK');
    expect(await store.getRun('failing-run')).toBeUndefined();
    expect(pool.leakedClients).toBe(0);
  });

  test('commits session, checkpoint, tool ledger and events atomically', async () => {
    const pool = createFakePool();
    const store = createPostgresRunStore({ pool });
    const run = buildRun('commit-run');
    const session = buildSession('commit-run');
    await store.createExecution({
      run,
      session,
      checkpoint: buildCheckpoint('commit-run'),
      lease: buildLease('commit-run'),
      events: [buildEvent('commit-run', 1)],
    });

    session.history.push({ role: 'system', content: 'committed' });
    const toolExecution: ToolExecutionRecord = {
      runId: 'commit-run',
      toolCallId: 'call-1',
      toolName: 'lookup',
      input: { query: 'value' },
      status: 'completed',
      attempt: 1,
      idempotencyKey: 'key-1',
      output: { answer: 'ok' },
      updatedAt: now,
    };
    expect(
      await store.commitExecution({
        expectedRevision: 1,
        run,
        session,
        checkpoint: buildCheckpoint('commit-run'),
        toolExecution,
        events: [buildEvent('commit-run', 2)],
      }),
    ).toBe(true);
    expect(run.revision).toBe(2);
    expect((await store.getSession('commit-run-session'))?.history).toHaveLength(1);
    expect(await store.getToolExecution('commit-run', 'call-1')).toMatchObject({
      status: 'completed',
    });
    expect(await store.listEvents('commit-run')).toHaveLength(2);
  });

  test('rejects a stale revision without writing anything', async () => {
    const pool = createFakePool();
    const store = createPostgresRunStore({ pool });
    const run = buildRun('stale-run');
    await store.createExecution({
      run,
      checkpoint: buildCheckpoint('stale-run'),
      lease: buildLease('stale-run'),
      events: [buildEvent('stale-run', 1)],
    });

    expect(
      await store.commitExecution({
        expectedRevision: 0,
        run: { ...run, status: 'failed' },
        events: [buildEvent('stale-run', 2)],
      }),
    ).toBe(false);
    expect((await store.getRun('stale-run'))?.status).toBe('running');
    expect(await store.listEvents('stale-run')).toHaveLength(1);
    expect(pool.leakedClients).toBe(0);
  });

  test('rejects a commit for a run that does not exist', async () => {
    const store = createPostgresRunStore({ pool: createFakePool() });
    expect(
      await store.commitExecution({ expectedRevision: 0, run: buildRun('ghost-run') }),
    ).toBe(false);
  });

  test('returns undefined for unknown ids', async () => {
    const store = createPostgresRunStore({ pool: createFakePool() });
    expect(await store.getRun('unknown')).toBeUndefined();
    expect(await store.getSession('unknown')).toBeUndefined();
    expect(await store.getCheckpoint('unknown')).toBeUndefined();
    expect(await store.getToolExecution('unknown', 'call')).toBeUndefined();
  });

  // Guards the property that keeps this fake honest: if a statement in the
  // store changes, the fake must fail loudly instead of returning an empty
  // result and turning a regression green.
  test('rejects SQL it does not recognise', async () => {
    const pool = createFakePool();
    await expect(pool.query('SELECT 1')).rejects.toThrow(/Unhandled SQL/);
  });

  test('rejects statements on a released client', async () => {
    const pool = createFakePool();
    const client = await pool.connect();
    client.release();
    await expect(client.query('BEGIN')).rejects.toThrow(/after calling release/);
    expect(pool.leakedClients).toBe(0);
  });

  test('rejects malformed options', () => {
    expect(() => createPostgresRunStore({ connectionString: '  ' })).toThrow(TypeError);
    expect(() =>
      createPostgresRunStore(null as unknown as { connectionString: string }),
    ).toThrow(TypeError);
  });
});

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

  test('persists team runs without a schema migration', async () => {
    const store = createPostgresRunStore({ connectionString: connectionString! });
    try {
      await store.migrate();
      const app = createFevex({
        models: {
          default: {
            async *stream() {
              yield { type: 'output.delta' as const, delta: 'done' };
              yield { type: 'completed' as const, result: { output: 'done' } };
            },
          },
        },
        agents: [defineAgent({ name: 'worker', instructions: 'Work.' })],
        teams: [
          defineTeam({
            name: 'postgres-team',
            supervisor: 'worker',
            members: [],
            async run(step, input) {
              return (
                await step.delegate('work', { agent: 'worker', task: input })
              ).output;
            },
          }),
        ],
        runStore: store,
      });
      const result = await app.runTeam('postgres-team', { input: 'go' });
      expect(await store.getRun(result.runId)).toMatchObject({
        kind: 'team',
        teamName: 'postgres-team',
        status: 'completed',
      });
    } finally {
      await store.close();
    }
  });
});
