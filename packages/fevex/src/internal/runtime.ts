import type {
  AgentEvent,
  AgentEventPayloads,
  AgentEventType,
  AgentMessage,
  ExecutionContext,
  JsonObject,
  JsonValue,
} from '../core';
import type { Fevex } from '../fevex';
import type { ContextBlock, KnowledgeContext, MemoryStore } from '../knowledge';
import type { ModelGateway, ModelUsage, ToolChoice } from '../models';
import type { PolicyDecision } from '../policies';
import { FevexRunError, RunPausedError } from '../run-error';
import {
  isDurableRunStore,
  type AgentRunPause,
  type AgentRun,
  type DurableRunStore,
  type PendingToolExecution,
  type ResumeRunResolution,
  type RunRecord,
  type RunCheckpoint,
  type RunRequest,
  type RunResult,
  type Session,
  type StoredRunCheckpoint,
  type CoordinatorCheckpoint,
  type CoordinatorRun,
  type TeamRun,
  type ToolExecutionRecord,
  type WorkflowBudgetUsage,
  type WorkflowCheckpoint,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '../runtime';
import {
  compileFevexJsonSchema,
  IntegrationError,
  toToolSpec,
  validateFevexJsonSchemaProfile,
  type ToolDefinition,
} from '../tools';
import type {
  WorkflowAgentResult,
  WorkflowEventResult,
  WorkflowStep,
  WorkflowStepContext,
  WorkflowStepOptions,
} from '../workflows';
import type { FevexComposition } from './configuration';
import {
  definitionHash,
  teamDefinitionHash,
  workflowDefinitionHash,
} from './definition-hash';
import { serializeJsonValue, serializeValue, toJsonValue } from './json';
import { buildRunTrace } from './observability';
import {
  abortable,
  addUsage,
  assertContinuationBudget,
  assertTokenBudget,
  cancellationReason,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOOL_CALLS,
  eventUsage,
  remainingOutputTokens,
  toErrorMessage,
} from './run-support';
import { assertStandardSchema, toTransportableSchema, validateSchema } from './schemas';
import { readModelStream } from './model-stream';
import {
  addWorkflowBudget,
  assertWorkflowBudget,
  combineLimits,
  remainingWorkflowLimits,
} from './workflow-budget';

const LEASE_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
const ELICIT_TOOL_NAME = 'fevex__elicit';

interface ExecutionState<TInput = unknown, TOutput = unknown> {
  run: AgentRun;
  session: Session;
  request: RunRequest<TInput, TOutput> & { signal: AbortSignal };
  controller: AbortController;
  eventSequence: number;
  advancing: boolean;
  checkpoint?: RunCheckpoint;
  approvedToolCallId?: string;
  forcedRetryToolCallId?: string;
  leaseOwner?: string;
  leaseTimer?: ReturnType<typeof setInterval>;
  initialEvents?: AgentEvent[];
}

interface WorkflowExecutionState<TInput = unknown, TOutput = unknown> {
  run: CoordinatorRun;
  session: Session;
  request: RunRequest<TInput, TOutput> & { signal: AbortSignal };
  controller: AbortController;
  eventSequence: number;
  checkpoint: CoordinatorCheckpoint;
  advancing: boolean;
  leaseOwner?: string;
  leaseTimer?: ReturnType<typeof setInterval>;
  commitQueue: Promise<void>;
  initialEvents?: AgentEvent[];
  recoveryActor?: { id: string; type?: string };
}

function redact(message: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (safe, secret) => (secret ? safe.split(secret).join('[REDACTED]') : safe),
    message,
  );
}

function containsSecret(value: JsonValue, secrets: readonly string[]): boolean {
  if (typeof value === 'string') return secrets.some((secret) => secret && value.includes(secret));
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, secrets));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsSecret(item, secrets));
  }
  return false;
}

function effectiveElicitationMode(
  agent: { elicitation?: 'pause' | 'forbid' },
  request: { elicitation?: 'pause' | 'forbid' },
) {
  return request.elicitation ?? agent.elicitation ?? 'forbid';
}

function effectiveApprovalMode(
  agent: { approvalMode?: 'pause' | 'deny' },
  request: { approvalMode?: 'pause' | 'deny' },
) {
  return request.approvalMode ?? agent.approvalMode ?? 'pause';
}

function effectiveToolChoice(
  agent: { toolChoice?: ToolChoice },
  request: { toolChoice?: ToolChoice },
) {
  return request.toolChoice ?? agent.toolChoice ?? 'auto';
}

function isElicitationToolCall(call: { name: string }) {
  return call.name === ELICIT_TOOL_NAME;
}

