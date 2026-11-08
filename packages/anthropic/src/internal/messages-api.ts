import {
  PROVIDER_REASONING_UNSUPPORTED,
  PROVIDER_SCHEMA_UNSUPPORTED,
  type AgentMessage,
  type JsonObject,
  type ModelInput,
  type ModelStreamEvent,
  type ToolSpec,
} from '@fevex/core';
import type { ResolvedAnthropicConfig } from '../config';
import { AnthropicError } from '../anthropic-error';
import { findAnthropicSchemaIssue } from './provider-schema';
import { readAnthropicProviderState, type AnthropicProviderState } from './provider-state';
import {
  parseAnthropicResult,
  type AnthropicFinalBlock,
  type AnthropicUsage,
} from './response';
import { readSSE } from './sse';

type MutableBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject; partialJson: string };

const defaultBaseURL = 'https://api.anthropic.com';
const defaultMaxTokens = 4_096;

export async function* streamAnthropicMessage(
  config: ResolvedAnthropicConfig,
  modelId: string,
  input: ModelInput,
): AsyncGenerator<ModelStreamEvent> {
  input.signal?.throwIfAborted();
  assertCompatibleInput(input);
  if (config.schemaPolicy === 'strict') assertStrictSchemas(input);
  const body = buildRequestBody(config, modelId, input);

  let response: Response;
  try {
    response = await config.fetch(toMessagesURL(config.baseURL), {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    throw new AnthropicError('Anthropic request failed', { cause: error });
  }

  input.signal?.throwIfAborted();
  const requestId = response.headers.get('request-id') ?? undefined;
  if (!response.ok) {
    const data = await readResponseJson(response, requestId, input.signal);
    throw new AnthropicError(toAnthropicErrorMessage(data, response.status), {
      status: response.status,
      requestId,
      cause: data,
    });
  }

  let started = false;
  let stopped = false;
  let stopReason: unknown;
  let usage: AnthropicUsage | undefined;
  const blocks = new Map<number, MutableBlock>();
  const finishedBlocks = new Set<number>();

  try {
    for await (const data of readSSE(response.body, input.signal)) {
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch (error) {
        throw new AnthropicError('Anthropic stream event was not valid JSON', {
          status: response.status,
          requestId,
          cause: error,
        });
      }
      if (!isRecord(event) || typeof event.type !== 'string') {
        throw new AnthropicError('Anthropic stream event was invalid', {
          status: response.status,
          requestId,
          cause: event,
        });
      }

      switch (event.type) {
        case 'message_start': {
          if (started) throw new AnthropicError('Anthropic stream returned a duplicate message_start');
          if (!isRecord(event.message)) {
            throw new AnthropicError('Anthropic stream returned an invalid message_start', {
              status: response.status,
              requestId,
              cause: event,
            });
          }
          started = true;
          if (event.message.usage !== undefined && event.message.usage !== null) {
            usage = mergeUsage(usage, event.message.usage);
          }
          break;
        }
        case 'content_block_start': {
          assertStarted(started);
          const index = readBlockIndex(event.index);
          if (blocks.has(index)) {
            throw new AnthropicError(`Anthropic stream repeated content block ${index}`);
          }
          const block = toMutableBlock(event.content_block);
          blocks.set(index, block);
          if (block.type === 'text' && block.text) {
            yield { type: 'output.delta', delta: block.text };
          }
          break;
        }
        case 'content_block_delta': {
          assertStarted(started);
          const index = readBlockIndex(event.index);
          const block = blocks.get(index);
          if (!block || finishedBlocks.has(index)) {
            throw new AnthropicError(`Anthropic stream referenced unknown content block ${index}`);
          }
          if (!isRecord(event.delta) || typeof event.delta.type !== 'string') {
            throw new AnthropicError('Anthropic stream returned an invalid content delta');
          }
          switch (event.delta.type) {
            case 'text_delta': {
              if (block.type !== 'text' || typeof event.delta.text !== 'string') {
                throw new AnthropicError('Anthropic text delta was invalid');
              }
              block.text += event.delta.text;
              if (event.delta.text) {
                yield { type: 'output.delta', delta: event.delta.text };
              }
              break;
            }
            case 'thinking_delta': {
              if (block.type !== 'thinking' || typeof event.delta.thinking !== 'string') {
                throw new AnthropicError('Anthropic thinking delta was invalid');
              }
              block.thinking += event.delta.thinking;
              break;
            }
            case 'signature_delta': {
              if (block.type !== 'thinking' || typeof event.delta.signature !== 'string') {
                throw new AnthropicError('Anthropic signature delta was invalid');
              }
              block.signature += event.delta.signature;
              break;
            }
            case 'input_json_delta': {
              if (block.type !== 'tool_use' || typeof event.delta.partial_json !== 'string') {
                throw new AnthropicError('Anthropic tool input delta was invalid');
              }
              block.partialJson += event.delta.partial_json;
              break;
            }
            default:
              throw new AnthropicError(
                `Anthropic content delta type "${event.delta.type}" is unsupported`,
              );
          }
          break;
        }
        case 'content_block_stop': {
          assertStarted(started);
          const index = readBlockIndex(event.index);
          if (!blocks.has(index) || finishedBlocks.has(index)) {
            throw new AnthropicError(`Anthropic stream referenced unknown content block ${index}`);
          }
          finishedBlocks.add(index);
          break;
        }
        case 'message_delta': {
          assertStarted(started);
          if (!isRecord(event.delta)) {
            throw new AnthropicError('Anthropic stream returned an invalid message_delta');
          }
          if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) {
            if (typeof event.delta.stop_reason !== 'string') {
              throw new AnthropicError('Anthropic stop_reason was invalid');
            }
            if (stopReason !== undefined && stopReason !== event.delta.stop_reason) {
              throw new AnthropicError('Anthropic stream returned conflicting stop reasons');
            }
            stopReason = event.delta.stop_reason;
          }
          if (event.usage !== undefined && event.usage !== null) {
            usage = mergeUsage(usage, event.usage);
          }
          break;
        }
        case 'message_stop': {
          assertStarted(started);
          stopped = true;
          break;
        }
        case 'ping':
          break;
        case 'error':
          throw new AnthropicError(toAnthropicStreamErrorMessage(event), {
            status: response.status,
            requestId,
            cause: event,
          });
        default:
          break;
      }

      if (stopped) break;
    }
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (error instanceof AnthropicError) throw error;
    throw new AnthropicError('Anthropic stream failed', {
      status: response.status,
      requestId,
      cause: error,
    });
  }

  if (!stopped) {
    throw new AnthropicError('Anthropic stream ended without message_stop', {
      status: response.status,
      requestId,
    });
  }
  for (const index of blocks.keys()) {
    if (!finishedBlocks.has(index)) {
      throw new AnthropicError(`Anthropic stream ended before content block ${index} stopped`, {
        status: response.status,
        requestId,
      });
    }
  }

  const finalized = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => finalizeBlock(block));

  yield {
    type: 'completed',
    result: parseAnthropicResult(finalized, stopReason, usage, input, modelId),
  };
}

