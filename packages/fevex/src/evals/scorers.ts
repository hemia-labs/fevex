import type { JsonValue } from '../core';
import type { ToolRisk } from '../tools';
import type {
  EvalScorer,
  EvalTrajectoryEntry,
  EvalTrajectoryExpectation,
} from './types';
import { serializeCanonical } from './canonical-json';

export function exactOutputScorer(id = 'output.exact'): EvalScorer {
  return {
    id,
    score({ testCase, output }) {
      if (testCase.expected?.output === undefined) {
        return { skipped: true, reason: 'No expected output' };
      }
      const passed = serializeCanonical(output) === serializeCanonical(testCase.expected.output);
      return { passed, score: passed ? 1 : 0 };
    },
  };
}

export function toolSelectionScorer(
  options: { id?: string; ordered?: boolean } = {},
): EvalScorer {
  return {
    id: options.id ?? 'tools.selected',
    score({ testCase, tools }) {
      const expected = testCase.expected?.tools;
      if (!expected) return { skipped: true, reason: 'No expected tools' };
      const passed = options.ordered === false
        ? [...tools].sort().join('\0') === [...expected].sort().join('\0')
        : tools.join('\0') === expected.join('\0');
      return { passed, score: passed ? 1 : 0 };
    },
  };
}

export function forbiddenToolsScorer(
  tools: readonly string[],
  id = 'tools.forbidden',
): EvalScorer {
  const forbidden = new Set(tools);
  return {
    id,
    score(context) {
      const selected = context.tools.filter((tool) => forbidden.has(tool));
      return {
        passed: selected.length === 0,
        score: selected.length ? 0 : 1,
        ...(selected.length ? { details: { selected } } : {}),
      };
    },
  };
}

export function maxLatencyScorer(maxMs: number, id = 'latency.max'): EvalScorer {
  if (!Number.isFinite(maxMs) || maxMs < 0) throw new TypeError('maxMs must be non-negative');
  return {
    id,
    score({ latencyMs }) {
      return {
        passed: latencyMs <= maxMs,
        score: latencyMs <= maxMs ? 1 : 0,
        details: { actualMs: latencyMs, maxMs },
      };
    },
  };
}

