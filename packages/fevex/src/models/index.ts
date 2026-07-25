import type { AgentMessage, JsonObject, ToolCall, ToolSpec } from '../core';

export type ReasoningEffort =
  | 'provider-default'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high';

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelGenerateInput {
  messages: AgentMessage[];
  tools?: ToolSpec[];
  reasoning?: ReasoningEffort;
  modelOptions?: Record<string, unknown>;
  outputSchema?: JsonObject;
  signal?: AbortSignal;
}

export interface ModelGenerateResult<TOutput = unknown> {
  output?: TOutput;
  toolCalls?: ToolCall[];
  usage?: ModelUsage;
}

export interface ModelGateway {
  generate(input: ModelGenerateInput): Promise<ModelGenerateResult>;
}

export type ModelRef = string | ModelGateway;
