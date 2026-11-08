import type { JsonValue } from '@fevex/core';
import { AnthropicError } from '../anthropic-error';
import type { AnthropicFinalBlock } from './response';

const stateBrand = Symbol('anthropic-provider-state');

interface AnthropicTurnState {
  toolCallIds: string[];
  content: AnthropicFinalBlock[];
}

export interface AnthropicProviderState {
  readonly [stateBrand]: true;
  readonly modelId: string;
  readonly turns: AnthropicTurnState[];
}

export function readAnthropicProviderState(
  value: unknown,
  modelId: string,
): AnthropicProviderState | undefined {
  if (value === undefined) return undefined;
  if (!isAnthropicProviderState(value) || value.modelId !== modelId) {
    throw new AnthropicError('Anthropic providerState is invalid for this model');
  }
  return value;
}

export function appendAnthropicProviderState(
  previous: AnthropicProviderState | undefined,
  modelId: string,
  toolCallIds: string[],
  content: AnthropicFinalBlock[],
): AnthropicProviderState {
  return {
    [stateBrand]: true,
    modelId,
    turns: [
      ...(previous?.turns ?? []),
      {
        toolCallIds: [...toolCallIds],
        content: structuredClone(content),
      },
    ],
  };
}

export function serializeAnthropicProviderState(
  value: unknown,
  modelId: string,
): JsonValue {
  const state = readAnthropicProviderState(value, modelId);
  if (!state) throw new AnthropicError('Anthropic providerState is required');
  return JSON.parse(JSON.stringify({
    modelId: state.modelId,
    turns: state.turns,
  })) as JsonValue;
}

export function restoreAnthropicProviderState(
  value: JsonValue,
  modelId: string,
): AnthropicProviderState {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || value.modelId !== modelId
    || !Array.isArray(value.turns)
  ) {
    throw new AnthropicError('Anthropic serialized providerState is invalid for this model');
  }
  const turns = value.turns.map((turn) => {
    if (
      typeof turn !== 'object'
      || turn === null
      || Array.isArray(turn)
      || !Array.isArray(turn.toolCallIds)
      || !turn.toolCallIds.every((id) => typeof id === 'string' && id.length > 0)
      || !Array.isArray(turn.content)
      || !turn.content.every(isContentBlock)
    ) {
      throw new AnthropicError('Anthropic serialized providerState is invalid for this model');
    }
    return {
      toolCallIds: [...turn.toolCallIds] as string[],
      content: structuredClone(turn.content) as AnthropicFinalBlock[],
    };
  });
  return { [stateBrand]: true, modelId, turns };
}

function isAnthropicProviderState(value: unknown): value is AnthropicProviderState {
  if (typeof value !== 'object' || value === null) return false;
  if (
    (value as Partial<AnthropicProviderState>)[stateBrand] !== true
    || typeof (value as Partial<AnthropicProviderState>).modelId !== 'string'
    || !Array.isArray((value as Partial<AnthropicProviderState>).turns)
  ) return false;

  return (value as AnthropicProviderState).turns.every((turn) =>
    typeof turn === 'object'
    && turn !== null
    && Array.isArray(turn.toolCallIds)
    && turn.toolCallIds.every((id) => typeof id === 'string' && id.length > 0)
    && Array.isArray(turn.content)
    && turn.content.every(isContentBlock)
  );
}

function isContentBlock(value: unknown): value is AnthropicFinalBlock {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === 'string';
}
