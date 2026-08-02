import {
  PROVIDER_REASONING_UNSUPPORTED,
  PROVIDER_SCHEMA_UNSUPPORTED,
  type AgentMessage,
  type JsonObject,
  type ModelInput,
  type ModelStreamEvent,
  type ToolCall,
  type ToolSpec,
} from '@fevex/core';
import type { ResolvedDeepSeekConfig } from '../config';
import { DeepSeekError } from '../deepseek-error';
import { readDeepSeekProviderState, type DeepSeekProviderState } from './provider-state';
import { findDeepSeekToolSchemaIssue } from './provider-schema';
import { parseDeepSeekResponse, type DeepSeekResponse } from './response';
import { readSSE } from './sse';

type ChatMessage =
  | {
      role: 'system' | 'user' | 'assistant';
      content: string;
      tool_calls?: ChatToolCall[];
      reasoning_content?: string;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

const defaultBaseURL = 'https://api.deepseek.com';

export async function* streamChatCompletion(
  config: ResolvedDeepSeekConfig,
  modelId: string,
  input: ModelInput,
): AsyncGenerator<ModelStreamEvent> {
  input.signal?.throwIfAborted();
  assertCompatibleInput(input);
  if (config.schemaPolicy === 'strict') {
    assertStrictSchemas(config.baseURL, input);
  }
  const body = buildRequestBody(config, modelId, input);

  let response: Response;
  try {
    response = await config.fetch(toChatCompletionsURL(config.baseURL), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    throw new DeepSeekError('DeepSeek request failed', { cause: error });
  }

  input.signal?.throwIfAborted();
  const requestId = getRequestId(response);
  if (!response.ok) {
    const data = await readResponseJson(response, requestId, input.signal);
    throw new DeepSeekError(toDeepSeekErrorMessage(data, response.status), {
      status: response.status,
      requestId,
      cause: data,
    });
  }

  const toolCalls = new Map<
    number,
    {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }
  >();
  let content = '';
  let hasContent = false;
  let reasoningContent = '';
  let finishReason: unknown;
  let usage: DeepSeekResponse['usage'];
  let done = false;

  try {
    for await (const data of readSSE(response.body, input.signal)) {
      if (data === '[DONE]') {
        done = true;
        break;
      }

      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch (error) {
        throw new DeepSeekError('DeepSeek stream event was not valid JSON', {
          status: response.status,
          requestId,
          cause: error,
        });
      }
      if (!isRecord(chunk)) {
        throw new DeepSeekError('DeepSeek stream event was invalid', {
          status: response.status,
          requestId,
          cause: chunk,
        });
      }
      if (isRecord(chunk.error)) {
        throw new DeepSeekError(toDeepSeekErrorMessage(chunk, response.status), {
          status: response.status,
          requestId,
          cause: chunk,
        });
      }
      if (chunk.usage !== undefined && chunk.usage !== null) {
        if (!isRecord(chunk.usage)) {
          throw new DeepSeekError('DeepSeek stream usage was invalid', {
            status: response.status,
            requestId,
            cause: chunk,
          });
        }
        usage = chunk.usage;
      }
      if (!Array.isArray(chunk.choices)) {
        throw new DeepSeekError('DeepSeek stream choices were invalid', {
          status: response.status,
          requestId,
          cause: chunk,
        });
      }
      for (const choice of chunk.choices) {
        if (!isRecord(choice) || choice.index !== 0) {
          throw new DeepSeekError('DeepSeek stream returned an invalid choice', {
            status: response.status,
            requestId,
            cause: choice,
          });
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (finishReason !== undefined && finishReason !== choice.finish_reason) {
            throw new DeepSeekError('DeepSeek stream returned conflicting finish reasons');
          }
          finishReason = choice.finish_reason;
        }
        if (!isRecord(choice.delta)) {
          throw new DeepSeekError('DeepSeek stream returned an invalid delta', {
            status: response.status,
            requestId,
            cause: choice,
          });
        }
        const delta = choice.delta;
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== 'string') {
            throw new DeepSeekError('DeepSeek content delta was invalid');
          }
          hasContent = true;
          content += delta.content;
          if (delta.content) yield { type: 'output.delta', delta: delta.content };
        }
        if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
          if (typeof delta.reasoning_content !== 'string') {
            throw new DeepSeekError('DeepSeek reasoning delta was invalid');
          }
          reasoningContent += delta.reasoning_content;
        }
        appendToolCallDeltas(toolCalls, delta.tool_calls);
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (error instanceof DeepSeekError) throw error;
    throw new DeepSeekError('DeepSeek stream failed', {
      status: response.status,
      requestId,
      cause: error,
    });
  }

  if (!done) {
    throw new DeepSeekError('DeepSeek stream ended without [DONE]', {
      status: response.status,
      requestId,
    });
  }

  const calls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
  yield {
    type: 'completed',
    result: parseDeepSeekResponse(
      {
        choices: [
          {
            finish_reason: finishReason,
            message: {
              content: hasContent ? content : null,
              ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
              ...(calls.length ? { tool_calls: calls } : {}),
            },
          },
        ],
        ...(usage ? { usage } : {}),
      },
      input,
      modelId,
    ),
  };
}

function buildRequestBody(config: ResolvedDeepSeekConfig, modelId: string, input: ModelInput) {
  const strict = config.schemaPolicy === 'strict';
  const options = { ...(input.modelOptions ?? {}) };
  const providerLimit = options.max_tokens;
  const providerResponseFormat = options.response_format;
  const providerThinking = options.thinking;
  const providerReasoningEffort = options.reasoning_effort;
  for (const key of [
    'model',
    'messages',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'max_tokens',
    'response_format',
    'thinking',
    'reasoning_effort',
    'stream',
    'stream_options',
  ]) {
    delete options[key];
  }
  const messages =
    input.outputSchema && !strict
      ? withSchemaInstruction(input.messages, input.outputSchema)
      : input.messages;
  const maxOutputTokens = cappedTokenLimit(input.maxOutputTokens, providerLimit);
  const responseFormat = toDeepSeekResponseFormat(input, providerResponseFormat);
  const reasoning = toDeepSeekReasoning(
    input,
    providerThinking,
    providerReasoningEffort,
    modelId,
  );

  return {
    ...options,
    model: modelId,
    messages: toDeepSeekMessages(messages, readDeepSeekProviderState(input.providerState, modelId)),
    ...(input.tools?.length
      ? {
          tools: input.tools.map((tool) => toDeepSeekTool(tool, strict)),
          ...(toDeepSeekToolChoice(input) === undefined
            ? {}
            : { tool_choice: toDeepSeekToolChoice(input) }),
          parallel_tool_calls: false,
        }
      : {}),
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    ...(reasoning.thinking === undefined ? {} : { thinking: reasoning.thinking }),
    ...(reasoning.effort === undefined ? {} : { reasoning_effort: reasoning.effort }),
    ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
    stream: true,
    stream_options: { include_usage: true },
  };
}

function toDeepSeekToolChoice(input: ModelInput): unknown {
  if (!input.tools?.length || input.toolChoice === undefined || input.toolChoice === 'auto') {
    return undefined;
  }
  if (typeof input.toolChoice === 'string') return input.toolChoice;
  return { type: 'function', function: { name: input.toolChoice.name } };
}

function appendToolCallDeltas(
  calls: Map<
    number,
    {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }
  >,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw new DeepSeekError('DeepSeek tool call delta was invalid');
  }
  for (const item of value) {
    if (!isRecord(item) || !Number.isInteger(item.index) || Number(item.index) < 0) {
      throw new DeepSeekError('DeepSeek tool call delta index was invalid');
    }
    const index = Number(item.index);
    const current = calls.get(index) ?? {
      id: '',
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };
    if (item.type !== undefined && item.type !== 'function') {
      throw new DeepSeekError('DeepSeek tool call delta type was invalid');
    }
    if (item.id !== undefined) {
      if (typeof item.id !== 'string' || (current.id && current.id !== item.id)) {
        throw new DeepSeekError('DeepSeek tool call delta id was invalid');
      }
      current.id = item.id;
    }
    if (item.function !== undefined) {
      if (!isRecord(item.function)) {
        throw new DeepSeekError('DeepSeek tool call function delta was invalid');
      }
      if (item.function.name !== undefined) {
        if (typeof item.function.name !== 'string') {
          throw new DeepSeekError('DeepSeek tool call name delta was invalid');
        }
        current.function.name += item.function.name;
      }
      if (item.function.arguments !== undefined) {
        if (typeof item.function.arguments !== 'string') {
          throw new DeepSeekError('DeepSeek tool call arguments delta was invalid');
        }
        current.function.arguments += item.function.arguments;
      }
    }
    calls.set(index, current);
  }
}