function readElicitationInput(input: JsonValue): {
  prompt: string;
  responseSchema: JsonObject;
  expiresAt?: string;
} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Elicitation input must be an object');
  }
  const prompt = input.prompt;
  const responseSchema = input.responseSchema;
  const expiresAt = input.expiresAt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('Elicitation prompt must be a non-empty string');
  }
  if (typeof responseSchema !== 'object' || responseSchema === null || Array.isArray(responseSchema)) {
    throw new TypeError('Elicitation responseSchema must be an object');
  }
  validateFevexJsonSchemaProfile(responseSchema);
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
      throw new TypeError('Elicitation expiresAt must be a valid ISO date string');
    }
  }
  return {
    prompt,
    responseSchema,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function isCoordinatorRun(run: RunRecord): run is CoordinatorRun {
  return run.kind === 'workflow' || run.kind === 'team';
}

function isTeamRun(run: RunRecord): run is TeamRun {
  return run.kind === 'team';
}

function coordinatorName(run: CoordinatorRun): string {
  return run.kind === 'team' ? run.teamName : run.workflowName;
}

class WorkflowChildPausedError extends Error {
  constructor(
    readonly stepId: string,
    readonly paused: RunPausedError,
  ) {
    super(paused.message, { cause: paused });
  }
}

function pauseMatchesResolution(
  pause: AgentRunPause,
  resolution: ResumeRunResolution,
): boolean {
  if (pause.type === 'elicitation' && resolution.type === 'elicitation') {
    return pause.request.id === resolution.requestId;
  }
  if (pause.type === 'approval' && resolution.type === 'approval') {
    return pause.approval.id === resolution.approvalId;
  }
  if (pause.type === 'tool_execution_unknown' && resolution.type === 'tool_execution') {
    return pause.toolCallId === resolution.toolCallId;
  }
  return false;
}

function mergeExecutionContext(
  parent: ExecutionContext | undefined,
  child: ExecutionContext | undefined,
): ExecutionContext | undefined {
  if (!parent) return child;
  if (!child) return parent;
  return {
    ...parent,
    ...child,
    actor: parent.actor ?? child.actor,
    ...(parent.attributes || child.attributes
      ? { attributes: { ...parent.attributes, ...child.attributes } }
      : {}),
    ...(parent.prompt || child.prompt ? { prompt: { ...parent.prompt, ...child.prompt } } : {}),
  };
}

function systemBlock(label: string, provider: string, block: ContextBlock): AgentMessage {
  return {
    role: 'system',
    content: `[${label}: ${provider}/${block.id}]\n${block.content}`,
  };
}

async function readMemoryMessages(
  agent: FevexComposition['agents'] extends Map<string, infer T> ? T : never,
  context: KnowledgeContext,
  memoryStore: MemoryStore | undefined,
): Promise<AgentMessage[]> {
  if (!agent.memory || agent.memory.read === false || !memoryStore) return [];
  try {
    const records = await abortable(
      () =>
        memoryStore.search(
          {
            query: context.input,
            limit: agent.memory?.limit ?? 5,
            agentName: context.agentName,
            sessionId: context.sessionId,
            namespace: context.context?.namespace,
            actor: context.context?.actor,
          },
          context,
        ),
      context.signal!,
    );
    return records
      .filter((record) => record.content.trim())
      .map((record) => ({
        role: 'system',
        content: `[Memory: ${record.id}]\n${record.content}`,
      }));
  } catch (cause) {
    throw new Error('Memory search failed', { cause });
  }
}

export function createRuntime({
  models,
  agents,
  workflows,
  teams,
  tools,
  contextProviders,
  memoryStore,
  runStore,
  credentialStore,
  sandbox,
  policies,
  onEvent,
  observability,
}: FevexComposition): Fevex {
  const activeRuns = new Map<string, ExecutionState>();
  const activeWorkflowRuns = new Map<string, WorkflowExecutionState>();
  const activeSessions = new Set<string>();
  const pendingExports = new Set<Promise<void>>();
  const exportFailures: unknown[] = [];
  const exportedRuns = new Set<string>();
  const runtimeOwner = crypto.randomUUID();

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
      const modelRegistryName = typeof agent.model === 'string' ? agent.model : 'default';
      const gateway =
        typeof agent.model === 'string'
          ? models.get(agent.model)
          : (agent.model ?? models.get('default'));
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

  const prepareExecution = async <TInput, TOutput>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): Promise<ExecutionState<TInput, TOutput>> => {
    const agent = agents.get(name);
    if (!agent) {
      throw new FevexRunError('AGENT_NOT_FOUND', `Agent "${name}" is not registered`);
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
    const run: AgentRun = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      agentName: name,
      status: 'running',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const state: ExecutionState<TInput, TOutput> = {
      run,
      session,
      request: { ...request, sessionId: session.id, signal },
      controller,
      eventSequence: 0,
      advancing: false,
    };
    try {
      if (isDurableRunStore(runStore)) {
        const modelName = typeof agent.model === 'string' ? agent.model : 'default';
        const validatedInput =
          agent.inputSchema === undefined
            ? request.input
            : await abortable(
                () =>
                  validateSchema(
                    agent.inputSchema!,
                    request.input,
                    `Input for agent "${name}" does not match inputSchema`,
                  ),
                signal,
              );
        const inputContent = serializeValue(
          validatedInput,
          'Run input must be a string or JSON-serializable value',
        );
        const knowledge = await readKnowledgeMessages(state, agent, inputContent);
        const messages: AgentMessage[] = [
          { role: 'system', content: agent.instructions },
          ...knowledge.skills,
          ...session.history,
          ...knowledge.context,
          ...knowledge.memory,
          { role: 'user', content: inputContent },
        ];
        const checkpoint: RunCheckpoint = {
          version: 2,
          runId: run.id,
          definitionHash: await definitionHash(name, modelName, agent, tools),
          limits: combineLimits(agent.limits, request.limits),
          messages,
          inputContent,
          context: request.context,
          step: 1,
          toolCallCount: 0,
          seenToolCallIds: [],
          pendingTools: [],
          pendingIndex: 0,
          effectiveElicitationMode: effectiveElicitationMode(agent, request),
          effectiveApprovalMode: effectiveApprovalMode(agent, request),
          effectiveToolChoice: effectiveToolChoice(agent, request),
        };
        const ownerId = `${runtimeOwner}:${crypto.randomUUID()}`;
        const started = createEvent(state, 'run.started', undefined) as AgentEvent;
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
        state.checkpoint = checkpoint;
        state.leaseOwner = ownerId;
        state.initialEvents = [started];
        notifyObserver(started);
        startLease(state, runStore);
      } else {
        if (newSession) await runStore.saveSession(session);
        await runStore.saveRun(run);
      }
    } catch (error) {
      activeSessions.delete(session.id);
      throw error;
    }
    activeRuns.set(run.id, state as ExecutionState);
    return state;
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

  const toolSourcePayload = (tool: ToolDefinition, error?: unknown) => {
    const source = error instanceof IntegrationError ? error.source ?? tool.source : tool.source;
    return source === undefined ? {} : { source };
  };

  const toolErrorPayload = (tool: ToolDefinition, error: unknown) => ({
    ...toolSourcePayload(tool, error),
    ...(error instanceof IntegrationError
      ? { errorCode: error.code, retryable: error.retryable }
      : {}),
  });

  const runErrorPayload = (error: unknown) => {
    if (!(error instanceof IntegrationError)) return {};
    return {
      errorCode: error.code,
      retryable: error.retryable,
      ...(error.source === undefined ? {} : { source: error.source }),
    };
  };

  const durableCheckpoint = async (
    state: ExecutionState,
    model: ModelGateway,
    modelName: string,
    messages: AgentMessage[],
    inputContent: string,
    usage: ModelUsage | undefined,
    providerState: unknown,
    step: number,
    toolCallCount: number,
    seenToolCallIds: Set<string>,
    pendingTools: PendingToolExecution[],
    pendingIndex: number,
  ): Promise<RunCheckpoint> => {
    const agent = agents.get(state.run.agentName)!;
    if (agent.model !== undefined && typeof agent.model !== 'string') {
      throw new FevexRunError(
        'RUN_NOT_RESUMABLE',
        'Durable continuation requires a named model',
        state.run.id,
      );
    }
    let serializedState: JsonValue | undefined;
    if (providerState !== undefined) {
      if (!model.stateCodec) {
        throw new FevexRunError(
          'RUN_NOT_RESUMABLE',
          'ModelGateway must provide stateCodec for durable continuation',
          state.run.id,
        );
      }
      serializedState = toJsonValue(
        model.stateCodec.serialize(providerState),
        'Model provider state must be JSON-serializable',
      );
    }
    return {
      version: 2,
      runId: state.run.id,
      definitionHash: await definitionHash(state.run.agentName, modelName, agent, tools),
      limits: state.checkpoint?.limits ?? combineLimits(agent.limits, state.request.limits),
      messages: structuredClone(messages),
      inputContent,
      context: state.request.context,
      usage,
      providerState: serializedState,
      step,
      toolCallCount,
      seenToolCallIds: [...seenToolCallIds],
      pendingTools: structuredClone(pendingTools),
      pendingIndex,
      effectiveElicitationMode:
        state.checkpoint?.effectiveElicitationMode ?? effectiveElicitationMode(agent, state.request),
      effectiveApprovalMode:
        state.checkpoint?.effectiveApprovalMode ?? effectiveApprovalMode(agent, state.request),
      effectiveToolChoice:
        state.checkpoint?.effectiveToolChoice ?? effectiveToolChoice(agent, state.request),
    };
  };

  const knowledgeContext = (
    state: ExecutionState,
    input: string,
  ): KnowledgeContext => ({
    agentName: state.run.agentName,
    input,
    sessionId: state.session.id,
    ...(state.request.context === undefined ? {} : { context: state.request.context }),
    signal: state.request.signal,
  });

  const readProvider = async (
    providerName: string,
    label: string,
    context: KnowledgeContext,
  ): Promise<AgentMessage[]> => {
    try {
      const provider = contextProviders.get(providerName)!;
      const blocks = await abortable(() => provider.read(context), context.signal!);
      return blocks
        .filter((block) => block.content.trim())
        .map((block) => systemBlock(label, providerName, block));
    } catch (cause) {
      throw new Error(`${label} provider "${providerName}" failed`, { cause });
    }
  };

  const readKnowledgeMessages = async (
    state: ExecutionState,
    agent: FevexComposition['agents'] extends Map<string, infer T> ? T : never,
    input: string,
  ): Promise<{ skills: AgentMessage[]; context: AgentMessage[]; memory: AgentMessage[] }> => {
    const context = knowledgeContext(state, input);
    const skills = (
      await Promise.all((agent.skills ?? []).map((name) => readProvider(name, 'Skill', context)))
    ).flat();
    const contextual = (
      await Promise.all((agent.context ?? []).map((name) => readProvider(name, 'Context', context)))
    ).flat();
    const memory = await readMemoryMessages(agent, context, memoryStore);
    return { skills, context: contextual, memory };
  };

  const writeMemory = async (
    state: ExecutionState,
    agent: FevexComposition['agents'] extends Map<string, infer T> ? T : never,
    input: string,
    output: JsonValue,
  ): Promise<void> => {
    if (!agent.memory?.write || !memoryStore) return;
    const context = knowledgeContext(state, input);
    try {
      await abortable(
        () =>
          memoryStore.write(
            {
              content: `User: ${input}\nAssistant: ${serializeJsonValue(output)}`,
              agentName: state.run.agentName,
              sessionId: state.session.id,
              namespace: state.request.context?.namespace,
              actor: state.request.context?.actor,
              metadata: { runId: state.run.id },
            },
            context,
          ),
        state.request.signal,
      );
    } catch (cause) {
      throw new Error('Memory write failed', { cause });
    }
  };

  async function* executeAgent<TInput = unknown, TOutput = unknown>(
    name: string,
    state: ExecutionState<TInput, TOutput>,
  ): AsyncGenerator<AgentEvent, RunResult<TOutput> | undefined> {
    const { request } = state;
    const agent = agents.get(name)!;
    const modelName = typeof agent.model === 'string' ? agent.model : 'default';
    const model =
      typeof agent.model === 'string'
        ? models.get(agent.model)!
        : (agent.model ?? models.get('default')!);
    const events: AgentEvent[] = [...(state.initialEvents ?? [])];
    const firstEvents = state.initialEvents ?? [];
    state.initialEvents = undefined;
    const emit = async <TType extends AgentEventType>(
      type: TType,
      payload: AgentEventPayloads[TType],
    ): Promise<AgentEvent> => {
      const event = (await emitEvent(state, type, payload)) as AgentEvent;
      events.push(event);
      return event;
    };
    let inputContent: string;
    let messages: AgentMessage[];
    let usage: ModelUsage | undefined;
    let providerState: unknown;
    let step: number;
    let toolCallCount: number;
    let seenToolCallIds: Set<string>;
    let pendingTools: PendingToolExecution[];
    let pendingIndex: number;

    try {
      for (const event of firstEvents) yield event;
      if (state.checkpoint) {
        const checkpoint = state.checkpoint;
        if (checkpoint.version !== 2) {
          throw new FevexRunError(
            'CHECKPOINT_UNSUPPORTED',
            `Checkpoint for run "${state.run.id}" is unsupported`,
            state.run.id,
          );
        }
        const hash = await definitionHash(name, modelName, agent, tools);
        if (checkpoint.definitionHash !== hash) {
          throw new FevexRunError(
            'RUN_DEFINITION_CHANGED',
            `Definition for agent "${name}" changed`,
            state.run.id,
          );
        }
        inputContent = checkpoint.inputContent;
        messages = checkpoint.messages;
        usage = checkpoint.usage;
        providerState =
          checkpoint.providerState === undefined
            ? undefined
            : model.stateCodec?.restore(checkpoint.providerState);
        step = checkpoint.step;
        toolCallCount = checkpoint.toolCallCount;
        seenToolCallIds = new Set(checkpoint.seenToolCallIds);
        pendingTools = checkpoint.pendingTools;
        pendingIndex = checkpoint.pendingIndex;
      } else {
        yield await emit('run.started', undefined);
        request.signal.throwIfAborted();
        const validatedInput =
          agent.inputSchema === undefined
            ? request.input
            : await abortable(
                () =>
                  validateSchema(
                    agent.inputSchema!,
                    request.input,
                    `Input for agent "${name}" does not match inputSchema`,
                  ),
                request.signal,
              );
        inputContent = serializeValue(
          validatedInput,
          'Run input must be a string or JSON-serializable value',
        );
        const knowledge = await readKnowledgeMessages(state, agent, inputContent);
        messages = [
          { role: 'system', content: agent.instructions },
          ...knowledge.skills,
          ...state.session.history,
          ...knowledge.context,
          ...knowledge.memory,
          { role: 'user', content: inputContent },
        ];
        step = 1;
        toolCallCount = 0;
        seenToolCallIds = new Set();
        pendingTools = [];
        pendingIndex = 0;
      }

      const activeOutputSchema = agent.outputSchema;
      const outputSchema =
        activeOutputSchema === undefined
          ? undefined
          : toTransportableSchema(
              activeOutputSchema,
              'output',
              `Output schema for agent "${name}" is not transportable`,
            );
      const currentElicitationMode =
        state.checkpoint?.effectiveElicitationMode ?? effectiveElicitationMode(agent, request);
      const currentApprovalMode =
        state.checkpoint?.effectiveApprovalMode ?? effectiveApprovalMode(agent, request);
      const currentToolChoice =
        state.checkpoint?.effectiveToolChoice ?? effectiveToolChoice(agent, request);
      const agentTools = await Promise.all((agent.tools ?? []).map(async (toolName) => {
        const tool = tools.get(toolName)!;
        const remote = await tool.resolve?.({ context: request.context });
        const inputSchema =
          tool.inputJsonSchema ??
          remote?.inputSchema ??
          (tool.inputSchema === undefined
            ? undefined
            : toTransportableSchema(
                tool.inputSchema,
                'input',
                `Input schema for tool "${tool.name}" is not transportable`,
              ));
        return toToolSpec(
          tool.description === undefined && remote?.description !== undefined
            ? { ...tool, description: remote.description }
            : tool,
          inputSchema,
        );
      }));
      const allTools = currentElicitationMode === 'pause'
        ? [
            ...agentTools,
            {
              name: ELICIT_TOOL_NAME,
              description: 'Request external information required to continue this run.',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: { type: 'string' },
                  responseSchema: { type: 'object' },
                  expiresAt: { type: 'string' },
                },
                required: ['prompt', 'responseSchema'],
                additionalProperties: false,
              },
            },
          ]
        : agentTools;
      const effectiveLimits = state.checkpoint?.limits ?? combineLimits(agent.limits, request.limits);
      const maxSteps = effectiveLimits?.maxSteps ?? DEFAULT_MAX_STEPS;
      const maxToolCalls = effectiveLimits?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
      if (
        typeof currentToolChoice === 'object' &&
        !allTools.some((tool) => tool.name === currentToolChoice.name)
      ) {
        throw new Error(`Tool "${currentToolChoice.name}" is not available to agent "${name}"`);
      }

      while (step <= maxSteps) {
        request.signal.throwIfAborted();

        if (pendingTools.length === 0) {
          const hasToolBudget = step < maxSteps && toolCallCount < maxToolCalls;
          const modelToolChoice: ToolChoice | undefined =
            hasToolBudget && allTools.length
              ? (currentToolChoice === 'auto' ? undefined : currentToolChoice)
              : undefined;
          yield await emit('model.started', { step });
          const modelStream = readModelStream(model, {
            messages: [...messages],
            tools: hasToolBudget && allTools.length ? allTools : undefined,
            ...(modelToolChoice === undefined ? {} : { toolChoice: modelToolChoice }),
            reasoning: agent.reasoning,
            modelOptions: agent.modelOptions,
            outputSchema,
            ...(remainingOutputTokens(effectiveLimits?.maxOutputTokens, usage) === undefined
              ? {}
              : {
                  maxOutputTokens: remainingOutputTokens(effectiveLimits?.maxOutputTokens, usage),
                }),
            ...(providerState === undefined ? {} : { providerState }),
            signal: request.signal,
          });
          let modelResult = await modelStream.next();
          while (!modelResult.done) {
            yield await emit('model.output.delta', {
              step,
              delta: modelResult.value,
            });
            modelResult = await modelStream.next();
          }
          const result = modelResult.value;
          providerState = result.providerState;
          usage = addUsage(usage, result.usage);
          const usagePayload = eventUsage(usage);
          yield await emit('model.completed', {
            step,
            ...(usagePayload === undefined ? {} : { usage: usagePayload }),
          });
          assertTokenBudget(
            name,
            'maxInputTokens',
            'inputTokens',
            effectiveLimits?.maxInputTokens,
            result.usage,
            usage,
          );
          assertTokenBudget(
            name,
            'maxOutputTokens',
            'outputTokens',
            effectiveLimits?.maxOutputTokens,
            result.usage,
            usage,
          );
          if (!result.toolCalls?.length) {
            if (result.output === undefined) {
              throw new Error(`Model for agent "${name}" returned no output`);
            }
            const validated =
              activeOutputSchema === undefined
                ? result.output
                : await abortable(
                    () =>
                      validateSchema(
                        activeOutputSchema,
                        result.output,
                        `Output from agent "${name}" does not match outputSchema`,
                      ),
                    request.signal,
                  );
            const output = toJsonValue(
              validated,
              `Output from agent "${name}" must be JSON-serializable`,
            );
            await writeMemory(state, agent, inputContent, output);
            state.session.history.push(
              { role: 'user', content: inputContent },
              { role: 'assistant', content: serializeValue(output, 'Output must be serializable') },
            );
            state.session.updatedAt = new Date().toISOString();
            Object.assign(state.run, {
              status: 'completed',
              pause: undefined,
              output,
              ...(usage === undefined ? {} : { usage }),
              updatedAt: new Date().toISOString(),
            });
            const payload: AgentEventPayloads['run.completed'] = { output };
            const finalUsage = eventUsage(usage);
            if (finalUsage) payload.usage = finalUsage;
            const completed = createEvent(state, 'run.completed', payload) as AgentEvent;
            if (isDurableRunStore(runStore)) {
              await commit(state, {
                checkpoint: null,
                session: state.session,
                events: [completed],
              });
            } else {
              await runStore.saveSession(state.session);
              await runStore.saveRun(state.run);
              await runStore.appendEvent(completed);
              notifyObserver(completed);
            }
            events.push(completed);
            await releaseExecution(state);
            yield completed;
            return {
              runId: state.run.id,
              sessionId: state.session.id,
              output: output as TOutput,
              events,
              usage,
            };
          }
          if (!hasToolBudget) {
            throw new Error(
              step >= maxSteps
                ? `Agent "${name}" reached maxSteps limit of ${maxSteps}`
                : `Agent "${name}" reached maxToolCalls limit of ${maxToolCalls}`,
            );
          }
          assertContinuationBudget(
            name,
            'maxInputTokens',
            'inputTokens',
            effectiveLimits?.maxInputTokens,
            usage,
          );
          assertContinuationBudget(
            name,
            'maxOutputTokens',
            'outputTokens',
            effectiveLimits?.maxOutputTokens,
            usage,
          );
          if (result.toolCalls.length > maxToolCalls - toolCallCount) {
            throw new Error(`Agent "${name}" exceeded maxToolCalls limit of ${maxToolCalls}`);
          }
          const elicitationCall = result.toolCalls.find(isElicitationToolCall);
          if (elicitationCall) {
            if (!isDurableRunStore(runStore)) {
              throw new FevexRunError(
                'DURABLE_STORE_REQUIRED',
                'Elicitation requires a DurableRunStore',
                state.run.id,
              );
            }
            if (currentElicitationMode !== 'pause') {
              throw new Error(`Tool "${ELICIT_TOOL_NAME}" is not available to agent "${name}"`);
            }
            if (result.toolCalls.length !== 1) {
              throw new Error(`${ELICIT_TOOL_NAME} must be the only tool call in a model turn`);
            }
            if (!elicitationCall.id?.trim()) throw new Error('Tool call id cannot be empty');
            if (seenToolCallIds.has(elicitationCall.id)) {
              throw new Error(`Tool call id "${elicitationCall.id}" is duplicated in run "${state.run.id}"`);
            }
            const rawInput = toJsonValue(
              elicitationCall.input,
              `Input for tool "${ELICIT_TOOL_NAME}" must be JSON-serializable`,
            );
            const input = readElicitationInput(rawInput);
            seenToolCallIds.add(elicitationCall.id);
            messages.push({
              role: 'assistant',
              content:
                result.output === undefined
                  ? ''
                  : serializeValue(
                      result.output,
                      `Model output for agent "${name}" must be serializable`,
                    ),
              toolCalls: [{ ...elicitationCall, input: rawInput }],
            });
            const checkpoint = await durableCheckpoint(
              state,
              model,
              modelName,
              messages,
              inputContent,
              usage,
              providerState,
              step + 1,
              toolCallCount,
              seenToolCallIds,
              [],
              0,
            );
            const request = {
              id: crypto.randomUUID(),
              toolCallId: elicitationCall.id,
              prompt: input.prompt,
              responseSchema: input.responseSchema,
              requestedAt: new Date().toISOString(),
              ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            };
            state.run.status = 'paused';
            state.run.pause = { type: 'elicitation', request };
            const requested = createEvent(state, 'elicitation.requested', {
              request,
            }) as AgentEvent;
            const paused = createEvent(state, 'run.paused', {
              reason: 'elicitation',
              toolCallId: elicitationCall.id,
            }) as AgentEvent;
            await commit(state, { checkpoint, events: [requested, paused] });
            events.push(requested, paused);
            await releaseExecution(state);
            yield requested;
            yield paused;
            return undefined;
          }
          const batch = new Set<string>();
          pendingTools = [];
          for (const call of result.toolCalls) {
            if (!call.id?.trim()) throw new Error('Tool call id cannot be empty');
            if (!call.name?.trim()) throw new Error('Tool call name cannot be empty');
            if (seenToolCallIds.has(call.id) || batch.has(call.id)) {
              throw new Error(`Tool call id "${call.id}" is duplicated in run "${state.run.id}"`);
            }
            batch.add(call.id);
            const tool = agent.tools?.includes(call.name) ? tools.get(call.name) : undefined;
            if (!tool) throw new Error(`Tool "${call.name}" is not available to agent "${name}"`);
            const rawInput = toJsonValue(
              call.input,
              `Input for tool "${call.name}" must be JSON-serializable`,
            );
            let validated: unknown;
            try {
              validated =
                tool.inputSchema === undefined
                  ? rawInput
                  : await validateSchema(
                      tool.inputSchema,
                      rawInput,
                      `Input for tool "${call.name}" does not match inputSchema`,
                    );
            } catch (error) {
              yield await emit('tool.failed', {
                step,
                toolCallId: call.id,
                toolName: call.name,
                error: toErrorMessage(error),
                ...toolErrorPayload(tool, error),
              });
              throw error;
            }
            pendingTools.push({
              call: { ...call, input: rawInput },
              input: toJsonValue(validated, `Input for tool "${call.name}" must be serializable`),
              idempotencyKey: crypto.randomUUID(),
              attempt: 0,
            });
          }
          for (const id of batch) seenToolCallIds.add(id);
          messages.push({
            role: 'assistant',
            content:
              result.output === undefined
                ? ''
                : serializeValue(
                    result.output,
                    `Model output for agent "${name}" must be serializable`,
                  ),
            toolCalls: pendingTools.map(({ call }) => call),
          });
          pendingIndex = 0;
        }

        while (pendingIndex < pendingTools.length) {
          request.signal.throwIfAborted();
          const pending = pendingTools[pendingIndex]!;
          const tool = tools.get(pending.call.name)!;
          const durable = isDurableRunStore(runStore) ? runStore : undefined;
          if (!durable && (tool.approval === 'required' || tool.idempotency === 'keyed')) {
            throw new FevexRunError(
              'DURABLE_STORE_REQUIRED',
              `Tool "${tool.name}" requires a DurableRunStore`,
              state.run.id,
            );
          }
          let record = durable
            ? await durable.getToolExecution(state.run.id, pending.call.id)
            : undefined;
          const policy = await authorize(state, tool, pending.input, 'tool.execute');
          const needsApproval = tool.approval === 'required' || policy === 'require_approval';

          if (
            needsApproval
            && state.approvedToolCallId !== pending.call.id
            && record?.status !== 'started'
            && record?.status !== 'completed'
          ) {
            if (currentApprovalMode === 'deny') {
              throw new FevexRunError(
                'POLICY_DENIED',
                `Tool "${tool.name}" requires approval but approvalMode is "deny"`,
                state.run.id,
              );
            }
            const checkpoint = await durableCheckpoint(
              state,
              model,
              modelName,
              messages,
              inputContent,
              usage,
              providerState,
              step,
              toolCallCount,
              seenToolCallIds,
              pendingTools,
              pendingIndex,
            );
            const approval = {
              id: crypto.randomUUID(),
              toolCallId: pending.call.id,
              toolName: pending.call.name,
              input: pending.input,
              risk: tool.risk ?? ('read' as const),
              requestedAt: new Date().toISOString(),
            };
            state.run.status = 'paused';
            state.run.pause = { type: 'approval', approval };
            const requested = createEvent(state, 'approval.requested', {
              approvalId: approval.id,
              toolCallId: approval.toolCallId,
              toolName: approval.toolName,
              ...toolSourcePayload(tool),
            }) as AgentEvent;
            const paused = createEvent(state, 'run.paused', {
              reason: 'approval',
              toolCallId: pending.call.id,
            }) as AgentEvent;
            await commit(state, { checkpoint, events: [requested, paused] });
            events.push(requested, paused);
            await releaseExecution(state);
            yield requested;
            yield paused;
            return undefined;
          }
          state.approvedToolCallId = undefined;

          const requiresRecovery = Boolean(
            durable &&
            (state.checkpoint ||
              (tool.risk && tool.risk !== 'read') ||
              tool.idempotency === 'keyed' ||
              tool.retry ||
              tool.credentials?.length ||
              policies.length),
          );
          if (requiresRecovery) {
            const checkpoint = await durableCheckpoint(
              state,
              model,
              modelName,
              messages,
              inputContent,
              usage,
              providerState,
              step,
              toolCallCount,
              seenToolCallIds,
              pendingTools,
              pendingIndex,
            );
            await commit(state, { checkpoint });
            state.checkpoint = checkpoint;
          }
          if (record?.status === 'completed') {
            messages.push({
              role: 'tool',
              name: pending.call.name,
              toolCallId: pending.call.id,
              content: serializeJsonValue(record.output!),
            });
            toolCallCount += 1;
            pendingIndex += 1;
            continue;
          }
          if (
            record?.status === 'started' &&
            tool.idempotency !== 'keyed' &&
            state.forcedRetryToolCallId !== pending.call.id
          ) {
            const checkpoint = await durableCheckpoint(
              state,
              model,
              modelName,
              messages,
              inputContent,
              usage,
              providerState,
              step,
              toolCallCount,
              seenToolCallIds,
              pendingTools,
              pendingIndex,
            );
            state.run.status = 'paused';
            state.run.pause = {
              type: 'tool_execution_unknown',
              toolCallId: pending.call.id,
              toolName: pending.call.name,
              input: pending.input,
            };
            const unknown = createEvent(state, 'tool.execution_unknown', {
              step,
              toolCallId: pending.call.id,
              toolName: pending.call.name,
              ...toolSourcePayload(tool),
            }) as AgentEvent;
            const paused = createEvent(state, 'run.paused', {
              reason: 'tool_execution_unknown',
              toolCallId: pending.call.id,
            }) as AgentEvent;
            await commit(state, { checkpoint, events: [unknown, paused] });
            events.push(unknown, paused);
            await releaseExecution(state);
            yield unknown;
            yield paused;
            return undefined;
          }
          const forcedRetry = state.forcedRetryToolCallId === pending.call.id;
          state.forcedRetryToolCallId = undefined;

          const configuredMaxAttempts = tool.retry?.maxAttempts ?? 1;
          const maxAttempts = forcedRetry
            ? Math.max(configuredMaxAttempts, (record?.attempt ?? 0) + 1)
            : configuredMaxAttempts;
          let output: JsonValue | undefined;
          let attempt =
            record?.status === 'started' && tool.idempotency === 'keyed'
              ? Math.max(0, record.attempt - 1)
              : (record?.attempt ?? 0);
          while (attempt < maxAttempts) {
            if (attempt > 0) {
              const retryDecision = await authorize(state, tool, pending.input, 'tool.execute');
              if (retryDecision === 'require_approval') {
                if (currentApprovalMode === 'deny') {
                  throw new FevexRunError(
                    'POLICY_DENIED',
                    `Tool "${tool.name}" requires approval but approvalMode is "deny"`,
                    state.run.id,
                  );
                }
                const checkpoint = await durableCheckpoint(
                  state,
                  model,
                  modelName,
                  messages,
                  inputContent,
                  usage,
                  providerState,
                  step,
                  toolCallCount,
                  seenToolCallIds,
                  pendingTools,
                  pendingIndex,
                );
                const approval = {
                  id: crypto.randomUUID(),
                  toolCallId: pending.call.id,
                  toolName: pending.call.name,
                  input: pending.input,
                  risk: tool.risk ?? ('read' as const),
                  requestedAt: new Date().toISOString(),
                };
                state.run.status = 'paused';
                state.run.pause = { type: 'approval', approval };
                const requested = createEvent(state, 'approval.requested', {
                  approvalId: approval.id,
                  toolCallId: approval.toolCallId,
                  toolName: approval.toolName,
                  ...toolSourcePayload(tool),
                }) as AgentEvent;
                const paused = createEvent(state, 'run.paused', {
                  reason: 'approval',
                  toolCallId: pending.call.id,
                }) as AgentEvent;
                await commit(state, { checkpoint, events: [requested, paused] });
                events.push(requested, paused);
                await releaseExecution(state);
                yield requested;
                yield paused;
                return undefined;
              }
            }
            attempt += 1;
            const secrets: string[] = [];
            const resolvedCredentials = new Map<string, string>();
            for (const credentialName of tool.credentials ?? []) {
              const value = await credentialStore?.resolve({
                name: credentialName,
                namespace: request.context?.namespace,
                actor: request.context?.actor,
              });
              if (!value) {
                throw new FevexRunError(
                  'CREDENTIAL_NOT_FOUND',
                  `Credential "${credentialName}" was not found`,
                  state.run.id,
                );
              }
              resolvedCredentials.set(credentialName, value);
              secrets.push(value);
            }
            const getCredential = async (credentialName: string): Promise<string> => {
              if (!tool.credentials?.includes(credentialName)) {
                throw new FevexRunError(
                  'CREDENTIAL_NOT_FOUND',
                  `Credential "${credentialName}" is not declared for tool "${tool.name}"`,
                  state.run.id,
                );
              }
              return resolvedCredentials.get(credentialName)!;
            };
            const scopedSandbox = tool.sandbox === undefined
              ? undefined
              : {
                  run: (sandboxRequest: Parameters<NonNullable<typeof sandbox>['run']>[0]) => {
                    if (!sandbox) {
                      throw new FevexRunError(
                        'SANDBOX_REQUIRED',
                        `Tool "${tool.name}" requires a sandbox`,
                        state.run.id,
                      );
                    }
                    const signal = sandboxRequest.signal
                      ? AbortSignal.any([request.signal, sandboxRequest.signal])
                      : request.signal;
                    return sandbox.run({
                      ...sandboxRequest,
                      capabilities: tool.sandbox,
                      runId: state.run.id,
                      toolCallId: pending.call.id,
                      attempt,
                      idempotencyKey: pending.idempotencyKey,
                      context: request.context,
                      signal,
                    });
                  },
                };
            record = {
              runId: state.run.id,
              toolCallId: pending.call.id,
              toolName: pending.call.name,
              input: pending.input,
              status: 'started',
              attempt,
              idempotencyKey: pending.idempotencyKey,
              updatedAt: new Date().toISOString(),
            };
            const started = createEvent(state, 'tool.started', {
              step,
              toolCallId: pending.call.id,
              toolName: pending.call.name,
              ...toolSourcePayload(tool),
              ...(attempt > 1 ? { attempt } : {}),
            }) as AgentEvent;
            if (durable) await commit(state, { toolExecution: record, events: [started] });
            else {
              await runStore.appendEvent(started);
              notifyObserver(started);
            }
            events.push(started);
            yield started;
            try {
              const raw = await abortable(
                () =>
                  tool.execute(pending.input, {
                    runId: state.run.id,
                    toolCallId: pending.call.id,
                    attempt,
                    idempotencyKey: pending.idempotencyKey,
                    getCredential,
                    ...(scopedSandbox === undefined ? {} : { sandbox: scopedSandbox }),
                    context: request.context,
                    signal: request.signal,
                  }),
                request.signal,
              );
              const validated =
                tool.outputSchema === undefined
                  ? raw
                  : await validateSchema(
                      tool.outputSchema,
                      raw,
                      `Output from tool "${tool.name}" does not match outputSchema`,
                    );
              output = toJsonValue(
                validated,
                `Output from tool "${tool.name}" must be JSON-serializable`,
              );
              if (containsSecret(output, secrets)) {
                throw new Error(`Output from tool "${tool.name}" contains a credential`);
              }
              record = {
                ...record,
                status: 'completed',
                output,
                updatedAt: new Date().toISOString(),
              };
              const completed = createEvent(state, 'tool.completed', {
                step,
                toolCallId: pending.call.id,
                toolName: pending.call.name,
                ...toolSourcePayload(tool),
                ...(attempt > 1 ? { attempt } : {}),
              }) as AgentEvent;
              if (durable) await commit(state, { toolExecution: record, events: [completed] });
              else {
                await runStore.appendEvent(completed);
                notifyObserver(completed);
              }
              events.push(completed);
              yield completed;
              break;
            } catch (error) {
              if (request.signal.aborted) throw error;
              const safeError = redact(toErrorMessage(error), secrets);
              record = {
                ...record,
                status: 'failed',
                error: safeError,
                updatedAt: new Date().toISOString(),
              };
              if (durable) await commit(state, { toolExecution: record });
              if (attempt >= maxAttempts || tool.idempotency !== 'keyed') {
                yield await emit('tool.failed', {
                  step,
                  toolCallId: pending.call.id,
                  toolName: pending.call.name,
                  error: safeError,
                  ...toolErrorPayload(tool, error),
                });
                throw secrets.length ? new Error(safeError, { cause: error }) : error;
              }
              const delayMs = Math.min(
                tool.retry!.backoffMs * 2 ** (attempt - 1),
                tool.retry!.maxBackoffMs ?? Number.MAX_SAFE_INTEGER,
              );
              yield await emit('tool.retrying', {
                step,
                toolCallId: pending.call.id,
                toolName: pending.call.name,
                attempt: attempt + 1,
                delayMs,
                error: safeError,
                ...toolErrorPayload(tool, error),
              });
              if (delayMs) {
                await abortable(
                  () => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
                  request.signal,
                );
              }
            }
          }
          if (output === undefined) {
            throw new FevexRunError(
              'TOOL_EXECUTION_UNKNOWN',
              `Tool "${tool.name}" exhausted its configured attempts`,
              state.run.id,
            );
          }
          messages.push({
            role: 'tool',
            name: pending.call.name,
            toolCallId: pending.call.id,
            content: serializeJsonValue(output!),
          });
          toolCallCount += 1;
          pendingIndex += 1;
        }
        pendingTools = [];
        pendingIndex = 0;
        step += 1;
      }
      throw new Error(`Agent "${name}" reached maxSteps limit of ${maxSteps}`);
    } catch (error) {
      if (request.signal.aborted) {
        const event = await cancelExecution(state);
        if (event) {
          events.push(event);
          yield event;
        }
      } else if (state.run.status === 'running') {
        Object.assign(state.run, {
          status: 'failed',
          error: toErrorMessage(error),
          ...(usage === undefined ? {} : { usage }),
          updatedAt: new Date().toISOString(),
        });
        const failed = createEvent(state, 'run.failed', {
          error: toErrorMessage(error),
          ...runErrorPayload(error),
        }) as AgentEvent;
        if (isDurableRunStore(runStore)) {
          try {
            await commit(state, { checkpoint: null, events: [failed] });
          } catch (commitError) {
            await releaseExecution(state);
            throw commitError;
          }
        } else {
          await runStore.saveRun(state.run);
          await runStore.appendEvent(failed);
          notifyObserver(failed);
        }
        events.push(failed);
        await releaseExecution(state);
        yield failed;
      } else {
        await releaseExecution(state);
      }
      throw error;
    }
  }

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

  const nextEvent = async <TInput, TOutput>(
    state: ExecutionState<TInput, TOutput>,
    execution: AsyncGenerator<AgentEvent, RunResult<TOutput> | undefined>,
  ) => {
    state.advancing = true;
    try {
      return await execution.next();
    } finally {
      state.advancing = false;
    }
  };

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

  const drainExecution = async <TInput, TOutput>(
    name: string,
    state: ExecutionState<TInput, TOutput>,
    throwOnPause: boolean,
  ): Promise<RunResult<TOutput> | undefined> => {
    const execution = executeAgent(name, state);
    while (true) {
      const next = await nextEvent(state, execution);
      if (next.done) {
        if (next.value === undefined && throwOnPause) {
          const run = await runStore.getRun(state.run.id);
          if (run?.pause) throw new RunPausedError(run.id, run.pause);
        }
        return next.value;
      }
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

  const resumeAgent = async <TOutput>(
    runId: string,
    resolution: ResumeRunResolution | undefined,
    waitForCompletion = false,
    recoveryActor?: { id: string; type?: string },
  ): Promise<AgentRun<TOutput>> => {
    if (resolution?.type === 'timer' || resolution?.type === 'event') {
      throw new FevexRunError('RUN_NOT_RESUMABLE', `Run "${runId}" cannot be resumed`, runId);
    }
    if (!isDurableRunStore(runStore)) {
      throw new FevexRunError(
        'DURABLE_STORE_REQUIRED',
        'resumeRun requires DurableRunStore',
        runId,
      );
    }
    const run = await runStore.getRun<AgentRun>(runId);
    const checkpoint = await runStore.getCheckpoint<RunCheckpoint>(runId);
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
    const agent = agents.get(run.agentName);
    if (!agent) {
      throw new FevexRunError(
        'RUN_DEFINITION_CHANGED',
        `Agent "${run.agentName}" is unavailable`,
        runId,
      );
    }
    const modelName = typeof agent.model === 'string' ? agent.model : 'default';
    const model =
      typeof agent.model === 'string'
        ? models.get(agent.model)
        : (agent.model ?? models.get('default'));
    if (
      !model ||
      checkpoint.definitionHash !== (await definitionHash(run.agentName, modelName, agent, tools))
    ) {
      throw new FevexRunError(
        'RUN_DEFINITION_CHANGED',
        `Definition for agent "${run.agentName}" changed`,
        runId,
      );
    }
    if (checkpoint.providerState !== undefined && !model.stateCodec) {
      throw new FevexRunError(
        'RUN_NOT_RESUMABLE',
        'ModelGateway no longer provides its stateCodec',
        runId,
      );
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
      const controller = new AbortController();
      const state: ExecutionState = {
        run,
        session,
        request: {
          input: '',
          sessionId: session.id,
          context: checkpoint.context,
          limits: checkpoint.limits,
          signal: controller.signal,
        },
        controller,
        eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
        advancing: false,
        checkpoint,
        leaseOwner: ownerId,
        ...(resolution?.type === 'approval'
          ? {
              approvedToolCallId:
                run.pause?.type === 'approval' ? run.pause.approval.toolCallId : undefined,
            }
          : resolution?.type === 'tool_execution'
            ? {
                approvedToolCallId: resolution.toolCallId,
                ...(resolution.decision === 'retry'
                  ? { forcedRetryToolCallId: resolution.toolCallId }
                  : {}),
              }
            : {}),
      };
      if (!resolution) {
        if (!recoveryActor?.id.trim()) {
          throw new FevexRunError(
            'RUN_NOT_RECOVERABLE',
            'Recovery actor is required',
            runId,
          );
        }
        const recovered = createEvent(state, 'run.recovered', {
          actorId: recoveryActor.id,
        }) as AgentEvent;
        await commit(state, { checkpoint, events: [recovered] });
        state.initialEvents = [recovered];
        activeRuns.set(runId, state);
        activeSessions.add(session.id);
        startLease(state, runStore);
        if (waitForCompletion) await drainExecution(run.agentName, state, false);
        else void drainExecution(run.agentName, state, false).catch(() => {});
        return structuredClone(run) as AgentRun<TOutput>;
      }
      if (!resolution.actor?.id?.trim()) {
        await runStore.releaseLease(runId, ownerId);
        throw new FevexRunError(
          resolution.type === 'elicitation' ? 'ELICITATION_INVALID' : 'APPROVAL_INVALID',
          'Resolution actor is required',
          runId,
        );
      }

      if (resolution.type === 'elicitation') {
        const pause = run.pause;
        if (pause?.type !== 'elicitation' || pause.request.id !== resolution.requestId) {
          await runStore.releaseLease(runId, ownerId);
          throw new FevexRunError(
            'ELICITATION_INVALID',
            'Elicitation does not match the run',
            runId,
          );
        }
        if (pause.request.expiresAt && Date.now() > Date.parse(pause.request.expiresAt)) {
          await runStore.releaseLease(runId, ownerId);
          throw new FevexRunError('ELICITATION_INVALID', 'Elicitation has expired', runId);
        }
        let value: JsonValue;
        try {
          value = compileFevexJsonSchema(pause.request.responseSchema).validate(
            resolution.value,
          );
        } catch (error) {
          await runStore.releaseLease(runId, ownerId);
          throw new FevexRunError(
            'ELICITATION_INVALID',
            `Elicitation value does not match responseSchema: ${toErrorMessage(error)}`,
            runId,
            { cause: error },
          );
        }
        checkpoint.messages.push({
          role: 'tool',
          name: ELICIT_TOOL_NAME,
          toolCallId: pause.request.toolCallId,
          content: serializeJsonValue(value),
        });
        run.status = 'running';
        run.pause = undefined;
        const resolved = createEvent(state, 'elicitation.resolved', {
          requestId: pause.request.id,
          toolCallId: pause.request.toolCallId,
          actorId: resolution.actor.id,
        }) as AgentEvent;
        const resumed = createEvent(state, 'run.resumed', undefined) as AgentEvent;
        await commit(state, { checkpoint, events: [resolved, resumed] });
        activeRuns.set(runId, state);
        activeSessions.add(session.id);
        startLease(state, runStore);
        if (waitForCompletion) {
          await drainExecution(run.agentName, state, false);
        } else {
          void drainExecution(run.agentName, state, false).catch(() => {});
        }
        return structuredClone(run) as AgentRun<TOutput>;
      }

      if (resolution.type === 'approval') {
        if (run.pause?.type !== 'approval' || run.pause.approval.id !== resolution.approvalId) {
          await runStore.releaseLease(runId, ownerId);
          throw new FevexRunError('APPROVAL_INVALID', 'Approval does not match the run', runId);
        }
        const pending = checkpoint.pendingTools[checkpoint.pendingIndex];
        const tool = pending && tools.get(pending.call.name);
        if (!pending || !tool) {
          await runStore.releaseLease(runId, ownerId);
          throw new FevexRunError('APPROVAL_INVALID', 'Approval tool is unavailable', runId);
        }
        if (resolution.decision === 'approve') {
          await authorize(state, tool, pending.input, 'approval.resolve', {
            ...state.request.context,
            actor: resolution.actor,
          });
        }
        if (resolution.decision === 'reject') {
          const toolCallId = run.pause.approval.toolCallId;
          run.status = 'cancelled';
          run.pause = undefined;
          run.error = 'approval_rejected';
          const resolved = createEvent(state, 'approval.resolved', {
            approvalId: resolution.approvalId,
            toolCallId,
            decision: 'reject',
            actorId: resolution.actor.id,
            ...toolSourcePayload(tool),
          }) as AgentEvent;
          const cancelled = createEvent(state, 'run.cancelled', {
            reason: 'approval_rejected',
          }) as AgentEvent;
          await commit(state, { checkpoint: null, events: [resolved, cancelled] });
          await releaseExecution(state);
          return structuredClone(run) as AgentRun<TOutput>;
        }
      } else {
        const pending = checkpoint.pendingTools[checkpoint.pendingIndex];
        const record = await runStore.getToolExecution(runId, resolution.toolCallId);
        const matchesUnknownPause =
          run.pause?.type === 'tool_execution_unknown' &&
          run.pause.toolCallId === resolution.toolCallId;
        const matchesInterruptedAttempt =
          run.status === 'running' &&
          pending?.call.id === resolution.toolCallId &&
          (record?.status === 'started' || record?.status === 'completed');
        if (!matchesUnknownPause && !matchesInterruptedAttempt) {
          await runStore.releaseLease(runId, ownerId);
          throw new FevexRunError(
            'RUN_NOT_RESUMABLE',
            'Tool execution resolution does not match a pending attempt',
            runId,
          );
        }
      }

      if (resolution.type === 'tool_execution' && resolution.decision === 'use_output') {
        const pending = checkpoint.pendingTools[checkpoint.pendingIndex]!;
        const tool = tools.get(pending.call.name);
        if (!tool) {
          await runStore.releaseLease(runId, ownerId);
          throw new FevexRunError('RUN_DEFINITION_CHANGED', 'Pending tool is unavailable', runId);
        }
        const validated =
          tool.outputSchema === undefined
            ? resolution.output
            : await validateSchema(
                tool.outputSchema,
                resolution.output,
                `Manual output for tool "${tool.name}" does not match outputSchema`,
              );
        const output = toJsonValue(validated, 'Manual tool output must be JSON-serializable');
        const current = await runStore.getToolExecution(runId, resolution.toolCallId);
        await commit(state, {
          toolExecution: {
            runId,
            toolCallId: resolution.toolCallId,
            toolName: pending.call.name,
            input: pending.input,
            status: 'completed',
            attempt: current?.attempt ?? 1,
            idempotencyKey: current?.idempotencyKey ?? pending.idempotencyKey,
            output,
            updatedAt: new Date().toISOString(),
          },
        });
      }
      const approval = run.pause?.type === 'approval' ? run.pause.approval : undefined;
      const approvalTool = approval ? tools.get(approval.toolName) : undefined;
      run.status = 'running';
      run.pause = undefined;
      const resumed = createEvent(state, 'run.resumed', undefined) as AgentEvent;
      const resumeEvents = [resumed];
      if (approval && resolution.type === 'approval') {
        resumeEvents.push(
          createEvent(state, 'approval.resolved', {
            approvalId: approval.id,
            toolCallId: approval.toolCallId,
            decision: 'approve',
            actorId: resolution.actor.id,
            ...(approvalTool === undefined ? {} : toolSourcePayload(approvalTool)),
          }) as AgentEvent,
        );
      }
      await commit(state, { checkpoint, events: resumeEvents });
      activeRuns.set(runId, state);
      activeSessions.add(session.id);
      startLease(state, runStore);
      if (waitForCompletion) {
        await drainExecution(run.agentName, state, false);
      } else {
        void drainExecution(run.agentName, state, false).catch(() => {});
      }
      return structuredClone(run) as AgentRun<TOutput>;
    } catch (error) {
      await runStore.releaseLease(runId, ownerId).catch(() => {});
      throw error;
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

  const resumeRun = async <TOutput>(
    runId: string,
    resolution: ResumeRunResolution,
  ): Promise<RunRecord<TOutput>> => {
    const run = await runStore.getRun<RunRecord>(runId);
    if (run && isCoordinatorRun(run)) return resumeWorkflow<TOutput>(runId, resolution);
    return resumeAgent<TOutput>(runId, resolution);
  };

  const recoverRun = async <TOutput>(
    runId: string,
    actor: { id: string; type?: string },
  ): Promise<RunRecord<TOutput>> => {
    const run = await runStore.getRun<RunRecord>(runId);
    if (!run) {
      throw new FevexRunError(
        'RUN_NOT_RECOVERABLE',
        `Run "${runId}" cannot be recovered`,
        runId,
      );
    }
    if (isCoordinatorRun(run)) return resumeWorkflow<TOutput>(runId, undefined, actor);
    return resumeAgent<TOutput>(runId, undefined, false, actor);
  };

  const cancelStoredAgent = async (runId: string): Promise<boolean> => {
    const active = activeRuns.get(runId);
    if (active && !active.request.signal.aborted) {
      active.controller.abort(new DOMException('Run cancelled', 'AbortError'));
      if (!active.advancing) {
        await cancelExecution(active);
        return true;
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await runStore.getRun(runId);
        if (
          current?.status === 'cancelled'
          || current?.status === 'completed'
          || current?.status === 'failed'
        ) {
          return true;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      return false;
    }
    if (!isDurableRunStore(runStore)) return false;
    const run = await runStore.getRun<AgentRun>(runId);
    if (!run) return false;
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return true;
    }
    const ownerId = `${runtimeOwner}:${crypto.randomUUID()}`;
    const acquired = await runStore.acquireLease({
      runId,
      ownerId,
      expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    });
    if (!acquired) return false;
    try {
      const session = await runStore.getSession(run.sessionId);
      if (!session) return false;
      const controller = new AbortController();
      const state: ExecutionState = {
        run,
        session,
        request: { input: '', sessionId: session.id, signal: controller.signal },
        controller,
        eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
        advancing: false,
        leaseOwner: ownerId,
      };
      run.status = 'cancelled';
      run.pause = undefined;
      run.error = 'aborted';
      const cancelled = createEvent(state, 'run.cancelled', { reason: 'aborted' }) as AgentEvent;
      await commit(state, { checkpoint: null, events: [cancelled] });
      return true;
    } catch (error) {
      if (error instanceof FevexRunError && error.code === 'RUN_CONFLICT') return false;
      throw error;
    } finally {
      await runStore.releaseLease(runId, ownerId).catch(() => {});
    }
  };

  return {
    async startAgent<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareExecution(name, request);
      void drainExecution(name, state, false).catch(() => {});
      return structuredClone(state.run) as AgentRun<TOutput>;
    },
    async runAgent<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareExecution(name, request);
      return (await drainExecution(name, state, true)) as RunResult<TOutput>;
    },
    streamAgent<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      return {
        async *[Symbol.asyncIterator]() {
          const state = await prepareExecution(name, request);
          const execution = executeAgent(name, state);
          let finished = false;
          try {
            while (true) {
              const next = await nextEvent(state, execution);
              if (next.done) {
                finished = true;
                return;
              }
              yield next.value;
            }
          } finally {
            if (!finished && state.run.status === 'running') {
              state.controller.abort(new DOMException('Stream abandoned', 'AbortError'));
              try {
                while (state.run.status === 'running') {
                  const next = await nextEvent(state, execution);
                  if (next.done) break;
                }
              } catch {
                // The execution persists its buffered deltas and cancellation event.
              }
              if (state.run.status === 'running') await cancelExecution(state);
            }
            await execution.return(undefined);
          }
        },
      };
    },
    async startWorkflow<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareWorkflowExecution(name, request);
      void drainWorkflowExecution(name, state, false).catch(() => {});
      return structuredClone(state.run) as WorkflowRun<TOutput>;
    },
    async runWorkflow<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareWorkflowExecution(name, request);
      return (await drainWorkflowExecution(name, state, true)) as RunResult<TOutput>;
    },
    async startTeam<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareWorkflowExecution(name, request, 'team');
      void drainWorkflowExecution(name, state, false).catch(() => {});
      return structuredClone(state.run) as TeamRun<TOutput>;
    },
    async runTeam<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareWorkflowExecution(name, request, 'team');
      return (await drainWorkflowExecution(name, state, true)) as RunResult<TOutput>;
    },
    streamTeam<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      return {
        async *[Symbol.asyncIterator]() {
          const state = await prepareWorkflowExecution(name, request, 'team');
          const execution = executeWorkflow(name, state);
          let finished = false;
          try {
            while (true) {
              const next = await nextWorkflowEvent(state, execution);
              if (next.done) {
                finished = true;
                return;
              }
              yield next.value;
            }
          } finally {
            if (!finished && state.run.status === 'running') {
              state.controller.abort(new DOMException('Stream abandoned', 'AbortError'));
              try {
                while (state.run.status === 'running') {
                  const next = await nextWorkflowEvent(state, execution);
                  if (next.done) break;
                }
              } catch {
                // The coordinator persists its cancellation event.
              }
              if (state.run.status === 'running') await cancelWorkflowExecution(state);
            }
            await execution.return(undefined);
          }
        },
      };
    },
    async getTeamRun<TOutput = unknown>(runId: string) {
      const run = await runStore.getRun<RunRecord<TOutput>>(runId);
      return run?.kind === 'team' ? run : undefined;
    },
    getRun<TOutput = unknown>(runId: string) {
      return runStore.getRun<RunRecord<TOutput>>(runId);
    },
    listEvents(runId, options) {
      return runStore.listEvents(runId, options);
    },
    async cancelRun(runId) {
      const activeWorkflow = activeWorkflowRuns.get(runId);
      if (activeWorkflow && !activeWorkflow.request.signal.aborted) {
        activeWorkflow.controller.abort(new DOMException('Run cancelled', 'AbortError'));
        if (!activeWorkflow.advancing) await cancelWorkflowExecution(activeWorkflow);
        return true;
      }
      const active = activeRuns.get(runId);
      if (active && !active.request.signal.aborted) {
        active.controller.abort(new DOMException('Run cancelled', 'AbortError'));
        if (!active.advancing) await cancelExecution(active);
        return true;
      }
      const run = await runStore.getRun<RunRecord>(runId);
      if (!run || (run.status !== 'paused' && run.status !== 'running')) return false;
      if (!isDurableRunStore(runStore)) return false;
      const session = await runStore.getSession(run.sessionId);
      if (!session) return false;
      if (isCoordinatorRun(run)) {
        const checkpoint = await runStore.getCheckpoint<CoordinatorCheckpoint>(runId);
        if (!checkpoint) return false;
        const ownerId = `${runtimeOwner}:${crypto.randomUUID()}`;
        const acquired = await runStore.acquireLease({
          runId,
          ownerId,
          expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
        });
        if (!acquired) return false;
        try {
          const childRunIds = Object.values(checkpoint.steps)
            .filter(
              (record): record is Extract<
                WorkflowStepRecord,
                { type: 'agent'; status: 'running' }
              > => record.type === 'agent' && record.status === 'running',
            )
            .map(({ childRunId }) => childRunId);
          for (const childRunId of childRunIds) {
            if (!(await cancelStoredAgent(childRunId))) return false;
          }
          const state: WorkflowExecutionState = {
            run,
            session,
            request: {
              input: checkpoint.input,
              sessionId: session.id,
              context: checkpoint.context,
              limits: checkpoint.limits,
              signal: new AbortController().signal,
            },
            controller: new AbortController(),
            eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
            checkpoint,
            advancing: false,
            leaseOwner: ownerId,
            commitQueue: Promise.resolve(),
          };
          run.status = 'cancelled';
          run.pause = undefined;
          run.error = 'aborted';
          run.usage = checkpoint.budget?.usage;
          const cancelled = createCoordinatorEvent(
            state,
            'workflow.run.cancelled',
            { reason: 'aborted' },
            'team.run.cancelled',
          );
          await commit(state, { checkpoint: null, events: [cancelled] });
          return true;
        } catch (error) {
          if (
            error instanceof FevexRunError &&
            error.code === 'RUN_CONFLICT' &&
            (await runStore.getRun<RunRecord>(runId))?.status !== 'paused'
          )
            return false;
          throw error;
        } finally {
          await runStore.releaseLease(runId, ownerId).catch(() => {});
        }
      }
      return cancelStoredAgent(runId);
    },
    resumeRun<TOutput = unknown>(runId: string, resolution: ResumeRunResolution) {
      return resumeRun<TOutput>(runId, resolution);
    },
    recoverRun<TOutput = unknown>(
      runId: string,
      options: { actor: { id: string; type?: string } },
    ) {
      return recoverRun<TOutput>(runId, options.actor);
    },
    async compactSession(sessionId, summary) {
      if (typeof summary !== 'string' || !summary.trim()) {
        throw new Error('Session summary must be a non-empty string');
      }
      if (activeSessions.has(sessionId))
        throw new Error(`Session "${sessionId}" has an active run`);
      const session = await runStore.getSession(sessionId);
      if (!session) throw new Error(`Session "${sessionId}" does not exist`);
      session.history = [{ role: 'system', content: summary }];
      session.updatedAt = new Date().toISOString();
      await runStore.saveSession(session);
      return structuredClone(session);
    },
    async flushObservability() {
      while (pendingExports.size) await Promise.all([...pendingExports]);
      if (exportFailures.length) {
        const failures = exportFailures.splice(0);
        throw new AggregateError(failures, 'Observability export failed');
      }
    },
  };
}