export function maxTokensScorer(
  limits: { input?: number; output?: number; total?: number },
  id = 'tokens.max',
): EvalScorer {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} token limit is invalid`);
  }
  return {
    id,
    score({ usage }) {
      if (!usage) return { passed: false, score: 0, details: 'Model usage is unavailable' };
      const passed =
        (limits.input === undefined || (usage.inputTokens ?? Infinity) <= limits.input) &&
        (limits.output === undefined || (usage.outputTokens ?? Infinity) <= limits.output) &&
        (limits.total === undefined || (usage.totalTokens ?? Infinity) <= limits.total);
      return {
        passed,
        score: passed ? 1 : 0,
        details: {
          usage: {
            ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
            ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
            ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
          },
          limits: {
            ...(limits.input === undefined ? {} : { input: limits.input }),
            ...(limits.output === undefined ? {} : { output: limits.output }),
            ...(limits.total === undefined ? {} : { total: limits.total }),
          },
        },
      };
    },
  };
}

export function maxCostScorer(
  maxAmount: number,
  currency: string,
  id = 'cost.max',
): EvalScorer {
  if (!Number.isFinite(maxAmount) || maxAmount < 0) {
    throw new TypeError('maxAmount must be non-negative');
  }
  if (!currency.trim()) throw new TypeError('currency must be non-empty');
  return {
    id,
    score({ cost }) {
      if (!cost) return { passed: false, score: 0, details: 'Cost is unavailable' };
      const passed = cost.currency === currency && cost.amount <= maxAmount;
      return {
        passed,
        score: passed ? 1 : 0,
        details: {
          actual: { amount: cost.amount, currency: cost.currency },
          maximum: { amount: maxAmount, currency },
        },
      };
    },
  };
}

function matchesExpectation(
  actual: EvalTrajectoryEntry,
  expected: EvalTrajectoryExpectation,
): boolean {
  if (actual.type !== expected.type) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'type' || value === undefined) continue;
    if ((actual as unknown as Record<string, unknown>)[key] !== value) return false;
  }
  return true;
}

export interface TrajectoryScorerOptions {
  id?: string;
  /** Defaults to true. Set false to assert the same steps in any order. */
  ordered?: boolean;
  /** Defaults to false. Set true to allow unasserted steps. */
  allowAdditional?: boolean;
}

function scoreTrajectory(
  trajectory: readonly EvalTrajectoryEntry[],
  expected: readonly EvalTrajectoryExpectation[],
  options: TrajectoryScorerOptions,
): { passed: boolean; score: number; details: JsonValue } {
  const ordered = options.ordered ?? true;
  const allowAdditional = options.allowAdditional ?? false;
  const types = new Set(expected.map(({ type }) => type));
  const selected = trajectory.filter(({ type }) => types.has(type));
  let passed: boolean;
  if (ordered && !allowAdditional) {
    passed =
      expected.every((step, index) => {
        const actual = selected[index];
        return actual !== undefined && matchesExpectation(actual, step);
      }) && selected.length === expected.length;
  } else if (ordered) {
    let cursor = 0;
    passed = expected.every((step) => {
      while (cursor < selected.length && !matchesExpectation(selected[cursor]!, step)) {
        cursor += 1;
      }
      if (cursor >= selected.length) return false;
      cursor += 1;
      return true;
    });
  } else {
    const remaining = [...selected];
    passed = expected.every((step) => {
      const index = remaining.findIndex((actual) => matchesExpectation(actual, step));
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    }) && (allowAdditional || remaining.length === 0);
  }
  return {
    passed,
    score: passed ? 1 : 0,
    details: {
      expected: expected as unknown as JsonValue,
      actual: selected as unknown as JsonValue,
    },
  };
}

/** Asserts the ordered tool, approval and non-allow policy decisions of a run. */
export function trajectoryScorer(
  expected: readonly EvalTrajectoryExpectation[],
  options: TrajectoryScorerOptions = {},
): EvalScorer {
  return {
    id: options.id ?? 'trajectory',
    score: ({ trajectory }) => scoreTrajectory(trajectory, expected, options),
  };
}

/** Reads the expected trajectory from each dataset case. */
export function trajectoryExpectationScorer(
  options: TrajectoryScorerOptions = {},
): EvalScorer {
  return {
    id: options.id ?? 'trajectory',
    score({ testCase, trajectory }) {
      const expected = testCase.expected?.trajectory;
      if (!expected) return { skipped: true, reason: 'No expected trajectory' };
      return scoreTrajectory(trajectory, expected, options);
    },
  };
}

type ApprovalExpectation = Extract<EvalTrajectoryExpectation, { type: 'approval' }>;
type ElicitationExpectation = Extract<EvalTrajectoryExpectation, { type: 'elicitation' }>;
type PolicyExpectation = Extract<EvalTrajectoryExpectation, { type: 'policy' }>;

export function approvalScorer(
  expected: readonly ApprovalExpectation[],
  options: TrajectoryScorerOptions = {},
): EvalScorer {
  return trajectoryScorer(expected, { ...options, id: options.id ?? 'approvals' });
}

export function elicitationScorer(
  expected: readonly ElicitationExpectation[],
  options: TrajectoryScorerOptions = {},
): EvalScorer {
  return trajectoryScorer(expected, { ...options, id: options.id ?? 'elicitations' });
}

export function policyScorer(
  expected: readonly PolicyExpectation[],
  options: TrajectoryScorerOptions = {},
): EvalScorer {
  return trajectoryScorer(expected, { ...options, id: options.id ?? 'policies' });
}

const TOOL_RISKS: readonly ToolRisk[] = ['read', 'write', 'sensitive', 'destructive'];

export interface RiskGuardrailScorerOptions {
  /** Risks that must never execute. Defaults to `destructive`. */
  deny?: readonly ToolRisk[];
  /** Risks that must have an approved approval before execution. Defaults to `sensitive`. */
  requireApproval?: readonly ToolRisk[];
  /** Expected handling of tools that omit `risk`. Defaults to `allow`. */
  undeclaredRisk?: 'allow' | 'require_approval' | 'deny';
}

/** Asserts that risky tools respected the configured guardrail. */
export function riskGuardrailScorer(
  options: RiskGuardrailScorerOptions = {},
  id = 'guardrails.risk',
): EvalScorer {
  const deny = new Set<ToolRisk>(options.deny ?? ['destructive']);
  const requireApproval = new Set<ToolRisk>(options.requireApproval ?? ['sensitive']);
  const undeclaredRisk = options.undeclaredRisk ?? 'allow';
  if (!['allow', 'require_approval', 'deny'].includes(undeclaredRisk)) {
    throw new TypeError('undeclaredRisk must be allow, require_approval or deny');
  }
  for (const risk of [...deny, ...requireApproval]) {
    if (!TOOL_RISKS.includes(risk)) throw new TypeError(`Invalid tool risk: ${risk}`);
  }
  return {
    id,
    score({ trajectory }) {
      const violations: Array<Record<string, string>> = [];
      const approvals = new Map(
        trajectory
          .filter((step): step is Extract<EvalTrajectoryEntry, { type: 'approval' }> =>
            step.type === 'approval')
          .map((step) => [step.toolCallId, step]),
      );
      for (const step of trajectory) {
        if (step.type !== 'tool') continue;
        const approval = approvals.get(step.toolCallId);
        if (step.declaredRisk === undefined) {
          if (undeclaredRisk === 'deny') {
            violations.push({ tool: step.name, reason: 'undeclared_risk_executed' });
            continue;
          }
          if (undeclaredRisk === 'require_approval' && approval?.decision !== 'approve') {
            violations.push({ tool: step.name, reason: 'undeclared_risk_missing_approval' });
            continue;
          }
        }
        if (deny.has(step.risk)) {
          violations.push({ tool: step.name, reason: 'denied_risk_executed' });
          continue;
        }
        if (requireApproval.has(step.risk) && approval?.decision !== 'approve') {
          violations.push({ tool: step.name, reason: 'missing_approval' });
        }
        if (approval?.decision === 'reject') {
          violations.push({ tool: step.name, reason: 'rejected_tool_executed' });
        }
      }
      return {
        passed: violations.length === 0,
        score: violations.length === 0 ? 1 : 0,
        details: { violations },
      };
    },
  };
}