function toChatCompletionsURL(baseURL: string | undefined): string {
  return `${(baseURL ?? defaultBaseURL).replace(/\/$/, '')}/chat/completions`;
}

function cappedTokenLimit(runtimeLimit: number | undefined, providerLimit: unknown): unknown {
  if (runtimeLimit === undefined) return providerLimit;
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
    throw new DeepSeekError('DeepSeek response was not valid JSON', {
      status: response.status,
      requestId,
      cause: error,
    });
  }
}

function getRequestId(response: Response): string | undefined {
  return response.headers.get('x-ds-request-id') ?? undefined;
}

function toDeepSeekMessages(
  messages: AgentMessage[],
  state: DeepSeekProviderState | undefined,
): ChatMessage[] {
  let turnIndex = 0;
  const result = messages.map((message): ChatMessage => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      };
    }

    const turn =
      message.role === 'assistant' && message.toolCalls?.length
        ? state?.turns[turnIndex]
        : undefined;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      if (!turn) {
        throw new DeepSeekError(
          'DeepSeek providerState is required for assistant tool-call history',
        );
      }
      const ids = message.toolCalls.map(({ id }) => id);
      if (!sameStrings(turn.toolCallIds, ids)) {
        throw new DeepSeekError(
          'DeepSeek providerState does not match assistant tool-call history',
        );
      }
      turnIndex += 1;
    }

    return {
      role: message.role,
      content: message.content,
      ...(turn?.reasoningContent === undefined ? {} : { reasoning_content: turn.reasoningContent }),
      ...(message.toolCalls?.length
        ? { tool_calls: message.toolCalls.map(toDeepSeekToolCall) }
        : {}),
    };
  });

  if (turnIndex !== (state?.turns.length ?? 0)) {
    throw new DeepSeekError('DeepSeek providerState does not match assistant tool-call history');
  }
  return result;
}

