import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ExactDefinition } from '../internal/exact-definition';
import type { ModelRef, ReasoningEffort, ToolChoice } from '../models';
import type { ApprovalMode, ElicitationMode } from '../runtime';

/** Resource limits enforced by the runtime for a single agent run. */
export interface AgentLimits {
  maxSteps?: number;
  maxToolCalls?: number;
  maxInputTokens?: number | false;
  maxOutputTokens?: number | false;
}

/**
 * Per-request model context budget. It is separate from
 * {@link AgentLimits.maxInputTokens}, which caps cumulative spend for a run.
 */
export interface ContextBudget {
  /** Model context window in tokens. */
  contextWindow: number;
  /** Tokens reserved for the next model output. Defaults to 0. */
  reserveOutputTokens?: number;
  /** Fraction of the usable window that triggers compaction. Defaults to 0.8. */
  compactAt?: number;
  /** Target tokens after compaction. Defaults below the compaction threshold. */
  targetTokens?: number;
  /** Multiplier applied to estimates to leave headroom. Defaults to 1.1. */
  safetyFactor?: number;
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
  toolChoice?: ToolChoice;
  elicitation?: ElicitationMode;
  approvalMode?: ApprovalMode;
  inputSchema?: StandardSchemaV1<unknown, TInput>;
  outputSchema?: StandardSchemaV1<unknown, TOutput>;
  limits?: AgentLimits;
  contextBudget?: ContextBudget;
}

export function defineAgent<T extends AgentDefinition>(
  agent: ExactDefinition<T, AgentDefinition>,
): T {
  return agent;
}