function buildHeaders(config: ResolvedAnthropicConfig): Record<string, string> {
  return {
    'x-api-key': config.apiKey,
    'anthropic-version': config.apiVersion,
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
}

function buildRequestBody(
  config: ResolvedAnthropicConfig,
  modelId: string,
  input: ModelInput,
) {
  const strict = config.schemaPolicy === 'strict';
  const options = { ...(input.modelOptions ?? {}) };
  const providerMaxTokens = options.max_tokens;
  const providerOutputConfig = options.output_config;
  const providerThinking = options.thinking;
  for (const key of [
    'model',
    'messages',
    'system',
    'tools',
    'tool_choice',
    'max_tokens',
    'output_config',
    'thinking',
    'stream',
  ]) {
    delete options[key];
  }

  const messages =
    input.outputSchema && !strict
      ? withSchemaInstruction(input.messages, input.outputSchema)
      : input.messages;
  const converted = toAnthropicMessages(
    messages,
    readAnthropicProviderState(input.providerState, modelId),
  );
  const maxOutputTokens = cappedTokenLimit(input.maxOutputTokens, providerMaxTokens);
  const outputConfig = toAnthropicOutputConfig(input, providerOutputConfig, strict);
  const thinking = toAnthropicThinking(input, providerThinking);
  const toolChoice = toAnthropicToolChoice(input);

  return {
    ...options,
    model: modelId,
    max_tokens: maxOutputTokens ?? defaultMaxTokens,
    ...(converted.system === undefined ? {} : { system: converted.system }),
    messages: converted.messages,
    ...(input.tools?.length
      ? {
          tools: input.tools.map((tool) => toAnthropicTool(tool, strict)),
          ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
        }
      : {}),
    ...(outputConfig === undefined ? {} : { output_config: outputConfig }),
    ...(thinking === undefined ? {} : { thinking }),
    stream: true,
  };
}

function toAnthropicToolChoice(input: ModelInput): JsonObject | undefined {
  if (!input.tools?.length) return undefined;
  if (input.toolChoice === undefined || input.toolChoice === 'auto') {
    return { type: 'auto', disable_parallel_tool_use: true };
  }
  if (input.toolChoice === 'required') {
    return { type: 'any', disable_parallel_tool_use: true };
  }
  if (input.toolChoice === 'none') return { type: 'none' };
  return { type: 'tool', name: input.toolChoice.name, disable_parallel_tool_use: true };
}

function toAnthropicOutputConfig(
  input: ModelInput,
  providerOutputConfig: unknown,
  strict: boolean,
): JsonObject | undefined {
  const config: JsonObject = isRecord(providerOutputConfig)
    ? { ...providerOutputConfig } as JsonObject
    : {};
  if (input.outputSchema) {
    if (strict) {
      config.format = { type: 'json_schema', schema: input.outputSchema };
    } else {
      delete config.format;
    }
  }
  if (input.reasoning && input.reasoning !== 'provider-default') {
    if (input.reasoning === 'none') {
      delete config.effort;
    } else if (input.reasoning !== 'minimal') {
      config.effort = input.reasoning;
    }
  }
  return Object.keys(config).length ? config : undefined;
}

function toAnthropicThinking(input: ModelInput, providerThinking: unknown): JsonObject | undefined {
  if (input.reasoning === 'none') return { type: 'disabled' };
  return isRecord(providerThinking) ? providerThinking as JsonObject : undefined;
}

function toMessagesURL(baseURL: string | undefined): string {
  const base = (baseURL ?? defaultBaseURL).replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

function cappedTokenLimit(runtimeLimit: number | undefined, providerLimit: unknown): number | undefined {
  if (runtimeLimit === undefined) {
    return typeof providerLimit === 'number' ? providerLimit : undefined;
  }
  return typeof providerLimit === 'number' && Number.isFinite(providerLimit) && providerLimit > 0
    ? Math.min(runtimeLimit, providerLimit)
    : runtimeLimit;
}

async function readResponseJson(
  response: Response,
  requestId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const text = await response.text();
  signal?.throwIfAborted();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AnthropicError('Anthropic response was not valid JSON', {
      status: response.status,
      requestId,
      cause: error,
    });
  }
}

function toAnthropicMessages(
  messages: AgentMessage[],
  state: AnthropicProviderState | undefined,
): { system: string | undefined; messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> } {
  const system: string[] = [];
  const result: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
  let turnIndex = 0;
  let pendingToolResults: unknown[] = [];

  const pushMessage = (role: 'user' | 'assistant', content: unknown[]): void => {
    if (!content.length) return;
    const last = result[result.length - 1];
    if (last?.role === role) {
      last.content.push(...content);
    } else {
      result.push({ role, content });
    }
  };
  const flushToolResults = (): void => {
    if (!pendingToolResults.length) return;
    const content = pendingToolResults;
    pendingToolResults = [];
    pushMessage('user', content);
  };

  for (const message of messages) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      });
      continue;
    }
    flushToolResults();

    if (message.role === 'user') {
      if (message.content) pushMessage('user', [{ type: 'text', text: message.content }]);
      continue;
    }

    if (message.toolCalls?.length) {
      const turn = state?.turns[turnIndex];
      if (!turn) {
        throw new AnthropicError('Anthropic providerState is required for assistant tool-call history');
      }
      const ids = message.toolCalls.map(({ id }) => id);
      if (!sameStrings(turn.toolCallIds, ids)) {
        throw new AnthropicError('Anthropic providerState does not match assistant tool-call history');
      }
      turnIndex += 1;
      pushMessage('assistant', structuredClone(turn.content));
    } else if (message.content) {
      pushMessage('assistant', [{ type: 'text', text: message.content }]);
    }
  }
  flushToolResults();

  if (turnIndex !== (state?.turns.length ?? 0)) {
    throw new AnthropicError('Anthropic providerState does not match assistant tool-call history');
  }
  if (!result.length) {
    throw new AnthropicError('Anthropic messages must include non-empty content');
  }
  return {
    system: system.length ? system.join('\n\n') : undefined,
    messages: result,
  };
}

