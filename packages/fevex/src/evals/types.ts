import type { AgentEvent, ExecutionContext, JsonValue } from '../core';
import type { Fevex } from '../fevex';
import type { ModelMetadata, ModelUsage } from '../models';
import type { CostCalculator, TraceCost } from '../observability';
import type { PolicyDecision } from '../policies';
import type { ToolRisk } from '../tools';

export interface EvalExpectation {
  output?: JsonValue;
  tools?: string[];
  trajectory?: EvalTrajectoryExpectation[];
}

/** One decision point recorded while an evaluation case runs. */
export type EvalTrajectoryEntry =
  | {
      type: 'tool';
      step: number;
      toolCallId: string;
      name: string;
      attempt: number;
      risk: ToolRisk;
      declaredRisk?: ToolRisk;
      status: 'started' | 'completed' | 'failed' | 'unknown' | 'retrying';
    }
  | {
      type: 'approval';
      toolCallId: string;
      toolName: string;
      decision: 'approve' | 'reject';
      actorId: string;
    }
  | {
      type: 'elicitation';
      requestId: string;
      toolCallId: string;
      prompt?: string;
      actorId: string;
    }
  | {
      type: 'policy';
      policyName: string;
      toolName: string;
      toolCallId?: string;
      action: 'tool.execute' | 'approval.resolve';
      decision: Exclude<PolicyDecision, 'allow'>;
      risk: ToolRisk;
      declaredRisk?: ToolRisk;
    };

/** Expected trajectory step. Omitted fields match any value. */
export type EvalTrajectoryExpectation =
  | {
      type: 'tool';
      name: string;
      status?: 'started' | 'completed' | 'failed' | 'unknown' | 'retrying';
      attempt?: number;
      risk?: ToolRisk;
      declaredRisk?: ToolRisk;
    }
  | {
      type: 'approval';
      toolName: string;
      decision: 'approve' | 'reject';
      actorId?: string;
    }
  | {
      type: 'elicitation';
      requestId?: string;
      toolCallId?: string;
      prompt?: string;
      actorId?: string;
    }
  | {
      type: 'policy';
      toolName: string;
      decision: Exclude<PolicyDecision, 'allow'>;
      policyName?: string;
      action?: 'tool.execute' | 'approval.resolve';
      declaredRisk?: ToolRisk;
    };

/** Approval resolution supplied by an evaluation case when a run pauses. */
export interface EvalApproval {
  /** Tool name required to match the paused approval. Omit to accept any tool. */
  toolName?: string;
  decision: 'approve' | 'reject';
  actor?: { id: string; type?: string };
}

/** Elicitation value supplied by an evaluation case when a run pauses. */
export interface EvalElicitation {
  /** Prompt text required to match the paused request. Omit to accept any prompt. */
  prompt?: string;
  value: JsonValue;
  actor?: { id: string; type?: string };
}

export interface EvalCase<TInput = unknown> {
  id: string;
  input: TInput;
  expected?: EvalExpectation;
  context?: ExecutionContext;
  /** Resolutions consumed in order when the run pauses for approval. */
  approvals?: readonly EvalApproval[];
  /** Values consumed in order when the run pauses for elicitation. */
  elicitations?: readonly EvalElicitation[];
  /** Maximum wall-clock time for this case, including pauses. */
  deadlineMs?: number;
}

export interface EvalDataset<TInput = unknown> {
  name: string;
  version: string;
  cases: readonly EvalCase<TInput>[];
}

export interface EvalScorerContext<TInput = unknown> {
  testCase: EvalCase<TInput>;
  output?: JsonValue;
  tools: readonly string[];
  trajectory: readonly EvalTrajectoryEntry[];
  events: readonly AgentEvent[];
  usage?: ModelUsage;
  cost?: TraceCost;
  latencyMs: number;
  error?: string;
}

export type EvalScorerResult =
  | { passed: boolean; score: number; details?: JsonValue }
  | { skipped: true; reason?: string };

export interface EvalScorer<TInput = unknown> {
  id: string;
  score(context: EvalScorerContext<TInput>): EvalScorerResult | Promise<EvalScorerResult>;
}

export type EvalScoreStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface EvalScore {
  scorerId: string;
  status: EvalScoreStatus;
  score?: number;
  details?: JsonValue;
  error?: string;
}

