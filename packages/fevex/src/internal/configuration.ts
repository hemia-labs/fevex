import type { AgentDefinition } from '../agents';
import { FevexConfigurationError, type FevexConfigurationErrorCode } from '../configuration-error';
import type { JsonObject, JsonValue } from '../core';
import type { FevexConfig } from '../fevex';
import {
  InMemoryMemoryStore,
  type ContextProvider,
  type MemoryStore,
} from '../knowledge';
import type { ModelGateway, ReasoningEffort } from '../models';
import type { ObservabilityOptions } from '../observability';
import type { PolicyDefinition } from '../policies';
import { InMemoryRunStore, type RunStore } from '../runtime';
import {
  IntegrationError,
  type ConnectionDefinition,
  type ConnectionToolPolicy,
  type ToolProviderContext,
  type ToolProviderTool,
  type ToolDefinition,
} from '../tools';
import type { WorkflowDefinition } from '../workflows';
import { isStandardSchema } from './schemas';

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
]);

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

export interface FevexComposition {
  models: Map<string, ModelGateway>;
  agents: Map<string, AgentDefinition>;
  workflows: Map<string, WorkflowDefinition>;
  tools: Map<string, ToolDefinition>;
  contextProviders: Map<string, ContextProvider>;
  memoryStore: MemoryStore | undefined;
  runStore: RunStore;
  credentialStore: FevexConfig['credentialStore'];
  policies: PolicyDefinition[];
  onEvent: FevexConfig['onEvent'];
  observability: ObservabilityOptions | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configurationError(
  code: FevexConfigurationErrorCode,
  message: string,
): FevexConfigurationError {
  return new FevexConfigurationError(code, message);
}

function assertConfiguration(
  condition: unknown,
  code: FevexConfigurationErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw configurationError(code, message);
}

function isModelGateway(value: unknown): value is ModelGateway {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { stream?: unknown }).stream === 'function'
  );
}

function isRunStore(value: unknown): value is RunStore {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    ['getRun', 'saveRun', 'getSession', 'saveSession', 'appendEvent', 'listEvents'].every(
      (method) => typeof (value as Record<string, unknown>)[method] === 'function',
    )
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function isToolProvider(value: unknown): value is ConnectionDefinition['provider'] {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { listTools?: unknown }).listTools === 'function' &&
    typeof (value as { callTool?: unknown }).callTool === 'function'
  );
}

function isContextProvider(value: unknown): value is ContextProvider {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { read?: unknown }).read === 'function'
  );
}

function isMemoryStore(value: unknown): value is MemoryStore {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { search?: unknown }).search === 'function' &&
    typeof (value as { write?: unknown }).write === 'function'
  );
}

function connectionAllowlist(connection: ConnectionDefinition): readonly string[] | undefined {
  if (connection.allowlist) return connection.allowlist;
  if (connection.tools && Array.isArray((connection.tools as { allow?: unknown }).allow)) {
    return (connection.tools as { allow: readonly string[] }).allow;
  }
  return undefined;
}

function connectionMetadata(
  connection: ConnectionDefinition,
  remoteName: string,
): ConnectionToolPolicy | undefined {
  if (!connection.tools || 'allow' in connection.tools) return undefined;
  return connection.tools[remoteName];
}

function namespacedToolName(connectionName: string, toolName: string): string {
  return `${connectionName}__${toolName}`;
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => {
    controller.abort(new IntegrationError(
      'CONNECTION_TIMEOUT',
      'timeout',
      true,
      'Connection tool call timed out',
    ));
  }, timeoutMs);

  parent?.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function connectionError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new IntegrationError(
      'CONNECTION_TIMEOUT',
      'timeout',
      true,
      'Connection tool call timed out',
      { cause: error },
    );
  }
  return new IntegrationError(
    'CONNECTION_REMOTE_ERROR',
    'remote',
    false,
    'Connection tool call failed',
    { cause: error },
  );
}

