import type { AgentEvent, AgentEventPayloads, AgentEventType, JsonValue } from '../core';
import type { ModelRef } from '../models';
import type { PolicyDecision } from '../policies';
import { FevexRunError } from '../run-error';
import {
  isDurableRunStore,
  type AgentRun,
  type DurableRunStore,
  type RunCheckpoint,
  type RunRecord,
  type Session,
  type StoredRunCheckpoint,
  type ToolExecutionRecord,
} from '../runtime';
import type { ToolDefinition } from '../tools';
import type { FevexComposition } from './configuration';
import { definitionHash } from './definition-hash';
import { buildRunTrace } from './observability';
import { isCoordinatorRun, isTeamRun } from './run-helpers';
import type { ExecutionState, WorkflowExecutionState } from './run-state';
import { cancellationReason } from './run-support';
import { LEASE_MS, LEASE_RENEW_MS } from './runtime-constants';

/**
 * Shared foundation both engines build on: the registries that enforce one
 * active run per session, the single event sequencer, the durable commit path,
 * leases and policy authorization.
 *
 * It must be instantiated exactly once per runtime. `createEvent` advances
 * `state.eventSequence` in place and `runtimeOwner` identifies this process to
 * the lease table, so a second instance would corrupt event ordering and lease
 * ownership without raising an error.
 */
