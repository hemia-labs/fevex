import {
  PROVIDER_SCHEMA_UNSUPPORTED,
  type AgentMessage,
  type JsonObject,
  type ModelInput,
  type ModelStreamEvent,
  type ToolSpec,
} from '@fevex/core';
import type { ResolvedOpenAIConfig } from '../config';
import { OpenAIError } from '../openai-error';
import { readOpenAIProviderState, type OpenAIProviderState } from './provider-state';
import { findOpenAISchemaIssue } from './provider-schema';
import { parseOpenAIResponse, type OpenAIResponse } from './response';
import { readSSE } from './sse';

const defaultBaseURL = 'https://api.openai.com/v1';

export async function* streamOpenAIResponse(
  config: ResolvedOpenAIConfig,
  modelId: string,
  input: ModelInput,
): AsyncGenerator<ModelStreamEvent> {
  input.signal?.throwIfAborted();
  assertCompatibleInput(input);
  if (config.schemaPolicy === 'strict') assertStrictSchemas(input);
  const body = buildRequestBody(config, modelId, input);

  let response: Response;
  try {
    response = await config.fetch(toResponsesURL(config.baseURL), {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    throw new OpenAIError('OpenAI request failed', { cause: error });
  }

  input.signal?.throwIfAborted();
  const requestId = response.headers.get('x-request-id') ?? undefined;
  if (!response.ok) {
    const data = await readResponseJson(response, requestId, input.signal);
    throw new OpenAIError(toOpenAIErrorMessage(data, response.status), {
      status: response.status,
      requestId,
      cause: data,
    });
  }

  let completed = false;
  try {
    for await (const data of readSSE(response.body, input.signal)) {
      if (data === '[DONE]') continue;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch (error) {
        throw new OpenAIError('OpenAI stream event was not valid JSON', {
          status: response.status,
          requestId,
          cause: error,
        });
      }
      if (!isRecord(event) || typeof event.type !== 'string') {
        throw new OpenAIError('OpenAI stream event was invalid', {
          status: response.status,
          requestId,
          cause: event,
        });
      }
      if (event.type === 'response.output_text.delta') {
        if (typeof event.delta !== 'string') {
          throw new OpenAIError('OpenAI output delta was invalid', {
            status: response.status,
            requestId,
            cause: event,
          });
        }
        if (event.delta) yield { type: 'output.delta', delta: event.delta };
        continue;
      }
      if (event.type === 'response.completed') {
        if (completed || !isRecord(event.response)) {
          throw new OpenAIError('OpenAI stream returned an invalid completion', {
            status: response.status,
            requestId,
            cause: event,
          });
        }
        completed = true;
        yield {
          type: 'completed',
          result: parseOpenAIResponse(event.response as unknown as OpenAIResponse, input, modelId),
        };
        continue;
      }
      if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        if (!isRecord(event.response)) {
          throw new OpenAIError('OpenAI stream returned an invalid terminal response', {
            status: response.status,
            requestId,
            cause: event,
          });
        }
        parseOpenAIResponse(event.response as unknown as OpenAIResponse, input, modelId);
      }
      if (event.type === 'error') {
        throw new OpenAIError(toOpenAIStreamErrorMessage(event), {
          status: response.status,
          requestId,
          cause: event,
        });
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (error instanceof OpenAIError) throw error;
    throw new OpenAIError('OpenAI stream failed', {
      status: response.status,
      requestId,
      cause: error,
    });
  }
  if (!completed) {
    throw new OpenAIError('OpenAI stream ended without response.completed', {
      status: response.status,
      requestId,
    });
  }
}

function buildHeaders(config: ResolvedOpenAIConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(config.organization ? { 'openai-organization': config.organization } : {}),
    ...(config.project ? { 'openai-project': config.project } : {}),
  };
}

function buildRequestBody(config: ResolvedOpenAIConfig, modelId: string, input: ModelInput) {
  const strict = config.schemaPolicy === 'strict';
  const options = { ...(input.modelOptions ?? {}) };
  const providerLimit = options.max_output_tokens;
  const providerReasoning = options.reasoning;
  const providerText = options.text;
  for (const key of [
    'model',
    'input',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'max_output_tokens',
    'text',
    'reasoning',
    'stream',
    'background',
    'previous_response_id',
    'conversation',
  ]) {
    delete options[key];
  }
  const messages =
    input.outputSchema && !strict
      ? withSchemaInstruction(input.messages, input.outputSchema)
      : input.messages;
  const maxOutputTokens = cappedTokenLimit(input.maxOutputTokens, providerLimit);
  const text = toOpenAIText(config, input, providerText);
  const reasoning = toOpenAIReasoning(input, providerReasoning);

  return {
    ...options,
    model: modelId,
    stream: true,
    input: toOpenAIInput(messages, readOpenAIProviderState(input.providerState, modelId)),
    ...(input.tools?.length
      ? {
          tools: input.tools.map((tool) => toOpenAITool(tool, strict)),
          parallel_tool_calls: false,
        }
      : {}),
    ...(text === undefined ? {} : { text }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
  };
}

function toResponsesURL(baseURL: string | undefined): string {
  return `${(baseURL ?? defaultBaseURL).replace(/\/$/, '')}/responses`;
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
    throw new OpenAIError('OpenAI response was not valid JSON', {
      status: response.status,
      requestId,
      cause: error,
    });
  }
}

function toOpenAIInput(
  messages: AgentMessage[],
  state: OpenAIProviderState | undefined,
): unknown[] {
  const input: unknown[] = [];
  let turnIndex = 0;

  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: message.content,
      });
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const turn = state?.turns[turnIndex];
      if (!turn) {
        throw new OpenAIError('OpenAI providerState is required for assistant tool-call history');
      }
      const ids = message.toolCalls.map(({ id }) => id);
      if (!sameStrings(turn.toolCallIds, ids)) {
        throw new OpenAIError('OpenAI providerState does not match assistant tool-call history');
      }
      input.push(...turn.output);
      turnIndex += 1;
      continue;
    }

    input.push({ role: message.role, content: message.content });
  }

  if (turnIndex !== (state?.turns.length ?? 0)) {
    throw new OpenAIError('OpenAI providerState does not match assistant tool-call history');
  }

  return input;
}

