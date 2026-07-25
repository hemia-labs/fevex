import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ExactDefinition } from '../internal/exact-definition';
import type { ModelRef, ReasoningEffort } from '../models';

export interface AgentLimits {
  maxSteps?: number;
  maxToolCalls?: number;
  maxInputTokens?: number | false;
  maxOutputTokens?: number | false;
}

export interface AgentDefinition<TOutput = unknown> {
  name: string;
  instructions: string;
  model?: ModelRef;
  tools?: string[];
  reasoning?: ReasoningEffort;
  modelOptions?: Record<string, unknown>;
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  limits?: AgentLimits;
}

export function defineAgent<T extends AgentDefinition>(
  agent: ExactDefinition<T, AgentDefinition>,
): T {
  return agent;
}
