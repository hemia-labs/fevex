import type { ExecutionContext, JsonValue, RunId } from '../core';
import type { ToolRisk } from '../tools';

export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

export interface PolicyAuthorization {
  runId: RunId;
  agentName: string;
  toolName: string;
  risk: ToolRisk;
  input: JsonValue;
  action: 'tool.execute' | 'approval.resolve';
  context?: ExecutionContext;
}

export interface PolicyDefinition {
  name: string;
  authorize(
    input: PolicyAuthorization,
  ): PolicyDecision | Promise<PolicyDecision>;
}

export function definePolicy<T extends PolicyDefinition>(policy: T): T {
  return policy;
}
