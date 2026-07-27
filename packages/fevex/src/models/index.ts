import type { AgentMessage, JsonObject, JsonValue, ToolCall, ToolSpec } from '../core';

export type ReasoningEffort = 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelInput {
  messages: AgentMessage[];
  tools?: ToolSpec[];
  reasoning?: ReasoningEffort;
  modelOptions?: Record<string, unknown>;
  outputSchema?: JsonObject;
  maxOutputTokens?: number;
  providerState?: unknown;
  signal?: AbortSignal;
}

export interface ModelResult<TOutput = unknown> {
  output?: TOutput;
  toolCalls?: ToolCall[];
  usage?: ModelUsage;
  providerState?: unknown;
}

export interface ModelMetadata {
  provider?: string;
  model?: string;
}

export interface ModelGateway {
  stream(input: ModelInput): AsyncIterable<ModelStreamEvent>;
  metadata?: ModelMetadata;
  stateCodec?: {
    serialize(state: unknown): JsonValue;
    restore(state: JsonValue): unknown;
  };
}

export type ModelStreamEvent<TOutput = unknown> =
  { type: 'output.delta'; delta: string } | { type: 'completed'; result: ModelResult<TOutput> };

export type ModelRef = string | ModelGateway;
