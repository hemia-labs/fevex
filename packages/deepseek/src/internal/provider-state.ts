import { DeepSeekError } from '../deepseek-error';
import type { JsonValue } from '@fevex/core';

const stateBrand = Symbol('deepseek-provider-state');

interface DeepSeekTurnState {
  toolCallIds: string[];
  reasoningContent?: string;
}

export interface DeepSeekProviderState {
  readonly [stateBrand]: true;
  readonly modelId: string;
  readonly turns: DeepSeekTurnState[];
}

export function readDeepSeekProviderState(
  value: unknown,
  modelId: string,
): DeepSeekProviderState | undefined {
  if (value === undefined) return undefined;
  if (!isDeepSeekProviderState(value) || value.modelId !== modelId) {
    throw new DeepSeekError('DeepSeek providerState is invalid for this model');
  }
  return value;
}

export function appendDeepSeekProviderState(
  previous: DeepSeekProviderState | undefined,
  modelId: string,
  toolCallIds: string[],
  reasoningContent: string | undefined,
): DeepSeekProviderState {
  return {
    [stateBrand]: true,
    modelId,
    turns: [
      ...(previous?.turns ?? []),
      {
        toolCallIds: [...toolCallIds],
        ...(reasoningContent === undefined ? {} : { reasoningContent }),
      },
    ],
  };
}

export function serializeDeepSeekProviderState(
  value: unknown,
  modelId: string,
): JsonValue {
  const state = readDeepSeekProviderState(value, modelId);
  if (!state) throw new DeepSeekError('DeepSeek providerState is required');
  return JSON.parse(JSON.stringify({
    modelId: state.modelId,
    turns: state.turns,
  })) as JsonValue;
}

export function restoreDeepSeekProviderState(
  value: JsonValue,
  modelId: string,
): DeepSeekProviderState {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || value.modelId !== modelId
    || !Array.isArray(value.turns)
  ) {
    throw new DeepSeekError('DeepSeek serialized providerState is invalid for this model');
  }
  const turns = value.turns.map((turn) => {
    if (
      typeof turn !== 'object'
      || turn === null
      || Array.isArray(turn)
      || !Array.isArray(turn.toolCallIds)
      || !turn.toolCallIds.every((id) => typeof id === 'string' && id.length > 0)
      || (
        turn.reasoningContent !== undefined
        && typeof turn.reasoningContent !== 'string'
      )
    ) {
      throw new DeepSeekError('DeepSeek serialized providerState is invalid for this model');
    }
    return {
      toolCallIds: [...turn.toolCallIds] as string[],
      ...(turn.reasoningContent === undefined
        ? {}
        : { reasoningContent: turn.reasoningContent }),
    };
  });
  return { [stateBrand]: true, modelId, turns };
}

function isDeepSeekProviderState(value: unknown): value is DeepSeekProviderState {
  if (typeof value !== 'object' || value === null) return false;
  if (
    (value as Partial<DeepSeekProviderState>)[stateBrand] !== true
    || typeof (value as Partial<DeepSeekProviderState>).modelId !== 'string'
    || !Array.isArray((value as Partial<DeepSeekProviderState>).turns)
  ) return false;

  return (value as DeepSeekProviderState).turns.every((turn) =>
    typeof turn === 'object'
    && turn !== null
    && Array.isArray(turn.toolCallIds)
    && turn.toolCallIds.every((id) => typeof id === 'string' && id.length > 0)
    && (
      turn.reasoningContent === undefined
      || typeof turn.reasoningContent === 'string'
    )
  );
}
