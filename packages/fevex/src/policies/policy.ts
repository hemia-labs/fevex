import type { ExecutionContext, JsonValue, RunId } from '../core';
import type { ToolRisk } from '../tools';

/** Authorization outcome returned by a policy. */
export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

export interface PolicyAuthorization {
  runId: RunId;
  agentName: string;
  toolName: string;
  /** Effective risk; tools without an explicit risk default to `read`. */
  risk: ToolRisk;
  /** Risk declared by the tool definition. Absent when the tool omitted it. */
  declaredRisk?: ToolRisk;
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

const TOOL_RISKS: readonly ToolRisk[] = ['read', 'write', 'sensitive', 'destructive'];

/** Static risk guardrail for hosts that do not need custom authorization logic. */
export interface RiskGuardrailOptions {
  /** Policy name reported in `policy.evaluated`. Defaults to `risk`. */
  name?: string;
  /** Risks that are always denied. Defaults to `destructive`. */
  deny?: readonly ToolRisk[];
  /** Risks that require explicit human approval. Defaults to `sensitive`. */
  requireApproval?: readonly ToolRisk[];
  /**
   * Decision for tools that omit `risk`. Defaults to `allow`, preserving the
   * effective `read` behavior. Use `require_approval` or `deny` to fail closed.
   */
  undeclaredRisk?: 'allow' | 'require_approval' | 'deny';
}

function riskSet(values: readonly ToolRisk[] | undefined, fallback: readonly ToolRisk[], name: string): Set<ToolRisk> {
  const selected = values ?? fallback;
  for (const risk of selected) {
    if (!TOOL_RISKS.includes(risk)) throw new TypeError(`${name} contains an invalid tool risk: ${risk}`);
  }
  return new Set(selected);
}

/**
 * Denies destructive tools and requires approval for sensitive tools by
 * default. Pass explicit lists to change the thresholds.
 */
export function riskGuardrail(options: RiskGuardrailOptions = {}): PolicyDefinition {
  if (options.name !== undefined && !options.name.trim()) {
    throw new TypeError('Risk guardrail name must be non-empty');
  }
  const undeclaredRisk = options.undeclaredRisk ?? 'allow';
  if (!['allow', 'require_approval', 'deny'].includes(undeclaredRisk)) {
    throw new TypeError('Risk guardrail undeclaredRisk must be allow, require_approval or deny');
  }
  const deny = riskSet(options.deny, ['destructive'], 'deny');
  const requireApproval = riskSet(options.requireApproval, ['sensitive'], 'requireApproval');
  return definePolicy({
    name: options.name ?? 'risk',
    authorize({ risk, declaredRisk }) {
      if (declaredRisk === undefined) {
        if (undeclaredRisk === 'deny') return 'deny';
        if (undeclaredRisk === 'require_approval') return 'require_approval';
      }
      if (deny.has(risk)) return 'deny';
      if (requireApproval.has(risk)) return 'require_approval';
      return 'allow';
    },
  });
}