function toOpenAIText(
  config: ResolvedOpenAIConfig,
  input: ModelInput,
  providerText: unknown,
): unknown {
  if (!input.outputSchema) return providerText;
  const text = isRecord(providerText) ? providerText : {};

  if (config.schemaPolicy === 'strict') {
    return {
      ...text,
      format: {
        type: 'json_schema',
        name: config.schemaName ?? 'fevex_output',
        strict: true,
        schema: input.outputSchema,
      },
    };
  }

  if (!isObjectRoot(input.outputSchema) && providerText === undefined) {
    return undefined;
  }
  return {
    ...text,
    format: isObjectRoot(input.outputSchema) ? { type: 'json_object' } : { type: 'text' },
  };
}

function toOpenAIReasoning(input: ModelInput, providerReasoning: unknown): unknown {
  if (!input.reasoning || input.reasoning === 'provider-default') {
    return providerReasoning;
  }
  return {
    ...(isRecord(providerReasoning) ? providerReasoning : {}),
    effort: input.reasoning,
  };
}

function toOpenAITool(tool: ToolSpec, strict: boolean): JsonObject {
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.inputSchema ?? emptyObjectSchema(strict),
    strict,
  };
}

function assertStrictSchemas(input: ModelInput): void {
  for (const tool of input.tools ?? []) {
    assertStrictSchema(tool.inputSchema ?? emptyObjectSchema(true), `tool-input "${tool.name}"`);
  }
  if (input.outputSchema) assertStrictSchema(input.outputSchema, 'output');
}

function assertCompatibleInput(input: ModelInput): void {
  if (!isRecord(input)) throw new OpenAIError('OpenAI input must be an object');
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new OpenAIError('OpenAI messages must be a non-empty array');
  }
  if (input.modelOptions !== undefined && !isRecord(input.modelOptions)) {
    throw new OpenAIError('OpenAI modelOptions must be an object');
  }
  if (
    input.maxOutputTokens !== undefined &&
    (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)
  ) {
    throw new OpenAIError('OpenAI maxOutputTokens must be a positive integer');
  }
  if (
    input.reasoning !== undefined &&
    !['provider-default', 'none', 'minimal', 'low', 'medium', 'high'].includes(input.reasoning)
  ) {
    throw new OpenAIError('OpenAI reasoning effort is invalid');
  }
  if (input.outputSchema !== undefined && !isRecord(input.outputSchema)) {
    throw new OpenAIError('OpenAI outputSchema must be an object');
  }
  if (input.tools !== undefined && !Array.isArray(input.tools)) {
    throw new OpenAIError('OpenAI tools must be an array');
  }
  if ((input.tools?.length ?? 0) > 128) {
    throw new OpenAIError('OpenAI supports at most 128 tools');
  }

  const toolNames = new Set<string>();
  for (const tool of input.tools ?? []) {
    if (!isRecord(tool) || !isProviderName(tool.name)) {
      throw new OpenAIError('OpenAI tool names must match [A-Za-z0-9_-]{1,64}');
    }
    if (toolNames.has(tool.name)) {
      throw new OpenAIError(`OpenAI tool "${tool.name}" is duplicated`);
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
      throw new OpenAIError('OpenAI message is invalid');
    }

    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      if (!Array.isArray(message.toolCalls)) {
        throw new OpenAIError('OpenAI assistant toolCalls must be an array');
      }
      for (const call of message.toolCalls) {
        if (
          !isRecord(call) ||
          typeof call.id !== 'string' ||
          !call.id.trim() ||
          !isProviderName(call.name)
        ) {
          throw new OpenAIError('OpenAI assistant tool call is invalid');
        }
        if (callIds.has(call.id)) {
          throw new OpenAIError(`OpenAI tool call id "${call.id}" is duplicated`);
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
        throw new OpenAIError('OpenAI tool result has an invalid toolCallId');
      }
      completedCallIds.add(message.toolCallId);
    }
  }
  if (completedCallIds.size !== callIds.size) {
    throw new OpenAIError('OpenAI assistant tool call is missing a tool result');
  }
}

function assertStrictSchema(schema: JsonObject, boundary: string): void {
  const issue = findOpenAISchemaIssue(schema);
  if (!issue) return;
  throw new OpenAIError(`OpenAI strict schema for ${boundary} is unsupported at ${issue}`, {
    code: PROVIDER_SCHEMA_UNSUPPORTED,
  });
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

function toOpenAIErrorMessage(data: unknown, status: number): string {
  if (isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string') {
    return data.error.message;
  }
  return `OpenAI request failed with status ${status}`;
}

function toOpenAIStreamErrorMessage(event: Record<string, unknown>): string {
  if (typeof event.message === 'string') return event.message;
  if (isRecord(event.error) && typeof event.error.message === 'string') {
    return event.error.message;
  }
  return 'OpenAI stream failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
