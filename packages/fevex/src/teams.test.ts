import { describe, expect, test } from 'bun:test';
import { type AgentEvent, type JsonObject } from './core';
import { createFevex, defineTool, defineTeam, InMemoryRunStore, RunPausedError } from './index';
import {
  agent,
  getConfigurationError,
  lookupCall,
  modelWithOutput,
  streamFrom,
} from './test-fixtures';

describe('teams', () => {
  test('runs a durable team with parallel delegations and a traced handoff', async () => {
    const app = createFevex({
      models: {
        default: {
          stream: streamFrom(async (input) => {
            const role = input.messages[0]!.content;
            if (role === 'planner') return { output: 'plan' };
            if (role === 'researcher') return { output: 'research' };
            if (role === 'coder') return { output: 'code' };
            return { output: 'approved' };
          }),
        },
      },
      agents: [
        agent('planner', { instructions: 'planner' }),
        agent('researcher', { instructions: 'researcher' }),
        agent('coder', { instructions: 'coder' }),
        agent('reviewer', { instructions: 'reviewer' }),
      ],
      teams: [
        defineTeam({
          name: 'software-team',
          supervisor: 'planner',
          members: [
            { agent: 'researcher', role: 'research' },
            { agent: 'coder', role: 'implementation' },
            { agent: 'reviewer', role: 'review' },
          ],
          limits: { maxDelegations: 4, maxParallel: 2 },
          async run(team, input) {
            const plan = await team.delegate<string, string>('plan', {
              agent: 'planner',
              task: input as string,
              expectedOutput: 'Implementation plan',
            });
            const work = await team.parallel('work', {
              research: () =>
                team.delegate<string, string>('research', {
                  agent: 'researcher',
                  task: plan.output,
                }),
              implementation: () =>
                team.delegate<string, string>('implementation', {
                  agent: 'coder',
                  task: plan.output,
                }),
            });
            return (
              await team.handoff<
                { research: string; implementation: string },
                string
              >('review', {
                from: 'coder',
                to: 'reviewer',
                reason: 'Final review',
                task: {
                  research: work.research.output,
                  implementation: work.implementation.output,
                },
              })
            ).output;
          },
        }),
      ],
    });

    const result = await app.runTeam<string, string>('software-team', {
      input: 'Build it',
    });
    expect(result.output).toBe('approved');
    expect(await app.getTeamRun(result.runId)).toMatchObject({
      kind: 'team',
      teamName: 'software-team',
      status: 'completed',
    });

    const events = await app.listEvents(result.runId);
    expect(events.some(({ type }) => type.startsWith('workflow.'))).toBe(false);
    expect(events.map(({ type }) => type)).toContain('team.merge.completed');
    expect(events.filter(({ type }) => type === 'team.agent.assigned')).toHaveLength(4);
    expect(events.find(({ type }) => type === 'team.handoff.created')).toMatchObject({
      payload: {
        delegationId: 'review',
        from: 'coder',
        to: 'reviewer',
        reason: 'Final review',
      },
    });
    expect(events.find(({ type }) => type === 'model.output.delta')).toMatchObject({
      payload: {
        teamDelegationId: 'plan',
        teamAgentName: 'planner',
      },
    });
  });

  test('validates team membership and operational limits', async () => {
    expect(
      getConfigurationError({
        models: { default: modelWithOutput('ok') },
        agents: [agent('planner')],
        teams: [
          defineTeam({
            name: 'invalid-team',
            supervisor: 'missing',
            members: [],
            run() {},
          }),
        ],
      }).code,
    ).toBe('INVALID_TEAM');

    const app = createFevex({
      models: { default: modelWithOutput('ok') },
      agents: [agent('planner'), agent('worker')],
      teams: [
        defineTeam({
          name: 'limited-team',
          supervisor: 'planner',
          members: [{ agent: 'worker', role: 'work' }],
          limits: { maxDelegations: 1, maxParallel: 1 },
          async run(team, input) {
            await team.delegate('first', { agent: 'worker', task: input });
            return team.delegate('second', { agent: 'worker', task: input });
          },
        }),
      ],
    });

    await expect(app.runTeam('limited-team', { input: 'work' })).rejects.toThrow(
      'exceeded maxDelegations limit of 1',
    );
  });

  test('resumes supervisor, parallel work and review without repeating delegations', async () => {
    const store = new InMemoryRunStore();
    const modelCalls = new Map<string, number>();
    let toolExecutions = 0;
    const team = defineTeam({
      name: 'approval-team',
      supervisor: 'planner',
      members: [
        { agent: 'researcher', role: 'research' },
        { agent: 'coder', role: 'implementation' },
        { agent: 'reviewer', role: 'review' },
      ],
      limits: { maxDelegations: 4, maxParallel: 2 },
      async run(step, input) {
        const plan = await step.delegate<string, string>('plan', {
          agent: 'planner',
          task: input as string,
        });
        const work = await step.parallel('work', {
          research: () =>
            step.delegate<string, string>('research', {
              agent: 'researcher',
              task: plan.output,
            }),
          implementation: () =>
            step.delegate<string, string>('implementation', {
              agent: 'coder',
              task: plan.output,
            }),
        });
        return (
          await step.handoff('review', {
            from: 'coder',
            to: 'reviewer',
            reason: 'Final review',
            task: {
              research: work.research.output,
              implementation: work.implementation.output,
            },
          })
        ).output;
      },
    });
    const makeApp = (onEvent?: (event: AgentEvent) => void) =>
      createFevex({
        models: {
          default: {
            stateCodec: {
              serialize(state) {
                return structuredClone(state) as JsonObject;
              },
              restore(state) {
                return structuredClone(state);
              },
            },
            stream: streamFrom(async (input) => {
              const role = input.messages[0]!.content;
              modelCalls.set(role, (modelCalls.get(role) ?? 0) + 1);
              if (role !== 'reviewer') return { output: `${role}-done` };
              return input.providerState === undefined
                ? { toolCalls: [lookupCall], providerState: { turn: 1 } }
                : { output: 'approved' };
            }),
          },
        },
        agents: [
          agent('planner', { instructions: 'planner' }),
          agent('researcher', { instructions: 'researcher' }),
          agent('coder', { instructions: 'coder' }),
          agent('reviewer', { instructions: 'reviewer', tools: ['lookup'] }),
        ],
        tools: [
          defineTool({
            name: 'lookup',
            approval: 'required',
            risk: 'write',
            execute() {
              toolExecutions += 1;
              return 'ok';
            },
          }),
        ],
        teams: [team],
        runStore: store,
        ...(onEvent ? { onEvent } : {}),
      });

    let paused!: RunPausedError;
    await makeApp().runTeam('approval-team', { input: 'build' }).catch((error) => {
      paused = error as RunPausedError;
    });
    expect(paused.pause.type).toBe('workflow_child');
    const childPause = paused.pause.type === 'workflow_child' ? paused.pause.childPause : undefined;
    const approvalId = childPause?.type === 'approval' ? childPause.approval.id : '';

    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await makeApp((event) => {
      if (event.runId === paused.runId && event.type === 'team.run.completed') finish();
    }).resumeRun(paused.runId, {
      type: 'approval',
      approvalId,
      decision: 'approve',
      actor: { id: 'operator' },
    });
    await completed;

    expect(Object.fromEntries(modelCalls)).toEqual({
      planner: 1,
      researcher: 1,
      coder: 1,
      reviewer: 2,
    });
    expect(toolExecutions).toBe(1);
    const events = await store.listEvents(paused.runId);
    expect(events.filter(({ type }) => type === 'team.agent.assigned')).toHaveLength(4);
    expect(events.filter(({ type }) => type === 'team.task.completed')).toHaveLength(4);
    expect(events.filter(({ type }) => type === 'team.merge.completed')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'team.handoff.created')).toHaveLength(1);
    expect(events.map(({ type }) => type)).toContain('team.run.resumed');
    expect(await store.getRun(paused.runId)).toMatchObject({
      kind: 'team',
      status: 'completed',
      output: 'approved',
    });
  });

  test('streams and cancels team runs through the shared runtime controls', async () => {
    const team = defineTeam({
      name: 'single-team',
      supervisor: 'worker',
      members: [],
      async run(step, input) {
        return (await step.delegate('work', { agent: 'worker', task: input })).output;
      },
    });
    const completedApp = createFevex({
      models: { default: modelWithOutput('done') },
      agents: [agent('worker')],
      teams: [team],
    });
    const streamed: AgentEvent[] = [];
    for await (const event of completedApp.streamTeam('single-team', { input: 'go' })) {
      streamed.push(event);
    }
    expect(streamed.at(0)?.type).toBe('team.run.started');
    expect(streamed.at(-1)?.type).toBe('team.run.completed');

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runningApp = createFevex({
      models: {
        default: {
          async *stream(input) {
            markStarted();
            await new Promise<void>((resolve) => {
              input.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        },
      },
      agents: [agent('worker')],
      teams: [team],
    });
    const run = await runningApp.startTeam('single-team', { input: 'wait' });
    await started;
    expect(await runningApp.cancelRun(run.id)).toBe(true);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await runningApp.getTeamRun(run.id))?.status !== 'running') break;
      await Bun.sleep(2);
    }
    expect(await runningApp.getTeamRun(run.id)).toMatchObject({ status: 'cancelled' });
    expect((await runningApp.listEvents(run.id)).at(-1)?.type).toBe(
      'team.run.cancelled',
    );
  });

  test('recovers a running team child without repeating its delegation', async () => {
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
    const team = defineTeam({
      name: 'recover-team',
      version: '1',
      supervisor: 'worker',
      members: [],
      async run(step, input) {
        return (await step.delegate('only-child', { agent: 'worker', task: input })).output;
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
      teams: [team],
      runStore: store,
    });
    const parent = await crashedRuntime.startTeam('recover-team', { input: 'go' });
    await childStarted;
    const checkpoint = await store.getCheckpoint<any>(parent.id);
    const childRunId = checkpoint?.steps['only-child'].childRunId as string;
    await store.releaseLease(parent.id, store.leaseOwners.get(parent.id)!);
    await store.releaseLease(childRunId, store.leaseOwners.get(childRunId)!);

    const recoveredRuntime = createFevex({
      models: { default: modelWithOutput('recovered') },
      agents: [agent('worker')],
      teams: [team],
      runStore: store,
    });
    await recoveredRuntime.recoverRun(parent.id, { actor: { id: 'team-worker' } });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await store.getRun(parent.id))?.status !== 'running') break;
      await Bun.sleep(2);
    }

    expect(await store.getRun(parent.id)).toMatchObject({
      kind: 'team',
      status: 'completed',
      output: 'recovered',
    });
    const events = await store.listEvents(parent.id);
    expect(events.filter(({ type }) => type === 'team.agent.assigned')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'team.task.completed')).toHaveLength(1);
    expect(events.map(({ type }) => type)).toContain('team.run.recovered');
    releaseCrashedChild();
    await Bun.sleep(2);
  });
});
