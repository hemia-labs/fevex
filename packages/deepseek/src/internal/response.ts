import type { JsonValue, ModelInput, ModelResult, ModelUsage, ToolCall } from '@fevex/core';
import { DeepSeekError } from '../deepseek-error';
import { appendDeepSeekProviderState, readDeepSeekProviderState } from './provider-state';

export interface DeepSeekResponse {
  choices?: unknown;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

export function parseDeepSeekResponse(
  response: DeepSeekResponse,
  input: ModelInput,
  modelId: string,
): ModelResult {
  const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
  if (!isRecord(choice)) {
    throw new DeepSeekError('DeepSeek response returned an invalid choice');
  }
  assertFinishReason(choice.finish_reason);
  if (!isRecord(choice.message) || !Object.hasOwn(choice.message, 'content')) {
    throw new DeepSeekError('DeepSeek response returned an invalid message');
  }
  const message = choice.message;
  if (message.content !== null && typeof message.content !== 'string') {
    throw new DeepSeekError('DeepSeek response returned invalid message content');
  }
  if (
    message?.reasoning_content !== undefined &&
    message.reasoning_content !== null &&
    typeof message.reasoning_content !== 'string'
  ) {
    throw new DeepSeekError('DeepSeek reasoning_content is invalid');
  }
  const toolCalls = parseToolCalls(message?.tool_calls);
  if ((choice.finish_reason === 'tool_calls') !== Boolean(toolCalls?.length)) {
    throw new DeepSeekError('DeepSeek finish_reason does not match the tool call payload');
  }
  const output =
    typeof message.content === 'string'
      ? parseOutput(message.content, input.outputSchema !== undefined)
      : undefined;
  const usage = parseUsage(response.usage);
  const providerState = toolCalls?.length
    ? appendDeepSeekProviderState(
        readDeepSeekProviderState(input.providerState, modelId),
        modelId,
        toolCalls.map(({ id }) => id),
        typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined,
      )
    : undefined;

  if (output === undefined && !toolCalls?.length) {
    throw new DeepSeekError('DeepSeek response returned no output');
  }

  return {
    ...(output === undefined ? {} : { output }),
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
    ...(providerState ? { providerState } : {}),
  };
}

function parseToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const calls: ToolCall[] = [];
  const callIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || item.type !== 'function' || !isRecord(item.function)) {
      throw new DeepSeekError('DeepSeek tool call payload is invalid');
    }
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw new DeepSeekError('DeepSeek tool call returned an invalid id');
    }
    if (
      typeof item.function.name !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(item.function.name)
    ) {
      throw new DeepSeekError('DeepSeek tool call returned an invalid name');
    }
    if (callIds.has(item.id)) {
      throw new DeepSeekError(`DeepSeek tool call id "${item.id}" is duplicated`);
    }
    callIds.add(item.id);
    if (typeof item.function.arguments !== 'string') {
      throw new DeepSeekError(
        `DeepSeek tool call "${item.function.name}" returned invalid arguments`,
      );
    }

    let parsedArguments: JsonValue;
    try {
      parsedArguments = JSON.parse(item.function.arguments) as JsonValue;
    } catch (error) {
      throw new DeepSeekError(
        `DeepSeek tool call "${item.function.name}" returned invalid JSON arguments`,
        { cause: error },
      );
    }
    if (!isRecord(parsedArguments)) {
      throw new DeepSeekError(
        `DeepSeek tool call "${item.function.name}" arguments must be a JSON object`,
      );
    }

    calls.push({
      id: item.id,
      name: item.function.name,
      input: parsedArguments,
    });
  }

  return calls.length ? calls : undefined;
}

function parseOutput(value: string, structured: boolean): JsonValue {
  if (!structured) return value;
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new DeepSeekError('DeepSeek structured output was not valid JSON', {
      cause: error,
    });
  }
}

function assertFinishReason(value: unknown): void {
  if (value === 'stop' || value === 'tool_calls') return;
  if (typeof value === 'string') {
    throw new DeepSeekError(`DeepSeek response stopped with finish_reason "${value}"`);
  }
  throw new DeepSeekError('DeepSeek response returned an invalid finish_reason');
}

function parseUsage(usage: DeepSeekResponse['usage']): ModelUsage | undefined {
  if (!usage) return undefined;

  return {
    ...(typeof usage.prompt_tokens === 'number' ? { inputTokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === 'number'
      ? { outputTokens: usage.completion_tokens }
      : {}),
    ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