function expandConnection(connection: ConnectionDefinition): ToolDefinition[] {
  assertConfiguration(isRecord(connection), 'INVALID_CONNECTION', 'Connection must be an object');
  const allowlist = connectionAllowlist(connection);
  assertConfiguration(
    typeof connection.name === 'string' && Boolean(connection.name.trim()),
    'INVALID_CONNECTION',
    'Connection name must be a non-empty string',
  );
  assertConfiguration(
    !connection.name.includes('__'),
    'INVALID_CONNECTION',
    `Connection "${connection.name}" name cannot contain "__"`,
  );
  assertConfiguration(
    isToolProvider(connection.provider),
    'INVALID_CONNECTION',
    `Connection "${connection.name}" provider must implement listTools and callTool`,
  );
  assertConfiguration(
    Array.isArray(allowlist) && allowlist.length > 0,
    'INVALID_CONNECTION',
    `Connection "${connection.name}" allowlist must be a non-empty array`,
  );
  assertConfiguration(
    connection.timeoutMs === undefined ||
      (Number.isInteger(connection.timeoutMs) && connection.timeoutMs! > 0),
    'INVALID_CONNECTION',
    `Connection "${connection.name}" timeoutMs must be a positive integer`,
  );

  const seen = new Set<string>();
  let remoteTools: Promise<Map<string, ToolProviderTool>> | undefined;
  const listRemoteTools = async (context?: ToolProviderContext) => {
    remoteTools ??= connection.provider.listTools(context).then((tools) => {
      const map = new Map<string, ToolProviderTool>();
      for (const tool of tools) map.set(tool.name, tool);
      return map;
    });
    return remoteTools;
  };

  return allowlist.map((remoteName) => {
    assertConfiguration(
      typeof remoteName === 'string' && Boolean(remoteName.trim()),
      'INVALID_TOOL',
      `Connection "${connection.name}" tool names must be non-empty strings`,
    );
    assertConfiguration(
      !remoteName.includes('__'),
      'INVALID_TOOL',
      `Connection "${connection.name}" tool "${remoteName}" cannot contain "__"`,
    );
    assertConfiguration(
      !seen.has(remoteName),
      'DUPLICATE_TOOL',
      `Connection "${connection.name}" tool "${remoteName}" is duplicated`,
    );
    seen.add(remoteName);

    const policy = connectionMetadata(connection, remoteName);
    assertConfiguration(
      policy?.inputSchema === undefined || isJsonObject(policy.inputSchema),
      'INVALID_TOOL',
      `Input schema for connection tool "${remoteName}" must be a JSON object`,
    );
    assertConfiguration(
      policy?.outputSchema === undefined || isJsonObject(policy.outputSchema),
      'INVALID_TOOL',
      `Output schema for connection tool "${remoteName}" must be a JSON object`,
    );

    return {
      name: namespacedToolName(connection.name, remoteName),
      ...(policy?.description === undefined ? {} : { description: policy.description }),
      ...(policy?.inputSchema === undefined ? {} : { inputJsonSchema: policy.inputSchema }),
      ...(policy?.outputSchema === undefined ? {} : { outputJsonSchema: policy.outputSchema }),
      ...(policy?.risk === undefined ? {} : { risk: policy.risk }),
      ...(policy?.approval === undefined ? {} : { approval: policy.approval }),
      ...(policy?.idempotency === undefined ? {} : { idempotency: policy.idempotency }),
      ...(policy?.retry === undefined ? {} : { retry: policy.retry }),
      ...(policy?.credentials === undefined ? {} : { credentials: policy.credentials }),
      async resolve(context) {
        return (await listRemoteTools(context)).get(remoteName);
      },
      async execute(input: JsonValue, context) {
        const timeout = timeoutSignal(context.signal, connection.timeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS);
        try {
          return await Promise.race([
            connection.provider.callTool(remoteName, input, {
              runId: context.runId,
              toolCallId: context.toolCallId,
              attempt: context.attempt,
              idempotencyKey: context.idempotencyKey,
              context: context.context,
              signal: timeout.signal,
            }),
            new Promise<never>((_, reject) => {
              timeout.signal.addEventListener('abort', () => {
                reject(timeout.signal.reason ?? new DOMException('Aborted', 'AbortError'));
              }, { once: true });
            }),
          ]);
        } catch (error) {
          throw connectionError(error);
        } finally {
          timeout.dispose();
        }
      },
    } satisfies ToolDefinition;
  });
}

