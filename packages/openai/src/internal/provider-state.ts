import { OpenAIError } from '../openai-error';
import type { JsonValue } from '@fevex/core';

const stateBrand = Symbol('openai-provider-state');

interface OpenAITurnState {
  toolCallIds: string[];
  output: unknown[];
}

export interface OpenAIProviderState {
  readonly [stateBrand]: true;
  readonly modelId: string;
  readonly turns: OpenAITurnState[];
}

export function readOpenAIProviderState(
  value: unknown,
  modelId: string,
): OpenAIProviderState | undefined {
  if (value === undefined) return undefined;
  if (!isOpenAIProviderState(value) || value.modelId !== modelId) {
    throw new OpenAIError('OpenAI providerState is invalid for this model');
  }
  return value;
}

export function appendOpenAIProviderState(
  previous: OpenAIProviderState | undefined,
  modelId: string,
  output: unknown[],
  toolCallIds: string[],
): OpenAIProviderState {
  return {
    [stateBrand]: true,
    modelId,
    turns: [
      ...(previous?.turns ?? []),
      { toolCallIds: [...toolCallIds], output: [...output] },
    ],
  };
}

export function serializeOpenAIProviderState(
  value: unknown,
  modelId: string,
): JsonValue {
  const state = readOpenAIProviderState(value, modelId);
  if (!state) throw new OpenAIError('OpenAI providerState is required');
  return JSON.parse(JSON.stringify({
    modelId: state.modelId,
    turns: state.turns,
  })) as JsonValue;
}

export function restoreOpenAIProviderState(
  value: JsonValue,
  modelId: string,
): OpenAIProviderState {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || value.modelId !== modelId
    || !Array.isArray(value.turns)
  ) {
    throw new OpenAIError('OpenAI serialized providerState is invalid for this model');
  }
  const turns = value.turns.map((turn) => {
    if (
      typeof turn !== 'object'
      || turn === null
      || Array.isArray(turn)
      || !Array.isArray(turn.toolCallIds)
      || !turn.toolCallIds.every((id) => typeof id === 'string' && id.length > 0)
      || !Array.isArray(turn.output)
    ) {
      throw new OpenAIError('OpenAI serialized providerState is invalid for this model');
    }
    return {
      toolCallIds: [...turn.toolCallIds] as string[],
      output: structuredClone(turn.output),
    };
  });
  return { [stateBrand]: true, modelId, turns };
}

function isOpenAIProviderState(value: unknown): value is OpenAIProviderState {
  if (typeof value !== 'object' || value === null) return false;
  if (
    (value as Partial<OpenAIProviderState>)[stateBrand] !== true
    || typeof (value as Partial<OpenAIProviderState>).modelId !== 'string'
    || !Array.isArray((value as Partial<OpenAIProviderState>).turns)
  ) return false;

  return (value as OpenAIProviderState).turns.every((turn) =>
    typeof turn === 'object'
    && turn !== null
    && Array.isArray(turn.toolCallIds)
    && turn.toolCallIds.every((id) => typeof id === 'string' && id.length > 0)
    && Array.isArray(turn.output)
  );
}
