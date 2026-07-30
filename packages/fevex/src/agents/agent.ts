import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ExactDefinition } from '../internal/exact-definition';
import type { ModelRef, ReasoningEffort } from '../models';

/** Resource limits enforced by the runtime for a single agent run. */
export interface AgentLimits {
  maxSteps?: number;
  maxToolCalls?: number;
  maxInputTokens?: number | false;
  maxOutputTokens?: number | false;
}

export interface AgentDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  instructions: string;
  model?: ModelRef;
  tools?: string[];
  context?: string[];
  memory?: { read?: boolean; write?: boolean; limit?: number };
  skills?: string[];
  reasoning?: ReasoningEffort;
  modelOptions?: Record<string, unknown>;
  inputSchema?: StandardSchemaV1<unknown, TInput>;
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  limits?: AgentLimits;
}

export function defineAgent<T extends AgentDefinition>(
  agent: ExactDefinition<T, AgentDefinition>,
): T {
  return agent;
}
