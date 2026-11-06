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
  /** Maximum serialized bytes for one tool result. Tools should use artifacts above this. */
  maxToolResultBytes?: number;
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

/** On-demand tool discovery for agents with large tool catalogs. */
export interface ToolSearchOptions {
  /** `auto` enables search above the configured thresholds. Defaults to `auto`. */
  mode?: 'auto' | 'on' | 'off';
  /** Tool-count threshold for `auto`. Defaults to 30. */
  threshold?: number;
  /** Estimated tool-token threshold for `auto`. */
  tokenThreshold?: number;
  /** Maximum tools returned by one search. Defaults to 5. */
  limit?: number;
  /** Tool names exposed without a search. */
  pinned?: string[];
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
  toolSearch?: ToolSearchOptions;
}

export function defineAgent<T extends AgentDefinition>(
  agent: ExactDefinition<T, AgentDefinition>,
): T {
  return agent;
}
