import type { AgentEvent, ExecutionContext, JsonValue } from '../core';
import type { Fevex } from '../fevex';
import type { ModelMetadata, ModelUsage } from '../models';
import type { CostCalculator, TraceCost } from '../observability';

export interface EvalExpectation {
  output?: JsonValue;
  tools?: string[];
}

export interface EvalCase<TInput = unknown> {
  id: string;
  input: TInput;
  expected?: EvalExpectation;
  context?: ExecutionContext;
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
  usage?: ModelUsage;
  cost?: TraceCost;
  latencyMs: number;
  scores: EvalScore[];
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
