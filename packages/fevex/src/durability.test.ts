import { describe, expect, test } from 'bun:test';
import { type JsonObject, type ToolCall } from './core';
import type { ModelGateway, ModelInput } from './models';
import {
  createFevex,
  defineTool,
  defineWorkflow,
  FevexRunError,
  InMemoryRunStore,
  RunPausedError,
  type RunCheckpoint,
  type StoredRunCheckpoint,
  type WorkflowDefinition,
} from './index';
import {
  agent,
  lookupCall,
  modelWithOutput,
  streamFrom,
} from './test-fixtures';

describe('durable runs', () => {
  test('persists runs and continues or compacts session history', async () => {
    const calls: ModelInput[] = [];
    const outputs = ['first answer', 'second answer', 'third answer'];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            calls.push(input);
            return { output: outputs[calls.length - 1] };
          }),
        },
      },
      agents: [agent('assistant')],
    });

    const first = await app.runAgent<string, string>('assistant', { input: 'first question' });
    expect(first.runId).not.toBe(first.sessionId);
    await expect(app.getRun(first.runId)).resolves.toMatchObject({
      id: first.runId,
      sessionId: first.sessionId,
      agentName: 'assistant',
      status: 'completed',
      output: 'first answer',
    });

    const firstEvents = await app.listEvents(first.runId);
    expect(firstEvents.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
    await expect(app.listEvents(first.runId, { after: firstEvents[1]!.id })).resolves.toEqual(
      firstEvents.slice(2),
    );

    const second = await app.runAgent<string, string>('assistant', {
      input: 'second question',
      sessionId: first.sessionId,
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(calls[1]?.messages).toEqual([
      { role: 'system', content: 'Answer clearly.' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]);
    await expect(
      app.listEvents(first.runId, {
        after: (await app.listEvents(second.runId))[0]!.id,
      }),
    ).rejects.toThrow(/does not exist in run/);

    const compacted = await app.compactSession(first.sessionId, 'The user asked two questions.');
    expect(compacted.history).toEqual([
      { role: 'system', content: 'The user asked two questions.' },
    ]);
    await app.runAgent('assistant', {
      input: 'third question',
      sessionId: first.sessionId,
    });
    expect(calls[2]?.messages).toEqual([
      { role: 'system', content: 'Answer clearly.' },
      { role: 'system', content: 'The user asked two questions.' },
      { role: 'user', content: 'third question' },
    ]);

    await expect(
      app.runAgent('assistant', {
        input: 'unknown',
        sessionId: 'missing-session',
      }),
    ).rejects.toThrow('Session "missing-session" does not exist');
    await expect(app.compactSession(first.sessionId, '  ')).rejects.toThrow(
      'Session summary must be a non-empty string',
    );
  });

  test('starts, cancels and releases a consultable background run', async () => {
    const calls: ModelInput[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    let finishModel!: (value: { output: string }) => void;
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            calls.push(input);
            if (calls.length > 1) return { output: 'continued' };
            markStarted();
            return new Promise<{ output: string }>((resolve) => {
              finishModel = resolve;
            });
          }),
        },
      },
      agents: [agent('assistant')],
      onEvent(event) {
        if (event.type === 'run.cancelled') markCancelled();
      },
    });

    const run = await app.startAgent('assistant', { input: 'cancelled question' });
    expect(run).toMatchObject({ status: 'running', agentName: 'assistant' });
    await started;
    await expect(app.getRun(run.id)).resolves.toMatchObject({ status: 'running' });
    await expect(
      app.runAgent('assistant', {
        input: 'concurrent',
        sessionId: run.sessionId,
      }),
    ).rejects.toThrow(`Session "${run.sessionId}" already has an active run`);
    await expect(app.compactSession(run.sessionId, 'summary')).rejects.toThrow(
      `Session "${run.sessionId}" has an active run`,
    );

    await expect(app.cancelRun(run.id)).resolves.toBe(true);
    await cancelled;
    await expect(app.getRun(run.id)).resolves.toMatchObject({
      status: 'cancelled',
      error: 'aborted',
    });
    expect((await app.listEvents(run.id)).at(-1)).toMatchObject({
      type: 'run.cancelled',
      payload: { reason: 'aborted' },
    });
    await expect(app.cancelRun(run.id)).resolves.toBe(false);
    await expect(app.cancelRun('missing-run')).resolves.toBe(false);

    await app.runAgent('assistant', {
      input: 'continued question',
      sessionId: run.sessionId,
    });
    expect(calls[1]?.messages).toEqual([
      { role: 'system', content: 'Answer clearly.' },
      { role: 'user', content: 'continued question' },
    ]);
    finishModel({ output: 'late' });
  });

  test('captures background failures and persists abandoned streams', async () => {
    const providerError = new Error('background failed');
    const calls: ModelInput[] = [];
    let markFailed!: () => void;
    const failed = new Promise<void>((resolve) => {
      markFailed = resolve;
    });
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            calls.push(input);
            if (calls.length > 1) return { output: 'recovered' };
            throw providerError;
          }),
        },
      },
      agents: [agent('assistant')],
      onEvent(event) {
        if (event.type === 'run.failed') markFailed();
      },
    });
    const background = await app.startAgent('assistant', { input: 'fail' });
    await failed;
    await expect(app.getRun(background.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'background failed',
    });
    await app.runAgent('assistant', {
      input: 'recover',
      sessionId: background.sessionId,
    });
    expect(calls[1]?.messages).toEqual([
      { role: 'system', content: 'Answer clearly.' },
      { role: 'user', content: 'recover' },
    ]);

    const streamApp = createFevex({
      models: { default: modelWithOutput('unused') },
      agents: [agent('assistant')],
    });
    const iterator = streamApp
      .streamAgent('assistant', { input: 'abandon' })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toMatchObject({ done: false, value: { type: 'run.started' } });
    const runId = first.value!.runId;
    await iterator.return?.();
    await expect(streamApp.getRun(runId)).resolves.toMatchObject({ status: 'cancelled' });
    expect((await streamApp.listEvents(runId)).map(({ type }) => type)).toEqual([
      'run.started',
      'run.cancelled',
    ]);
  });

  test('uses a configured RunStore and protects in-memory snapshots', async () => {
    let savedRuns = 0;
    let savedSessions = 0;
    let appendedEvents = 0;
    let commits = 0;
    class TrackingRunStore extends InMemoryRunStore {
      creates = 0;

      override async createExecution(
        ...args: Parameters<InMemoryRunStore['createExecution']>
      ): Promise<boolean> {
        this.creates += 1;
        return super.createExecution(...args);
      }

      override async saveRun(...args: Parameters<InMemoryRunStore['saveRun']>): Promise<void> {
        savedRuns += 1;
        await super.saveRun(...args);
      }

      override async saveSession(
        ...args: Parameters<InMemoryRunStore['saveSession']>
      ): Promise<void> {
        savedSessions += 1;
        await super.saveSession(...args);
      }

      override async appendEvent(
        ...args: Parameters<InMemoryRunStore['appendEvent']>
      ): Promise<void> {
        appendedEvents += 1;
        await super.appendEvent(...args);
      }

      override async commitExecution(
        ...args: Parameters<InMemoryRunStore['commitExecution']>
      ): Promise<boolean> {
        commits += 1;
        return super.commitExecution(...args);
      }
    }
    const runStore = new TrackingRunStore();
    const app = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('assistant')],
      runStore,
    });

    const result = await app.runAgent('assistant', { input: 'hello' });
    expect(runStore.creates).toBe(1);
    expect(savedRuns).toBe(0);
    expect(savedSessions).toBe(0);
    expect(appendedEvents).toBe(0);
    expect(commits).toBe(4);

    const snapshot = await runStore.getRun(result.runId);
    snapshot!.status = 'failed';
    await expect(runStore.getRun(result.runId)).resolves.toMatchObject({ status: 'completed' });
  });

  test('pauses for elicitation and resumes from another runtime', async () => {
    const store = new InMemoryRunStore();
    const calls: ModelInput[] = [];
    const elicitationCall: ToolCall = {
      id: 'elicit-1',
      name: 'fevex__elicit',
      input: {
        prompt: 'Which account should I use?',
        responseSchema: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
          additionalProperties: false,
        },
      },
    };
    const configuredModel = (): ModelGateway => ({
      stream: streamFrom(async (input) => {
        calls.push(input);
        return input.messages.some(
          (message) => message.role === 'tool' && message.toolCallId === 'elicit-1',
        )
          ? { output: 'using account-42' }
          : { toolCalls: [elicitationCall] };
      }),
    });
    const makeApp = () =>
      createFevex({
        models: { default: configuredModel(), alternate: configuredModel() },
        agents: [agent('assistant', { elicitation: 'pause' })],
        runStore: store,
      });

    let paused!: RunPausedError;
    await makeApp().runAgent('assistant', { input: 'hello', model: 'alternate' }).catch((error) => {
      paused = error as RunPausedError;
    });

    expect(paused).toBeInstanceOf(RunPausedError);
    expect(paused.pause).toMatchObject({
      type: 'elicitation',
      request: {
        toolCallId: 'elicit-1',
        prompt: 'Which account should I use?',
      },
    });
    expect(calls[0]?.tools?.map(({ name }) => name)).toContain('fevex__elicit');
    const elicitTool = calls[0]?.tools?.find(({ name }) => name === 'fevex__elicit');
    const elicitInputSchema = elicitTool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(elicitTool?.description).toContain('responseSchema property titles');
    expect(elicitInputSchema?.properties?.responseSchema).toMatchObject({
      description: expect.stringContaining('short title'),
    });

    const legacyRun = (await store.getRun(paused.runId))!;
    const legacyCheckpoint = (await store.getCheckpoint<RunCheckpoint>(paused.runId))!;
    delete legacyCheckpoint.modelName;
    expect(await store.commitExecution({
      expectedRevision: legacyRun.revision,
      run: legacyRun,
      checkpoint: legacyCheckpoint,
    })).toBe(true);

    const second = makeApp();
    await second.resumeRun(paused.runId, {
      type: 'elicitation',
      requestId: paused.pause.type === 'elicitation' ? paused.pause.request.id : '',
      value: { accountId: 'account-42' },
      actor: { id: 'user-1', type: 'user' },
    });
    await Bun.sleep(5);

    expect(await second.getRun(paused.runId)).toMatchObject({
      status: 'completed',
      output: 'using account-42',
    });
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      name: 'fevex__elicit',
      toolCallId: 'elicit-1',
      content: '{"accountId":"account-42"}',
    });
    expect((await second.listEvents(paused.runId)).map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.completed',
      'elicitation.requested',
      'run.paused',
      'elicitation.resolved',
      'run.resumed',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ]);
  });

  test('forbids elicitation by default', async () => {
    const calls: ModelInput[] = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            calls.push(input);
            return { output: 'done' };
          }),
        },
      },
      agents: [agent('assistant')],
    });

    await app.runAgent('assistant', { input: 'hello' });

    expect(calls[0]?.tools?.some(({ name }) => name === 'fevex__elicit') ?? false).toBe(false);
  });

  test('rejects invalid elicitation resolutions without resuming', async () => {
    const store = new InMemoryRunStore();
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) =>
            input.messages.some(({ role }) => role === 'tool')
              ? { output: 'done' }
              : {
                  toolCalls: [{
                    id: 'elicit-1',
                    name: 'fevex__elicit',
                    input: {
                      prompt: 'Account?',
                      responseSchema: {
                        type: 'object',
                        properties: { accountId: { type: 'string' } },
                        required: ['accountId'],
                        additionalProperties: false,
                      },
                    },
                  }],
                },
          ),
        },
      },
      agents: [agent('assistant', { elicitation: 'pause' })],
      runStore: store,
    });

    let paused!: RunPausedError;
    await app.runAgent('assistant', { input: 'hello' }).catch((error) => {
      paused = error as RunPausedError;
    });
    const requestId = paused.pause.type === 'elicitation' ? paused.pause.request.id : '';

    await expect(
      app.resumeRun(paused.runId, {
        type: 'elicitation',
        requestId,
        value: { accountId: 42 },
        actor: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ code: 'ELICITATION_INVALID' });
    await expect(
      app.resumeRun(paused.runId, {
        type: 'elicitation',
        requestId: 'wrong',
        value: { accountId: 'account-42' },
        actor: { id: 'user-1' },
      }),
    ).rejects.toMatchObject({ code: 'ELICITATION_INVALID' });
    expect(await app.getRun(paused.runId)).toMatchObject({ status: 'paused' });
  });

  test('passes toolChoice and denies approvals in autonomous mode', async () => {
    const calls: ModelInput[] = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            calls.push(input);
            return { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [
        agent('assistant', {
          tools: ['lookup'],
          toolChoice: 'required',
          approvalMode: 'deny',
        }),
      ],
      tools: [
        defineTool({
          name: 'lookup',
          approval: 'required',
          execute() {
            throw new Error('must not execute');
          },
        }),
      ],
    });

    await expect(app.runAgent('assistant', { input: 'hello' })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      message: 'Tool "lookup" requires approval but approvalMode is "deny"',
    });
    expect(calls[0]?.toolChoice).toBe('required');
  });

  test('pauses for approval and resumes from another runtime', async () => {
    const store = new InMemoryRunStore();
    let executions = 0;
    const configuredModel = (): ModelGateway => ({
      stateCodec: {
        serialize(state) {
          return structuredClone(state) as JsonObject;
        },
        restore(state) {
          return structuredClone(state);
        },
      },
      stream: streamFrom(async (input) => {
        if (input.providerState === undefined) {
          return {
            toolCalls: [lookupCall],
            providerState: { turn: 1 },
          };
        }
        expect(input.providerState).toEqual({ turn: 1 });
        return { output: 'approved' };
      }),
    });
    const configuredTool = () =>
      defineTool({
        name: 'lookup',
        label: 'Lookup account',
        risk: 'write',
        approval: 'required',
        idempotency: 'keyed',
        execute(_input, context) {
          executions += 1;
          expect(context.attempt).toBe(1);
          expect(context.idempotencyKey).toBeTruthy();
          return 'found';
        },
      });
    const first = createFevex({
      models: { default: configuredModel() },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [configuredTool()],
      runStore: store,
    });

    let paused!: RunPausedError;
    try {
      await first.runAgent('assistant', { input: 'hello' });
    } catch (error) {
      expect(error).toBeInstanceOf(RunPausedError);
      paused = error as RunPausedError;
    }
    expect(paused.pause.type).toBe('approval');
    expect(executions).toBe(0);
    expect(paused.pause.type === 'approval' ? paused.pause.approval : undefined).toMatchObject({
      toolName: 'lookup',
      toolLabel: 'Lookup account',
    });

    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const second = createFevex({
      models: { default: configuredModel() },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [configuredTool()],
      runStore: store,
      onEvent(event) {
        if (event.runId === paused.runId && event.type === 'run.completed') complete();
      },
    });
    const pause = paused.pause.type === 'approval' ? paused.pause.approval : undefined;
    expect(pause).toBeDefined();
    await second.resumeRun(paused.runId, {
      type: 'approval',
      approvalId: pause!.id,
      decision: 'approve',
      actor: { id: 'reviewer-1' },
    });
    await completed;

    expect(await second.getRun(paused.runId)).toMatchObject({
      status: 'completed',
      output: 'approved',
    });
    expect(executions).toBe(1);
    expect((await second.listEvents(paused.runId)).map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'model.completed',
      'approval.requested',
      'run.paused',
      'run.resumed',
      'approval.resolved',
      'tool.started',
      'tool.completed',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ]);
    expect(
      (await second.listEvents(paused.runId)).find((event) => event.type === 'approval.requested')?.payload,
    ).toMatchObject({
      toolName: 'lookup',
      toolLabel: 'Lookup account',
    });
  });

  test('rejects an approval once and cancels paused runs with terminal events', async () => {
    const store = new InMemoryRunStore();
    const makeApp = () =>
      createFevex({
        models: {
          default: {
            stream: streamFrom(async () => {
              return { toolCalls: [lookupCall] };
            }),
          },
        },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [
          defineTool({
            name: 'lookup',
            approval: 'required',
            execute() {
              throw new Error('must not execute');
            },
          }),
        ],
        runStore: store,
      });
    const first = makeApp();
    let firstPause!: RunPausedError;
    await first.runAgent('assistant', { input: 'one' }).catch((error) => {
      firstPause = error;
    });
    const approval = firstPause.pause.type === 'approval' ? firstPause.pause.approval : undefined;
    const rejected = await makeApp().resumeRun(firstPause.runId, {
      type: 'approval',
      approvalId: approval!.id,
      decision: 'reject',
      actor: { id: 'reviewer' },
    });
    expect(rejected.status).toBe('cancelled');
    expect((await first.listEvents(firstPause.runId)).map(({ type }) => type).slice(-2)).toEqual([
      'approval.resolved',
      'run.cancelled',
    ]);
    await expect(
      makeApp().resumeRun(firstPause.runId, {
        type: 'approval',
        approvalId: approval!.id,
        decision: 'approve',
        actor: { id: 'reviewer' },
      }),
    ).rejects.toBeInstanceOf(FevexRunError);

    let secondPause!: RunPausedError;
    await first.runAgent('assistant', { input: 'two' }).catch((error) => {
      secondPause = error;
    });
    expect(await makeApp().cancelRun(secondPause.runId)).toBe(true);
    expect((await first.getRun(secondPause.runId))?.status).toBe('cancelled');
    expect((await first.listEvents(secondPause.runId)).at(-1)?.type).toBe('run.cancelled');
  });

  test('applies policies before credentials and retries keyed tools safely', async () => {
    const order: string[] = [];
    const keys: string[] = [];
    let attempts = 0;
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            return input.messages.some(({ role }) => role === 'tool')
              ? { output: 'done' }
              : { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      policies: [
        {
          name: 'allow',
          async authorize() {
            order.push('policy');
            return 'allow' as const;
          },
        },
      ],
      credentialStore: {
        async resolve({ name }) {
          order.push(`credential:${name}`);
          return 'top-secret';
        },
      },
      tools: [
        defineTool({
          name: 'lookup',
          idempotency: 'keyed',
          retry: { maxAttempts: 2, backoffMs: 0 },
          credentials: ['api-key'],
          async execute(_input, context) {
            attempts += 1;
            keys.push(context.idempotencyKey);
            const secret = await context.getCredential('api-key');
            if (attempts === 1) throw new Error(`provider leaked ${secret}`);
            return 'found';
          },
        }),
      ],
    });
    const result = await app.runAgent('assistant', { input: 'hello' });
    expect(result.output).toBe('done');
    expect(attempts).toBe(2);
    expect(new Set(keys).size).toBe(1);
    expect(order[0]).toBe('policy');
    expect(
      (await app.listEvents(result.runId)).find(({ type }) => type === 'tool.retrying')?.payload,
    ).toMatchObject({ error: 'provider leaked [REDACTED]' });
  });

  test('reuses a durable completed tool execution after redelivery', async () => {
    const store = new InMemoryRunStore();
    let executions = 0;
    const makeApp = () =>
      createFevex({
        models: {
          default: {
            stream: streamFrom(async (input) => {
              return input.messages.some(({ role }) => role === 'tool')
                ? { output: 'done' }
                : { toolCalls: [lookupCall] };
            }),
          },
        },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [
          defineTool({
            name: 'lookup',
            approval: 'required',
            idempotency: 'keyed',
            execute() {
              executions += 1;
              return 'executed';
            },
          }),
        ],
        runStore: store,
      });
    const first = makeApp();
    let paused!: RunPausedError;
    await first.runAgent('assistant', { input: 'hello' }).catch((error) => {
      paused = error;
    });
    const run = (await store.getRun(paused.runId))!;
    const checkpoint = (await store.getCheckpoint(paused.runId))!;
    const pending = checkpoint.pendingTools[checkpoint.pendingIndex]!;
    expect(
      await store.commitExecution({
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

    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const second = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input: ModelInput) => {
            return input.messages.some(({ role }) => role === 'tool')
              ? { output: 'done' }
              : { toolCalls: [lookupCall] };
          }),
        },
      },
      agents: [agent('assistant', { tools: ['lookup'] })],
      tools: [
        defineTool({
          name: 'lookup',
          approval: 'required',
          idempotency: 'keyed',
          execute() {
            executions += 1;
            return 'executed';
          },
        }),
      ],
      runStore: store,
      onEvent(event) {
        if (event.runId === run.id && event.type === 'run.completed') finish();
      },
    });
    const approval = paused.pause.type === 'approval' ? paused.pause.approval : undefined;
    await second.resumeRun(run.id, {
      type: 'approval',
      approvalId: approval!.id,
      decision: 'approve',
      actor: { id: 'reviewer' },
    });
    await completed;
    expect(executions).toBe(0);
    expect((await second.getRun(run.id))?.status).toBe('completed');
  });

  test('recovers an orphaned agent checkpoint with persisted limits and usage', async () => {
    class CrashableStore extends InMemoryRunStore {
      leaseOwner?: string;

      override async createExecution(
        input: Parameters<InMemoryRunStore['createExecution']>[0],
      ): Promise<boolean> {
        this.leaseOwner = input.lease.ownerId;
        return super.createExecution(input);
      }
    }
    const store = new CrashableStore();
    let releaseCrashedModel!: () => void;
    let markCrashedModelStarted!: () => void;
    const crashedModelStarted = new Promise<void>((resolve) => {
      markCrashedModelStarted = resolve;
    });
    const crashedRuntime = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            markCrashedModelStarted();
            await new Promise<void>((resolve) => {
              releaseCrashedModel = resolve;
            });
            return { output: 'stale' };
          }),
        },
      },
      agents: [agent('recoverable')],
      runStore: store,
    });
    const run = await crashedRuntime.startAgent('recoverable', {
      input: 'go',
      limits: { maxOutputTokens: 3 },
    });
    await crashedModelStarted;
    await store.releaseLease(run.id, store.leaseOwner!);

    let recoveredLimit: number | undefined;
    const recoveredRuntime = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            recoveredLimit = input.maxOutputTokens;
            return {
              output: 'recovered',
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            };
          }),
        },
      },
      agents: [agent('recoverable')],
      runStore: store,
    });
    await recoveredRuntime.recoverRun(run.id, { actor: { id: 'worker-2' } });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await store.getRun(run.id))?.status !== 'running') break;
      await Bun.sleep(2);
    }
    releaseCrashedModel();
    await Bun.sleep(2);

    expect(recoveredLimit).toBe(3);
    expect(await store.getRun(run.id)).toMatchObject({
      status: 'completed',
      output: 'recovered',
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
    expect((await store.listEvents(run.id)).map(({ type }) => type)).toEqual([
      'run.started',
      'model.started',
      'run.recovered',
      'model.started',
      'model.output.delta',
      'model.completed',
      'run.completed',
    ]);
    await expect(
      recoveredRuntime.recoverRun(run.id, { actor: { id: 'worker-3' } }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_RECOVERABLE' });
  });

  test('recovers keyed tools with the same key and pauses uncertain non-keyed tools', async () => {
    class CrashableStore extends InMemoryRunStore {
      leaseOwner?: string;

      override async createExecution(
        input: Parameters<InMemoryRunStore['createExecution']>[0],
      ): Promise<boolean> {
        this.leaseOwner = input.lease.ownerId;
        return super.createExecution(input);
      }
    }
    const exercise = async (idempotency: 'keyed' | 'none') => {
      const store = new CrashableStore();
      const keys: string[] = [];
      let executions = 0;
      let releaseFirst!: () => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const model: ModelGateway = {
        stream: streamFrom(async (input) =>
          input.messages.some(({ role }) => role === 'tool')
            ? { output: 'done' }
            : { toolCalls: [{ id: 'crash-tool', name: 'effect', input: {} }] },
        ),
      };
      const tool = () =>
        defineTool({
          name: 'effect',
          idempotency,
          async execute(_input, context) {
            executions += 1;
            keys.push(context.idempotencyKey);
            if (executions === 1) {
              markStarted();
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
              });
            }
            return 'effect';
          },
        });
      const first = createFevex({
        models: { default: model },
        agents: [agent('tool-recovery', { tools: ['effect'] })],
        tools: [tool()],
        runStore: store,
      });
      const run = await first.startAgent('tool-recovery', { input: 'go' });
      await started;
      await store.releaseLease(run.id, store.leaseOwner!);

      const second = createFevex({
        models: { default: model },
        agents: [agent('tool-recovery', { tools: ['effect'] })],
        tools: [tool()],
        runStore: store,
      });
      await second.recoverRun(run.id, { actor: { id: 'recovery-worker' } });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await store.getRun(run.id))?.status !== 'running') break;
        await Bun.sleep(2);
      }

      if (idempotency === 'none') {
        const unknown = await store.getRun(run.id);
        expect(unknown).toMatchObject({
          status: 'paused',
          pause: { type: 'tool_execution_unknown', toolCallId: 'crash-tool' },
        });
        expect(executions).toBe(1);
        await second.resumeRun(run.id, {
          type: 'tool_execution',
          toolCallId: 'crash-tool',
          decision: 'retry',
          actor: { id: 'operator' },
        });
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if ((await store.getRun(run.id))?.status !== 'running') break;
          await Bun.sleep(2);
        }
      }

      expect(await store.getRun(run.id)).toMatchObject({
        status: 'completed',
        output: 'done',
      });
      expect(executions).toBe(2);
      expect(new Set(keys).size).toBe(1);
      releaseFirst();
      await Bun.sleep(2);
    };

    await exercise('keyed');
    await exercise('none');
  });

  test('rejects legacy checkpoints without inferring missing v2 contracts', async () => {
    class LegacyCheckpointStore extends InMemoryRunStore {
      legacy = false;

      override async getCheckpoint<
        TCheckpoint extends StoredRunCheckpoint = RunCheckpoint,
      >(runId: string): Promise<TCheckpoint | undefined> {
        const checkpoint = await super.getCheckpoint<TCheckpoint>(runId);
        return this.legacy && checkpoint
          ? ({ ...checkpoint, version: 1 } as unknown as TCheckpoint)
          : checkpoint;
      }
    }
    const store = new LegacyCheckpointStore();
    const workflow = defineWorkflow({
      name: 'legacy-flow',
      events: { release: {} },
      async run(step) {
        await step.waitForEvent('release', 'release');
        return 'done';
      },
    });
    const app = createFevex({
      models: { default: modelWithOutput('unused') },
      agents: [agent('assistant')],
      workflows: [workflow],
      runStore: store,
    });
    let paused!: RunPausedError;
    await app.runWorkflow('legacy-flow', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    store.legacy = true;

    await expect(
      app.resumeRun(paused.runId, { type: 'event', eventName: 'release' }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_UNSUPPORTED' });
    expect(await store.getRun(paused.runId)).toMatchObject({ status: 'paused' });
  });

  describe('definition guard', () => {
    const approvalModel = (): ModelGateway => ({
      stateCodec: {
        serialize: (state) => structuredClone(state) as JsonObject,
        restore: (state) => structuredClone(state),
      },
      stream: streamFrom(async (input) =>
        input.providerState === undefined
          ? { toolCalls: [lookupCall], providerState: { turn: 1 } }
          : { output: 'approved' },
      ),
    });
    const approvalTool = () =>
      defineTool({
        name: 'lookup',
        risk: 'write',
        approval: 'required',
        idempotency: 'keyed',
        execute: () => 'found',
      });

    const pauseWorkflow = async (
      store: InMemoryRunStore,
      workflow: WorkflowDefinition,
    ): Promise<RunPausedError> => {
      const app = createFevex({
        models: { default: approvalModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [approvalTool()],
        workflows: [workflow],
        runStore: store,
      });
      let paused!: RunPausedError;
      await app.runWorkflow(workflow.name, { input: 'hello' }).catch((error) => {
        paused = error as RunPausedError;
      });
      expect(paused).toBeInstanceOf(RunPausedError);
      return paused;
    };

    const resumeWith = (store: InMemoryRunStore, workflow: WorkflowDefinition) =>
      createFevex({
        models: { default: approvalModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [approvalTool()],
        workflows: [workflow],
        runStore: store,
      });

    const approve = (approvalId: string) =>
      ({
        type: 'approval',
        approvalId,
        decision: 'approve',
        actor: { id: 'reviewer-1' },
      }) as const;

    const approvalIdOf = (paused: RunPausedError): string => {
      const childPause =
        paused.pause.type === 'workflow_child' ? paused.pause.childPause : paused.pause;
      return childPause.type === 'approval' ? childPause.approval.id : '';
    };

    test('resumes a workflow whose run was rewritten but keeps its version', async () => {
      const store = new InMemoryRunStore();
      const paused = await pauseWorkflow(
        store,
        defineWorkflow({
          name: 'rewritten-flow',
          async run(step, input) {
            return (await step.agent('approve', 'assistant', { input })).output;
          },
        }),
      );

      // Same declared version, different source text. This is what a bundler or
      // a minifier produces, and it must not invalidate an in-flight run.
      const rewritten = defineWorkflow({
        name: 'rewritten-flow',
        run: async (s, i) => {
          const result = await s.agent('approve', 'assistant', { input: i });
          return result.output;
        },
      });
      const app = resumeWith(store, rewritten);
      await app.resumeRun(paused.runId, approve(approvalIdOf(paused)));

      await Bun.sleep(5);
      expect(await app.getRun(paused.runId)).toMatchObject({ status: 'completed' });
    });

    test('refuses to resume a workflow after its version changes', async () => {
      const store = new InMemoryRunStore();
      const paused = await pauseWorkflow(
        store,
        defineWorkflow({
          name: 'versioned-flow',
          version: '1',
          async run(step, input) {
            return (await step.agent('approve', 'assistant', { input })).output;
          },
        }),
      );

      const bumped = defineWorkflow({
        name: 'versioned-flow',
        version: '2',
        async run(step, input) {
          return (await step.agent('approve', 'assistant', { input })).output;
        },
      });
      const app = resumeWith(store, bumped);

      await expect(
        app.resumeRun(paused.runId, approve(approvalIdOf(paused))),
      ).rejects.toMatchObject({
        code: 'RUN_DEFINITION_CHANGED',
        message: 'Definition for workflow "versioned-flow" changed',
      });
      expect(await app.getRun(paused.runId)).toMatchObject({ status: 'paused' });
    });

    test('refuses to resume an agent after its instructions change', async () => {
      const store = new InMemoryRunStore();
      const first = createFevex({
        models: { default: approvalModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [approvalTool()],
        runStore: store,
      });
      let paused!: RunPausedError;
      await first.runAgent('assistant', { input: 'hello' }).catch((error) => {
        paused = error as RunPausedError;
      });
      expect(paused).toBeInstanceOf(RunPausedError);

      const second = createFevex({
        models: { default: approvalModel() },
        agents: [
          agent('assistant', { tools: ['lookup'], instructions: 'Answer very differently.' }),
        ],
        tools: [approvalTool()],
        runStore: store,
      });

      await expect(
        second.resumeRun(paused.runId, approve(approvalIdOf(paused))),
      ).rejects.toMatchObject({
        code: 'RUN_DEFINITION_CHANGED',
        message: 'Definition for agent "assistant" changed',
      });
      expect(await second.getRun(paused.runId)).toMatchObject({ status: 'paused' });
    });

    test('refuses to resume an agent after sandbox capabilities change', async () => {
      const store = new InMemoryRunStore();
      const sandbox = {
        async run() {
          return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 0, timedOut: false };
        },
      };
      const sandboxedTool = (command: string) =>
        defineTool({
          name: 'lookup',
          approval: 'required',
          idempotency: 'keyed',
          sandbox: { process: { commands: [command] } },
          execute: () => 'found',
        });
      const first = createFevex({
        models: { default: approvalModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [sandboxedTool('node')],
        sandbox,
        runStore: store,
      });
      let paused!: RunPausedError;
      await first.runAgent('assistant', { input: 'hello' }).catch((error) => {
        paused = error as RunPausedError;
      });
      expect(paused).toBeInstanceOf(RunPausedError);

      const second = createFevex({
        models: { default: approvalModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [sandboxedTool('bun')],
        sandbox,
        runStore: store,
      });

      await expect(
        second.resumeRun(paused.runId, approve(approvalIdOf(paused))),
      ).rejects.toMatchObject({
        code: 'RUN_DEFINITION_CHANGED',
        message: 'Definition for agent "assistant" changed',
      });
    });
  });
});