function toAnthropicTool(tool: ToolSpec, strict: boolean): JsonObject {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.inputSchema ?? emptyObjectSchema(),
    ...(strict ? { strict: true } : {}),
  };
}

function assertStrictSchemas(input: ModelInput): void {
  const tools = input.tools ?? [];
  if (tools.length > 20) {
    throw unsupportedSchema(
      'tools',
      '$: Anthropic supports at most 20 strict tools per request',
    );
  }

  const limits = { optionalParameters: 0, unionParameters: 0 };
  for (const tool of tools) {
    const issue = findAnthropicSchemaIssue(tool.inputSchema ?? emptyObjectSchema(), limits);
    if (issue) throw unsupportedSchema(`tool-input "${tool.name}"`, issue);
  }
  if (input.outputSchema) {
    const issue = findAnthropicSchemaIssue(input.outputSchema, limits);
    if (issue) throw unsupportedSchema('output', issue);
  }
}

function assertCompatibleInput(input: ModelInput): void {
  if (!isRecord(input)) throw new AnthropicError('Anthropic input must be an object');
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new AnthropicError('Anthropic messages must be a non-empty array');
  }
  if (input.modelOptions !== undefined && !isRecord(input.modelOptions)) {
    throw new AnthropicError('Anthropic modelOptions must be an object');
  }
  if (
    input.maxOutputTokens !== undefined &&
    (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)
  ) {
    throw new AnthropicError('Anthropic maxOutputTokens must be a positive integer');
  }
  if (
    input.reasoning !== undefined &&
    ![
      'provider-default',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ].includes(input.reasoning)
  ) {
    throw new AnthropicError('Anthropic reasoning effort is invalid');
  }
  if (input.reasoning === 'minimal') {
    throw new AnthropicError(
      'Anthropic does not support reasoning effort "minimal" without compatibility mapping',
      { code: PROVIDER_REASONING_UNSUPPORTED },
    );
  }
  if (input.outputSchema !== undefined && !isRecord(input.outputSchema)) {
    throw new AnthropicError('Anthropic outputSchema must be an object');
  }
  if (input.tools !== undefined && !Array.isArray(input.tools)) {
    throw new AnthropicError('Anthropic tools must be an array');
  }
  if ((input.tools?.length ?? 0) > 128) {
    throw new AnthropicError('Anthropic supports at most 128 tools');
  }
  if (input.toolChoice !== undefined) {
    if (typeof input.toolChoice === 'string') {
      if (!['auto', 'required', 'none'].includes(input.toolChoice)) {
        throw new AnthropicError('Anthropic toolChoice is invalid');
      }
    } else if (!isRecord(input.toolChoice) || !isProviderName(input.toolChoice.name)) {
      throw new AnthropicError('Anthropic toolChoice is invalid');
    }
  }

  const options = input.modelOptions;
  if (options) {
    if (
      options.max_tokens !== undefined
      && (!Number.isInteger(options.max_tokens) || Number(options.max_tokens) < 1)
    ) {
      throw new AnthropicError('Anthropic modelOptions.max_tokens must be a positive integer');
    }
    if (options.output_config !== undefined && !isRecord(options.output_config)) {
      throw new AnthropicError('Anthropic modelOptions.output_config must be an object');
    }
    if (options.thinking !== undefined && !isRecord(options.thinking)) {
      throw new AnthropicError('Anthropic modelOptions.thinking must be an object');
    }
  }

  const toolNames = new Set<string>();
  for (const tool of input.tools ?? []) {
    if (!isRecord(tool) || !isProviderName(tool.name)) {
      throw new AnthropicError('Anthropic tool names must match [A-Za-z0-9_-]{1,64}');
    }
    if (toolNames.has(tool.name)) {
      throw new AnthropicError(`Anthropic tool "${tool.name}" is duplicated`);
    }
    toolNames.add(tool.name);
  }

  const callIds = new Set<string>();
  const completedCallIds = new Set<string>();
  for (const message of input.messages) {
    if (
      !isRecord(message) ||
      !['system', 'user', 'assistant', 'tool'].includes(String(message.role)) ||
      typeof message.content !== 'string'
    ) {
      throw new AnthropicError('Anthropic message is invalid');
    }

    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      if (!Array.isArray(message.toolCalls)) {
        throw new AnthropicError('Anthropic assistant toolCalls must be an array');
      }
      for (const call of message.toolCalls) {
        if (
          !isRecord(call) ||
          typeof call.id !== 'string' ||
          !call.id.trim() ||
          !isProviderName(call.name)
        ) {
          throw new AnthropicError('Anthropic assistant tool call is invalid');
        }
        if (callIds.has(call.id)) {
          throw new AnthropicError(`Anthropic tool call id "${call.id}" is duplicated`);
        }
        callIds.add(call.id);
      }
    }

    if (message.role === 'tool') {
      if (
        typeof message.toolCallId !== 'string' ||
        !message.toolCallId.trim() ||
        !callIds.has(message.toolCallId) ||
        completedCallIds.has(message.toolCallId)
      ) {
        throw new AnthropicError('Anthropic tool result has an invalid toolCallId');
      }
      completedCallIds.add(message.toolCallId);
    }
  }
  if (completedCallIds.size !== callIds.size) {
    throw new AnthropicError('Anthropic assistant tool call is missing a tool result');
  }
}