export function createRunCore({
  models,
  agents,
  tools,
  runStore,
  policies,
  onEvent,
  observability,
}: FevexComposition) {
  const activeRuns = new Map<string, ExecutionState>();
  const activeWorkflowRuns = new Map<string, WorkflowExecutionState>();
  const activeSessions = new Set<string>();
  const pendingExports = new Set<Promise<void>>();
  const exportFailures: unknown[] = [];
  const exportedRuns = new Set<string>();
  const runtimeOwner = crypto.randomUUID();

  const resolveModel = (agent: { model?: ModelRef }, requestedModel?: string) => {
    const modelName = requestedModel ?? (typeof agent.model === 'string' ? agent.model : 'default');
    if (!modelName.trim()) {
      throw new FevexRunError('MODEL_NOT_FOUND', 'Model name cannot be empty');
    }
    const model = requestedModel !== undefined || typeof agent.model === 'string'
      ? models.get(modelName)
      : (agent.model ?? models.get(modelName));
    if (!model) {
      throw new FevexRunError('MODEL_NOT_FOUND', `Model "${modelName}" is not registered`);
    }
    return { modelName, model };
  };

  const resolveCheckpointModel = async (
    agentName: string,
    agent: FevexComposition['agents'] extends Map<string, infer T> ? T : never,
    checkpoint: RunCheckpoint,
  ) => {
    const preferred = resolveModel(agent, checkpoint.modelName);
    if (checkpoint.definitionHash === await definitionHash(agentName, preferred.modelName, agent, tools)) {
      return preferred;
    }
    if (checkpoint.modelName !== undefined) return undefined;

    for (const candidateName of models.keys()) {
      if (candidateName === preferred.modelName) continue;
      const candidate = resolveModel(agent, candidateName);
      if (checkpoint.definitionHash === await definitionHash(agentName, candidate.modelName, agent, tools)) {
        return candidate;
      }
    }
    return undefined;
  };

  const scheduleTraceExport = (event: AgentEvent): void => {
    if (
      !observability ||
      !['run.completed', 'run.failed', 'run.cancelled'].includes(event.type) ||
      exportedRuns.has(event.runId)
    ) {
      return;
    }
    exportedRuns.add(event.runId);
    let task!: Promise<void>;
    task = (async () => {
      const run = await runStore.getRun<RunRecord>(event.runId);
      if (!run) throw new Error(`Run "${event.runId}" does not exist`);
      if (isCoordinatorRun(run)) return;
      const agentRun = run as AgentRun;
      const agent = agents.get(agentRun.agentName);
      if (!agent) throw new Error(`Agent "${agentRun.agentName}" is not registered`);
      const checkpoint = isDurableRunStore(runStore)
        ? await runStore.getCheckpoint<RunCheckpoint>(agentRun.id)
        : undefined;
      const { modelName: modelRegistryName, model: gateway } = resolveModel(
        agent,
        checkpoint?.modelName,
      );
      const trace = buildRunTrace(
        agentRun,
        await runStore.listEvents(agentRun.id),
        modelRegistryName,
        gateway?.metadata,
        observability,
      );
      const results = await Promise.allSettled(
        observability.exporters.map((exporter) => Promise.resolve().then(() => exporter.export(trace))),
      );
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(({ reason }) => reason);
      if (failures.length) throw new AggregateError(failures, 'Trace export failed');
    })()
      .catch((error) => {
        exportFailures.push(error);
      })
      .finally(() => pendingExports.delete(task));
    pendingExports.add(task);
  };

  const notifyObserver = (event: AgentEvent): void => {
    scheduleTraceExport(event);
    if (!onEvent) return;
    try {
      void Promise.resolve(onEvent(event)).catch(() => {});
    } catch {}
  };

  const createEvent = <TType extends AgentEventType>(
    state: { run: RunRecord; eventSequence: number },
    type: TType,
    payload: AgentEventPayloads[TType],
  ): AgentEvent<TType> =>
    ({
      id: crypto.randomUUID(),
      sequence: (state.eventSequence += 1),
      type,
      runId: state.run.id,
      timestamp: new Date().toISOString(),
      ...(payload === undefined ? {} : { payload }),
    }) as AgentEvent<TType>;

  const createCoordinatorEvent = (
    state: WorkflowExecutionState,
    workflowType: AgentEventType,
    workflowPayload: unknown,
    teamType: AgentEventType,
    teamPayload = workflowPayload,
  ): AgentEvent =>
    createEvent(
      state,
      (isTeamRun(state.run) ? teamType : workflowType) as AgentEventType,
      (isTeamRun(state.run) ? teamPayload : workflowPayload) as never,
    ) as AgentEvent;

  const emitEvent = async <TType extends AgentEventType>(
    state: ExecutionState,
    type: TType,
    payload: AgentEventPayloads[TType],
  ): Promise<AgentEvent<TType>> => {
    const event = createEvent(state, type, payload);
    if (isDurableRunStore(runStore)) {
      await commit(state, { events: [event as AgentEvent] });
    } else {
      await runStore.appendEvent(event as AgentEvent);
      notifyObserver(event as AgentEvent);
    }
    return event;
  };

  const releaseExecution = async (state: ExecutionState): Promise<void> => {
    activeRuns.delete(state.run.id);
    activeSessions.delete(state.session.id);
    if (state.leaseTimer) clearInterval(state.leaseTimer);
    if (state.leaseOwner && isDurableRunStore(runStore)) {
      await runStore.releaseLease(state.run.id, state.leaseOwner).catch(() => {});
    }
  };

  const commit = async (
    state: ExecutionState | WorkflowExecutionState,
    options: {
      checkpoint?: StoredRunCheckpoint | null;
      session?: Session;
      toolExecution?: ToolExecutionRecord;
      events?: AgentEvent[];
    } = {},
  ): Promise<void> => {
    if (!isDurableRunStore(runStore)) {
      throw new FevexRunError(
        'DURABLE_STORE_REQUIRED',
        'This run requires a DurableRunStore',
        state.run.id,
      );
    }
    state.run.updatedAt = new Date().toISOString();
    const ok = await runStore.commitExecution({
      expectedRevision: state.run.revision,
      run: state.run,
      ...options,
    });
    if (!ok) {
      throw new FevexRunError('RUN_CONFLICT', `Run "${state.run.id}" was modified`, state.run.id);
    }
    for (const event of options.events ?? []) notifyObserver(event);
  };

  const startLease = (state: ExecutionState | WorkflowExecutionState, store: DurableRunStore): void => {
    state.leaseTimer = setInterval(() => {
      if (!state.leaseOwner || state.request.signal.aborted) return;
      const expiresAt = new Date(Date.now() + LEASE_MS).toISOString();
      void store
        .renewLease({
          runId: state.run.id,
          ownerId: state.leaseOwner,
          expiresAt,
        })
        .then((renewed) => {
          if (!renewed) {
            if (state.leaseTimer) clearInterval(state.leaseTimer);
            state.leaseTimer = undefined;
            state.controller.abort(new Error('Run lease was lost'));
          }
        });
    }, LEASE_RENEW_MS);
  };

  const cancelExecution = async (
    state: ExecutionState,
    reason: AgentEventPayloads['run.cancelled']['reason'] = cancellationReason(
      state.request.signal,
    ),
  ): Promise<AgentEvent<'run.cancelled'> | undefined> => {
    if (
      state.run.status === 'completed' ||
      state.run.status === 'failed' ||
      state.run.status === 'cancelled'
    ) {
      return undefined;
    }
    Object.assign(state.run, {
      status: 'cancelled' as const,
      pause: undefined,
      error: reason,
      updatedAt: new Date().toISOString(),
    });
    const event = createEvent(state, 'run.cancelled', { reason });
    if (isDurableRunStore(runStore)) {
      await commit(state, { checkpoint: null, events: [event] });
    } else {
      await runStore.saveRun(state.run);
      await runStore.appendEvent(event);
      notifyObserver(event);
    }
    await releaseExecution(state);
    return event;
  };

  const releaseWorkflowExecution = async (state: WorkflowExecutionState): Promise<void> => {
    activeWorkflowRuns.delete(state.run.id);
    activeSessions.delete(state.session.id);
    if (state.leaseTimer) clearInterval(state.leaseTimer);
    if (state.leaseOwner && isDurableRunStore(runStore)) {
      await runStore.releaseLease(state.run.id, state.leaseOwner).catch(() => {});
    }
  };

  const commitWorkflow = async (
    state: WorkflowExecutionState,
    update: () => void,
    events: AgentEvent[] = [],
  ): Promise<void> => {
    state.commitQueue = state.commitQueue.then(async () => {
      if (state.run.status !== 'running') {
        throw new FevexRunError(
          'RUN_CONFLICT',
          `Workflow run "${state.run.id}" is not running`,
          state.run.id,
        );
      }
      update();
      await commit(state, { checkpoint: state.checkpoint, events });
    });
    await state.commitQueue;
  };
  const authorize = async (
    state: ExecutionState,
    tool: ToolDefinition,
    input: JsonValue,
    action: 'tool.execute' | 'approval.resolve',
    context = state.request.context,
  ): Promise<PolicyDecision> => {
    let approval = false;
    for (const policy of policies) {
      const decision = await policy.authorize({
        runId: state.run.id,
        agentName: state.run.agentName,
        toolName: tool.name,
        risk: tool.risk ?? 'read',
        input,
        action,
        context,
      });
      if (decision === 'deny') {
        throw new FevexRunError(
          'POLICY_DENIED',
          `Policy "${policy.name}" denied tool "${tool.name}"`,
          state.run.id,
        );
      }
      if (decision === 'require_approval') approval = true;
    }
    return approval ? 'require_approval' : 'allow';
  };

  return {
    activeRuns,
    activeWorkflowRuns,
    activeSessions,
    pendingExports,
    exportFailures,
    runtimeOwner,
    resolveModel,
    resolveCheckpointModel,
    notifyObserver,
    createEvent,
    createCoordinatorEvent,
    emitEvent,
    releaseExecution,
    commit,
    startLease,
    cancelExecution,
    releaseWorkflowExecution,
    commitWorkflow,
    authorize,
  };
}

/** Everything the agent and workflow engines receive from the runtime core. */
export type RunCore = ReturnType<typeof createRunCore>;