function toDeepSeekToolCall(toolCall: ToolCall): ChatToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input),
    },
  };
}

function toDeepSeekTool(tool: ToolSpec, strict: boolean): JsonObject {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(strict ? { strict: true } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema ?? emptyObjectSchema(strict),
    },
  };
}

function assertStrictSchemas(baseURL: string | undefined, input: ModelInput): void {
  if (input.outputSchema) {
    throw unsupportedSchema('output', '$: DeepSeek JSON Output does not enforce a JSON Schema');
  }
  if (!input.tools?.length) return;
  if (!isBetaBaseURL(baseURL)) {
    throw unsupportedSchema(
      'tool-input',
      '$: DeepSeek strict tools require a baseURL ending in "/beta"',
    );
  }

  for (const tool of input.tools) {
    const issue = findDeepSeekToolSchemaIssue(tool.inputSchema ?? emptyObjectSchema(true));
    if (issue) throw unsupportedSchema(`tool-input "${tool.name}"`, issue);
  }
}

function assertCompatibleInput(input: ModelInput): void {
  if (!isRecord(input)) throw new DeepSeekError('DeepSeek input must be an object');
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new DeepSeekError('DeepSeek messages must be a non-empty array');
  }
  if (input.modelOptions !== undefined && !isRecord(input.modelOptions)) {
    throw new DeepSeekError('DeepSeek modelOptions must be an object');
  }
  if (
    input.maxOutputTokens !== undefined &&
    (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)
  ) {
    throw new DeepSeekError('DeepSeek maxOutputTokens must be a positive integer');
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
    throw new DeepSeekError('DeepSeek reasoning effort is invalid');
  }
  if (input.reasoning === 'minimal' || input.reasoning === 'medium') {
    throw new DeepSeekError(
      `DeepSeek does not support reasoning effort "${input.reasoning}" without compatibility mapping`,
      { code: PROVIDER_REASONING_UNSUPPORTED },
    );
  }
  const providerReasoning = input.modelOptions?.reasoning_effort;
  if (
    (!input.reasoning || input.reasoning === 'provider-default') &&
    providerReasoning !== undefined &&
    providerReasoning !== 'low' &&
    providerReasoning !== 'high' &&
    providerReasoning !== 'max'
  ) {
    throw new DeepSeekError(
      `DeepSeek does not support reasoning effort "${String(providerReasoning)}" without compatibility mapping`,
      { code: PROVIDER_REASONING_UNSUPPORTED },
    );
  }
  if (input.outputSchema !== undefined && !isRecord(input.outputSchema)) {
    throw new DeepSeekError('DeepSeek outputSchema must be an object');
  }
  if (input.tools !== undefined && !Array.isArray(input.tools)) {
    throw new DeepSeekError('DeepSeek tools must be an array');
  }
  if ((input.tools?.length ?? 0) > 128) {
    throw new DeepSeekError('DeepSeek supports at most 128 tools');
  }

  const toolNames = new Set<string>();
  for (const tool of input.tools ?? []) {
    if (!isRecord(tool) || !isProviderName(tool.name)) {
      throw new DeepSeekError('DeepSeek tool names must match [A-Za-z0-9_-]{1,64}');
    }
    if (toolNames.has(tool.name)) {
      throw new DeepSeekError(`DeepSeek tool "${tool.name}" is duplicated`);
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
      throw new DeepSeekError('DeepSeek message is invalid');
    }

    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      if (!Array.isArray(message.toolCalls)) {
        throw new DeepSeekError('DeepSeek assistant toolCalls must be an array');
      }
      for (const call of message.toolCalls) {
        if (
          !isRecord(call) ||
          typeof call.id !== 'string' ||
          !call.id.trim() ||
          !isProviderName(call.name)
        ) {
          throw new DeepSeekError('DeepSeek assistant tool call is invalid');
        }
        if (callIds.has(call.id)) {
          throw new DeepSeekError(`DeepSeek tool call id "${call.id}" is duplicated`);
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
        throw new DeepSeekError('DeepSeek tool result has an invalid toolCallId');
      }
      completedCallIds.add(message.toolCallId);
    }
  }
  if (completedCallIds.size !== callIds.size) {
    throw new DeepSeekError('DeepSeek assistant tool call is missing a tool result');
  }
}