function toMutableBlock(value: unknown): MutableBlock {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new AnthropicError('Anthropic content block was invalid');
  }
  switch (value.type) {
    case 'text':
      if (typeof value.text !== 'string') {
        throw new AnthropicError('Anthropic text content block was invalid');
      }
      return { type: 'text', text: value.text };
    case 'thinking':
      if (typeof value.thinking !== 'string') {
        throw new AnthropicError('Anthropic thinking content block was invalid');
      }
      if (value.signature !== undefined && typeof value.signature !== 'string') {
        throw new AnthropicError('Anthropic thinking signature was invalid');
      }
      return { type: 'thinking', thinking: value.thinking, signature: value.signature ?? '' };
    case 'redacted_thinking':
      if (typeof value.data !== 'string') {
        throw new AnthropicError('Anthropic redacted thinking block was invalid');
      }
      return { type: 'redacted_thinking', data: value.data };
    case 'tool_use':
      if (typeof value.id !== 'string' || !value.id.trim()) {
        throw new AnthropicError('Anthropic tool call returned an invalid id');
      }
      if (typeof value.name !== 'string' || !isProviderName(value.name)) {
        throw new AnthropicError('Anthropic tool call returned an invalid name');
      }
      if (!isRecord(value.input)) {
        throw new AnthropicError('Anthropic tool call returned an invalid input');
      }
      return {
        type: 'tool_use',
        id: value.id,
        name: value.name,
        input: value.input as JsonObject,
        partialJson: '',
      };
    default:
      throw new AnthropicError(`Anthropic content block type "${value.type}" is unsupported`);
  }
}

