import type {
  AgentEvent,
  AgentEventPayloads,
  AgentEventType,
  AgentMessage,
  JsonValue,
  ToolSpec,
} from '../core';
import type {
  ArtifactDescriptor,
  ArtifactStore,
  ArtifactStoreContext,
} from '../artifacts';
import {
  isProgressiveSkillProvider,
  type KnowledgeContext,
  type ProgressiveSkillProvider,
} from '../knowledge';
import type { ModelGateway, ModelUsage, ToolChoice } from '../models';
import { FevexRunError, RunPausedError } from '../run-error';
import {
  isDurableRunStore,
  resolveContextBudget,
  type AgentRun,
  type DurableRunStore,
  type PendingToolExecution,
  type ResumeRunResolution,
  type RunCheckpoint,
  type RunRequest,
  type ContextCompactionStats,
  type RunResult,
  type Session,
} from '../runtime';
import { compileFevexJsonSchema, toToolSpec } from '../tools';
import type { FevexComposition } from './configuration';
import {
  executeInternalTool,
  type SemanticToolIndexState,
} from './agent-internal-tools';
import {
  capSummary,
  compactContext,
  MAX_COMPACTION_EVENT_SUMMARY_CHARS,
} from './context-compaction';
import { definitionHash } from './definition-hash';
import {
  resolveToolSearchOptions,
  serializeToolSearchOptions,
  shouldUseToolSearch,
} from './tool-search';
import { serializeJsonValue, serializeValue, toJsonValue } from './json';
import {
  abortable,
  addUsage,
  assertContinuationBudget,
  assertTokenBudget,
  deadlineAtFromMs,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOOL_CALLS,
  eventUsage,
  remainingOutputTokens,
  resumeDeadlineSignal,
  runSignal,
  toErrorMessage,
} from './run-support';
import { toTransportableSchema, validateSchema } from './schemas';
import { readModelStream } from './model-stream';
import { combineLimits } from './workflow-budget';
import {
  containsSecret,
  effectiveApprovalMode,
  effectiveElicitationMode,
  effectiveToolChoice,
  isElicitationToolCall,
  readElicitationInput,
  readMemoryMessages,
  redact,
  runErrorPayload,
  systemBlock,
  toolErrorPayload,
  toolLabelPayload,
  toolSourcePayload,
} from './run-helpers';
import type { ExecutionState } from './run-state';
import {
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  ELICIT_TOOL_NAME,
  LEASE_MS,
  LOAD_SKILL_TOOL_NAME,
  SEARCH_TOOLS_TOOL_NAME,
} from './runtime-constants';

import type { RunCore } from './run-core';

/**
 * Everything that runs a single agent: preparation, the model/tool loop,
 * checkpointing, knowledge and memory, resume and out-of-band cancellation.
 *
 * Depends only on {@link RunCore}. It must never reach into the workflow
 * engine — that direction is what keeps the two separable.
 */