export interface EvalCaseReport {
  caseId: string;
  status: 'completed' | 'failed';
  output?: JsonValue;
  tools: string[];
  trajectory?: EvalTrajectoryEntry[];
  usage?: ModelUsage;
  cost?: TraceCost;
  latencyMs: number;
  scores: EvalScore[];
  warnings?: string[];
  error?: string;
}

export interface EvalSummary {
  caseCount: number;
  completedCount: number;
  failedCount: number;
  passedScoreCount: number;
  failedScoreCount: number;
  skippedScoreCount: number;
  errorScoreCount: number;
  /** Absent on reports created before case warnings existed. */
  warningCount?: number;
  averageScore?: number;
  usage?: ModelUsage;
  cost?: TraceCost;
  latencyMs: number;
}

export interface EvalReport {
  schemaVersion: 'fevex.eval.v1';
  suiteName: string;
  targetVersion: string;
  agentName: string;
  dataset: { name: string; version: string };
  scorerIds: string[];
  cases: EvalCaseReport[];
  summary: EvalSummary;
}

export interface EvalReporter {
  report(report: Readonly<EvalReport>): void | Promise<void>;
}

export interface EvalCostOptions {
  calculate: CostCalculator;
  modelRegistryName: string;
  model?: ModelMetadata;
}

export interface RunEvaluationOptions<TInput = unknown> {
  app: Fevex;
  suiteName: string;
  targetVersion: string;
  agentName: string;
  dataset: EvalDataset<TInput>;
  scorers: readonly EvalScorer<TInput>[];
  reporters?: readonly EvalReporter[];
  cost?: EvalCostOptions;
  signal?: AbortSignal;
  /** Default per-case wall-clock deadline. Defaults to 10 minutes. */
  deadlineMs?: number;
}

export interface Regression {
  kind:
    | 'case_removed'
    | 'case_failed'
    | 'scorer_removed'
    | 'score_failed'
    | 'score_dropped'
    | 'latency_increased'
    | 'cost_increased';
  caseId: string;
  scorerId?: string;
  message: string;
}

export interface RegressionReport {
  passed: boolean;
  baselineTargetVersion: string;
  currentTargetVersion: string;
  regressions: Regression[];
}

export interface RegressionOptions {
  maxScoreDrop?: number;
  maxLatencyIncreaseRatio?: number;
  maxCostIncreaseRatio?: number;
}

/** Minimum aggregate requirements for a release evaluation gate. */
export interface EvalGateThresholds {
  /** Fraction of cases that must complete. Defaults to 1. */
  minCompletionRate?: number;
  /** Fraction of non-skipped scores that must pass. Defaults to 1. */
  minPassRate?: number;
  /** Maximum failed scores across all cases. Defaults to 0. */
  maxFailedScores?: number;
  /** Maximum scorer errors across all cases. Defaults to 0. */
  maxErrorScores?: number;
  /** Maximum case warnings, such as unused resolution fixtures. Defaults to 0. */
  maxWarnings?: number;
  /** Minimum average score across numeric results. */
  minAverageScore?: number;
  /** Scorers that must be present in the report. */
  requiredScorers?: readonly string[];
  /** Maximum aggregate latency. */
  maxLatencyMs?: number;
  /** Maximum aggregate cost. Currency must match exactly. */
  maxCost?: TraceCost;
}

export interface ReleaseGateOptions extends EvalGateThresholds {
  /** Optional baseline report; trajectory or policy regressions fail the gate. */
  baseline?: EvalReport;
  regression?: RegressionOptions;
}

export interface EvalScorecard {
  caseCount: number;
  completedCount: number;
  completionRate: number;
  passedScoreCount: number;
  failedScoreCount: number;
  skippedScoreCount: number;
  errorScoreCount: number;
  warningCount: number;
  passRate: number;
  averageScore?: number;
  latencyMs: number;
  cost?: TraceCost;
}

export interface EvalGateCheck {
  name: string;
  passed: boolean;
  message: string;
  expected?: JsonValue;
  actual?: JsonValue;
}

export interface ReleaseGateResult {
  passed: boolean;
  scorecard: EvalScorecard;
  checks: EvalGateCheck[];
  regressions: Regression[];
}