function finalizeBlock(block: MutableBlock): AnthropicFinalBlock {
  if (block.type !== 'tool_use') return block;

  let input: JsonObject = block.input;
  if (block.partialJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.partialJson);
    } catch (error) {
      throw new AnthropicError(
        `Anthropic tool call "${block.name}" returned invalid JSON arguments`,
        { cause: error },
      );
    }
    if (!isRecord(parsed)) {
      throw new AnthropicError(
        `Anthropic tool call "${block.name}" arguments must be a JSON object`,
      );
    }
    input = parsed as JsonObject;
  }
  return { type: 'tool_use', id: block.id, name: block.name, input };
}

function readBlockIndex(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new AnthropicError('Anthropic content block index was invalid');
  }
  return Number(value);
}

function mergeUsage(
  current: AnthropicUsage | undefined,
  value: unknown,
): AnthropicUsage {
  if (!isRecord(value)) throw new AnthropicError('Anthropic stream usage was invalid');
  const next: AnthropicUsage = { ...current };
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ] as const) {
    const item = value[key];
    if (item === undefined || item === null) continue;
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) {
      throw new AnthropicError('Anthropic stream usage was invalid');
    }
    next[key] = item;
  }
  return next;
}

function assertStarted(started: boolean): void {
  if (!started) throw new AnthropicError('Anthropic stream started without message_start');
}

function unsupportedSchema(boundary: string, issue: string): AnthropicError {
  return new AnthropicError(`Anthropic strict schema for ${boundary} is unsupported at ${issue}`, {
    code: PROVIDER_SCHEMA_UNSUPPORTED,
  });
}

function emptyObjectSchema(): JsonObject {
  return {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  };
}

function withSchemaInstruction(messages: AgentMessage[], schema: JsonObject): AgentMessage[] {
  const kind = isObjectRoot(schema) ? 'JSON object' : 'JSON value';
  return [
    {
      role: 'system',
      content: `Respond with a ${kind} matching this schema: ${JSON.stringify(schema)}`,
    },
    ...messages,
  ];
}

function isObjectRoot(schema: JsonObject): boolean {
  return schema.type === 'object' && schema.anyOf === undefined;
}

function isProviderName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toAnthropicErrorMessage(data: unknown, status: number): string {
  if (isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string') {
    return data.error.message;
  }
  return `Anthropic request failed with status ${status}`;
}

function toAnthropicStreamErrorMessage(event: Record<string, unknown>): string {
  if (isRecord(event.error) && typeof event.error.message === 'string') {
    return event.error.message;
  }
  if (typeof event.message === 'string') return event.message;
  return 'Anthropic stream failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