export function createAgentEngine(composition: FevexComposition, core: RunCore) {
  const {
    models,
    agents,
    tools,
    contextProviders,
    contextBudget: defaultContextBudget,
    compaction,
    toolSearch: defaultToolSearch,
    toolSearchCache: defaultToolSearchCache,
    memoryStore,
    runStore,
    credentialStore,
    sandbox,
    artifacts,
    policies,
  } = composition;
  const compactionStats: ContextCompactionStats = {
    compactions: 0,
    removedMessages: 0,
    estimatedTokens: 0,
    compactedTokens: 0,
    savedTokens: 0,
  };
  const cleanupSandboxRun = async (runId: string): Promise<void> => {
    if (sandbox?.cleanupRun === undefined) return;
    try {
      await sandbox.cleanupRun(runId);
    } catch {
      // Sandbox cleanup is best effort and must never fail a terminal run.
    }
  };
  const {
    activeRuns,
    activeSessions,
    runtimeOwner,
    isClosed,
    admitStart,
    markInternalRun,
    resolveModel,
    resolveCheckpointModel,
    notifyObserver,
    createEvent,
    emitEvent,
    releaseExecution,
    commit,
    startLease,
    cancelExecution,
    authorize,
  } = core;

  const prepareExecutionBody = async <TInput, TOutput>(
    name: string,
    request: RunRequest<TInput, TOutput>,
    internal = false,
    correlation: { parentRunId?: string; rootRunId?: string } = {},
  ): Promise<ExecutionState<TInput, TOutput>> => {
    if (!internal && isClosed()) {
      throw new FevexRunError('RUNTIME_CLOSED', 'Runtime is not accepting new runs');
    }
    const agent = agents.get(name);
    if (!agent) {
      throw new FevexRunError('AGENT_NOT_FOUND', `Agent "${name}" is not registered`);
    }
    const contextBudget = resolveContextBudget(
      request.contextBudget ?? agent.contextBudget ?? defaultContextBudget,
      `Agent "${name}" contextBudget`,
    );
    const toolSearch = resolveToolSearchOptions(
      request.toolSearch ?? agent.toolSearch ?? defaultToolSearch,
      `Agent "${name}" toolSearch`,
      defaultToolSearchCache,
    );
    const toolChoice = effectiveToolChoice(agent, request);
    const initialLoadedTools = new Set(
      toolSearch.pinned.filter((toolName) => agent.tools?.includes(toolName)),
    );
    if (typeof toolChoice === 'object' && agent.tools?.includes(toolChoice.name)) {
      initialLoadedTools.add(toolChoice.name);
    }
    const { modelName, model } = resolveModel(agent, request.model);
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
    const controller = new AbortController();
    const signal = runSignal(controller, request);
    const deadlineAt = deadlineAtFromMs(request.deadlineMs);
    activeSessions.add(session.id);
    const run: AgentRun = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      agentName: name,
      modelName,
      ...(model.metadata === undefined ? {} : { modelMetadata: structuredClone(model.metadata) }),
      ...(correlation.parentRunId === undefined
        ? {}
        : { parentRunId: correlation.parentRunId }),
      ...(correlation.rootRunId === undefined ? {} : { rootRunId: correlation.rootRunId }),
      status: 'running',
      revision: 0,
      createdAt: now,
      updatedAt: now,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
    };
    if (internal) markInternalRun(run.id);
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
          ...sessionHistoryMessages(session),
          ...knowledge.context,
          { role: 'user', content: inputContent },
        ];
        const checkpoint: RunCheckpoint = {
          version: 2,
          runId: run.id,
          ...(request.model !== undefined || typeof agent.model === 'string'
            ? { modelName }
            : {}),
          ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
          definitionHash: await definitionHash(
            name,
            modelName,
            agent,
            tools,
            contextBudget,
          ),
          limits: combineLimits(agent.limits, request.limits),
          ...(contextBudget === undefined ? {} : { contextBudget }),
          toolSearch: serializeToolSearchOptions(toolSearch),
          loadedTools: [...initialLoadedTools],
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
          effectiveToolChoice: toolChoice,
        };
        const ownerId = `${runtimeOwner}:${crypto.randomUUID()}`;
        const lease = {
          generation: 0, runId: run.id, ownerId,
          expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
        };
        const started = createEvent(state, 'run.started', undefined) as AgentEvent;
        const initialEvents = [started];
        const created = await runStore.createExecution({
          run,
          checkpoint,
          session,
          lease,
          events: initialEvents,
        });
        if (!created) throw new FevexRunError('RUN_CONFLICT', `Run or session "${session.id}" is active or was modified`, run.id);
        state.checkpoint = checkpoint;
        state.lease = lease;
        state.initialEvents = initialEvents;
        for (const event of initialEvents) notifyObserver(event);
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

  const prepareExecution = async <TInput, TOutput>(
    name: string,
    request: RunRequest<TInput, TOutput>,
    options: {
      admit?: boolean;
      parentRunId?: string;
      rootRunId?: string;
    } = {},
  ): Promise<ExecutionState<TInput, TOutput>> => {
    const release = options.admit === false
      ? undefined
      : await admitStart('agent', name, request);
    try {
      return await prepareExecutionBody(name, request, options.admit === false, {
        ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
        ...(options.rootRunId === undefined ? {} : { rootRunId: options.rootRunId }),
      });
    } finally {
      release?.();
    }
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
    const contextBudget = resolveContextBudget(
      state.checkpoint?.contextBudget
        ?? state.request.contextBudget
        ?? agent.contextBudget
        ?? defaultContextBudget,
      `Agent "${state.run.agentName}" contextBudget`,
    );
    const toolSearch = state.toolSearch ?? resolveToolSearchOptions(
      state.checkpoint?.toolSearch
        ?? state.request.toolSearch
        ?? agent.toolSearch
        ?? defaultToolSearch,
      `Agent "${state.run.agentName}" toolSearch`,
      defaultToolSearchCache,
    );
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
      modelName,
      ...(state.request.reasoning === undefined ? {} : { reasoning: state.request.reasoning }),
      definitionHash: await definitionHash(
        state.run.agentName,
        modelName,
        agent,
        tools,
        contextBudget,
      ),
      limits: state.checkpoint?.limits ?? combineLimits(agent.limits, state.request.limits),
      ...(contextBudget === undefined ? {} : { contextBudget }),
      toolSearch: serializeToolSearchOptions(toolSearch),
      loadedTools: [...(state.loadedTools ?? [])],
      messages: structuredClone(messages),
      inputContent,
      ...(state.checkpoint?.memoryLoaded === undefined
        ? {}
        : { memoryLoaded: state.checkpoint.memoryLoaded }),
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
  ): Promise<{ skills: AgentMessage[]; context: AgentMessage[] }> => {
    const context = knowledgeContext(state, input);
    const skills = (
      await Promise.all((agent.skills ?? []).map((name) => readProvider(name, 'Skill', context)))
    ).flat();
    const contextual = (
      await Promise.all((agent.context ?? []).map((name) => readProvider(name, 'Context', context)))
    ).flat();
    return { skills, context: contextual };
  };

  const writeMemory = async (
    state: ExecutionState,
    agent: FevexComposition['agents'] extends Map<string, infer T> ? T : never,
    input: string,
    output: JsonValue,
    emit: <TType extends AgentEventType>(
      type: TType,
      payload: AgentEventPayloads[TType],
    ) => Promise<AgentEvent>,
  ): Promise<void> => {
    if (!agent.memory?.write || !memoryStore) return;
    const context = knowledgeContext(state, input);
    const startedAt = performance.now();
    let recordId: string | undefined;
    try {
      const record = await abortable(
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
      recordId = record.id;
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      await emit('memory.completed', {
        operation: 'write',
        durationMs: performance.now() - startedAt,
        error,
      }).catch(() => {});
      throw new Error('Memory write failed', { cause });
    }
    await emit('memory.completed', {
      operation: 'write',
      durationMs: performance.now() - startedAt,
      recordCount: 1,
      ...(recordId === undefined ? {} : { recordId }),
    });
  };

  async function* executeAgent<TInput = unknown, TOutput = unknown>(
    name: string,
    state: ExecutionState<TInput, TOutput>,
  ): AsyncGenerator<AgentEvent, RunResult<TOutput> | undefined> {
    const { request } = state;
    const agent = agents.get(name)!;
    const { modelName, model } = resolveModel(agent, state.checkpoint?.modelName ?? request.model);
    const contextBudget = resolveContextBudget(
      state.checkpoint?.contextBudget
        ?? request.contextBudget
        ?? agent.contextBudget
        ?? defaultContextBudget,
      `Agent "${name}" contextBudget`,
    );
    // Checkpoints created before tool search existed keep their original full tool list.
    const semantic =
      request.toolSearch?.semantic
      ?? agent.toolSearch?.semantic
      ?? defaultToolSearch?.semantic;
    const toolSearch = resolveToolSearchOptions(
      state.checkpoint === undefined
        ? request.toolSearch ?? agent.toolSearch ?? defaultToolSearch
        : state.checkpoint.toolSearch === undefined
          ? { mode: 'off' as const, ...(semantic === undefined ? {} : { semantic }) }
          : {
              ...state.checkpoint.toolSearch,
              ...(semantic === undefined ? {} : { semantic }),
            },
      `Agent "${name}" toolSearch`,
      defaultToolSearchCache,
    );
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
    let compactionApplied = false;
    const semanticState: SemanticToolIndexState = { attempted: false };

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
        const hash = await definitionHash(
          name,
          modelName,
          agent,
          tools,
          contextBudget,
        );
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
          ...sessionHistoryMessages(state.session),
          ...knowledge.context,
          { role: 'user', content: inputContent },
        ];
        step = 1;
        toolCallCount = 0;
        seenToolCallIds = new Set();
        pendingTools = [];
        pendingIndex = 0;
      }

      const memoryLoaded =
        state.checkpoint?.memoryLoaded ??
        messages.some(
          (message, index) =>
            index > 0 && message.role === 'system' && message.content.startsWith('[Memory: '),
        );
      if (!memoryLoaded && agent.memory && agent.memory.read !== false && memoryStore) {
        const memory = await readMemoryMessages(
          agent,
          knowledgeContext(state, inputContent),
          memoryStore,
        );
        if (memory.trace) {
          yield await emit('memory.completed', {
            operation: 'search',
            durationMs: memory.trace.durationMs,
            ...(memory.trace.recordCount === undefined
              ? {}
              : { recordCount: memory.trace.recordCount }),
            ...(memory.trace.error === undefined ? {} : { error: memory.trace.error }),
          });
        }
        if (memory.error !== undefined) {
          throw new Error('Memory search failed', { cause: memory.error });
        }
        if (memory.messages.length) {
          messages.splice(Math.max(0, messages.length - 1), 0, ...memory.messages);
        }
        if (state.checkpoint) {
          state.checkpoint.memoryLoaded = true;
          await commit(state, { checkpoint: state.checkpoint });
        }
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
      const progressiveSkills = (agent.skills ?? [])
        .map((skillName) => contextProviders.get(skillName))
        .filter(
          (provider): provider is ProgressiveSkillProvider =>
            provider !== undefined && isProgressiveSkillProvider(provider),
        );
      const skillTool = progressiveSkills.length === 0
        ? undefined
        : {
            name: LOAD_SKILL_TOOL_NAME,
            description: `Load the full instructions for one of this agent's skills. Available skills: ${progressiveSkills
              .map((skill) => skill.name)
              .join(', ')}. Pass a resource path from the loaded skill to read one resource.`,
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  enum: progressiveSkills.map((skill) => skill.name),
                },
                resource: {
                  type: 'string',
                  description: 'Optional resource path returned by a previous load.',
                },
              },
              required: ['name'],
              additionalProperties: false,
            },
          };
      const searchEnabled = shouldUseToolSearch(toolSearch, agentTools);
      const searchTool: ToolSpec | undefined = searchEnabled
        ? {
            name: SEARCH_TOOLS_TOOL_NAME,
            description: `Search ${agentTools.length} tools available to this agent by capability. Use it when you need a tool that is not currently exposed. Returns matching tools and makes their schemas available on the next turn.`,
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Capability to search for, such as "send email" or "query database".',
                },
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: toolSearch.limit,
                },
              },
              required: ['query'],
              additionalProperties: false,
            },
          }
        : undefined;
      const elicitationTool: ToolSpec | undefined = currentElicitationMode === 'pause'
        ? {
            name: ELICIT_TOOL_NAME,
            description:
              'Request external information required to continue this run. Use prompt for explanatory text shown outside the form. Put short field labels in responseSchema property titles and optional field help in property descriptions.',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'Explanatory text for the user; do not duplicate field labels here.',
                },
                responseSchema: {
                  type: 'object',
                  description:
                    'JSON Schema for the expected response. Each property should include a short title for the form label and may include a description for field help.',
                },
                expiresAt: { type: 'string' },
              },
              required: ['prompt', 'responseSchema'],
              additionalProperties: false,
            },
          }
        : undefined;
      const allTools: ToolSpec[] = [
        ...agentTools,
        ...(skillTool === undefined ? [] : [skillTool]),
        ...(searchTool === undefined ? [] : [searchTool]),
        ...(elicitationTool === undefined ? [] : [elicitationTool]),
      ];
      const loadedTools = new Set(state.loadedTools ?? state.checkpoint?.loadedTools ?? []);
      for (const toolName of toolSearch.pinned) {
        if (agent.tools?.includes(toolName)) loadedTools.add(toolName);
      }
      if (typeof currentToolChoice === 'object' && agent.tools?.includes(currentToolChoice.name)) {
        loadedTools.add(currentToolChoice.name);
      }
      state.loadedTools = loadedTools;
      state.toolSearch = toolSearch;
      let loadedToolsVersion = 0;
      let cachedModelTools: ToolSpec[] | undefined;
      let cachedModelToolsVersion = -1;
      const modelTools = (): ToolSpec[] => {
        if (!searchEnabled) return allTools;
        if (cachedModelTools !== undefined && cachedModelToolsVersion === loadedToolsVersion) {
          return cachedModelTools;
        }
        cachedModelTools = [
          ...agentTools.filter((tool) => loadedTools.has(tool.name)),
          ...(skillTool === undefined ? [] : [skillTool]),
          ...(searchTool === undefined ? [] : [searchTool]),
          ...(elicitationTool === undefined ? [] : [elicitationTool]),
        ];
        cachedModelToolsVersion = loadedToolsVersion;
        return cachedModelTools;
      };
      // ponytail: assumes message and tool estimates are additive; re-evaluate with a custom tokenizer if not.
      const toolsTokenCache = new WeakMap<readonly ToolSpec[], number>();
      const estimateContext = (
        input: { messages: AgentMessage[]; tools?: ToolSpec[] },
      ): number => {
        if (!input.tools?.length) return compaction.estimateTokens(input);
        let toolTokens = toolsTokenCache.get(input.tools);
        if (toolTokens === undefined) {
          toolTokens = compaction.estimateTokens({ messages: [], tools: input.tools });
          toolsTokenCache.set(input.tools, toolTokens);
        }
        return compaction.estimateTokens({ messages: input.messages }) + toolTokens;
      };
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
          const currentTools = modelTools();
          if (contextBudget !== undefined) {
            const compacted = await compactContext({
              runId: state.run.id,
              agentName: name,
              sessionId: state.session.id,
              messages,
              tools: currentTools,
              contextBudget,
              compactor: compaction.compactor,
              estimateTokens: estimateContext,
              step,
              ...(request.context === undefined ? {} : { context: request.context }),
              signal: request.signal,
              allowCompaction: !compactionApplied,
            });
            if (compacted !== undefined) {
              messages = compacted.messages;
              compactionApplied = true;
              compactionStats.compactions += 1;
              compactionStats.removedMessages += compacted.removedMessages;
              compactionStats.estimatedTokens += compacted.estimatedTokens;
              compactionStats.compactedTokens += compacted.compactedTokens;
              compactionStats.savedTokens += Math.max(
                0,
                compacted.estimatedTokens - compacted.compactedTokens,
              );
              const previous = state.session.compaction;
              const combined = previous === undefined
                ? compacted.summary
                : `${previous.summary}\n\n${compacted.summary}`;
              // ponytail: cap the derived cache; re-summarize old segments if this becomes lossy.
              const maxSummaryChars = Math.max(200, contextBudget.targetTokens * 4);
              state.session.compaction = {
                summary: capSummary(combined, maxSummaryChars),
                coveredMessages: state.session.history.length,
                updatedAt: new Date().toISOString(),
              };
              const redactedSummary = compaction.redactSummary?.(compacted.summary)
                ?? compacted.summary;
              if (typeof redactedSummary !== 'string') {
                throw new TypeError('compaction.redactSummary must return a string');
              }
              const summaryTruncated =
                redactedSummary.length > MAX_COMPACTION_EVENT_SUMMARY_CHARS;
              const event = createEvent(state, 'context.compacted', {
                step,
                removedMessages: compacted.removedMessages,
                estimatedTokens: compacted.estimatedTokens,
                compactedTokens: compacted.compactedTokens,
                targetTokens: contextBudget.targetTokens,
                contextWindow: contextBudget.contextWindow,
                summary: summaryTruncated
                  ? capSummary(redactedSummary, MAX_COMPACTION_EVENT_SUMMARY_CHARS)
                  : redactedSummary,
                ...(summaryTruncated ? { summaryTruncated: true } : {}),
              }) as AgentEvent;
              if (isDurableRunStore(runStore)) {
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
                await commit(state, {
                  checkpoint,
                  session: state.session,
                  events: [event],
                });
                state.checkpoint = checkpoint;
              } else {
                await runStore.appendEvent(event);
                notifyObserver(event);
              }
              events.push(event);
              yield event;
            }
          }
          const hasToolBudget = step < maxSteps && toolCallCount < maxToolCalls;
          const modelToolChoice: ToolChoice | undefined =
            hasToolBudget && currentTools.length
              ? (currentToolChoice === 'auto' ? undefined : currentToolChoice)
              : undefined;
          yield await emit('model.started', { step });
          const modelStream = readModelStream(model, {
            messages: [...messages],
            tools: hasToolBudget && currentTools.length ? currentTools : undefined,
            ...(modelToolChoice === undefined ? {} : { toolChoice: modelToolChoice }),
            reasoning: state.request.reasoning ?? agent.reasoning,
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
            await writeMemory(state, agent, inputContent, output, emit);
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
          const internalCall = result.toolCalls.find(
            (call) =>
              (searchEnabled && call.name === SEARCH_TOOLS_TOOL_NAME)
              || (progressiveSkills.length > 0 && call.name === LOAD_SKILL_TOOL_NAME),
          );
          if (internalCall) {
            if (result.toolCalls.length !== 1) {
              throw new Error(
                `${internalCall.name} must be the only tool call in a model turn`,
              );
            }
            if (!internalCall.id?.trim()) throw new Error('Tool call id cannot be empty');
            if (seenToolCallIds.has(internalCall.id)) {
              throw new Error(
                `Tool call id "${internalCall.id}" is duplicated in run "${state.run.id}"`,
              );
            }
            if (toolCallCount + 1 > maxToolCalls) {
              throw new Error(`Agent "${name}" exceeded maxToolCalls limit of ${maxToolCalls}`);
            }
            const rawInput = toJsonValue(
              internalCall.input,
              `Input for tool "${internalCall.name}" must be JSON-serializable`,
            );
            const loadedBefore = loadedTools.size;
            seenToolCallIds.add(internalCall.id);
            messages.push({
              role: 'assistant',
              content:
                result.output === undefined
                  ? ''
                  : serializeValue(
                      result.output,
                      `Model output for agent "${name}" must be serializable`,
                    ),
              toolCalls: [{ ...internalCall, input: rawInput }],
            });
            yield await emit('tool.started', {
              step,
              toolCallId: internalCall.id,
              toolName: internalCall.name,
              risk: 'read',
              declaredRisk: 'read',
            });
            let execution;
            try {
              execution = await executeInternalTool({
                call: internalCall,
                input: rawInput,
                tools: agentTools,
                searchEnabled,
                toolSearch,
                loadedTools,
                progressiveSkills,
                knowledgeContext: knowledgeContext(state, inputContent),
                semanticState,
                signal: request.signal,
              });
            } catch (error) {
              yield await emit('tool.failed', {
                step,
                toolCallId: internalCall.id,
                toolName: internalCall.name,
                error: toErrorMessage(error),
              });
              throw error;
            }
            if (!execution) {
              throw new Error(`Tool "${internalCall.name}" is not available to agent "${name}"`);
            }
            if (loadedTools.size > loadedBefore) loadedToolsVersion += 1;
            messages.push({
              role: 'tool',
              name: internalCall.name,
              toolCallId: internalCall.id,
              content: execution.content,
            });
            yield await emit('tool.completed', {
              step,
              toolCallId: internalCall.id,
              toolName: internalCall.name,
            });
            toolCallCount += 1;
            step += 1;
            continue;
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
            if (searchEnabled && !loadedTools.has(call.name)) {
              throw new Error(
                `Tool "${call.name}" is not loaded; use ${SEARCH_TOOLS_TOOL_NAME} first`,
              );
            }
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
          const policy = await authorize(
            state,
            tool,
            pending.input,
            'tool.execute',
            state.request.context,
            pending.call.id,
          );
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
              ...(tool.label === undefined ? {} : { toolLabel: tool.label }),
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
              ...toolLabelPayload(tool),
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
              const retryDecision = await authorize(
                state,
                tool,
                pending.input,
                'tool.execute',
                state.request.context,
                pending.call.id,
              );
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
                  ...(tool.label === undefined ? {} : { toolLabel: tool.label }),
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
                  ...toolLabelPayload(tool),
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
              risk: tool.risk ?? 'read',
              ...(tool.risk === undefined ? {} : { declaredRisk: tool.risk }),
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
            const createdArtifacts: AgentEvent[] = [];
            const toolArtifacts = artifacts === undefined
              ? undefined
              : scopedArtifacts(artifacts, {
                  runId: state.run.id,
                  sessionId: state.session.id,
                  request,
                  emit: async (descriptor) => {
                    createdArtifacts.push(
                      await emit('artifact.created', {
                        descriptor,
                        toolCallId: pending.call.id,
                        toolName: pending.call.name,
                        ...toolSourcePayload(tool),
                      }),
                    );
                  },
                });
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
                    ...(toolArtifacts === undefined ? {} : { artifacts: toolArtifacts }),
                    context: request.context,
                    signal: request.signal,
                  }),
                request.signal,
              );
              for (const event of createdArtifacts.splice(0)) yield event;
              const validated =
                tool.outputSchema === undefined
                  ? raw
                  : await validateSchema(
                      tool.outputSchema,
                      raw,
                      `Output from tool "${tool.name}" does not match outputSchema`,
                    );
              const serialized = serializeValue(
                validated,
                `Output from tool "${tool.name}" must be JSON-serializable`,
              );
              const configuredMaxResultBytes = tool.maxResultBytes !== undefined
                ? tool.maxResultBytes
                : effectiveLimits?.maxToolResultBytes;
              const maxResultBytes = configuredMaxResultBytes === undefined
                ? DEFAULT_MAX_TOOL_RESULT_BYTES
                : configuredMaxResultBytes;
              const resultBytes = new TextEncoder().encode(serialized).byteLength;
              if (maxResultBytes !== false && resultBytes > maxResultBytes) {
                throw new FevexRunError(
                  'TOOL_RESULT_TOO_LARGE',
                  `Tool "${tool.name}" returned ${resultBytes} bytes; limit is ${maxResultBytes}. Store large outputs as artifacts and return an artifact descriptor.`,
                  state.run.id,
                );
              }
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
              for (const event of createdArtifacts.splice(0)) yield event;
              if (request.signal.aborted) throw error;
              const safeError = redact(toErrorMessage(error), secrets);
              record = {
                ...record,
                status: 'failed',
                error: safeError,
                updatedAt: new Date().toISOString(),
              };
              if (durable) await commit(state, { toolExecution: record });
              if (
                attempt >= maxAttempts
                || tool.idempotency !== 'keyed'
                || (error instanceof FevexRunError && error.code === 'TOOL_RESULT_TOO_LARGE')
              ) {
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

  const drainExecution = async <TInput, TOutput>(
    name: string,
    state: ExecutionState<TInput, TOutput>,
    throwOnPause: boolean,
  ): Promise<RunResult<TOutput> | undefined> => {
    const execution = executeAgent(name, state);
    try {
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
    } finally {
      if (state.run.status !== 'running' && state.run.status !== 'paused') {
        await cleanupSandboxRun(state.run.id);
      }
    }
  };

  const resumeAgentBody = async <TOutput>(
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
    if (run.deadlineAt !== undefined && Date.parse(run.deadlineAt) <= Date.now()) {
      const cancelled = await cancelStoredAgent(runId, 'timeout');
      if (!cancelled) {
        throw new FevexRunError(
          resolution ? 'RUN_NOT_RESUMABLE' : 'RUN_NOT_RECOVERABLE',
          `Run "${runId}" deadline has passed`,
          runId,
        );
      }
      return (await runStore.getRun<AgentRun>(runId))! as AgentRun<TOutput>;
    }
    const deadlineSignal = resumeDeadlineSignal(
      run.deadlineAt,
      runId,
      resolution ? 'RUN_NOT_RESUMABLE' : 'RUN_NOT_RECOVERABLE',
    );
    const agent = agents.get(run.agentName);
    if (!agent) {
      throw new FevexRunError(
        'RUN_DEFINITION_CHANGED',
        `Agent "${run.agentName}" is unavailable`,
        runId,
      );
    }
    const checkpointModel = await resolveCheckpointModel(run.agentName, agent, checkpoint);
    if (!checkpointModel) {
      throw new FevexRunError(
        'RUN_DEFINITION_CHANGED',
        `Definition for agent "${run.agentName}" changed`,
        runId,
      );
    }
    const { modelName, model } = checkpointModel;
    if (run.modelName === undefined) {
      run.modelName = modelName;
      run.modelMetadata = model.metadata === undefined ? undefined : structuredClone(model.metadata);
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
    const lease = {
      generation: 0,
      runId,
      ownerId,
      expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    };
    const acquired = await runStore.acquireLease(lease);
    if (!acquired) throw new FevexRunError('RUN_CONFLICT', `Run "${runId}" is leased`, runId);

    try {
      const controller = new AbortController();
      const signal = deadlineSignal
        ? AbortSignal.any([controller.signal, deadlineSignal])
        : controller.signal;
      const state: ExecutionState = {
        run,
        session,
        request: {
          input: '',
          model: modelName,
          ...(checkpoint.reasoning === undefined ? {} : { reasoning: checkpoint.reasoning }),
          sessionId: session.id,
          context: checkpoint.context,
          limits: checkpoint.limits,
          signal,
        },
        controller,
        eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
        advancing: false,
        checkpoint,
        lease,
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
        await runStore.releaseLease(runId, ownerId, lease.generation);
        throw new FevexRunError(
          resolution.type === 'elicitation' ? 'ELICITATION_INVALID' : 'APPROVAL_INVALID',
          'Resolution actor is required',
          runId,
        );
      }

      if (resolution.type === 'elicitation') {
        const pause = run.pause;
        if (pause?.type !== 'elicitation' || pause.request.id !== resolution.requestId) {
          await runStore.releaseLease(runId, ownerId, lease.generation);
          throw new FevexRunError(
            'ELICITATION_INVALID',
            'Elicitation does not match the run',
            runId,
          );
        }
        if (pause.request.expiresAt && Date.now() > Date.parse(pause.request.expiresAt)) {
          await runStore.releaseLease(runId, ownerId, lease.generation);
          throw new FevexRunError('ELICITATION_INVALID', 'Elicitation has expired', runId);
        }
        let value: JsonValue;
        try {
          value = compileFevexJsonSchema(pause.request.responseSchema).validate(
            resolution.value,
          );
        } catch (error) {
          await runStore.releaseLease(runId, ownerId, lease.generation);
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
          await runStore.releaseLease(runId, ownerId, lease.generation);
          throw new FevexRunError('APPROVAL_INVALID', 'Approval does not match the run', runId);
        }
        const pending = checkpoint.pendingTools[checkpoint.pendingIndex];
        const tool = pending && tools.get(pending.call.name);
        if (!pending || !tool) {
          await runStore.releaseLease(runId, ownerId, lease.generation);
          throw new FevexRunError('APPROVAL_INVALID', 'Approval tool is unavailable', runId);
        }
        if (resolution.decision === 'approve') {
          await authorize(
            state,
            tool,
            pending.input,
            'approval.resolve',
            {
              ...state.request.context,
              actor: resolution.actor,
            },
            pending.call.id,
          );
        }
        if (resolution.decision === 'reject') {
          const approval = run.pause.approval;
          const toolCallId = approval.toolCallId;
          run.status = 'cancelled';
          run.pause = undefined;
          run.error = 'approval_rejected';
          const resolved = createEvent(state, 'approval.resolved', {
            approvalId: resolution.approvalId,
            toolCallId,
            decision: 'reject',
            actorId: resolution.actor.id,
            ...(approval.toolLabel === undefined
              ? {}
              : { toolLabel: approval.toolLabel }),
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
          await runStore.releaseLease(runId, ownerId, lease.generation);
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
          await runStore.releaseLease(runId, ownerId, lease.generation);
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
            ...(approval.toolLabel === undefined ? {} : { toolLabel: approval.toolLabel }),
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
      await runStore.releaseLease(runId, ownerId, lease.generation).catch(() => {});
      throw error;
    }
  };

  const resumeAgent = async <TOutput>(
    runId: string,
    resolution: ResumeRunResolution | undefined,
    waitForCompletion = false,
    recoveryActor?: { id: string; type?: string },
    options: { admit?: boolean; internal?: boolean } = {},
  ): Promise<AgentRun<TOutput>> => {
    let release: (() => void) | undefined;
    if (options.admit !== false) {
      const run = await runStore.getRun<AgentRun>(runId);
      const checkpoint = isDurableRunStore(runStore)
        ? await runStore.getCheckpoint<RunCheckpoint>(runId)
        : undefined;
      if (run && checkpoint && (run.status === 'paused' || run.status === 'running')) {
        release = await admitStart('agent', run.agentName, {
          input: '',
          ...(checkpoint.context === undefined ? {} : { context: checkpoint.context }),
        });
      }
    }
    try {
      if (options.internal) markInternalRun(runId);
      return await resumeAgentBody<TOutput>(
        runId,
        resolution,
        waitForCompletion,
        recoveryActor,
      );
    } finally {
      release?.();
    }
  };

  const cancelStoredAgent = async (
    runId: string,
    reason: 'aborted' | 'timeout' = 'aborted',
  ): Promise<boolean> => {
    const active = activeRuns.get(runId);
    if (active && !active.request.signal.aborted) {
      active.controller.abort(new DOMException(
        reason === 'timeout' ? 'Run deadline exceeded' : 'Run cancelled',
        reason === 'timeout' ? 'TimeoutError' : 'AbortError',
      ));
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
    const lease = {
      generation: 0,
      runId,
      ownerId,
      expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    };
    const acquired = await runStore.acquireLease(lease);
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
        lease,
      };
      run.status = 'cancelled';
      run.pause = undefined;
      run.error = reason;
      const cancelled = createEvent(state, 'run.cancelled', { reason }) as AgentEvent;
      await commit(state, { checkpoint: null, events: [cancelled] });
      await cleanupSandboxRun(runId);
      return true;
    } catch (error) {
      if (error instanceof FevexRunError && error.code === 'RUN_CONFLICT') return false;
      throw error;
    } finally {
      await runStore.releaseLease(runId, ownerId, lease.generation).catch(() => {});
    }
  };

  return {
    prepareExecution,
    executeAgent,
    nextEvent,
    drainExecution,
    resumeAgent,
    cancelStoredAgent,
    getCompactionStats() {
      return { ...compactionStats };
    },
  };
}

/** The agent-run surface the workflow engine and the public runtime consume. */
export type AgentEngine = ReturnType<typeof createAgentEngine>;

function sessionHistoryMessages(session: Session): AgentMessage[] {
  const compaction = session.compaction;
  if (
    compaction === undefined
    || compaction.coveredMessages <= 0
    || compaction.coveredMessages > session.history.length
  ) {
    return session.history;
  }
  return [
    { role: 'system', content: `[Compacted conversation]\n${compaction.summary}` },
    ...session.history.slice(compaction.coveredMessages),
  ];
}

function scopedArtifacts(
  store: ArtifactStore,
  options: {
    runId: string;
    sessionId: string;
    request: RunRequest;
    emit: (descriptor: ArtifactDescriptor) => Promise<void>;
  },
): ArtifactStore {
  const scopedContext = (value?: ArtifactStoreContext): ArtifactStoreContext => {
    const contextTenant = options.request.context?.attributes?.tenantId;
    const tenantId = typeof contextTenant === 'string' ? contextTenant : value?.tenantId;
    const actor = options.request.context?.actor;
    return {
      ...value,
      runId: options.runId,
      sessionId: options.sessionId,
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(actor === undefined ? {} : { actor }),
      signal: options.request.signal,
    };
  };

  return {
    async put(input, context) {
      const descriptor = await store.put(input, scopedContext(context));
      await options.emit(descriptor);
      return descriptor;
    },
    get(artifactId, context) {
      return store.get(artifactId, scopedContext(context));
    },
    ...(store.head === undefined
      ? {}
      : {
          head(artifactId: string, context?: ArtifactStoreContext) {
            return store.head!(artifactId, scopedContext(context));
          },
        }),
    ...(store.delete === undefined
      ? {}
      : {
          delete(artifactId: string, context?: ArtifactStoreContext) {
            return store.delete!(artifactId, scopedContext(context));
          },
        }),
  };
}