function toDeepSeekResponseFormat(input: ModelInput, providerFormat: unknown): unknown {
  if (!input.outputSchema) return providerFormat;
  if (isObjectRoot(input.outputSchema)) return { type: 'json_object' };
  return providerFormat === undefined ? undefined : { type: 'text' };
}

function toDeepSeekReasoning(
  input: ModelInput,
  providerThinking: unknown,
  providerEffort: unknown,
  modelId: string,
): { thinking?: unknown; effort?: unknown } {
  if (!input.reasoning || input.reasoning === 'provider-default') {
    return {
      ...(providerThinking === undefined ? {} : { thinking: providerThinking }),
      ...(providerEffort === undefined ? {} : { effort: providerEffort }),
    };
  }
  if (input.reasoning === 'none') {
    return { thinking: { type: 'disabled' } };
  }
  // ponytail: assertCompatibleInput already narrowed reasoning to low/high/xhigh/max here.
  return {
    thinking: { type: 'enabled' },
    effort:
      input.reasoning === 'xhigh'
        ? modelId === 'deepseek-v4-pro'
          ? 'max'
          : 'high'
        : input.reasoning,
  };
}

function unsupportedSchema(boundary: string, issue: string): DeepSeekError {
  return new DeepSeekError(`DeepSeek strict schema for ${boundary} is unsupported at ${issue}`, {
    code: PROVIDER_SCHEMA_UNSUPPORTED,
  });
}

function isBetaBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    return new URL(baseURL).pathname.replace(/\/+$/, '').endsWith('/beta');
  } catch {
    return false;
  }
}

function emptyObjectSchema(strict: boolean): JsonObject {
  return strict
    ? {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      }
    : { type: 'object', properties: {} };
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

function toDeepSeekErrorMessage(data: unknown, status: number): string {
  if (isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string') {
    return data.error.message;
  }
  return `DeepSeek request failed with status ${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
