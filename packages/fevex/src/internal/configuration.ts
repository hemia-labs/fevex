import type { AgentDefinition } from '../agents';
import { FevexConfigurationError, type FevexConfigurationErrorCode } from '../configuration-error';
import type { FevexConfig } from '../fevex';
import type { ModelGateway, ReasoningEffort } from '../models';
import type { ObservabilityOptions } from '../observability';
import type { PolicyDefinition } from '../policies';
import { InMemoryRunStore, type RunStore } from '../runtime';
import type { ToolDefinition } from '../tools';
import { isStandardSchema } from './schemas';

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
]);

export interface FevexComposition {
  models: Map<string, ModelGateway>;
  agents: Map<string, AgentDefinition>;
  tools: Map<string, ToolDefinition>;
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
    config.tools === undefined || Array.isArray(config.tools),
    'INVALID_CONFIG',
    'Fevex config "tools" must be an array',
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
  const tools = new Map<string, ToolDefinition>();

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

  for (const [index, definition] of (config.tools ?? []).entries()) {
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

    tools.set(name, {
      name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
      ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
      ...(definition.risk === undefined ? {} : { risk: definition.risk }),
      ...(definition.approval === undefined ? {} : { approval: definition.approval }),
      ...(definition.idempotency === undefined ? {} : { idempotency: definition.idempotency }),
      ...(definition.retry === undefined ? {} : { retry: { ...definition.retry } }),
      ...(definition.credentials === undefined ? {} : { credentials: [...definition.credentials] }),
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
      'INVALID_CONFIG',
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
  }

  return {
    models,
    agents,
    tools,
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