function assertLimit(
  value: unknown,
  name: string,
  minimum: number,
  agentName: string,
  allowFalse = false,
): void {
  if (value === undefined || (allowFalse && value === false)) return;

  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw configurationError(
      'INVALID_AGENT',
      `Agent "${agentName}" limit "${name}" must be ${minimum === 0 ? 'a non-negative' : 'a positive'} integer${allowFalse ? ' or false' : ''}`,
    );
  }
}

export function createComposition(config: FevexConfig): FevexComposition {
  assertConfiguration(isRecord(config), 'INVALID_CONFIG', 'Fevex config must be an object');
  assertConfiguration(
    isRecord(config.models),
    'INVALID_CONFIG',
    'Fevex config "models" must be an object',
  );
  assertConfiguration(
    Array.isArray(config.agents),
    'INVALID_CONFIG',
    'Fevex config "agents" must be an array',
  );
  assertConfiguration(
    config.workflows === undefined || Array.isArray(config.workflows),
    'INVALID_CONFIG',
    'Fevex config "workflows" must be an array',
  );
  assertConfiguration(
    config.tools === undefined || Array.isArray(config.tools),
    'INVALID_CONFIG',
    'Fevex config "tools" must be an array',
  );
  assertConfiguration(
    config.connections === undefined || Array.isArray(config.connections),
    'INVALID_CONFIG',
    'Fevex config "connections" must be an array',
  );
  assertConfiguration(
    config.contextProviders === undefined || Array.isArray(config.contextProviders),
    'INVALID_CONFIG',
    'Fevex config "contextProviders" must be an array',
  );
  assertConfiguration(
    config.memoryStore === undefined || isMemoryStore(config.memoryStore),
    'INVALID_CONFIG',
    'Fevex config "memoryStore" must implement MemoryStore',
  );
  assertConfiguration(
    config.onEvent === undefined || typeof config.onEvent === 'function',
    'INVALID_CONFIG',
    'Fevex config "onEvent" must be a function',
  );
  assertConfiguration(
    config.runStore === undefined || isRunStore(config.runStore),
    'INVALID_CONFIG',
    'Fevex config "runStore" must implement RunStore',
  );
  assertConfiguration(
    config.credentialStore === undefined || typeof config.credentialStore?.resolve === 'function',
    'INVALID_CONFIG',
    'Fevex config "credentialStore" must implement resolve',
  );
  assertConfiguration(
    config.policies === undefined || Array.isArray(config.policies),
    'INVALID_CONFIG',
    'Fevex config "policies" must be an array',
  );
  if (config.observability !== undefined) {
    assertConfiguration(
      isRecord(config.observability),
      'INVALID_CONFIG',
      'Fevex config "observability" must be an object',
    );
    assertConfiguration(
      Array.isArray(config.observability.exporters) &&
        config.observability.exporters.every(
          (exporter) => isRecord(exporter) && typeof exporter.export === 'function',
        ),
      'INVALID_CONFIG',
      'Fevex config "observability.exporters" must contain TraceExporters',
    );
    assertConfiguration(
      config.observability.calculateCost === undefined ||
        typeof config.observability.calculateCost === 'function',
      'INVALID_CONFIG',
      'Fevex config "observability.calculateCost" must be a function',
    );
    if (config.observability.content !== undefined) {
      const content = config.observability.content;
      assertConfiguration(
        isRecord(content) &&
          Array.isArray(content.include) &&
          content.include.every((kind) =>
            ['run.output', 'model.output', 'error.message'].includes(kind as string),
          ) &&
          (content.redact === undefined || typeof content.redact === 'function'),
        'INVALID_CONFIG',
        'Fevex config "observability.content" is invalid',
      );
    }
  }

  const models = new Map<string, ModelGateway>();
  const agents = new Map<string, AgentDefinition>();
  const workflows = new Map<string, WorkflowDefinition>();
  const tools = new Map<string, ToolDefinition>();
  const contextProviders = new Map<string, ContextProvider>();

  for (const [name, model] of Object.entries(config.models)) {
    assertConfiguration(name.trim(), 'INVALID_MODEL', 'Model name cannot be empty');
    assertConfiguration(
      isModelGateway(model),
      'INVALID_MODEL',
      `Model "${name}" must implement stream`,
    );
    assertConfiguration(
      model.stateCodec === undefined ||
        (isRecord(model.stateCodec) &&
          typeof model.stateCodec.serialize === 'function' &&
          typeof model.stateCodec.restore === 'function'),
      'INVALID_MODEL',
      `Model "${name}" stateCodec must implement serialize and restore`,
    );
    models.set(name, model);
  }

  for (const [index, provider] of (config.contextProviders ?? []).entries()) {
    assertConfiguration(
      isContextProvider(provider),
      'INVALID_CONTEXT_PROVIDER',
      `Context provider at index ${index} must have a name and read`,
    );
    const name = provider.name;
    assertConfiguration(
      name.trim(),
      'INVALID_CONTEXT_PROVIDER',
      'Context provider name cannot be empty',
    );
    assertConfiguration(
      !contextProviders.has(name),
      'DUPLICATE_CONTEXT_PROVIDER',
      `Context provider "${name}" is duplicated`,
    );
    contextProviders.set(name, provider);
  }

  const expandedTools = [
    ...(config.tools ?? []),
    ...(config.connections ?? []).flatMap((connection) => expandConnection(connection)),
  ];

  for (const [index, definition] of expandedTools.entries()) {
    assertConfiguration(
      isRecord(definition),
      'INVALID_TOOL',
      `Tool at index ${index} must be an object`,
    );
    assertConfiguration(
      typeof definition.name === 'string',
      'INVALID_TOOL',
      'Tool name must be a string',
    );
    const name = definition.name;
    assertConfiguration(name.trim(), 'INVALID_TOOL', 'Tool name cannot be empty');
    assertConfiguration(!tools.has(name), 'DUPLICATE_TOOL', `Tool "${name}" is duplicated`);
    assertConfiguration(
      definition.description === undefined || typeof definition.description === 'string',
      'INVALID_TOOL',
      `Tool "${name}" description must be a string`,
    );
    assertConfiguration(
      typeof definition.execute === 'function',
      'INVALID_TOOL',
      `Tool "${name}" must implement execute`,
    );
    assertConfiguration(
      definition.risk === undefined ||
        ['read', 'write', 'sensitive', 'destructive'].includes(definition.risk as string),
      'INVALID_TOOL',
      `Tool "${name}" risk is invalid`,
    );
    assertConfiguration(
      definition.approval === undefined ||
        definition.approval === 'never' ||
        definition.approval === 'required',
      'INVALID_TOOL',
      `Tool "${name}" approval is invalid`,
    );
    assertConfiguration(
      definition.idempotency === undefined ||
        definition.idempotency === 'none' ||
        definition.idempotency === 'keyed',
      'INVALID_TOOL',
      `Tool "${name}" idempotency is invalid`,
    );
    assertConfiguration(
      definition.credentials === undefined ||
        (Array.isArray(definition.credentials) &&
          definition.credentials.every((value) => typeof value === 'string' && value.trim())),
      'INVALID_TOOL',
      `Tool "${name}" credentials must be non-empty strings`,
    );
    if (definition.retry !== undefined) {
      assertConfiguration(
        isRecord(definition.retry) &&
          Number.isInteger(definition.retry.maxAttempts) &&
          (definition.retry.maxAttempts as number) >= 1 &&
          Number.isInteger(definition.retry.backoffMs) &&
          (definition.retry.backoffMs as number) >= 0 &&
          (definition.retry.maxBackoffMs === undefined ||
            (Number.isInteger(definition.retry.maxBackoffMs) &&
              (definition.retry.maxBackoffMs as number) >= 0)),
        'INVALID_TOOL',
        `Tool "${name}" retry is invalid`,
      );
    }
    if (definition.inputSchema !== undefined) {
      assertConfiguration(
        isStandardSchema(definition.inputSchema),
        'INVALID_TOOL',
        `Input schema for tool "${name}" must implement Standard Schema`,
      );
    }
    if (definition.outputSchema !== undefined) {
      assertConfiguration(
        isStandardSchema(definition.outputSchema),
        'INVALID_TOOL',
        `Output schema for tool "${name}" must implement Standard Schema`,
      );
    }
    if (definition.inputJsonSchema !== undefined) {
      assertConfiguration(
        isJsonObject(definition.inputJsonSchema),
        'INVALID_TOOL',
        `Input JSON schema for tool "${name}" must be an object`,
      );
    }
    if (definition.outputJsonSchema !== undefined) {
      assertConfiguration(
        isJsonObject(definition.outputJsonSchema),
        'INVALID_TOOL',
        `Output JSON schema for tool "${name}" must be an object`,
      );
    }

    tools.set(name, {
      name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
      ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
      ...(definition.inputJsonSchema === undefined
        ? {}
        : { inputJsonSchema: definition.inputJsonSchema }),
      ...(definition.outputJsonSchema === undefined
        ? {}
        : { outputJsonSchema: definition.outputJsonSchema }),
      ...(definition.risk === undefined ? {} : { risk: definition.risk }),
      ...(definition.approval === undefined ? {} : { approval: definition.approval }),
      ...(definition.idempotency === undefined ? {} : { idempotency: definition.idempotency }),
      ...(definition.retry === undefined ? {} : { retry: { ...definition.retry } }),
      ...(definition.credentials === undefined ? {} : { credentials: [...definition.credentials] }),
      ...(definition.resolve === undefined ? {} : { resolve: definition.resolve }),
      execute: definition.execute as ToolDefinition['execute'],
    });
  }

  const policies: PolicyDefinition[] = [];
  for (const [index, policy] of (config.policies ?? []).entries()) {
    assertConfiguration(
      isRecord(policy) &&
        typeof policy.name === 'string' &&
        Boolean(policy.name.trim()) &&
        typeof policy.authorize === 'function',
      'INVALID_POLICY',
      `Policy at index ${index} must have a name and authorize`,
    );
    policies.push({ name: policy.name, authorize: policy.authorize });
  }

  for (const [index, definition] of config.agents.entries()) {
    assertConfiguration(
      isRecord(definition),
      'INVALID_AGENT',
      `Agent at index ${index} must be an object`,
    );
    assertConfiguration(
      typeof definition.name === 'string',
      'INVALID_AGENT',
      'Agent name must be a string',
    );
    const name = definition.name;
    assertConfiguration(name.trim(), 'INVALID_AGENT', 'Agent name cannot be empty');
    assertConfiguration(
      typeof definition.instructions === 'string',
      'INVALID_AGENT',
      `Agent "${name}" instructions must be a string`,
    );
    assertConfiguration(
      definition.instructions.trim(),
      'INVALID_AGENT',
      `Agent "${name}" instructions cannot be empty`,
    );
    assertConfiguration(!agents.has(name), 'DUPLICATE_AGENT', `Agent "${name}" is duplicated`);

    const model = definition.model;
    if (model !== undefined) {
      if (typeof model === 'string') {
        assertConfiguration(
          model.trim(),
          'INVALID_MODEL',
          `Model name required by agent "${name}" cannot be empty`,
        );
      } else {
        assertConfiguration(
          isModelGateway(model),
          'INVALID_MODEL',
          `Model for agent "${name}" must implement stream`,
        );
      }
    }

    let agentTools: string[] | undefined;
    if (definition.tools !== undefined) {
      assertConfiguration(
        Array.isArray(definition.tools),
        'INVALID_AGENT',
        `Agent "${name}" tools must be an array`,
      );
      agentTools = [];
      const seenTools = new Set<string>();
      for (const [toolIndex, toolName] of definition.tools.entries()) {
        assertConfiguration(
          typeof toolName === 'string' && Boolean(toolName.trim()),
          'INVALID_AGENT',
          `Tool name at index ${toolIndex} for agent "${name}" must be a non-empty string`,
        );
        assertConfiguration(
          !seenTools.has(toolName),
          'DUPLICATE_TOOL',
          `Tool "${toolName}" is duplicated in agent "${name}"`,
        );
        seenTools.add(toolName);
        agentTools.push(toolName);
      }
    }

    let agentContext: string[] | undefined;
    if (definition.context !== undefined) {
      assertConfiguration(
        Array.isArray(definition.context),
        'INVALID_AGENT',
        `Agent "${name}" context must be an array`,
      );
      agentContext = [];
      const seenContext = new Set<string>();
      for (const [contextIndex, providerName] of definition.context.entries()) {
        assertConfiguration(
          typeof providerName === 'string' && Boolean(providerName.trim()),
          'INVALID_AGENT',
          `Context provider name at index ${contextIndex} for agent "${name}" must be a non-empty string`,
        );
        assertConfiguration(
          !seenContext.has(providerName),
          'INVALID_AGENT',
          `Context provider "${providerName}" is duplicated in agent "${name}"`,
        );
        seenContext.add(providerName);
        agentContext.push(providerName);
      }
    }

    let agentSkills: string[] | undefined;
    if (definition.skills !== undefined) {
      assertConfiguration(
        Array.isArray(definition.skills),
        'INVALID_AGENT',
        `Agent "${name}" skills must be an array`,
      );
      agentSkills = [];
      const seenSkills = new Set<string>();
      for (const [skillIndex, skillName] of definition.skills.entries()) {
        assertConfiguration(
          typeof skillName === 'string' && Boolean(skillName.trim()),
          'INVALID_AGENT',
          `Skill name at index ${skillIndex} for agent "${name}" must be a non-empty string`,
        );
        assertConfiguration(
          !seenSkills.has(skillName),
          'INVALID_AGENT',
          `Skill "${skillName}" is duplicated in agent "${name}"`,
        );
        seenSkills.add(skillName);
        agentSkills.push(skillName);
      }
    }

    assertConfiguration(
      definition.memory === undefined || isRecord(definition.memory),
      'INVALID_AGENT',
      `Agent "${name}" memory must be an object`,
    );
    assertConfiguration(
      definition.memory?.read === undefined || typeof definition.memory.read === 'boolean',
      'INVALID_AGENT',
      `Agent "${name}" memory.read must be a boolean`,
    );
    assertConfiguration(
      definition.memory?.write === undefined || typeof definition.memory.write === 'boolean',
      'INVALID_AGENT',
      `Agent "${name}" memory.write must be a boolean`,
    );
    assertConfiguration(
      definition.memory?.limit === undefined ||
        (Number.isInteger(definition.memory.limit) && definition.memory.limit > 0),
      'INVALID_AGENT',
      `Agent "${name}" memory.limit must be a positive integer`,
    );

    assertConfiguration(
      definition.reasoning === undefined ||
        (typeof definition.reasoning === 'string' &&
          REASONING_EFFORTS.has(definition.reasoning as ReasoningEffort)),
      'INVALID_AGENT',
      `Agent "${name}" reasoning is invalid`,
    );
    assertConfiguration(
      definition.modelOptions === undefined || isRecord(definition.modelOptions),
      'INVALID_AGENT',
      `Agent "${name}" modelOptions must be an object`,
    );
    assertConfiguration(
      definition.limits === undefined || isRecord(definition.limits),
      'INVALID_AGENT',
      `Agent "${name}" limits must be an object`,
    );
    if (definition.outputSchema !== undefined) {
      assertConfiguration(
        isStandardSchema(definition.outputSchema),
        'INVALID_AGENT',
        `Output schema for agent "${name}" must implement Standard Schema`,
      );
    }

    const rawLimits = definition.limits;
    assertLimit(rawLimits?.maxSteps, 'maxSteps', 1, name);
    assertLimit(rawLimits?.maxToolCalls, 'maxToolCalls', 0, name);
    assertLimit(rawLimits?.maxInputTokens, 'maxInputTokens', 1, name, true);
    assertLimit(rawLimits?.maxOutputTokens, 'maxOutputTokens', 1, name, true);

    agents.set(name, {
      name,
      instructions: definition.instructions,
      ...(model === undefined ? {} : { model: model as AgentDefinition['model'] }),
      ...(agentTools === undefined ? {} : { tools: agentTools }),
      ...(agentContext === undefined ? {} : { context: agentContext }),
      ...(agentSkills === undefined ? {} : { skills: agentSkills }),
      ...(definition.memory === undefined
        ? {}
        : {
            memory: {
              ...(definition.memory.read === undefined ? {} : { read: definition.memory.read }),
              ...(definition.memory.write === undefined
                ? {}
                : { write: definition.memory.write }),
              ...(definition.memory.limit === undefined
                ? {}
                : { limit: definition.memory.limit }),
            },
          }),
      ...(definition.reasoning === undefined
        ? {}
        : { reasoning: definition.reasoning as ReasoningEffort }),
      ...(definition.modelOptions === undefined
        ? {}
        : { modelOptions: { ...definition.modelOptions } }),
      ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
      ...(rawLimits === undefined
        ? {}
        : {
            limits: {
              ...(rawLimits.maxSteps === undefined
                ? {}
                : { maxSteps: rawLimits.maxSteps as number }),
              ...(rawLimits.maxToolCalls === undefined
                ? {}
                : { maxToolCalls: rawLimits.maxToolCalls as number }),
              ...(rawLimits.maxInputTokens === undefined
                ? {}
                : { maxInputTokens: rawLimits.maxInputTokens as number | false }),
              ...(rawLimits.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: rawLimits.maxOutputTokens as number | false }),
            },
          }),
    });
  }

  for (const agent of agents.values()) {
    if (typeof agent.model === 'string' && !models.has(agent.model)) {
      throw configurationError(
        'MISSING_MODEL',
        `Model "${agent.model}" required by agent "${agent.name}" is not registered`,
      );
    }
    if (agent.model === undefined && !models.has('default')) {
      throw configurationError(
        'MISSING_MODEL',
        `Default model "default" required by agent "${agent.name}" is not registered`,
      );
    }
    for (const toolName of agent.tools ?? []) {
      if (!tools.has(toolName)) {
        throw configurationError(
          'MISSING_TOOL',
          `Tool "${toolName}" required by agent "${agent.name}" is not registered`,
        );
      }
    }
    for (const providerName of [...(agent.context ?? []), ...(agent.skills ?? [])]) {
      if (!contextProviders.has(providerName)) {
        throw configurationError(
          'INVALID_AGENT',
          `Context provider "${providerName}" required by agent "${agent.name}" is not registered`,
        );
      }
    }
  }

  for (const [index, definition] of (config.workflows ?? []).entries()) {
    assertConfiguration(
      isRecord(definition),
      'INVALID_WORKFLOW',
      `Workflow at index ${index} must be an object`,
    );
    assertConfiguration(
      typeof definition.name === 'string',
      'INVALID_WORKFLOW',
      'Workflow name must be a string',
    );
    const name = definition.name;
    assertConfiguration(name.trim(), 'INVALID_WORKFLOW', 'Workflow name cannot be empty');
    assertConfiguration(
      typeof definition.run === 'function',
      'INVALID_WORKFLOW',
      `Workflow "${name}" must implement run`,
    );
    assertConfiguration(
      definition.version === undefined ||
        (typeof definition.version === 'string' && Boolean(definition.version.trim())),
      'INVALID_WORKFLOW',
      `Workflow "${name}" version must be a non-empty string`,
    );
    assertConfiguration(
      !workflows.has(name),
      'DUPLICATE_WORKFLOW',
      `Workflow "${name}" is duplicated`,
    );
    workflows.set(name, {
      name,
      version: (definition.version as string | undefined) ?? '1',
      run: definition.run as WorkflowDefinition['run'],
    });
  }

  const usesMemory = [...agents.values()].some(
    (agent) => agent.memory && (agent.memory.read !== false || agent.memory.write === true),
  );

  return {
    models,
    agents,
    workflows,
    tools,
    contextProviders,
    memoryStore: config.memoryStore ?? (usesMemory ? new InMemoryMemoryStore() : undefined),
    runStore: config.runStore ?? new InMemoryRunStore(),
    credentialStore: config.credentialStore,
    policies,
    onEvent: config.onEvent,
    observability:
      config.observability === undefined
        ? undefined
        : {
            exporters: [...config.observability.exporters],
            ...(config.observability.calculateCost
              ? { calculateCost: config.observability.calculateCost }
              : {}),
            ...(config.observability.content
              ? {
                  content: {
                    include: [...config.observability.content.include],
                    ...(config.observability.content.redact
                      ? { redact: config.observability.content.redact }
                      : {}),
                  },
                }
              : {}),
          },
  };
}
