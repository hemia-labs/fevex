import type { AgentEvent, AgentEventPayloads, AgentEventType, JsonValue } from '../core';
import { FevexRunError, RunPausedError } from '../run-error';
import {
  isDurableRunStore,
  type AgentRunPause,
  type AgentRun,
  type DurableRunStore,
  type ResumeRunResolution,
  type RunRequest,
  type RunResult,
  type Session,
  type CoordinatorCheckpoint,
  type CoordinatorRun,
  type WorkflowBudgetUsage,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '../runtime';
import type {
  WorkflowAgentResult,
  WorkflowEventResult,
  WorkflowStep,
  WorkflowStepContext,
  WorkflowStepOptions,
} from '../workflows';
import type { FevexComposition } from './configuration';
import { definitionHash, teamDefinitionHash, workflowDefinitionHash } from './definition-hash';
import { toJsonValue } from './json';
import { abortable, cancellationReason, eventUsage, toErrorMessage } from './run-support';
import { validateSchema } from './schemas';
import {
  addWorkflowBudget,
  assertWorkflowBudget,
  combineLimits,
  remainingWorkflowLimits,
} from './workflow-budget';
import {
  coordinatorName,
  isTeamRun,
  mergeExecutionContext,
  pauseMatchesResolution,
  runErrorPayload,
  WorkflowChildPausedError,
} from './run-helpers';
import type { WorkflowExecutionState } from './run-state';
import { LEASE_MS } from './runtime-constants';
import type { AgentEngine } from './agent-engine';
import type { RunCore } from './run-core';

/**
 * Coordination on top of the agent engine: durable workflow and team runs,
 * the step API, compensation, waits, and resume.
 *
 * It receives {@link AgentEngine} explicitly. That is what makes the old
 * forward reference from workflow cancellation into agent cancellation a
 * declared dependency instead of a call resolved 2,900 lines later.
 */
export function createWorkflowEngine(
  composition: FevexComposition,
  core: RunCore,
  agentEngine: AgentEngine,
) {
  const { models, agents, workflows, teams, runStore } = composition;
  const {
    activeRuns,
    activeWorkflowRuns,
    activeSessions,
    runtimeOwner,
    createEvent,
    createCoordinatorEvent,
    notifyObserver,
    commit,
    startLease,
    releaseWorkflowExecution,
    commitWorkflow,
  } = core;
  const {
    prepareExecution,
    executeAgent,
    nextEvent,
    resumeAgent,
    cancelStoredAgent,
  } = agentEngine;

  const cancelWorkflowExecution = async (
    state: WorkflowExecutionState,
    reason: AgentEventPayloads['workflow.run.cancelled']['reason'] = cancellationReason(
      state.request.signal,
    ),
  ): Promise<AgentEvent | undefined> => {
    if (
      state.run.status === 'completed' ||
      state.run.status === 'failed' ||
      state.run.status === 'cancelled'
    ) {
      return undefined;
    }
    const childRunIds = Object.values(state.checkpoint.steps)
      .filter(
        (record): record is Extract<
          WorkflowStepRecord,
          { type: 'agent'; status: 'running' }
        > => record.type === 'agent' && record.status === 'running',
      )
      .map(({ childRunId }) => childRunId);
    for (const childRunId of childRunIds) {
      if (!(await cancelStoredAgent(childRunId))) {
        throw new FevexRunError(
          'RUN_CONFLICT',
          `Workflow child "${childRunId}" could not be cancelled`,
          state.run.id,
        );
      }
    }
    state.run.status = 'cancelled';
    state.run.pause = undefined;
    state.run.error = reason;
    state.run.usage = state.checkpoint.budget?.usage;
    const event = createCoordinatorEvent(
      state,
      'workflow.run.cancelled',
      { reason },
      'team.run.cancelled',
    );
    await commit(state, { checkpoint: null, events: [event] });
    await releaseWorkflowExecution(state);
    return event;
  };

  const prepareWorkflowExecution = async <TInput, TOutput>(
    name: string,
    request: RunRequest<TInput, TOutput>,
    kind: 'workflow' | 'team' = 'workflow',
  ): Promise<WorkflowExecutionState<TInput, TOutput>> => {
    const workflow = workflows.get(name);
    const team = kind === 'team' ? teams.get(name) : undefined;
    if (
      !workflow
      || (kind === 'team' && !team)
      || (kind === 'workflow' && teams.has(name))
    ) {
      const owner = kind === 'team' ? 'Team' : 'Workflow';
      throw new FevexRunError(
        kind === 'team' ? 'TEAM_NOT_FOUND' : 'WORKFLOW_NOT_FOUND',
        `${owner} "${name}" is not registered`,
      );
    }
    if (!isDurableRunStore(runStore)) {
      throw new FevexRunError(
        'DURABLE_STORE_REQUIRED',
        `${kind === 'team' ? 'Teams' : 'Workflows'} require a DurableRunStore`,
      );
    }
    const now = new Date().toISOString();
    let session: Session;
    const newSession = request.sessionId === undefined;
    if (newSession) {
      session = { id: crypto.randomUUID(), history: [], createdAt: now, updatedAt: now };
    } else {
      const stored = await runStore.getSession(request.sessionId!);
      if (!stored) {
        throw new FevexRunError(
          'SESSION_NOT_FOUND',
          `Session "${request.sessionId}" does not exist`,
        );
      }
      session = stored;
    }
    if (activeSessions.has(session.id)) {
      throw new FevexRunError('RUN_CONFLICT', `Session "${session.id}" already has an active run`);
    }
    activeSessions.add(session.id);
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([controller.signal, request.signal])
      : controller.signal;
    const validatedInput =
      workflow.inputSchema === undefined
        ? request.input
        : await abortable(
            () =>
              validateSchema(
                workflow.inputSchema!,
                request.input,
                `Input for ${kind} "${name}" does not match inputSchema`,
              ),
            signal,
          );
    const input = toJsonValue(
      validatedInput,
      `${kind === 'team' ? 'Team' : 'Workflow'} input must be a string or JSON-serializable value`,
    );
    const id = crypto.randomUUID();
    const run: CoordinatorRun =
      kind === 'team'
        ? {
            kind: 'team',
            id,
            sessionId: session.id,
            teamName: name,
            status: 'running',
            revision: 0,
            createdAt: now,
            updatedAt: now,
          }
        : {
            kind: 'workflow',
            id,
            sessionId: session.id,
            workflowName: name,
            status: 'running',
            revision: 0,
            createdAt: now,
            updatedAt: now,
          };
    const checkpoint: CoordinatorCheckpoint =
      kind === 'team'
        ? {
            version: 2,
            kind: 'team',
            runId: run.id,
            teamName: name,
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
            definitionHash: await teamDefinitionHash(name, team!),
            input,
            context: request.context,
            steps: {},
            limits: combineLimits(workflow.limits, request.limits),
          }
        : {
            version: 2,
            kind: 'workflow',
            runId: run.id,
            workflowName: name,
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
            definitionHash: await workflowDefinitionHash(name, workflow),
            input,
            context: request.context,
            steps: {},
            limits: combineLimits(workflow.limits, request.limits),
          };
    const state: WorkflowExecutionState<TInput, TOutput> = {
      run,
      session,
      request: { ...request, sessionId: session.id, signal },
      controller,
      eventSequence: 0,
      checkpoint,
      advancing: false,
      commitQueue: Promise.resolve(),
    };
    try {
      const ownerId = `${runtimeOwner}:${crypto.randomUUID()}`;
      const started = createCoordinatorEvent(
        state,
        'workflow.run.started',
        undefined,
        'team.run.started',
      );
      const created = await runStore.createExecution({
        run,
        checkpoint,
        ...(newSession ? { session } : {}),
        lease: {
          runId: run.id,
          ownerId,
          expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
        },
        events: [started],
      });
      if (!created) throw new FevexRunError('RUN_CONFLICT', `Run "${run.id}" exists`, run.id);
      state.leaseOwner = ownerId;
      state.initialEvents = [started];
      notifyObserver(started);
      startLease(state, runStore);
    } catch (error) {
      activeSessions.delete(session.id);
      throw error;
    }
    activeWorkflowRuns.set(run.id, state as WorkflowExecutionState);
    return state;
  };

  async function* executeWorkflow<TInput = unknown, TOutput = unknown>(
    name: string,
    state: WorkflowExecutionState<TInput, TOutput>,
  ): AsyncGenerator<AgentEvent, RunResult<TOutput> | undefined> {
    const workflow = workflows.get(name)!;
    const events: AgentEvent[] = [];
    let parallelDepth = 0;
    const compensationHandlers = new Map<string, {
      kind: 'agent' | 'parallel';
      run(result: JsonValue): Promise<void>;
    }>();
    const emit = async <TType extends AgentEventType>(
      type: TType,
      payload: AgentEventPayloads[TType],
    ): Promise<AgentEvent> => {
      const event = createEvent(state, type, payload) as AgentEvent;
      await commitWorkflow(state, () => {}, [event]);
      events.push(event);
      return event;
    };
    const pauseForChild = async (
      stepId: string,
      error: RunPausedError,
    ): Promise<never> => {
      if (parallelDepth > 0) throw new WorkflowChildPausedError(stepId, error);
      const childPause = error.pause;
      if (childPause.type === 'workflow_child' || childPause.type === 'workflow_children') {
        throw error;
      }
      if (childPause.type === 'workflow_timer' || childPause.type === 'workflow_event') {
        throw new FevexRunError(
          'RUN_NOT_RESUMABLE',
          `Workflow child "${error.runId}" paused for a workflow wait`,
          state.run.id,
        );
      }
      const event = createCoordinatorEvent(
        state,
        'workflow.run.paused',
        { stepId, reason: 'child', childRunId: error.runId },
        'team.run.paused',
        { delegationId: stepId, reason: 'child', childRunId: error.runId },
      );
      await commitWorkflow(
        state,
        () => {
          state.run.status = 'paused';
          state.run.pause = {
            type: 'workflow_child',
            childRunId: error.runId,
            childPause,
          };
        },
        [event],
      );
      events.push(event);
      await releaseWorkflowExecution(state);
      throw new RunPausedError(state.run.id, state.run.pause!);
    };
    const compensationContext = (stepId: string): WorkflowStepContext => ({
      runId: state.run.id,
      sessionId: state.session.id,
      stepId,
      context: state.request.context,
      signal: state.request.signal,
    });
    const registerCompensation = <TResult>(
      stepId: string,
      kind: 'agent' | 'parallel',
      result: TResult,
      options: WorkflowStepOptions<TResult> | undefined,
    ): void => {
      if (!options?.compensate) return;
      compensationHandlers.set(stepId, {
        kind,
        async run() {
          await options.compensate!(structuredClone(result), compensationContext(stepId));
        },
      });
    };
    const childBudget = async (result: RunResult<JsonValue>): Promise<WorkflowBudgetUsage> => {
      const childEvents = await runStore.listEvents(result.runId);
      return {
        usage: result.usage,
        steps: childEvents.filter(({ type }) => type === 'model.completed').length,
        toolCalls: childEvents.filter(({ type }) => type === 'tool.completed').length,
      };
    };
    const addChildBudget = (budget: WorkflowBudgetUsage): void => {
      state.checkpoint.budget = addWorkflowBudget(state.checkpoint.budget, budget);
      state.run.usage = state.checkpoint.budget?.usage;
    };
    const relayChildEvent = async (
      event: AgentEvent,
      stepId: string,
      agentName: string,
    ): Promise<void> => {
      if (
        event.type !== 'model.started' &&
        event.type !== 'model.output.delta' &&
        event.type !== 'model.completed' &&
        event.type !== 'tool.started' &&
        event.type !== 'tool.completed' &&
        event.type !== 'tool.failed' &&
        event.type !== 'tool.retrying' &&
        event.type !== 'tool.execution_unknown' &&
        event.type !== 'elicitation.requested' &&
        event.type !== 'elicitation.resolved' &&
        event.type !== 'approval.requested' &&
        event.type !== 'approval.resolved'
      ) return;

      const relayed = createEvent(state, event.type, {
        ...(event.payload as object),
        ...(isTeamRun(state.run)
          ? { teamDelegationId: stepId, teamAgentName: agentName }
          : { workflowStepId: stepId, workflowAgentName: agentName }),
      } as never) as AgentEvent;
      await commitWorkflow(state, () => {}, [relayed]);
      events.push(relayed);
    };
    const runCompensations = async (): Promise<void> => {
      const entries = Object.entries(state.checkpoint.steps).reverse();
      for (const [stepId, record] of entries) {
        if (
          (record.type !== 'agent' && record.type !== 'parallel') ||
          record.status !== 'completed' ||
          record.compensation?.status !== 'pending'
        ) continue;
        const handler = compensationHandlers.get(stepId);
        if (!handler) throw new Error(`Workflow step "${stepId}" has no compensation handler`);
        const started = createEvent(state, 'workflow.compensation.started', {
          stepId,
          kind: handler.kind,
        }) as AgentEvent;
        await commitWorkflow(state, () => {}, [started]);
        events.push(started);
        try {
          await abortable(() => handler.run(record.result as JsonValue), state.request.signal);
          const completed = createEvent(state, 'workflow.compensation.completed', {
            stepId,
            kind: handler.kind,
          }) as AgentEvent;
          await commitWorkflow(
            state,
            () => {
              record.compensation = { status: 'completed' };
            },
            [completed],
          );
          events.push(completed);
        } catch (error) {
          const failed = createEvent(state, 'workflow.compensation.failed', {
            stepId,
            kind: handler.kind,
            error: toErrorMessage(error),
          }) as AgentEvent;
          await commitWorkflow(
            state,
            () => {
              record.compensation = { status: 'failed', error: toErrorMessage(error) };
            },
            [failed],
          );
          events.push(failed);
          throw error;
        }
      }
    };
    const completeAgentStep = async (
      stepId: string,
      agentName: string,
      childRunId: string,
      output: JsonValue,
      options?: WorkflowStepOptions<WorkflowAgentResult<JsonValue>>,
    ): Promise<WorkflowAgentResult<JsonValue>> => {
      const child = (await runStore.getRun<AgentRun>(childRunId))!;
      const result: WorkflowAgentResult<JsonValue> = {
        runId: childRunId,
        sessionId: child.sessionId,
        output,
        ...(child.usage === undefined ? {} : { usage: child.usage }),
      };
      const budget = await childBudget(result);
      const event = createCoordinatorEvent(
        state,
        'workflow.step.completed',
        { stepId, kind: 'agent' },
        'team.task.completed',
        {
          delegationId: stepId,
          agentName,
          ...(eventUsage(child.usage) === undefined
            ? {}
            : { usage: eventUsage(child.usage)! }),
        },
      );
      await commitWorkflow(
        state,
        () => {
          addChildBudget(budget);
          state.checkpoint.steps[stepId] = {
            type: 'agent',
            status: 'completed',
            agentName,
            childRunId,
            result,
            ...(options?.metadata === undefined
              ? {}
              : { metadata: structuredClone(options.metadata) }),
            ...(options?.compensate === undefined
              ? {}
              : { compensation: { status: 'pending' as const } }),
          };
        },
        [event],
      );
      if (options?.compensate) registerCompensation(stepId, 'agent', result, options);
      events.push(event);
      assertWorkflowBudget(name, state.checkpoint.limits, state.checkpoint.budget);
      return structuredClone(result);
    };
    const step: WorkflowStep = {
      async agent<TStepInput = unknown, TStepOutput = unknown>(
        stepId: string,
        agentName: string,
        request: RunRequest<TStepInput, TStepOutput>,
        options?: WorkflowStepOptions<WorkflowAgentResult<TStepOutput>>,
      ): Promise<WorkflowAgentResult<TStepOutput>> {
        if (!stepId.trim()) throw new Error('Workflow step id cannot be empty');
        const existing = state.checkpoint.steps[stepId];
        if (existing?.type === 'agent' && existing.status === 'completed') {
          const result = structuredClone(existing.result) as WorkflowAgentResult<TStepOutput>;
          registerCompensation(stepId, 'agent', result, options);
          return result;
        }
        if (existing?.type === 'agent' && existing.status === 'running') {
          let child = await runStore.getRun(existing.childRunId);
          if (!child) throw new Error(`Child run "${existing.childRunId}" does not exist`);
          if (child.status === 'running') {
            if (!state.recoveryActor) {
              throw new FevexRunError(
                'RUN_NOT_RECOVERABLE',
                `Child run "${child.id}" is still running`,
                state.run.id,
              );
            }
            child = await resumeAgent(
              child.id,
              undefined,
              true,
              state.recoveryActor,
            );
          }
          if (child.status === 'completed') {
            return completeAgentStep(
              stepId,
              existing.agentName,
              existing.childRunId,
              toJsonValue(child.output, 'Child agent output must be JSON-serializable'),
              options as WorkflowStepOptions<WorkflowAgentResult<JsonValue>>,
            ) as Promise<WorkflowAgentResult<TStepOutput>>;
          }
          if (child.status === 'paused' && child.pause) {
            return pauseForChild(stepId, new RunPausedError(child.id, child.pause));
          }
          if (child.status === 'failed' || child.status === 'cancelled') {
            throw new Error(`Child run "${child.id}" ${child.status}`);
          }
        }
        if (existing && existing.type !== 'agent') {
          throw new Error(`Workflow step "${stepId}" was already used as ${existing.type}`);
        }
        if (!agents.has(agentName)) {
          throw new FevexRunError('AGENT_NOT_FOUND', `Agent "${agentName}" is not registered`);
        }
        const childSignal = request.signal
          ? AbortSignal.any([state.request.signal, request.signal])
          : state.request.signal;
        const childState = await prepareExecution(agentName, {
          ...request,
          model: request.model ?? state.request.model,
          reasoning: request.reasoning ?? state.request.reasoning,
          context: mergeExecutionContext(state.request.context, request.context),
          limits: combineLimits(
            request.limits,
            remainingWorkflowLimits(state.checkpoint.limits, state.checkpoint.budget),
          ),
          signal: childSignal,
        });
        const action = options?.metadata?.teamAction === 'handoff' ? 'handoff' : 'delegate';
        const lifecycleEvents: AgentEvent[] = [];
        if (isTeamRun(state.run) && action === 'handoff') {
          lifecycleEvents.push(
            createEvent(state, 'team.handoff.created', {
              delegationId: stepId,
              from: String(options?.metadata?.from ?? ''),
              to: agentName,
              reason: String(options?.metadata?.reason ?? ''),
            }) as AgentEvent,
          );
        }
        const started = createCoordinatorEvent(
          state,
          'workflow.step.started',
          { stepId, kind: 'agent', agentName },
          'team.agent.assigned',
          {
            delegationId: stepId,
            agentName,
            action,
            ...(typeof options?.metadata?.expectedOutput === 'string'
              ? { expectedOutput: options.metadata.expectedOutput }
              : {}),
            ...(Array.isArray(options?.metadata?.constraints)
              ? { constraints: options.metadata.constraints }
              : {}),
          },
        );
        lifecycleEvents.push(started);
        await commitWorkflow(
          state,
          () => {
            state.checkpoint.steps[stepId] = {
              type: 'agent',
              status: 'running',
              agentName,
              childRunId: childState.run.id,
              ...(options?.metadata === undefined
                ? {}
                : { metadata: structuredClone(options.metadata) }),
            };
          },
          lifecycleEvents,
        );
        events.push(...lifecycleEvents);
        try {
          const execution = executeAgent(agentName, childState);
          let result: RunResult<TStepOutput> | undefined;
          while (true) {
            const next = await nextEvent(childState, execution);
            if (next.done) {
              if (next.value === undefined) {
                const run = await runStore.getRun(childState.run.id);
                if (run?.pause) throw new RunPausedError(run.id, run.pause);
              }
              result = next.value as RunResult<TStepOutput> | undefined;
              break;
            }
            await relayChildEvent(next.value, stepId, agentName);
          }
          if (!result) throw new Error(`Agent "${agentName}" did not complete`);
          const normalized: WorkflowAgentResult<TStepOutput> = {
            runId: result.runId,
            sessionId: result.sessionId,
            output: result.output,
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          };
          const budget = await childBudget(normalized as RunResult<JsonValue>);
          const completed = createCoordinatorEvent(
            state,
            'workflow.step.completed',
            { stepId, kind: 'agent' },
            'team.task.completed',
            {
              delegationId: stepId,
              agentName,
              ...(eventUsage(normalized.usage) === undefined
                ? {}
                : { usage: eventUsage(normalized.usage)! }),
            },
          );
          await commitWorkflow(
            state,
            () => {
              addChildBudget(budget);
              state.checkpoint.steps[stepId] = {
                type: 'agent',
                status: 'completed',
                agentName,
                childRunId: normalized.runId,
                result: structuredClone(normalized) as RunResult<JsonValue>,
                ...(options?.metadata === undefined
                  ? {}
                  : { metadata: structuredClone(options.metadata) }),
                ...(options?.compensate === undefined
                  ? {}
                  : { compensation: { status: 'pending' as const } }),
              };
            },
            [completed],
          );
          registerCompensation(stepId, 'agent', normalized, options);
          events.push(completed);
          assertWorkflowBudget(name, state.checkpoint.limits, state.checkpoint.budget);
          return normalized;
        } catch (error) {
          if (error instanceof RunPausedError) return pauseForChild(stepId, error);
          const failed = createCoordinatorEvent(
            state,
            'workflow.step.failed',
            { stepId, kind: 'agent', error: toErrorMessage(error) },
            'team.task.failed',
            { delegationId: stepId, agentName, error: toErrorMessage(error) },
          );
          await commitWorkflow(state, () => {}, [failed]);
          events.push(failed);
          throw error;
        }
      },
      async parallel<TTasks extends Record<string, () => Promise<unknown>>>(
        stepId: string,
        tasks: TTasks,
        options?: WorkflowStepOptions<{ [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>> }>,
      ): Promise<{ [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>> }> {
        if (!stepId.trim()) throw new Error('Workflow step id cannot be empty');
        const existing = state.checkpoint.steps[stepId];
        if (existing?.type === 'parallel' && existing.status === 'completed') {
          const result = structuredClone(existing.result) as {
            [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>>;
          };
          registerCompensation(stepId, 'parallel', result, options);
          return result;
        }
        if (existing && existing.type !== 'parallel') {
          throw new Error(`Workflow step "${stepId}" was already used as ${existing.type}`);
        }
        const started = createCoordinatorEvent(
          state,
          'workflow.step.started',
          { stepId, kind: 'parallel' },
          'team.merge.started',
          {
            stepId,
            width:
              typeof options?.metadata?.width === 'number'
                ? options.metadata.width
                : Object.keys(tasks).length,
          },
        );
        await commitWorkflow(
          state,
          () => {
            state.checkpoint.steps[stepId] = {
              type: 'parallel',
              status: 'running',
              ...(options?.metadata === undefined
                ? {}
                : { metadata: structuredClone(options.metadata) }),
            };
          },
          [started],
        );
        events.push(started);
        try {
          parallelDepth += 1;
          const taskEntries = Object.entries(tasks);
          let settled: PromiseSettledResult<readonly [string, unknown]>[];
          try {
            settled = await Promise.allSettled(
              taskEntries.map(async ([key, task]) => [key, await task()] as const),
            );
          } finally {
            parallelDepth -= 1;
          }
          const failures = settled
            .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
            .map(({ reason }) => reason);
          const pauses = failures.filter(
            (error): error is WorkflowChildPausedError =>
              error instanceof WorkflowChildPausedError,
          );
          const errors = failures.filter(
            (error) => !(error instanceof WorkflowChildPausedError),
          );
          if (errors.length) {
            for (const pause of pauses) {
              if (!(await cancelStoredAgent(pause.paused.runId))) {
                throw new FevexRunError(
                  'RUN_CONFLICT',
                  `Paused workflow child "${pause.paused.runId}" could not be cancelled`,
                  state.run.id,
                );
              }
            }
            throw errors.length === 1
              ? errors[0]
              : new AggregateError(errors, `Workflow parallel step "${stepId}" failed`);
          }
          if (pauses.length) {
            if (pauses.length > 1) {
              const event = createCoordinatorEvent(
                state,
                'workflow.run.paused',
                { stepId, reason: 'child', childRunId: pauses[0]!.paused.runId },
                'team.run.paused',
                { delegationId: stepId, reason: 'child', childRunId: pauses[0]!.paused.runId },
              );
              await commitWorkflow(
                state,
                () => {
                  state.run.status = 'paused';
                  state.run.pause = {
                    type: 'workflow_children',
                    children: pauses.map((pause) => ({
                      stepId: pause.stepId,
                      childRunId: pause.paused.runId,
                      childPause: pause.paused.pause as AgentRunPause,
                    })),
                  };
                },
                [event],
              );
              events.push(event);
              await releaseWorkflowExecution(state);
              throw new RunPausedError(state.run.id, state.run.pause!);
            }
            return pauseForChild(pauses[0]!.stepId, pauses[0]!.paused);
          }
          const entries = settled.map(
            (item) => (item as PromiseFulfilledResult<readonly [string, unknown]>).value,
          );
          const result = toJsonValue(
            Object.fromEntries(entries),
            `Workflow parallel step "${stepId}" result must be JSON-serializable`,
          );
          if (typeof result !== 'object' || result === null || Array.isArray(result)) {
            throw new Error(`Workflow parallel step "${stepId}" result must be an object`);
          }
          const completed = createCoordinatorEvent(
            state,
            'workflow.step.completed',
            { stepId, kind: 'parallel' },
            'team.merge.completed',
            { stepId },
          );
          await commitWorkflow(
            state,
            () => {
              state.checkpoint.steps[stepId] = {
                type: 'parallel',
                status: 'completed',
                result,
                ...(options?.metadata === undefined
                  ? {}
                  : { metadata: structuredClone(options.metadata) }),
                ...(options?.compensate === undefined
                  ? {}
                  : { compensation: { status: 'pending' as const } }),
              };
            },
            [completed],
          );
          registerCompensation(
            stepId,
            'parallel',
            structuredClone(result) as {
              [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>>;
            },
            options,
          );
          events.push(completed);
          return structuredClone(result) as {
            [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>>;
          };
        } catch (error) {
          if (error instanceof RunPausedError) throw error;
          const failed = createCoordinatorEvent(
            state,
            'workflow.step.failed',
            { stepId, kind: 'parallel', error: toErrorMessage(error) },
            'team.merge.failed',
            { stepId, error: toErrorMessage(error) },
          );
          await commitWorkflow(state, () => {}, [failed]);
          events.push(failed);
          throw error;
        }
      },
      async waitUntil(stepId: string, resumeAt: string | Date): Promise<void> {
        if (!stepId.trim()) throw new Error('Workflow step id cannot be empty');
        const existing = state.checkpoint.steps[stepId];
        if (existing?.type === 'wait' && existing.status === 'completed') return;
        if (existing && existing.type !== 'wait') {
          throw new Error(`Workflow step "${stepId}" was already used as ${existing.type}`);
        }
        const at = resumeAt instanceof Date ? resumeAt : new Date(resumeAt);
        if (!Number.isFinite(at.getTime())) {
          throw new Error(`Workflow wait "${stepId}" resumeAt must be a valid date`);
        }
        const wait = { type: 'timer' as const, resumeAt: at.toISOString() };
        if (Date.now() >= at.getTime()) {
          const started = createEvent(state, 'workflow.wait.started', {
            stepId,
            kind: 'timer',
            resumeAt: wait.resumeAt,
          }) as AgentEvent;
          const completed = createEvent(state, 'workflow.wait.completed', {
            stepId,
            kind: 'timer',
          }) as AgentEvent;
          await commitWorkflow(
            state,
            () => {
              state.checkpoint.steps[stepId] = { type: 'wait', status: 'completed', wait };
            },
            [started, completed],
          );
          events.push(started, completed);
          return;
        }
        const started = createEvent(state, 'workflow.wait.started', {
          stepId,
          kind: 'timer',
          resumeAt: wait.resumeAt,
        }) as AgentEvent;
        const paused = createEvent(state, 'workflow.run.paused', {
          stepId,
          reason: 'timer',
        }) as AgentEvent;
        await commitWorkflow(
          state,
          () => {
            state.checkpoint.steps[stepId] = { type: 'wait', status: 'running', wait };
            state.run.status = 'paused';
            state.run.pause = { type: 'workflow_timer', stepId, resumeAt: wait.resumeAt };
          },
          [started, paused],
        );
        events.push(started, paused);
        await releaseWorkflowExecution(state);
        throw new RunPausedError(state.run.id, state.run.pause!);
      },
      async waitForEvent<TPayload extends JsonValue = JsonValue>(
        stepId: string,
        eventName: string,
      ): Promise<WorkflowEventResult<TPayload>> {
        if (!stepId.trim()) throw new Error('Workflow step id cannot be empty');
        if (!eventName.trim()) throw new Error('Workflow event name cannot be empty');
        const definition = workflow.events?.[eventName];
        if (!definition) {
          throw new Error(`Workflow event "${eventName}" is not declared`);
        }
        const existing = state.checkpoint.steps[stepId];
        if (existing?.type === 'wait' && existing.status === 'completed') {
          return {
            ...(existing.payload === undefined ? {} : { payload: existing.payload as TPayload }),
            ...(existing.actor === undefined ? {} : { actor: existing.actor }),
            receivedAt: existing.receivedAt!,
          };
        }
        if (existing && existing.type !== 'wait') {
          throw new Error(`Workflow step "${stepId}" was already used as ${existing.type}`);
        }
        const wait = {
          type: 'event' as const,
          eventName,
          requireActor: definition.requireActor ?? false,
        };
        const started = createEvent(state, 'workflow.wait.started', {
          stepId,
          kind: 'event',
          eventName,
        }) as AgentEvent;
        const paused = createEvent(state, 'workflow.run.paused', {
          stepId,
          reason: 'event',
        }) as AgentEvent;
        await commitWorkflow(
          state,
          () => {
            state.checkpoint.steps[stepId] = { type: 'wait', status: 'running', wait };
            state.run.status = 'paused';
            state.run.pause = { type: 'workflow_event', stepId, eventName };
          },
          [started, paused],
        );
        events.push(started, paused);
        await releaseWorkflowExecution(state);
        throw new RunPausedError(state.run.id, state.run.pause!);
      },
    };

    const firstEvents = state.initialEvents ?? [];
    state.initialEvents = undefined;
    events.push(...firstEvents);

    try {
      for (const event of firstEvents) yield event;
      if (state.checkpoint.version !== 2) {
        throw new FevexRunError(
          'CHECKPOINT_UNSUPPORTED',
          `Checkpoint for run "${state.run.id}" is unsupported`,
          state.run.id,
        );
      }
      const hash = isTeamRun(state.run)
        ? await teamDefinitionHash(name, teams.get(name)!)
        : await workflowDefinitionHash(name, workflow);
      if (state.checkpoint.definitionHash !== hash) {
        const owner = isTeamRun(state.run) ? 'Team' : 'Workflow';
        throw new FevexRunError(
          'RUN_DEFINITION_CHANGED',
          `Definition for ${owner.toLowerCase()} "${name}" changed`,
          state.run.id,
        );
      }
      state.request.signal.throwIfAborted();
      const rawOutput = await workflow.run(step, state.checkpoint.input as TInput);
      const validated =
        workflow.outputSchema === undefined
          ? rawOutput
          : await validateSchema(
              workflow.outputSchema,
              rawOutput,
              `Output from ${isTeamRun(state.run) ? 'team' : 'workflow'} "${name}" does not match outputSchema`,
            );
      const output = toJsonValue(
        validated,
        `Output from ${isTeamRun(state.run) ? 'team' : 'workflow'} "${name}" must be JSON-serializable`,
      );
      await state.commitQueue;
      state.run.status = 'completed';
      state.run.pause = undefined;
      state.run.output = output;
      state.run.usage = state.checkpoint.budget?.usage;
      const completedPayload = {
        output,
        ...(eventUsage(state.run.usage) === undefined
          ? {}
          : { usage: eventUsage(state.run.usage)! }),
      };
      const completed = createCoordinatorEvent(
        state,
        'workflow.run.completed',
        completedPayload,
        'team.run.completed',
      );
      await commit(state, { checkpoint: null, events: [completed] });
      events.push(completed);
      await releaseWorkflowExecution(state);
      yield completed;
      return {
        runId: state.run.id,
        sessionId: state.session.id,
        output: output as TOutput,
        events,
        ...(state.run.usage === undefined ? {} : { usage: state.run.usage }),
      };
    } catch (error) {
      let thrown = error;
      if (state.request.signal.aborted) {
        try {
          const event = await cancelWorkflowExecution(state);
          if (event) {
            events.push(event);
            yield event;
          }
        } catch (cancellationError) {
          await releaseWorkflowExecution(state);
          throw cancellationError;
        }
      } else if (state.run.status === 'paused') {
        throw error;
      } else if (error instanceof FevexRunError && error.code === 'RUN_CONFLICT') {
        await releaseWorkflowExecution(state);
        throw error;
      } else if (state.run.status === 'running') {
        await state.commitQueue;
        let failure = error;
        try {
          await runCompensations();
        } catch (compensationError) {
          failure = new AggregateError(
            [error, compensationError],
            `Workflow failed: ${toErrorMessage(error)}; compensation failed: ${toErrorMessage(compensationError)}`,
          );
          thrown = failure;
        }
        state.run.status = 'failed';
        state.run.error = toErrorMessage(failure);
        state.run.usage = state.checkpoint.budget?.usage;
        const failedPayload = {
          error: toErrorMessage(failure),
          ...runErrorPayload(failure),
        };
        const failed = createCoordinatorEvent(
          state,
          'workflow.run.failed',
          failedPayload,
          'team.run.failed',
        );
        await commit(state, { checkpoint: null, events: [failed] });
        events.push(failed);
        await releaseWorkflowExecution(state);
        yield failed;
      } else {
        await releaseWorkflowExecution(state);
      }
      throw thrown;
    }
  }

  const nextWorkflowEvent = async <TInput, TOutput>(
    state: WorkflowExecutionState<TInput, TOutput>,
    execution: AsyncGenerator<AgentEvent, RunResult<TOutput> | undefined>,
  ) => {
    state.advancing = true;
    try {
      return await execution.next();
    } finally {
      state.advancing = false;
    }
  };

  const drainWorkflowExecution = async <TInput, TOutput>(
    name: string,
    state: WorkflowExecutionState<TInput, TOutput>,
    throwOnPause: boolean,
  ): Promise<RunResult<TOutput> | undefined> => {
    const execution = executeWorkflow(name, state);
    while (true) {
      const next = await nextWorkflowEvent(state, execution);
      if (next.done) {
        if (next.value === undefined && throwOnPause) {
          const run = await runStore.getRun<WorkflowRun>(state.run.id);
          if (run?.pause) throw new RunPausedError(run.id, run.pause);
        }
        return next.value;
      }
    }
  };

  const resumeWorkflow = async <TOutput>(
    runId: string,
    resolution: ResumeRunResolution | undefined,
    recoveryActor?: { id: string; type?: string },
  ): Promise<CoordinatorRun<TOutput>> => {
    if (!isDurableRunStore(runStore)) {
      throw new FevexRunError(
        'DURABLE_STORE_REQUIRED',
        'resumeRun requires DurableRunStore',
        runId,
      );
    }
    const run = await runStore.getRun<CoordinatorRun>(runId);
    const checkpoint = await runStore.getCheckpoint<CoordinatorCheckpoint>(runId);
    if (!run || !checkpoint) {
      throw new FevexRunError(
        resolution ? 'RUN_NOT_RESUMABLE' : 'RUN_NOT_RECOVERABLE',
        `Run "${runId}" cannot be ${resolution ? 'resumed' : 'recovered'}`,
        runId,
      );
    }
    if (checkpoint.version !== 2) {
      throw new FevexRunError(
        'CHECKPOINT_UNSUPPORTED',
        `Checkpoint for run "${runId}" is unsupported`,
        runId,
      );
    }
    if (
      (resolution && run.status !== 'paused' && run.status !== 'running') ||
      (!resolution && run.status !== 'running')
    ) {
      throw new FevexRunError(
        resolution ? 'RUN_NOT_RESUMABLE' : 'RUN_NOT_RECOVERABLE',
        `Run "${runId}" is not ${resolution ? 'resumable' : 'recoverable'}`,
        runId,
      );
    }
    const name = coordinatorName(run);
    const workflow = workflows.get(name);
    const team = isTeamRun(run) ? teams.get(name) : undefined;
    if (!workflow) {
      const owner = isTeamRun(run) ? 'Team' : 'Workflow';
      throw new FevexRunError(
        'RUN_DEFINITION_CHANGED',
        `${owner} "${name}" is unavailable`,
        runId,
      );
    }
    const currentHash = isTeamRun(run)
      ? team && await teamDefinitionHash(name, team)
      : await workflowDefinitionHash(name, workflow);
    if (!currentHash || checkpoint.definitionHash !== currentHash) {
      throw new FevexRunError(
        'RUN_DEFINITION_CHANGED',
        `Definition for ${isTeamRun(run) ? 'team' : 'workflow'} "${name}" changed`,
        runId,
      );
    }
    if (resolution && (
      run.pause?.type !== 'workflow_child' &&
      run.pause?.type !== 'workflow_children' &&
      run.pause?.type !== 'workflow_timer' &&
      run.pause?.type !== 'workflow_event'
    )) {
      throw new FevexRunError('RUN_NOT_RESUMABLE', `Run "${runId}" cannot be resumed`, runId);
    }
    const session = await runStore.getSession(run.sessionId);
    if (!session) throw new Error(`Session "${run.sessionId}" does not exist`);
    if (activeSessions.has(session.id)) {
      throw new FevexRunError('RUN_CONFLICT', `Session "${session.id}" is active`, runId);
    }
    const ownerId = `${runtimeOwner}:${crypto.randomUUID()}`;
    const acquired = await runStore.acquireLease({
      runId,
      ownerId,
      expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    });
    if (!acquired) throw new FevexRunError('RUN_CONFLICT', `Run "${runId}" is leased`, runId);

    try {
      if (!resolution) {
        if (!recoveryActor?.id.trim()) {
          throw new FevexRunError(
            'RUN_NOT_RECOVERABLE',
            'Recovery actor is required',
            runId,
          );
        }
        const controller = new AbortController();
        const state: WorkflowExecutionState = {
          run,
          session,
          request: {
            input: checkpoint.input,
            ...(checkpoint.model === undefined ? {} : { model: checkpoint.model }),
            ...(checkpoint.reasoning === undefined ? {} : { reasoning: checkpoint.reasoning }),
            sessionId: session.id,
            context: checkpoint.context,
            limits: checkpoint.limits,
            signal: controller.signal,
          },
          controller,
          eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
          checkpoint,
          advancing: false,
          leaseOwner: ownerId,
          commitQueue: Promise.resolve(),
          recoveryActor,
        };
        const recovered = createCoordinatorEvent(
          state,
          'workflow.run.recovered',
          { actorId: recoveryActor.id },
          'team.run.recovered',
        );
        await commit(state, { checkpoint, events: [recovered] });
        state.initialEvents = [recovered];
        activeWorkflowRuns.set(runId, state);
        activeSessions.add(session.id);
        startLease(state, runStore);
        void drainWorkflowExecution(name, state, false).catch(() => {});
        return structuredClone(run) as CoordinatorRun<TOutput>;
      }
      const workflowPause = run.pause;
      if (
        !workflowPause ||
        (
          workflowPause.type !== 'workflow_child' &&
          workflowPause.type !== 'workflow_children' &&
          workflowPause.type !== 'workflow_timer' &&
          workflowPause.type !== 'workflow_event'
        )
      ) {
        throw new FevexRunError('RUN_NOT_RESUMABLE', `Run "${runId}" cannot be resumed`, runId);
      }
      if (workflowPause.type === 'workflow_timer' || workflowPause.type === 'workflow_event') {
        const pause = workflowPause;
        if (pause.type === 'workflow_timer') {
          if (resolution.type !== 'timer') {
            throw new FevexRunError('RUN_NOT_RESUMABLE', 'Timer resolution is required', runId);
          }
          if (Date.now() < Date.parse(pause.resumeAt)) {
            throw new FevexRunError('RUN_NOT_RESUMABLE', 'Workflow timer has not elapsed', runId);
          }
        } else {
          if (resolution.type !== 'event' || resolution.eventName !== pause.eventName) {
            throw new FevexRunError('RUN_NOT_RESUMABLE', 'Workflow event does not match', runId);
          }
        }
        const waiting = checkpoint.steps[pause.stepId];
        if (waiting?.type !== 'wait' || waiting.status !== 'running') {
          throw new FevexRunError('RUN_NOT_RESUMABLE', 'Workflow wait is unavailable', runId);
        }
        let eventPayload: JsonValue | undefined;
        const receivedAt = new Date().toISOString();
        if (resolution.type === 'event') {
          const eventDefinition = workflow.events?.[resolution.eventName];
          if (!eventDefinition) {
            throw new FevexRunError(
              'RUN_DEFINITION_CHANGED',
              `Workflow event "${resolution.eventName}" is unavailable`,
              runId,
            );
          }
          if (waiting.wait.type !== 'event') {
            throw new FevexRunError('RUN_NOT_RESUMABLE', 'Workflow wait is unavailable', runId);
          }
          if (waiting.wait.requireActor && !resolution.actor?.id?.trim()) {
            throw new FevexRunError('APPROVAL_INVALID', 'Workflow event actor is required', runId);
          }
          const validatedPayload =
            eventDefinition.payloadSchema === undefined
              ? resolution.payload
              : await validateSchema(
                  eventDefinition.payloadSchema,
                  resolution.payload,
                  `Payload for workflow event "${resolution.eventName}" does not match payloadSchema`,
                );
          if (validatedPayload !== undefined) {
            eventPayload = toJsonValue(
              validatedPayload,
              'Workflow event payload must be JSON-serializable',
            );
          }
        }
        const controller = new AbortController();
        const state: WorkflowExecutionState = {
          run,
          session,
          request: {
            input: checkpoint.input,
            ...(checkpoint.model === undefined ? {} : { model: checkpoint.model }),
            ...(checkpoint.reasoning === undefined ? {} : { reasoning: checkpoint.reasoning }),
            sessionId: session.id,
            context: checkpoint.context,
            limits: checkpoint.limits,
            signal: controller.signal,
          },
          controller,
          eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
          checkpoint,
          advancing: false,
          leaseOwner: ownerId,
          commitQueue: Promise.resolve(),
        };
        run.status = 'running';
        run.pause = undefined;
        const resumed = createCoordinatorEvent(
          state,
          'workflow.run.resumed',
          undefined,
          'team.run.resumed',
        );
        const completed = createEvent(state, 'workflow.wait.completed', {
          stepId: pause.stepId,
          kind: waiting.wait.type,
          ...(eventPayload === undefined ? {} : { payload: eventPayload }),
          ...(resolution.type === 'event' && resolution.actor
            ? { actorId: resolution.actor.id }
            : {}),
          ...(resolution.type === 'event' ? { receivedAt } : {}),
        }) as AgentEvent;
        await commitWorkflow(
          state,
          () => {
            state.checkpoint.steps[pause.stepId] = {
              type: 'wait',
              status: 'completed',
              wait: waiting.wait,
              ...(eventPayload === undefined ? {} : { payload: eventPayload }),
              ...(resolution.type === 'event' && resolution.actor
                ? { actor: resolution.actor }
                : {}),
              ...(resolution.type === 'event' ? { receivedAt } : {}),
            };
          },
          [resumed, completed],
        );
        activeWorkflowRuns.set(runId, state);
        activeSessions.add(session.id);
        startLease(state, runStore);
        void drainWorkflowExecution(name, state, false).catch(() => {});
        return structuredClone(run) as CoordinatorRun<TOutput>;
      }
      if (resolution.type === 'timer' || resolution.type === 'event') {
        throw new FevexRunError('RUN_NOT_RESUMABLE', `Run "${runId}" cannot be resumed`, runId);
      }
      const childRunId = workflowPause.type === 'workflow_children'
        ? workflowPause.children.find(({ childPause }) =>
            pauseMatchesResolution(childPause, resolution),
          )?.childRunId
        : workflowPause.childRunId;
      if (!childRunId) {
        throw new FevexRunError(
          'RUN_NOT_RESUMABLE',
          'Resolution does not match a paused child run',
          runId,
        );
      }
      const childRun = await resumeAgent(childRunId, resolution, true);
      const controller = new AbortController();
      const state: WorkflowExecutionState = {
        run,
        session,
        request: {
          input: checkpoint.input,
          ...(checkpoint.model === undefined ? {} : { model: checkpoint.model }),
          ...(checkpoint.reasoning === undefined ? {} : { reasoning: checkpoint.reasoning }),
          sessionId: session.id,
          context: checkpoint.context,
          limits: checkpoint.limits,
          signal: controller.signal,
        },
        controller,
        eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
        checkpoint,
        advancing: false,
        leaseOwner: ownerId,
        commitQueue: Promise.resolve(),
      };
      if (childRun.status === 'cancelled') {
        run.status = 'cancelled';
        run.pause = undefined;
        run.error = childRun.error ?? 'aborted';
        const reason =
          childRun.error === 'approval_rejected' ? 'approval_rejected' : 'aborted';
        const cancelled = createCoordinatorEvent(
          state,
          'workflow.run.cancelled',
          { reason },
          'team.run.cancelled',
        );
        await commit(state, { checkpoint: null, events: [cancelled] });
        await releaseWorkflowExecution(state);
        return structuredClone(run) as CoordinatorRun<TOutput>;
      }
      run.status = 'running';
      run.pause = undefined;
      const resumed = createCoordinatorEvent(
        state,
        'workflow.run.resumed',
        undefined,
        'team.run.resumed',
      );
      await commit(state, { checkpoint, events: [resumed] });
      activeWorkflowRuns.set(runId, state);
      activeSessions.add(session.id);
      startLease(state, runStore);
      void drainWorkflowExecution(name, state, false).catch(() => {});
      return structuredClone(run) as CoordinatorRun<TOutput>;
    } catch (error) {
      await runStore.releaseLease(runId, ownerId).catch(() => {});
      throw error;
    }
  };

  return {
    prepareWorkflowExecution,
    executeWorkflow,
    nextWorkflowEvent,
    drainWorkflowExecution,
    resumeWorkflow,
    cancelWorkflowExecution,
  };
}

/** The coordinator surface the public runtime consumes. */
export type WorkflowEngine = ReturnType<typeof createWorkflowEngine>;
