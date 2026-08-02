import { describe, expect, test } from 'bun:test';
import { type AgentEvent, type JsonObject } from './core';
import type { ModelGateway } from './models';
import {
  createFevex,
  defineTool,
  defineWorkflow,
  InMemoryRunStore,
  RunPausedError,
} from './index';
import {
  agent,
  lookupCall,
  modelWithOutput,
  schema,
  streamFrom,
} from './test-fixtures';

describe('workflows', () => {
  test('runs workflows with conditional agent steps and parallel fan-out', async () => {
    const calls: string[] = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            const role = input.messages[0]!.content;
            calls.push(role);
            if (role === 'triage') return { output: { kind: 'support' } };
            if (role === 'billing') return { output: 'billing' };
            if (role === 'docs') return { output: 'docs-result' };
            if (role === 'account') return { output: 'account-result' };
            return { output: { answer: 'docs-result/account-result' } };
          }),
        },
      },
      agents: [
        agent('triage', { instructions: 'triage' }),
        agent('billing', { instructions: 'billing' }),
        agent('docs', { instructions: 'docs' }),
        agent('account', { instructions: 'account' }),
        agent('answer', { instructions: 'answer' }),
      ],
      workflows: [
        defineWorkflow({
          name: 'support-flow',
          async run(step, input) {
            const triage = await step.agent<{ question: string }, { kind: string }>(
              'triage',
              'triage',
              { input: input as { question: string } },
            );
            if (triage.output.kind === 'billing') {
              return (await step.agent('billing', 'billing', { input })).output;
            }
            const research = await step.parallel('research', {
              docs: () => step.agent('docs', 'docs', { input }),
              account: () => step.agent('account', 'account', { input }),
            });
            return (
              await step.agent('answer', 'answer', {
                input: {
                  question: input,
                  docs: research.docs.output,
                  account: research.account.output,
                },
              })
            ).output;
          },
        }),
      ],
    });

    const result = await app.runWorkflow<{ question: string }, { answer: string }>(
      'support-flow',
      { input: { question: 'help' } },
    );

    expect(result.output).toEqual({ answer: 'docs-result/account-result' });
    expect(calls).toEqual(['triage', 'docs', 'account', 'answer']);
    expect((await app.listEvents(result.runId)).map(({ type }) => type)).toEqual([
      'workflow.run.started',
      'workflow.step.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'workflow.step.completed',
      'workflow.step.started',
      'workflow.step.started',
      'workflow.step.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'workflow.step.completed',
      'model.started',
      'model.output.delta',
      'model.completed',
      'workflow.step.completed',
      'workflow.step.completed',
      'workflow.step.started',
      'model.started',
      'model.output.delta',
      'model.completed',
      'workflow.step.completed',
      'workflow.run.completed',
    ]);
    await expect(app.runWorkflow('missing-flow', { input: 'hello' })).rejects.toThrow(
      'Workflow "missing-flow" is not registered',
    );
    await expect(
      app.runWorkflow('support-flow', { input: { question: 'hello' }, context: {} }),
    ).resolves.toMatchObject({ output: { answer: 'docs-result/account-result' } });
  });

  test('pauses and resumes durable workflows when a child agent needs approval', async () => {
    const store = new InMemoryRunStore();
    let executions = 0;
    const workflow = defineWorkflow({
      name: 'approval-flow',
      async run(step, input) {
        return (await step.agent('approve', 'assistant', { input })).output;
      },
    });
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
          return { toolCalls: [lookupCall], providerState: { turn: 1 } };
        }
        return { output: 'approved' };
      }),
    });
    const configuredTool = () =>
      defineTool({
        name: 'lookup',
        risk: 'write',
        approval: 'required',
        idempotency: 'keyed',
        execute() {
          executions += 1;
          return 'found';
        },
      });
    const makeApp = (onEvent?: (event: AgentEvent) => void) =>
      createFevex({
        models: { default: configuredModel() },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [configuredTool()],
        workflows: [workflow],
        runStore: store,
        ...(onEvent ? { onEvent } : {}),
      });

    const first = makeApp();
    let paused!: RunPausedError;
    await first.runWorkflow('approval-flow', { input: 'hello' }).catch((error) => {
      expect(error).toBeInstanceOf(RunPausedError);
      paused = error;
    });
    expect(paused.pause.type).toBe('workflow_child');
    expect(executions).toBe(0);

    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const second = makeApp((event) => {
      if (event.runId === paused.runId && event.type === 'workflow.run.completed') complete();
    });
    const childPause = paused.pause.type === 'workflow_child' ? paused.pause.childPause : undefined;
    const approval = childPause?.type === 'approval' ? childPause.approval : undefined;
    await second.resumeRun(paused.runId, {
      type: 'approval',
      approvalId: approval!.id,
      decision: 'approve',
      actor: { id: 'reviewer-1' },
    });
    await completed;

    expect(await second.getRun(paused.runId)).toMatchObject({
      kind: 'workflow',
      status: 'completed',
      output: 'approved',
    });
    expect(executions).toBe(1);
    expect((await second.listEvents(paused.runId)).map(({ type }) => type)).toEqual([
      'workflow.run.started',
      'workflow.step.started',
      'model.started',
      'model.completed',
      'approval.requested',
      'workflow.run.paused',
      'workflow.run.resumed',
      'workflow.step.completed',
      'workflow.run.completed',
    ]);
  });

  test('aggregates parallel child elicitations and resumes the matching child', async () => {
    const store = new InMemoryRunStore();
    const model = (): ModelGateway => ({
      stream: streamFrom(async (input) => {
        const user = [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? 'x';
        return input.messages.some(({ role }) => role === 'tool')
          ? { output: `done-${user}` }
          : {
              toolCalls: [{
                id: `elicit-${user}`,
                name: 'fevex__elicit',
                input: {
                  prompt: `Need ${user}`,
                  responseSchema: {
                    type: 'object',
                    properties: { value: { type: 'string' } },
                    required: ['value'],
                    additionalProperties: false,
                  },
                },
              }],
            };
      }),
    });
    const workflow = defineWorkflow({
      name: 'parallel-elicit',
      async run(step) {
        return step.parallel('batch', {
          a: () => step.agent('a', 'asker', { input: 'a' }),
          b: () => step.agent('b', 'asker', { input: 'b' }),
        });
      },
    });
    const app = createFevex({
      models: { default: model() },
      agents: [agent('asker', { elicitation: 'pause' })],
      workflows: [workflow],
      runStore: store,
    });

    let paused!: RunPausedError;
    await app.runWorkflow('parallel-elicit', { input: 'start' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect(paused.pause.type).toBe('workflow_children');
    const children = paused.pause.type === 'workflow_children' ? paused.pause.children : [];
    expect(children.map(({ stepId }) => stepId).sort()).toEqual(['a', 'b']);
    const childB = children.find(({ stepId }) => stepId === 'b')!;
    expect(childB.childPause.type).toBe('elicitation');

    await app.resumeRun(paused.runId, {
      type: 'elicitation',
      requestId: childB.childPause.type === 'elicitation' ? childB.childPause.request.id : '',
      value: { value: 'b-value' },
      actor: { id: 'user-1' },
    });
    await Bun.sleep(5);

    const parent = await app.getRun(paused.runId);
    expect(parent).toMatchObject({ status: 'paused' });
    expect(parent?.pause).toMatchObject({
      type: 'workflow_child',
      childRunId: children.find(({ stepId }) => stepId === 'a')!.childRunId,
    });
  });

  test('cancels a paused workflow child before cancelling its parent', async () => {
    const store = new InMemoryRunStore();
    const workflow = defineWorkflow({
      name: 'cancel-child-flow',
      async run(step, input) {
        return (await step.agent('approval', 'assistant', { input })).output;
      },
    });
    const makeApp = () =>
      createFevex({
        models: {
          default: {
            stateCodec: {
              serialize: (state) => state as JsonObject,
              restore: (state) => state,
            },
            stream: streamFrom(async (input) =>
              input.providerState
                ? { output: 'done' }
                : { toolCalls: [lookupCall], providerState: { turn: 1 } },
            ),
          },
        },
        agents: [agent('assistant', { tools: ['lookup'] })],
        tools: [
          defineTool({
            name: 'lookup',
            risk: 'write',
            approval: 'required',
            idempotency: 'keyed',
            execute: () => 'done',
          }),
        ],
        workflows: [workflow],
        runStore: store,
      });

    let paused!: RunPausedError;
    await makeApp().runWorkflow('cancel-child-flow', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    const checkpoint = await store.getCheckpoint<any>(paused.runId);
    const childRunId = checkpoint?.steps.approval.childRunId as string;

    expect(await makeApp().cancelRun(paused.runId)).toBe(true);
    expect(await store.getRun(childRunId)).toMatchObject({ status: 'cancelled' });
    expect(await store.getRun(paused.runId)).toMatchObject({ status: 'cancelled' });
    expect((await store.listEvents(childRunId)).at(-1)?.type).toBe('run.cancelled');
    expect((await store.listEvents(paused.runId)).at(-1)?.type).toBe(
      'workflow.run.cancelled',
    );
  });

  test('settles parallel work and reports multiple failures in declaration order', async () => {
    const settled: string[] = [];
    const app = createFevex({
      models: { default: modelWithOutput('unused') },
      agents: [agent('assistant')],
      workflows: [
        defineWorkflow({
          name: 'parallel-failures',
          async run(step) {
            await step.parallel('fanout', {
              first: async () => {
                await Bun.sleep(4);
                settled.push('first');
                throw new Error('first failed');
              },
              second: async () => {
                settled.push('second');
                throw new Error('second failed');
              },
            });
            return 'unreachable';
          },
        }),
      ],
    });

    let failure!: AggregateError;
    await app.runWorkflow('parallel-failures', { input: 'go' }).catch((error) => {
      failure = error as AggregateError;
    });
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toBe('Workflow parallel step "fanout" failed');
    expect(failure.errors.map((error) => (error as Error).message)).toEqual([
      'first failed',
      'second failed',
    ]);
    expect(settled).toEqual(['second', 'first']);
  });

  test('compensates completed workflow steps in reverse order when a workflow fails', async () => {
    const compensated: string[] = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => ({ output: input.messages[0]!.content })),
        },
      },
      agents: [agent('first', { instructions: 'first' }), agent('second', { instructions: 'second' })],
      workflows: [
        defineWorkflow({
          name: 'compensating-flow',
          async run(step, input) {
            await step.agent('first', 'first', { input }, {
              compensate(result) {
                compensated.push(`first:${result.output}`);
              },
            });
            await step.agent('second', 'second', { input }, {
              compensate(result) {
                compensated.push(`second:${result.output}`);
              },
            });
            throw new Error('workflow failed');
          },
        }),
      ],
    });

    await expect(app.runWorkflow('compensating-flow', { input: 'go' })).rejects.toThrow(
      'workflow failed',
    );

    expect(compensated).toEqual(['second:second', 'first:first']);
  });

  test('does not repeat compensated steps after replaying a paused workflow', async () => {
    const store = new InMemoryRunStore();
    const executions: string[] = [];
    const workflow = defineWorkflow({
      name: 'replay-compensation-flow',
      events: { release: {} },
      async run(step, input) {
        await step.agent('write', 'writer', { input }, {
          compensate(result) {
            executions.push(`compensate:${result.output}`);
          },
        });
        await step.waitForEvent('release', 'release');
        throw new Error('after replay');
      },
    });
    const makeApp = () =>
      createFevex({
        models: {
          default: {
            stream: streamFrom(async () => {
              executions.push('write');
              return { output: 'written' };
            }),
          },
        },
        agents: [agent('writer')],
        workflows: [workflow],
        runStore: store,
      });

    let paused!: RunPausedError;
    await makeApp().runWorkflow('replay-compensation-flow', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect(paused).toBeInstanceOf(RunPausedError);

    await makeApp().resumeRun(paused.runId, { type: 'event', eventName: 'release' });
    await Bun.sleep(5);

    expect(executions).toEqual(['write', 'compensate:written']);
    expect(await store.getRun(paused.runId)).toMatchObject({ status: 'failed' });
  });

  test('marks workflow failed when compensation fails', async () => {
    const store = new InMemoryRunStore();
    const events: AgentEvent[] = [];
    const app = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('writer')],
      workflows: [
        defineWorkflow({
          name: 'failed-compensation-flow',
          async run(step, input) {
            await step.agent('write', 'writer', { input }, {
              compensate() {
                throw new Error('undo failed');
              },
            });
            throw new Error('main failed');
          },
        }),
      ],
      runStore: store,
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(app.runWorkflow('failed-compensation-flow', { input: 'go' })).rejects.toThrow(
      'Workflow failed: main failed; compensation failed: undo failed',
    );

    const failed = events.find(({ type }) => type === 'workflow.run.failed')!;
    expect(await store.getRun(failed.runId)).toMatchObject({
      status: 'failed',
      error: 'Workflow failed: main failed; compensation failed: undo failed',
    });
    expect(events.map(({ type }) => type)).toContain('workflow.compensation.failed');
  });

  test('pauses a workflow until a timer is explicitly resumed after it elapses', async () => {
    const store = new InMemoryRunStore();
    const resumeAt = new Date(Date.now() + 20).toISOString();
    const workflow = defineWorkflow({
      name: 'timer-flow',
      async run(step) {
        await step.waitUntil('timer', resumeAt);
        return 'ready';
      },
    });
    const makeApp = (onEvent?: (event: AgentEvent) => void) =>
      createFevex({
        models: { default: modelWithOutput('unused') },
        agents: [agent('assistant')],
        workflows: [workflow],
        runStore: store,
        ...(onEvent ? { onEvent } : {}),
      });

    let paused!: RunPausedError;
    await makeApp().runWorkflow('timer-flow', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect(paused.pause).toMatchObject({ type: 'workflow_timer', resumeAt });
    await expect(makeApp().resumeRun(paused.runId, { type: 'timer' })).rejects.toMatchObject({
      code: 'RUN_NOT_RESUMABLE',
    });

    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await Bun.sleep(25);
    await makeApp((event) => {
      if (event.type === 'workflow.run.completed') complete();
    }).resumeRun(paused.runId, { type: 'timer' });
    await completed;

    expect(await store.getRun(paused.runId)).toMatchObject({ status: 'completed', output: 'ready' });
  });

  test('pauses a workflow until the matching external event is resumed', async () => {
    const store = new InMemoryRunStore();
    const workflow = defineWorkflow({
      name: 'event-flow',
      events: { approved: {} },
      async run(step) {
        const event = await step.waitForEvent<JsonObject>('approval-event', 'approved');
        return event.payload;
      },
    });
    const makeApp = (onEvent?: (event: AgentEvent) => void) =>
      createFevex({
        models: { default: modelWithOutput('unused') },
        agents: [agent('assistant')],
        workflows: [workflow],
        runStore: store,
        ...(onEvent ? { onEvent } : {}),
      });

    let paused!: RunPausedError;
    await makeApp().runWorkflow('event-flow', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect(paused.pause).toMatchObject({ type: 'workflow_event', eventName: 'approved' });
    await expect(
      makeApp().resumeRun(paused.runId, { type: 'event', eventName: 'wrong' }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_RESUMABLE' });

    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await makeApp((event) => {
      if (event.type === 'workflow.run.completed') complete();
    }).resumeRun(paused.runId, {
      type: 'event',
      eventName: 'approved',
      payload: { approved: true },
    });
    await completed;

    expect(await store.getRun(paused.runId)).toMatchObject({
      status: 'completed',
      output: { approved: true },
    });
  });

  test('transforms workflow input and persists an audited, schema-validated event', async () => {
    const store = new InMemoryRunStore();
    const inputSchema = schema<{ value: string }>(
      (value) => ({ value: { value: String(value).trim().toUpperCase() } }),
      { type: 'string' },
    );
    const eventSchema = schema<{ approved: true }>(
      (value) =>
        (value as { decision?: unknown })?.decision === 'yes'
          ? { value: { approved: true as const } }
          : { issues: [{ message: 'decision must be yes' }] },
      {
        type: 'object',
        properties: { decision: { const: 'yes' } },
        required: ['decision'],
      },
    );
    const outputSchema = schema<string>(
      (value) => {
        const result = value as {
          input: { value: string };
          event: { payload?: { approved: true }; actor?: { id: string }; receivedAt: string };
        };
        return {
          value:
            `${result.input.value}:${result.event.payload?.approved}:` +
            `${result.event.actor?.id}:${result.event.receivedAt}`,
        };
      },
      { type: 'string' },
    );
    const workflow = defineWorkflow({
      name: 'audited-event-flow',
      inputSchema,
      outputSchema,
      events: {
        approved: { payloadSchema: eventSchema, requireActor: true },
      },
      async run(step, input: { value: string }) {
        const event = await step.waitForEvent<{ approved: true }>('approval', 'approved');
        return { input, event };
      },
    });
    const makeApp = () =>
      createFevex({
        models: { default: modelWithOutput('unused') },
        agents: [agent('assistant')],
        workflows: [workflow],
        runStore: store,
      });

    let paused!: RunPausedError;
    await makeApp().runWorkflow('audited-event-flow', { input: '  hello  ' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect((await store.getCheckpoint<any>(paused.runId))?.input).toEqual({ value: 'HELLO' });

    await expect(
      makeApp().resumeRun(paused.runId, {
        type: 'event',
        eventName: 'approved',
        payload: { decision: 'yes' },
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    await expect(
      makeApp().resumeRun(paused.runId, {
        type: 'event',
        eventName: 'approved',
        payload: { decision: 'no' },
        actor: { id: 'reviewer' },
      }),
    ).rejects.toThrow('decision must be yes');
    expect(await store.getRun(paused.runId)).toMatchObject({ status: 'paused' });

    await makeApp().resumeRun(paused.runId, {
      type: 'event',
      eventName: 'approved',
      payload: { decision: 'yes' },
      actor: { id: 'reviewer' },
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await store.getRun(paused.runId))?.status !== 'running') break;
      await Bun.sleep(2);
    }
    const completed = await store.getRun(paused.runId);
    expect(completed).toMatchObject({ status: 'completed' });
    expect(String(completed?.output)).toStartWith('HELLO:true:reviewer:');
    expect(
      (await store.listEvents(paused.runId)).find(
        ({ type }) => type === 'workflow.wait.completed',
      )?.payload,
    ).toMatchObject({
      payload: { approved: true },
      actorId: 'reviewer',
    });
  });

  test('fails a resumed workflow when its definition output schema rejects the result', async () => {
    const store = new InMemoryRunStore();
    const workflow = defineWorkflow({
      name: 'invalid-resumed-output',
      outputSchema: schema(
        () => ({ issues: [{ message: 'final output is invalid' }] }),
        { type: 'string' },
      ),
      events: { release: {} },
      async run(step) {
        await step.waitForEvent('release', 'release');
        return 'invalid';
      },
    });
    const makeApp = () =>
      createFevex({
        models: { default: modelWithOutput('unused') },
        agents: [agent('assistant')],
        workflows: [workflow],
        runStore: store,
      });
    let paused!: RunPausedError;
    await makeApp().runWorkflow('invalid-resumed-output', { input: 'go' }).catch((error) => {
      paused = error as RunPausedError;
    });
    await makeApp().resumeRun(paused.runId, { type: 'event', eventName: 'release' });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await store.getRun(paused.runId))?.status !== 'running') break;
      await Bun.sleep(2);
    }
    expect(await store.getRun(paused.runId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('final output is invalid'),
    });
  });

  test('inherits workflow context while preventing child actor impersonation', async () => {
    const seen: Array<{ source: string; context: unknown }> = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) =>
            input.messages.some(({ role }) => role === 'tool')
              ? { output: 'done' }
              : { toolCalls: [{ id: 'context-call', name: 'inspect', input: {} }] },
          ),
        },
      },
      contextProviders: [
        {
          name: 'tenant',
          async read(input) {
            seen.push({ source: 'provider', context: input.context });
            return [];
          },
        },
      ],
      policies: [
        {
          name: 'context-policy',
          authorize(input) {
            seen.push({ source: 'policy', context: input.context });
            return 'allow';
          },
        },
      ],
      tools: [
        defineTool({
          name: 'inspect',
          execute(_input, input) {
            seen.push({ source: 'tool', context: input.context });
            return 'ok';
          },
        }),
      ],
      agents: [agent('worker', { context: ['tenant'], tools: ['inspect'] })],
      workflows: [
        defineWorkflow({
          name: 'context-flow',
          async run(step, input) {
            return (
              await step.agent('inspect', 'worker', {
                input,
                context: {
                  namespace: 'child',
                  actor: { id: 'impersonator' },
                  attributes: { child: true, shared: 'child' },
                  prompt: { child: true },
                },
              })
            ).output;
          },
        }),
      ],
    });

    await app.runWorkflow('context-flow', {
      input: 'go',
      context: {
        namespace: 'parent',
        actor: { id: 'authenticated' },
        attributes: { parent: true, shared: 'parent' },
        prompt: { parent: true },
      },
    });
    expect(seen.map(({ source }) => source)).toEqual(['provider', 'policy', 'tool']);
    for (const item of seen) {
      expect(item.context).toEqual({
        namespace: 'child',
        actor: { id: 'authenticated' },
        attributes: { parent: true, shared: 'child', child: true },
        prompt: { parent: true, child: true },
      });
    }
  });

  test('recovers a running workflow child without replacing or repeating its step', async () => {
    class CrashableStore extends InMemoryRunStore {
      readonly leaseOwners = new Map<string, string>();

      override async createExecution(
        input: Parameters<InMemoryRunStore['createExecution']>[0],
      ): Promise<boolean> {
        this.leaseOwners.set(input.run.id, input.lease.ownerId);
        return super.createExecution(input);
      }
    }
    const store = new CrashableStore();
    let releaseCrashedChild!: () => void;
    let markChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    const workflow = defineWorkflow({
      name: 'recover-child-flow',
      version: '1',
      async run(step, input) {
        return (await step.agent('only-child', 'worker', { input })).output;
      },
    });
    const crashedRuntime = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => {
            markChildStarted();
            await new Promise<void>((resolve) => {
              releaseCrashedChild = resolve;
            });
            return { output: 'stale' };
          }),
        },
      },
      agents: [agent('worker')],
      workflows: [workflow],
      runStore: store,
    });
    const parent = await crashedRuntime.startWorkflow('recover-child-flow', { input: 'go' });
    await childStarted;
    const checkpoint = await store.getCheckpoint<any>(parent.id);
    const childRunId = checkpoint?.steps['only-child'].childRunId as string;
    await store.releaseLease(parent.id, store.leaseOwners.get(parent.id)!);
    await store.releaseLease(childRunId, store.leaseOwners.get(childRunId)!);

    const recoveredRuntime = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => ({
            output: 'recovered-child',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          })),
        },
      },
      agents: [agent('worker')],
      workflows: [workflow],
      runStore: store,
    });
    await recoveredRuntime.recoverRun(parent.id, { actor: { id: 'workflow-worker' } });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await store.getRun(parent.id))?.status !== 'running') break;
      await Bun.sleep(2);
    }
    expect(await store.getRun(parent.id)).toMatchObject({
      status: 'completed',
      output: 'recovered-child',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    expect(await store.getRun(childRunId)).toMatchObject({
      status: 'completed',
      output: 'recovered-child',
    });
    const parentEvents = await store.listEvents(parent.id);
    expect(parentEvents.filter(({ type }) => type === 'workflow.step.started')).toHaveLength(1);
    expect(parentEvents.filter(({ type }) => type === 'workflow.step.completed')).toHaveLength(1);
    expect(parentEvents.filter(({ type }) => type === 'workflow.run.completed')).toHaveLength(1);
    expect(parentEvents.map(({ type }) => type)).toContain('workflow.run.recovered');
    releaseCrashedChild();
    await Bun.sleep(2);
  });

  test('inherits workflow token budget into child agents', async () => {
    const requestedOutputLimits: Array<number | undefined> = [];
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            requestedOutputLimits.push(input.maxOutputTokens);
            return { output: 'ok', usage: { inputTokens: 1, outputTokens: 3 } };
          }),
        },
      },
      agents: [agent('worker')],
      workflows: [
        defineWorkflow({
          name: 'token-budget-flow',
          limits: { maxOutputTokens: 5 },
          async run(step, input) {
            await step.agent('first', 'worker', { input });
            await step.agent('second', 'worker', { input });
            return 'done';
          },
        }),
      ],
    });

    await expect(app.runWorkflow('token-budget-flow', { input: 'go' })).rejects.toThrow(
      'exceeded maxOutputTokens limit of 2',
    );
    expect(requestedOutputLimits).toEqual([5, 2]);
  });

  test('inherits workflow step and tool-call budgets into child agents', async () => {
    const stepBudgetApp = createFevex({
      models: { default: modelWithOutput('ok') },
      agents: [agent('worker')],
      workflows: [
        defineWorkflow({
          name: 'step-budget-flow',
          limits: { maxSteps: 1 },
          async run(step, input) {
            await step.agent('first', 'worker', { input });
            await step.agent('second', 'worker', { input });
            return 'done';
          },
        }),
      ],
    });

    await expect(stepBudgetApp.runWorkflow('step-budget-flow', { input: 'go' })).rejects.toThrow(
      'reached maxSteps limit of 0',
    );

    const toolCall = { id: 'tool-1', name: 'lookup', input: {} };
    const toolBudgetApp = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) =>
            input.messages.some(({ role }) => role === 'tool')
              ? { output: 'done' }
              : { toolCalls: [toolCall] },
          ),
        },
      },
      agents: [agent('worker', { tools: ['lookup'] })],
      tools: [defineTool({ name: 'lookup', execute: () => 'ok' })],
      workflows: [
        defineWorkflow({
          name: 'tool-budget-flow',
          limits: { maxSteps: 10, maxToolCalls: 1 },
          async run(step, input) {
            await step.agent('first', 'worker', { input });
            await step.agent('second', 'worker', { input });
            return 'done';
          },
        }),
      ],
    });

    await expect(toolBudgetApp.runWorkflow('tool-budget-flow', { input: 'go' })).rejects.toThrow(
      'reached maxToolCalls limit of 0',
    );
  });

  test('adds parallel child usage back into the shared workflow budget', async () => {
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async () => ({
            output: 'ok',
            usage: { inputTokens: 1, outputTokens: 3 },
          })),
        },
      },
      agents: [agent('worker')],
      workflows: [
        defineWorkflow({
          name: 'parallel-budget-flow',
          limits: { maxOutputTokens: 5 },
          async run(step, input) {
            await step.parallel('parallel', {
              left: () => step.agent('left', 'worker', { input }),
              right: () => step.agent('right', 'worker', { input }),
            });
            return 'done';
          },
        }),
      ],
    });

    await expect(app.runWorkflow('parallel-budget-flow', { input: 'go' })).rejects.toThrow(
      'exceeded maxOutputTokens limit of 5',
    );
  });
});
