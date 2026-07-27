import type { JsonValue, ModelInput, ModelResult, ModelUsage, ToolCall } from '@fevex/core';
import { OpenAIError } from '../openai-error';
import { appendOpenAIProviderState, readOpenAIProviderState } from './provider-state';

export interface OpenAIResponse {
  status: unknown;
  error?: unknown;
  incomplete_details?: unknown;
  output?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
  };
}

export function parseOpenAIResponse(
  response: OpenAIResponse,
  input: ModelInput,
  modelId: string,
): ModelResult {
  assertCompletedResponse(response);
  if (!Array.isArray(response.output)) {
    throw new OpenAIError('OpenAI response returned an invalid output array');
  }
  const providerOutput = response.output;
  const toolCalls = parseToolCalls(providerOutput);
  const output = parseOutput(providerOutput, input.outputSchema !== undefined);
  const usage = parseUsage(response.usage);
  const providerState = toolCalls?.length
    ? appendOpenAIProviderState(
        readOpenAIProviderState(input.providerState, modelId),
        modelId,
        providerOutput,
        toolCalls.map(({ id }) => id),
      )
    : undefined;

  if (output === undefined && !toolCalls?.length) {
    throw new OpenAIError('OpenAI response returned no output');
  }

  return {
    ...(output === undefined ? {} : { output }),
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
    ...(providerState ? { providerState } : {}),
  };
}

function parseToolCalls(output: unknown): ToolCall[] | undefined {
  if (!Array.isArray(output)) return undefined;

  const calls: ToolCall[] = [];
  const callIds = new Set<string>();
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'function_call') continue;

    if (typeof item.call_id !== 'string' || !item.call_id.trim()) {
      throw new OpenAIError('OpenAI tool call returned an invalid call_id');
    }
    if (typeof item.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.name)) {
      throw new OpenAIError('OpenAI tool call returned an invalid name');
    }
    if (callIds.has(item.call_id)) {
      throw new OpenAIError(`OpenAI tool call id "${item.call_id}" is duplicated`);
    }
    callIds.add(item.call_id);
    if (typeof item.arguments !== 'string') {
      throw new OpenAIError(`OpenAI tool call "${item.name}" returned invalid arguments`);
    }

    let parsedArguments: JsonValue;
    try {
      parsedArguments = JSON.parse(item.arguments) as JsonValue;
    } catch (error) {
      throw new OpenAIError(`OpenAI tool call "${item.name}" returned invalid JSON arguments`, {
        cause: error,
      });
    }
    if (!isRecord(parsedArguments)) {
      throw new OpenAIError(`OpenAI tool call "${item.name}" arguments must be a JSON object`);
    }

    calls.push({ id: item.call_id, name: item.name, input: parsedArguments });
  }

  return calls.length ? calls : undefined;
}

function parseOutput(providerOutput: unknown[], structured: boolean): JsonValue | undefined {
  const texts: string[] = [];
  for (const item of providerOutput) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (!isRecord(content)) continue;
      if (content.type === 'refusal' && typeof content.refusal === 'string') {
        throw new OpenAIError(`OpenAI refused the response: ${content.refusal}`);
      }
      if (content.type === 'output_text' && typeof content.text === 'string') {
        texts.push(content.text);
      }
    }
  }

  const text = texts.length ? texts.join('') : undefined;
  if (text === undefined) return undefined;
  if (!structured) return text;

  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new OpenAIError('OpenAI structured output was not valid JSON', {
      cause: error,
    });
  }
}

function assertCompletedResponse(response: OpenAIResponse): void {
  if (response.status === 'completed') return;
  if (typeof response.status !== 'string') {
    throw new OpenAIError('OpenAI response returned an invalid status');
  }

  let detail: string | undefined;
  if (isRecord(response.error) && typeof response.error.message === 'string') {
    detail = response.error.message;
  } else if (
    isRecord(response.incomplete_details) &&
    typeof response.incomplete_details.reason === 'string'
  ) {
    detail = response.incomplete_details.reason;
  }

  throw new OpenAIError(`OpenAI response was ${response.status}${detail ? `: ${detail}` : ''}`);
}

function parseUsage(usage: OpenAIResponse['usage']): ModelUsage | undefined {
  if (!usage) return undefined;

  return {
    ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
