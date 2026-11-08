import type {
  JsonObject,
  JsonValue,
  ModelInput,
  ModelResult,
  ModelUsage,
  ToolCall,
} from '@fevex/core';
import { AnthropicError } from '../anthropic-error';
import { appendAnthropicProviderState, readAnthropicProviderState } from './provider-state';

export type AnthropicFinalBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonObject };

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function parseAnthropicResult(
  blocks: AnthropicFinalBlock[],
  stopReason: unknown,
  usage: AnthropicUsage | undefined,
  input: ModelInput,
  modelId: string,
): ModelResult {
  const toolCalls = parseToolCalls(blocks);
  const textBlocks = blocks.filter(
    (block): block is Extract<AnthropicFinalBlock, { type: 'text' }> => block.type === 'text',
  );
  const text = textBlocks.length ? textBlocks.map(({ text: value }) => value).join('') : undefined;
  assertStopReason(stopReason, Boolean(toolCalls?.length), text);

  // Tool-call text is intermediate content; the schema applies to the final reply.
  const output = text === undefined
    ? undefined
    : toolCalls?.length && input.outputSchema !== undefined
      ? text || undefined
      : parseOutput(text, input.outputSchema !== undefined);
  const providerState = toolCalls?.length
    ? appendAnthropicProviderState(
        readAnthropicProviderState(input.providerState, modelId),
        modelId,
        toolCalls.map(({ id }) => id),
        blocks,
      )
    : undefined;

  if (output === undefined && !toolCalls?.length) {
    throw new AnthropicError('Anthropic response returned no output');
  }

  const parsedUsage = parseUsage(usage);
  return {
    ...(output === undefined ? {} : { output }),
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(parsedUsage ? { usage: parsedUsage } : {}),
    ...(providerState ? { providerState } : {}),
  };
}

function parseToolCalls(blocks: AnthropicFinalBlock[]): ToolCall[] | undefined {
  const calls: ToolCall[] = [];
  const callIds = new Set<string>();

  for (const block of blocks) {
    if (block.type !== 'tool_use') continue;
    if (callIds.has(block.id)) {
      throw new AnthropicError(`Anthropic tool call id "${block.id}" is duplicated`);
    }
    callIds.add(block.id);
    calls.push({ id: block.id, name: block.name, input: block.input });
  }

  return calls.length ? calls : undefined;
}

function parseOutput(value: string, structured: boolean): JsonValue {
  if (!structured) return value;
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new AnthropicError('Anthropic structured output was not valid JSON', { cause: error });
  }
}

function assertStopReason(value: unknown, hasToolCalls: boolean, text: string | undefined): void {
  if (value === 'tool_use') {
    if (!hasToolCalls) {
      throw new AnthropicError('Anthropic stop_reason does not match the tool call payload');
    }
    return;
  }
  if (hasToolCalls) {
    throw new AnthropicError('Anthropic stop_reason does not match the tool call payload');
  }
  if (value === 'end_turn' || value === 'stop_sequence') return;
  if (value === 'refusal') {
    throw new AnthropicError(`Anthropic refused the response${text ? `: ${text}` : ''}`);
  }
  if (typeof value === 'string') {
    throw new AnthropicError(`Anthropic response stopped with stop_reason "${value}"`);
  }
  throw new AnthropicError('Anthropic response returned an invalid stop_reason');
}

function parseUsage(usage: AnthropicUsage | undefined): ModelUsage | undefined {
  if (!usage) return undefined;

  const inputParts = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].filter((value): value is number => typeof value === 'number');
  const inputTokens = inputParts.length
    ? inputParts.reduce((total, value) => total + value, 0)
    : undefined;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;

  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}
