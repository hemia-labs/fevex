import type {
  AgentEvent,
  AgentEventPayloads,
  AgentEventType,
  AgentMessage,
  JsonObject,
  JsonValue,
  ToolCall,
} from '../core';
import type { Fevex } from '../fevex';
import type { ContextBlock, KnowledgeContext, MemoryStore } from '../knowledge';
import type { ModelGateway, ModelUsage } from '../models';
import type { PolicyDecision } from '../policies';
import { FevexRunError, RunPausedError } from '../run-error';
import {
  isDurableRunStore,
  type AgentRun,
  type DurableRunStore,
  type PendingToolExecution,
  type ResumeRunResolution,
  type RunRecord,
  type RunCheckpoint,
  type RunRequest,
  type RunResult,
  type Session,
  type ToolExecutionRecord,
  type WorkflowCheckpoint,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '../runtime';
import { toToolSpec, type ToolDefinition } from '../tools';
import type { WorkflowStep } from '../workflows';
import type { FevexComposition } from './configuration';
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

const LEASE_MS = 30_000;
const LEASE_RENEW_MS = 10_000;

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
}

interface WorkflowExecutionState<TInput = unknown, TOutput = unknown> {
  run: WorkflowRun;
  session: Session;
  request: RunRequest<TInput, TOutput> & { signal: AbortSignal };
  controller: AbortController;
  eventSequence: number;
  checkpoint: WorkflowCheckpoint;
  advancing: boolean;
  leaseOwner?: string;
  leaseTimer?: ReturnType<typeof setInterval>;
  commitQueue: Promise<void>;
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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

async function transportableTool(
  tool: ToolDefinition,
  context?: RunRequest['context'],
): Promise<{
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  risk: string;
  approval: string;
  idempotency: string;
  retry: ToolDefinition['retry'];
  credentials: string[];
}> {
  const remote = await tool.resolve?.({ context });
  return {
    name: tool.name,
    description: tool.description ?? remote?.description,
    inputSchema:
      tool.inputJsonSchema ??
      remote?.inputSchema ??
      (tool.inputSchema === undefined
        ? undefined
        : toTransportableSchema(
            tool.inputSchema,
            'input',
            `Input schema for tool "${tool.name}" is not transportable`,
          )),
    outputSchema:
      tool.outputJsonSchema ??
      remote?.outputSchema ??
      (tool.outputSchema === undefined
        ? undefined
        : toTransportableSchema(
            tool.outputSchema,
            'output',
            `Output schema for tool "${tool.name}" is not transportable`,
          )),
    risk: tool.risk ?? 'read',
    approval: tool.approval ?? 'never',
    idempotency: tool.idempotency ?? 'none',
    retry: tool.retry,
    credentials: tool.credentials ?? [],
  };
}

async function definitionHash(
  name: string,
  modelName: string,
  agent: FevexComposition['agents'] extends Map<string, infer T> ? T : never,
  tools: Map<string, ToolDefinition>,
): Promise<string> {
  const toolDefinitions = await Promise.all(
    (agent.tools ?? []).map((toolName) => transportableTool(tools.get(toolName)!)),
  );
  const portable = JSON.stringify(
    canonicalize({
      name,
      modelName,
      instructions: agent.instructions,
      context: agent.context,
      memory: agent.memory,
      skills: agent.skills,
      tools: toolDefinitions,
      reasoning: agent.reasoning,
      modelOptions: agent.modelOptions,
      limits: agent.limits,
      outputSchema:
        agent.outputSchema === undefined
          ? undefined
          : toTransportableSchema(
              agent.outputSchema,
              'output',
              `Output schema for agent "${name}" is not transportable`,
            ),
    }),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(portable));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function workflowDefinitionHash(
  name: string,
  workflow: FevexComposition['workflows'] extends Map<string, infer T> ? T : never,
): Promise<string> {
  // Hash the declared surface, never the source of `run`. `run.toString()`
  // changes on any minified redeploy and still misses changes inside the
  // functions `run` closes over, so it is wrong in both directions. This
  // mirrors the agent hash, which covers declarations and skips `tool.execute`.
  const portable = JSON.stringify(canonicalize({ name, version: workflow.version ?? '1' }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(portable));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isWorkflowRun(run: RunRecord): run is WorkflowRun {
  return run.kind === 'workflow';
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
  tools,
  contextProviders,
  memoryStore,
  runStore,
  credentialStore,
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
      if (isWorkflowRun(run)) return;
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

  const emitEvent = async <TType extends AgentEventType>(
    state: ExecutionState,
    type: TType,
    payload: AgentEventPayloads[TType],
  ): Promise<AgentEvent<TType>> => {
    const event = createEvent(state, type, payload);
    await runStore.appendEvent(event as AgentEvent);
    notifyObserver(event as AgentEvent);
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
      checkpoint?: RunCheckpoint | WorkflowCheckpoint | null;
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
          if (!renewed) state.controller.abort(new Error('Run lease was lost'));
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
  ): Promise<AgentEvent<'workflow.run.cancelled'> | undefined> => {
    if (
      state.run.status === 'completed' ||
      state.run.status === 'failed' ||
      state.run.status === 'cancelled'
    ) {
      return undefined;
    }
    state.run.status = 'cancelled';
    state.run.pause = undefined;
    state.run.error = reason;
    const event = createEvent(state, 'workflow.run.cancelled', { reason });
    await commit(state, { checkpoint: null, events: [event] });
    await releaseWorkflowExecution(state);
    return event;
  };

  const prepareExecution = async <TInput, TOutput>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): Promise<ExecutionState<TInput, TOutput>> => {
    if (!agents.has(name)) {
      throw new FevexRunError('AGENT_NOT_FOUND', `Agent "${name}" is not registered`);
    }
    const now = new Date().toISOString();
    let session: Session;
    if (request.sessionId === undefined) {
      session = { id: crypto.randomUUID(), history: [], createdAt: now, updatedAt: now };
      await runStore.saveSession(session);
    } else {
      const stored = await runStore.getSession(request.sessionId);
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
      await runStore.saveRun(run);
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
  ): Promise<WorkflowExecutionState<TInput, TOutput>> => {
    const workflow = workflows.get(name);
    if (!workflow) {
      throw new FevexRunError('AGENT_NOT_FOUND', `Workflow "${name}" is not registered`);
    }
    if (!isDurableRunStore(runStore)) {
      throw new FevexRunError(
        'DURABLE_STORE_REQUIRED',
        'Workflows require a DurableRunStore',
      );
    }
    const now = new Date().toISOString();
    let session: Session;
    if (request.sessionId === undefined) {
      session = { id: crypto.randomUUID(), history: [], createdAt: now, updatedAt: now };
      await runStore.saveSession(session);
    } else {
      const stored = await runStore.getSession(request.sessionId);
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
    const input = toJsonValue(
      request.input,
      'Workflow input must be a string or JSON-serializable value',
    );
    const run: WorkflowRun = {
      kind: 'workflow',
      id: crypto.randomUUID(),
      sessionId: session.id,
      workflowName: name,
      status: 'running',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    const checkpoint: WorkflowCheckpoint = {
      kind: 'workflow',
      runId: run.id,
      workflowName: name,
      definitionHash: await workflowDefinitionHash(name, workflow),
      input,
      context: request.context,
      steps: {},
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
      await runStore.saveRun(run);
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
    if (state.request.outputSchema !== undefined) {
      throw new FevexRunError(
        'RUN_NOT_RESUMABLE',
        'Durable runs must declare outputSchema on the agent',
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
      runId: state.run.id,
      definitionHash: await definitionHash(state.run.agentName, modelName, agent, tools),
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
    const events: AgentEvent[] = [];
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
      if (state.checkpoint) {
        const checkpoint = state.checkpoint;
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
        if (request.outputSchema !== undefined) {
          assertStandardSchema(
            request.outputSchema,
            `Output schema for request to agent "${name}" must implement Standard Schema`,
          );
        }
        inputContent = serializeValue(
          request.input,
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

      const activeOutputSchema = request.outputSchema ?? agent.outputSchema;
      const outputSchema =
        activeOutputSchema === undefined
          ? undefined
          : toTransportableSchema(
              activeOutputSchema,
              'output',
              `Output schema for agent "${name}" is not transportable`,
            );
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
      const maxSteps = agent.limits?.maxSteps ?? DEFAULT_MAX_STEPS;
      const maxToolCalls = agent.limits?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

      while (step <= maxSteps) {
        request.signal.throwIfAborted();

        if (pendingTools.length === 0) {
          const hasToolBudget = step < maxSteps && toolCallCount < maxToolCalls;
          yield await emit('model.started', { step });
          const modelStream = readModelStream(model, {
            messages: [...messages],
            tools: hasToolBudget && agentTools.length ? agentTools : undefined,
            reasoning: agent.reasoning,
            modelOptions: agent.modelOptions,
            outputSchema,
            ...(remainingOutputTokens(agent.limits?.maxOutputTokens, usage) === undefined
              ? {}
              : {
                  maxOutputTokens: remainingOutputTokens(agent.limits?.maxOutputTokens, usage),
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
            agent.limits?.maxInputTokens,
            result.usage,
            usage,
          );
          assertTokenBudget(
            name,
            'maxOutputTokens',
            'outputTokens',
            agent.limits?.maxOutputTokens,
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
            agent.limits?.maxInputTokens,
            usage,
          );
          assertContinuationBudget(
            name,
            'maxOutputTokens',
            'outputTokens',
            agent.limits?.maxOutputTokens,
            usage,
          );
          if (result.toolCalls.length > maxToolCalls - toolCallCount) {
            throw new Error(`Agent "${name}" exceeded maxToolCalls limit of ${maxToolCalls}`);
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
          const policy = await authorize(state, tool, pending.input, 'tool.execute');
          const needsApproval = tool.approval === 'required' || policy === 'require_approval';

          if (needsApproval && state.approvedToolCallId !== pending.call.id) {
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
          let record = durable
            ? await durable.getToolExecution(state.run.id, pending.call.id)
            : undefined;
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
          state.forcedRetryToolCallId = undefined;

          const maxAttempts = tool.retry?.maxAttempts ?? 1;
          let output: JsonValue | undefined;
          let attempt = record?.attempt ?? 0;
          while (attempt < maxAttempts) {
            if (attempt > 0) {
              const retryDecision = await authorize(state, tool, pending.input, 'tool.execute');
              if (retryDecision === 'require_approval') {
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
        }) as AgentEvent;
        if (isDurableRunStore(runStore)) {
          await commit(state, { checkpoint: null, events: [failed] });
        } else {
          await runStore.saveRun(state.run);
          await runStore.appendEvent(failed);
          notifyObserver(failed);
        }
        events.push(failed);
        await releaseExecution(state);
        yield failed;
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
      const childPause = error.pause;
      if (childPause.type === 'workflow_child') throw error;
      const event = createEvent(state, 'workflow.run.paused', {
        stepId,
        childRunId: error.runId,
      }) as AgentEvent;
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
    const completeAgentStep = async (
      stepId: string,
      agentName: string,
      childRunId: string,
      output: JsonValue,
    ): Promise<RunResult<JsonValue>> => {
      const result: RunResult<JsonValue> = {
        runId: childRunId,
        sessionId: (await runStore.getRun(childRunId))!.sessionId,
        output,
      };
      const event = createEvent(state, 'workflow.step.completed', {
        stepId,
        kind: 'agent',
      }) as AgentEvent;
      await commitWorkflow(
        state,
        () => {
          state.checkpoint.steps[stepId] = {
            type: 'agent',
            status: 'completed',
            agentName,
            childRunId,
            result,
          };
        },
        [event],
      );
      events.push(event);
      return structuredClone(result);
    };
    const step: WorkflowStep = {
      async agent<TStepInput = unknown, TStepOutput = unknown>(
        stepId: string,
        agentName: string,
        request: RunRequest<TStepInput, TStepOutput>,
      ): Promise<RunResult<TStepOutput>> {
        if (!stepId.trim()) throw new Error('Workflow step id cannot be empty');
        const existing = state.checkpoint.steps[stepId];
        if (existing?.type === 'agent' && existing.status === 'completed') {
          return structuredClone(existing.result) as RunResult<TStepOutput>;
        }
        if (existing?.type === 'agent' && existing.status === 'running') {
          const child = await runStore.getRun(existing.childRunId);
          if (!child) throw new Error(`Child run "${existing.childRunId}" does not exist`);
          if (child.status === 'completed') {
            return completeAgentStep(
              stepId,
              existing.agentName,
              existing.childRunId,
              toJsonValue(child.output, 'Child agent output must be JSON-serializable'),
            ) as Promise<RunResult<TStepOutput>>;
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
        const childState = await prepareExecution(agentName, { ...request, signal: childSignal });
        const started = createEvent(state, 'workflow.step.started', {
          stepId,
          kind: 'agent',
          agentName,
        }) as AgentEvent;
        await commitWorkflow(
          state,
          () => {
            state.checkpoint.steps[stepId] = {
              type: 'agent',
              status: 'running',
              agentName,
              childRunId: childState.run.id,
            };
          },
          [started],
        );
        events.push(started);
        try {
          const result = await drainExecution(agentName, childState, true);
          if (!result) throw new Error(`Agent "${agentName}" did not complete`);
          const completed = createEvent(state, 'workflow.step.completed', {
            stepId,
            kind: 'agent',
          }) as AgentEvent;
          await commitWorkflow(
            state,
            () => {
              state.checkpoint.steps[stepId] = {
                type: 'agent',
                status: 'completed',
                agentName,
                childRunId: result.runId,
                result: structuredClone(result) as RunResult<JsonValue>,
              };
            },
            [completed],
          );
          events.push(completed);
          return result;
        } catch (error) {
          if (error instanceof RunPausedError) return pauseForChild(stepId, error);
          const failed = createEvent(state, 'workflow.step.failed', {
            stepId,
            kind: 'agent',
            error: toErrorMessage(error),
          }) as AgentEvent;
          await commitWorkflow(state, () => {}, [failed]);
          events.push(failed);
          throw error;
        }
      },
      async parallel<TTasks extends Record<string, () => Promise<unknown>>>(
        stepId: string,
        tasks: TTasks,
      ): Promise<{ [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>> }> {
        if (!stepId.trim()) throw new Error('Workflow step id cannot be empty');
        const existing = state.checkpoint.steps[stepId];
        if (existing?.type === 'parallel' && existing.status === 'completed') {
          return structuredClone(existing.result) as {
            [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>>;
          };
        }
        if (existing && existing.type !== 'parallel') {
          throw new Error(`Workflow step "${stepId}" was already used as ${existing.type}`);
        }
        const started = createEvent(state, 'workflow.step.started', {
          stepId,
          kind: 'parallel',
        }) as AgentEvent;
        await commitWorkflow(
          state,
          () => {
            state.checkpoint.steps[stepId] = { type: 'parallel', status: 'running' };
          },
          [started],
        );
        events.push(started);
        try {
          const entries = await Promise.all(
            Object.entries(tasks).map(async ([key, task]) => [key, await task()] as const),
          );
          const result = toJsonValue(
            Object.fromEntries(entries),
            `Workflow parallel step "${stepId}" result must be JSON-serializable`,
          );
          if (typeof result !== 'object' || result === null || Array.isArray(result)) {
            throw new Error(`Workflow parallel step "${stepId}" result must be an object`);
          }
          const completed = createEvent(state, 'workflow.step.completed', {
            stepId,
            kind: 'parallel',
          }) as AgentEvent;
          await commitWorkflow(
            state,
            () => {
              state.checkpoint.steps[stepId] = {
                type: 'parallel',
                status: 'completed',
                result,
              };
            },
            [completed],
          );
          events.push(completed);
          return structuredClone(result) as {
            [TKey in keyof TTasks]: Awaited<ReturnType<TTasks[TKey]>>;
          };
        } catch (error) {
          if (error instanceof RunPausedError) throw error;
          const failed = createEvent(state, 'workflow.step.failed', {
            stepId,
            kind: 'parallel',
            error: toErrorMessage(error),
          }) as AgentEvent;
          await commitWorkflow(state, () => {}, [failed]);
          events.push(failed);
          throw error;
        }
      },
    };

    try {
      const hash = await workflowDefinitionHash(name, workflow);
      if (state.checkpoint.definitionHash !== hash) {
        throw new FevexRunError(
          'RUN_DEFINITION_CHANGED',
          `Definition for workflow "${name}" changed`,
          state.run.id,
        );
      }
      if (state.run.revision === 0) {
        yield await emit('workflow.run.started', undefined);
      }
      state.request.signal.throwIfAborted();
      if (state.request.outputSchema !== undefined) {
        assertStandardSchema(
          state.request.outputSchema,
          `Output schema for workflow "${name}" must implement Standard Schema`,
        );
      }
      const rawOutput = await workflow.run(step, state.checkpoint.input as TInput);
      const validated =
        state.request.outputSchema === undefined
          ? rawOutput
          : await validateSchema(
              state.request.outputSchema,
              rawOutput,
              `Output from workflow "${name}" does not match outputSchema`,
            );
      const output = toJsonValue(
        validated,
        `Output from workflow "${name}" must be JSON-serializable`,
      );
      await state.commitQueue;
      state.run.status = 'completed';
      state.run.pause = undefined;
      state.run.output = output;
      const completed = createEvent(state, 'workflow.run.completed', { output }) as AgentEvent;
      await commit(state, { checkpoint: null, events: [completed] });
      events.push(completed);
      await releaseWorkflowExecution(state);
      yield completed;
      return {
        runId: state.run.id,
        sessionId: state.session.id,
        output: output as TOutput,
        events,
      };
    } catch (error) {
      if (state.request.signal.aborted) {
        const event = await cancelWorkflowExecution(state);
        if (event) {
          events.push(event);
          yield event;
        }
      } else if (state.run.status === 'paused') {
        throw error;
      } else if (state.run.status === 'running') {
        await state.commitQueue;
        state.run.status = 'failed';
        state.run.error = toErrorMessage(error);
        const failed = createEvent(state, 'workflow.run.failed', {
          error: toErrorMessage(error),
        }) as AgentEvent;
        await commit(state, { checkpoint: null, events: [failed] });
        events.push(failed);
        await releaseWorkflowExecution(state);
        yield failed;
      }
      throw error;
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
    resolution: ResumeRunResolution,
    waitForCompletion = false,
  ): Promise<AgentRun<TOutput>> => {
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
      throw new FevexRunError('RUN_NOT_RESUMABLE', `Run "${runId}" cannot be resumed`, runId);
    }
    if (run.status !== 'paused' && run.status !== 'running') {
      throw new FevexRunError('RUN_NOT_RESUMABLE', `Run "${runId}" is terminal`, runId);
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
          signal: controller.signal,
        },
        controller,
        eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
        advancing: false,
        checkpoint,
        leaseOwner: ownerId,
        ...(resolution.type === 'approval'
          ? {
              approvedToolCallId:
                run.pause?.type === 'approval' ? run.pause.approval.toolCallId : undefined,
            }
          : {
              approvedToolCallId: resolution.toolCallId,
              ...(resolution.decision === 'retry'
                ? { forcedRetryToolCallId: resolution.toolCallId }
                : {}),
            }),
      };
      if (!resolution.actor?.id?.trim()) {
        await runStore.releaseLease(runId, ownerId);
        throw new FevexRunError('APPROVAL_INVALID', 'Resolution actor is required', runId);
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
    resolution: ResumeRunResolution,
  ): Promise<WorkflowRun<TOutput>> => {
    if (!isDurableRunStore(runStore)) {
      throw new FevexRunError(
        'DURABLE_STORE_REQUIRED',
        'resumeRun requires DurableRunStore',
        runId,
      );
    }
    const run = await runStore.getRun<WorkflowRun>(runId);
    const checkpoint = await runStore.getCheckpoint<WorkflowCheckpoint>(runId);
    if (!run || !checkpoint) {
      throw new FevexRunError('RUN_NOT_RESUMABLE', `Run "${runId}" cannot be resumed`, runId);
    }
    if (run.status !== 'paused' && run.status !== 'running') {
      throw new FevexRunError('RUN_NOT_RESUMABLE', `Run "${runId}" is terminal`, runId);
    }
    const workflow = workflows.get(run.workflowName);
    if (!workflow) {
      throw new FevexRunError(
        'RUN_DEFINITION_CHANGED',
        `Workflow "${run.workflowName}" is unavailable`,
        runId,
      );
    }
    if (checkpoint.definitionHash !== (await workflowDefinitionHash(run.workflowName, workflow))) {
      throw new FevexRunError(
        'RUN_DEFINITION_CHANGED',
        `Definition for workflow "${run.workflowName}" changed`,
        runId,
      );
    }
    if (run.pause?.type !== 'workflow_child') {
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
      const childRun = await resumeAgent(run.pause.childRunId, resolution, true);
      const controller = new AbortController();
      const state: WorkflowExecutionState = {
        run,
        session,
        request: {
          input: checkpoint.input,
          sessionId: session.id,
          context: checkpoint.context,
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
        const cancelled = createEvent(state, 'workflow.run.cancelled', {
          reason: childRun.error === 'approval_rejected' ? 'approval_rejected' : 'aborted',
        }) as AgentEvent;
        await commit(state, { checkpoint: null, events: [cancelled] });
        await releaseWorkflowExecution(state);
        return structuredClone(run) as WorkflowRun<TOutput>;
      }
      run.status = 'running';
      run.pause = undefined;
      const resumed = createEvent(state, 'workflow.run.resumed', undefined) as AgentEvent;
      await commit(state, { checkpoint, events: [resumed] });
      activeWorkflowRuns.set(runId, state);
      activeSessions.add(session.id);
      startLease(state, runStore);
      void drainWorkflowExecution(run.workflowName, state, false).catch(() => {});
      return structuredClone(run) as WorkflowRun<TOutput>;
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
    if (run && isWorkflowRun(run)) return resumeWorkflow<TOutput>(runId, resolution);
    return resumeAgent<TOutput>(runId, resolution);
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
      if (run?.status !== 'paused') return false;
      if (!isDurableRunStore(runStore)) return false;
      const session = await runStore.getSession(run.sessionId);
      if (!session) return false;
      if (isWorkflowRun(run)) {
        const checkpoint = await runStore.getCheckpoint<WorkflowCheckpoint>(runId);
        if (!checkpoint) return false;
        const state: WorkflowExecutionState = {
          run,
          session,
          request: { input: checkpoint.input, sessionId: session.id, signal: new AbortController().signal },
          controller: new AbortController(),
          eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
          checkpoint,
          advancing: false,
          commitQueue: Promise.resolve(),
        };
        run.status = 'cancelled';
        run.pause = undefined;
        run.error = 'aborted';
        const cancelled = createEvent(state, 'workflow.run.cancelled', { reason: 'aborted' }) as AgentEvent;
        try {
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
        }
      }
      const state: ExecutionState = {
        run: run as AgentRun,
        session,
        request: { input: '', sessionId: session.id, signal: new AbortController().signal },
        controller: new AbortController(),
        eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
        advancing: false,
      };
      run.status = 'cancelled';
      run.pause = undefined;
      run.error = 'aborted';
      const cancelled = createEvent(state, 'run.cancelled', { reason: 'aborted' }) as AgentEvent;
      try {
        await commit(state, { checkpoint: null, events: [cancelled] });
        return true;
      } catch (error) {
        if (
          error instanceof FevexRunError &&
          error.code === 'RUN_CONFLICT' &&
          (await runStore.getRun(runId))?.status !== 'paused'
        )
          return false;
        throw error;
      }
    },
    resumeRun<TOutput = unknown>(runId: string, resolution: ResumeRunResolution) {
      return resumeRun<TOutput>(runId, resolution);
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
