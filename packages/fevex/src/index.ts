import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { AgentDefinition } from './agents';
import type {
  AgentEvent,
  AgentEventType,
  AgentMessage,
  JsonObject,
  JsonValue,
} from './core';
import { SCHEMA_NOT_TRANSPORTABLE } from './core';
import type { ModelGateway, ModelUsage } from './models';
import type { RunRequest, RunResult } from './runtime';
import { toToolSpec, type ToolDefinition } from './tools';

export * from './agents';
export * from './core';
export * from './models';
export * from './runtime';
export * from './tools';
export { SCHEMA_NOT_TRANSPORTABLE } from './core';

export interface FevexConfig {
  models: Record<string, ModelGateway>;
  agents: AgentDefinition[];
  tools?: ToolDefinition[];
  onEvent?: (event: AgentEvent) => void;
}

export interface Fevex {
  runAgent<TInput = unknown, TOutput = unknown>(
    name: string,
    request: RunRequest<TInput, TOutput>,
  ): Promise<RunResult<TOutput>>;
}

const invalidJsonValue = Symbol('invalid-json-value');

function normalizeJsonValue(
  value: unknown,
  seen = new WeakSet<object>(),
): JsonValue | typeof invalidJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : invalidJsonValue;
  }
  if (Array.isArray(value)) {
    const normalized: JsonValue[] = [];

    for (const item of value) {
      const normalizedItem = normalizeJsonValue(item, seen);
      if (normalizedItem === invalidJsonValue) return invalidJsonValue;
      normalized.push(normalizedItem);
    }

    return normalized;
  }
  if (typeof value !== 'object' || value === undefined) {
    return invalidJsonValue;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    return invalidJsonValue;
  }
  if (seen.has(value)) return invalidJsonValue;

  seen.add(value);
  const normalized: JsonObject = {};

  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;

    const normalizedItem = normalizeJsonValue(item, seen);
    if (normalizedItem === invalidJsonValue) return invalidJsonValue;
    normalized[key] = normalizedItem;
  }

  seen.delete(value);
  return normalized;
}

function toJsonValue(value: unknown, errorMessage: string): JsonValue {
  let normalized: JsonValue | typeof invalidJsonValue;

  try {
    normalized = normalizeJsonValue(value);
  } catch {
    throw new TypeError(errorMessage);
  }

  if (normalized === invalidJsonValue) {
    throw new TypeError(errorMessage);
  }

  return normalized;
}

function serializeJsonValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function serializeValue(value: unknown, errorMessage: string): string {
  return serializeJsonValue(toJsonValue(value, errorMessage));
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== 'object' || value === null || !('~standard' in value)) {
    return false;
  }

  const standard = (value as Record<string, unknown>)['~standard'];
  return (
    typeof standard === 'object'
    && standard !== null
    && (standard as Record<string, unknown>).version === 1
    && typeof (standard as Record<string, unknown>).validate === 'function'
  );
}

function assertStandardSchema(value: unknown, errorMessage: string): asserts value is StandardSchemaV1 {
  if (!isStandardSchema(value)) throw new TypeError(errorMessage);
}

function isStandardJsonSchema(value: unknown): value is StandardJSONSchemaV1 {
  if (!isStandardSchema(value)) return false;

  const jsonSchema = (value['~standard'] as unknown as Record<string, unknown>).jsonSchema;
  return (
    typeof jsonSchema === 'object'
    && jsonSchema !== null
    && typeof (jsonSchema as Record<string, unknown>).input === 'function'
    && typeof (jsonSchema as Record<string, unknown>).output === 'function'
  );
}

function schemaNotTransportable(message: string): TypeError & { code: typeof SCHEMA_NOT_TRANSPORTABLE } {
  return Object.assign(new TypeError(message), { code: SCHEMA_NOT_TRANSPORTABLE as typeof SCHEMA_NOT_TRANSPORTABLE });
}

function toTransportableSchema(
  schema: StandardSchemaV1,
  direction: 'input' | 'output',
  errorMessage: string,
): JsonObject {
  if (!isStandardJsonSchema(schema)) {
    throw schemaNotTransportable(`${errorMessage}: schema does not implement Standard JSON Schema`);
  }

  let rawSchema: unknown;

  try {
    rawSchema = schema['~standard'].jsonSchema[direction]({ target: 'draft-2020-12' });
  } catch (error) {
    throw schemaNotTransportable(`${errorMessage}: ${toErrorMessage(error)}`);
  }

  let jsonSchema: JsonValue;

  try {
    jsonSchema = toJsonValue(rawSchema, `${errorMessage}: JSON Schema must be JSON-serializable`);
  } catch {
    throw schemaNotTransportable(`${errorMessage}: JSON Schema must be JSON-serializable`);
  }
  if (typeof jsonSchema !== 'object' || jsonSchema === null || Array.isArray(jsonSchema)) {
    throw schemaNotTransportable(`${errorMessage}: JSON Schema must be an object`);
  }

  return jsonSchema;
}

async function validateSchema<TOutput>(
  schema: StandardSchemaV1<unknown, TOutput>,
  value: unknown,
  errorMessage: string,
): Promise<TOutput> {
  const result = await schema['~standard'].validate(value);

  if (result.issues) {
    const detail = result.issues[0]?.message ?? 'Validation failed';
    throw new TypeError(`${errorMessage}: ${detail}`);
  }

  return result.value;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function addUsage(first?: ModelUsage, second?: ModelUsage): ModelUsage | undefined {
  if (!first) return second;
  if (!second) return first;

  const inputTokens = first.inputTokens === undefined && second.inputTokens === undefined
    ? undefined
    : (first.inputTokens ?? 0) + (second.inputTokens ?? 0);
  const outputTokens = first.outputTokens === undefined && second.outputTokens === undefined
    ? undefined
    : (first.outputTokens ?? 0) + (second.outputTokens ?? 0);
  const totalTokens = first.totalTokens === undefined && second.totalTokens === undefined
    ? undefined
    : (first.totalTokens ?? 0) + (second.totalTokens ?? 0);

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function createFevex(config: FevexConfig): Fevex {
  const models = new Map(Object.entries(config.models));
  const agents = new Map<string, AgentDefinition>();
  const tools = new Map<string, ToolDefinition>();

  for (const [name, model] of models) {
    if (!name.trim()) throw new Error('Model name cannot be empty');
    if (!model || typeof model.generate !== 'function') {
      throw new Error(`Model "${name}" must implement generate`);
    }
  }

  for (const tool of config.tools ?? []) {
    if (!tool.name.trim()) throw new Error('Tool name cannot be empty');
    if (tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is duplicated`);
    if (tool.inputSchema !== undefined) {
      assertStandardSchema(
        tool.inputSchema,
        `Input schema for tool "${tool.name}" must implement Standard Schema`,
      );
    }
    if (tool.outputSchema !== undefined) {
      assertStandardSchema(
        tool.outputSchema,
        `Output schema for tool "${tool.name}" must implement Standard Schema`,
      );
    }
    tools.set(tool.name, tool);
  }

  for (const agent of config.agents) {
    if (!agent.name.trim()) throw new Error('Agent name cannot be empty');
    if (!agent.instructions.trim()) {
      throw new Error(`Agent "${agent.name}" instructions cannot be empty`);
    }
    if (agents.has(agent.name)) throw new Error(`Agent "${agent.name}" is duplicated`);
    if (agent.outputSchema !== undefined) {
      assertStandardSchema(
        agent.outputSchema,
        `Output schema for agent "${agent.name}" must implement Standard Schema`,
      );
    }
    agents.set(agent.name, agent);
  }

  for (const agent of agents.values()) {
    if (typeof agent.model === 'string' && !models.has(agent.model)) {
      throw new Error(`Model "${agent.model}" required by agent "${agent.name}" is not registered`);
    }
    if (agent.model && typeof agent.model !== 'string' && typeof agent.model.generate !== 'function') {
      throw new Error(`Model for agent "${agent.name}" must implement generate`);
    }
    if (!agent.model && !models.has('default')) {
      throw new Error(`Default model "default" required by agent "${agent.name}" is not registered`);
    }
    for (const toolName of agent.tools ?? []) {
      if (!tools.has(toolName)) {
        throw new Error(`Tool "${toolName}" required by agent "${agent.name}" is not registered`);
      }
    }
  }

  return {
    async runAgent<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ): Promise<RunResult<TOutput>> {
      const agent = agents.get(name);
      if (!agent) throw new Error(`Agent "${name}" is not registered`);

      const model = typeof agent.model === 'string'
        ? models.get(agent.model)
        : agent.model ?? models.get('default');
      const runId = globalThis.crypto.randomUUID();
      const events: AgentEvent[] = [];
      const createEvent = (
        type: AgentEventType,
        payload?: JsonObject,
      ): AgentEvent => ({
        type,
        runId,
        timestamp: new Date().toISOString(),
        ...(payload === undefined ? {} : { payload }),
      });
      const emit = (type: AgentEventType, payload?: JsonObject): void => {
        const event = createEvent(type, payload);
        config.onEvent?.(event);
        events.push(event);
      };
      const emitFailure = (type: 'tool.failed' | 'run.failed', payload: JsonObject): void => {
        const event = createEvent(type, payload);

        try {
          config.onEvent?.(event);
        } catch {}

        events.push(event);
      };

      try {
        emit('run.started');
        request.signal?.throwIfAborted();

        if (request.outputSchema !== undefined) {
          assertStandardSchema(
            request.outputSchema,
            `Output schema for request to agent "${name}" must implement Standard Schema`,
          );
        }

        const messages: AgentMessage[] = [
          { role: 'system', content: agent.instructions },
          {
            role: 'user',
            content: serializeValue(
              request.input,
              'Run input must be a string or JSON-serializable value',
            ),
          },
        ];
        const activeOutputSchema = request.outputSchema !== undefined
          ? request.outputSchema
          : agent.outputSchema;
        const outputSchema = activeOutputSchema === undefined
          ? undefined
          : toTransportableSchema(
            activeOutputSchema,
            'output',
            `Output schema for agent "${name}" is not transportable`,
          );
        const agentTools = (agent.tools ?? []).map((toolName) => {
          const tool = tools.get(toolName)!;
          const inputSchema = tool.inputSchema === undefined
            ? undefined
            : toTransportableSchema(
              tool.inputSchema,
              'input',
              `Input schema for tool "${tool.name}" is not transportable`,
            );

          return toToolSpec(tool, inputSchema);
        });
        const result = await model!.generate({
          messages,
          tools: agentTools.length > 0 ? agentTools : undefined,
          reasoning: agent.reasoning,
          modelOptions: agent.modelOptions,
          outputSchema,
          signal: request.signal,
        });

        emit('model.completed');

        if (!result.toolCalls?.length) {
          if (result.output === undefined) {
            throw new Error(`Model for agent "${name}" returned no output`);
          }

          const validatedOutput = activeOutputSchema === undefined
            ? result.output
            : await validateSchema(
              activeOutputSchema,
              result.output,
              `Output from agent "${name}" does not match outputSchema`,
            );
          const output = toJsonValue(
            validatedOutput,
            `Output from agent "${name}" must be JSON-serializable`,
          );

          emit('run.completed');

          return {
            output: output as TOutput,
            events,
            usage: result.usage,
          };
        }
        if (result.toolCalls.length > 1) {
          throw new Error(`Agent "${name}" requested multiple tools, but this runtime supports one tool call`);
        }

        const toolCall = result.toolCalls[0]!;
        if (typeof toolCall.id !== 'string' || !toolCall.id.trim()) {
          throw new Error('Tool call id cannot be empty');
        }
        if (typeof toolCall.name !== 'string' || !toolCall.name.trim()) {
          throw new Error('Tool call name cannot be empty');
        }

        const assistantContent = result.output === undefined
          ? ''
          : serializeValue(
            result.output,
            `Model output for agent "${name}" must be JSON-serializable`,
          );

        request.signal?.throwIfAborted();

        let toolContent: string;

        try {
          const tool = agent.tools?.includes(toolCall.name) ? tools.get(toolCall.name) : undefined;
          if (!tool) {
            throw new Error(`Tool "${toolCall.name}" is not available to agent "${name}"`);
          }

          const rawToolInput = toJsonValue(
            toolCall.input,
            `Input for tool "${toolCall.name}" must be JSON-serializable`,
          );
          const validatedToolInput = tool.inputSchema === undefined
            ? rawToolInput
            : await validateSchema(
              tool.inputSchema,
              rawToolInput,
              `Input for tool "${toolCall.name}" does not match inputSchema`,
            );
          const toolInput = toJsonValue(
            validatedToolInput,
            `Input for tool "${toolCall.name}" must be JSON-serializable`,
          );
          const rawToolOutput = await tool.execute(toolInput, {
            runId,
            toolCallId: toolCall.id,
            context: request.context,
            signal: request.signal,
          });
          const validatedToolOutput = tool.outputSchema === undefined
            ? rawToolOutput
            : await validateSchema(
              tool.outputSchema,
              rawToolOutput,
              `Output from tool "${toolCall.name}" does not match outputSchema`,
            );
          const toolOutput = toJsonValue(
            validatedToolOutput,
            `Output from tool "${toolCall.name}" must be JSON-serializable`,
          );

          toolContent = serializeJsonValue(toolOutput);
        } catch (error) {
          emitFailure('tool.failed', {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            error: toErrorMessage(error),
          });
          throw error;
        }

        emit('tool.completed', {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });

        request.signal?.throwIfAborted();
        const finalResult = await model!.generate({
          messages: [
            ...messages,
            {
              role: 'assistant',
              content: assistantContent,
              toolCalls: [toolCall],
            },
            {
              role: 'tool',
              name: toolCall.name,
              toolCallId: toolCall.id,
              content: toolContent,
            },
          ],
          tools: undefined,
          reasoning: agent.reasoning,
          modelOptions: agent.modelOptions,
          outputSchema,
          signal: request.signal,
        });

        emit('model.completed');

        if (finalResult.toolCalls?.length) {
          throw new Error(`Agent "${name}" requested another tool, but this runtime supports one tool call`);
        }
        if (finalResult.output === undefined) {
          throw new Error(`Model for agent "${name}" returned no output`);
        }

        const validatedOutput = activeOutputSchema === undefined
          ? finalResult.output
          : await validateSchema(
            activeOutputSchema,
            finalResult.output,
            `Output from agent "${name}" does not match outputSchema`,
          );
        const output = toJsonValue(
          validatedOutput,
          `Output from agent "${name}" must be JSON-serializable`,
        );

        emit('run.completed');

        return {
          output: output as TOutput,
          events,
          usage: addUsage(result.usage, finalResult.usage),
        };
      } catch (error) {
        emitFailure('run.failed', { error: toErrorMessage(error) });
        throw error;
      }
    },
  };
}
