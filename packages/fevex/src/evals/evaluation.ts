import type { AgentEvent } from '../core';
import type { ModelUsage } from '../models';
import type {
  EvalCase,
  EvalCaseReport,
  EvalReport,
  EvalReporter,
  EvalScore,
  EvalScorerContext,
  EvalSummary,
  Regression,
  RegressionOptions,
  RegressionReport,
  RunEvaluationOptions,
} from './types';
import { serializeCanonical } from './canonical-json';

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be non-empty`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addUsage(target: ModelUsage, usage: ModelUsage | undefined): void {
  if (!usage) return;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (usage[key] !== undefined) target[key] = (target[key] ?? 0) + usage[key]!;
  }
}

function usageFromEvent(event: AgentEvent): ModelUsage | undefined {
  if (event.type !== 'run.completed' || !event.payload.usage) return undefined;
  const usage: ModelUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const value = event.payload.usage[key];
    if (typeof value === 'number') usage[key] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function validateOptions<TInput>(options: RunEvaluationOptions<TInput>): void {
  assertNonEmpty(options.suiteName, 'suiteName');
  assertNonEmpty(options.targetVersion, 'targetVersion');
  assertNonEmpty(options.agentName, 'agentName');
  assertNonEmpty(options.dataset.name, 'dataset.name');
  assertNonEmpty(options.dataset.version, 'dataset.version');
  if (!Array.isArray(options.dataset.cases) || !options.dataset.cases.length) {
    throw new TypeError('dataset.cases must contain at least one case');
  }
  const caseIds = new Set<string>();
  for (const testCase of options.dataset.cases) {
    assertNonEmpty(testCase.id, 'case.id');
    if (caseIds.has(testCase.id)) throw new TypeError(`Eval case "${testCase.id}" is duplicated`);
    caseIds.add(testCase.id);
  }
  if (!Array.isArray(options.scorers) || !options.scorers.length) {
    throw new TypeError('scorers must contain at least one scorer');
  }
  const scorerIds = new Set<string>();
  for (const scorer of options.scorers) {
    assertNonEmpty(scorer.id, 'scorer.id');
    if (typeof scorer.score !== 'function') {
      throw new TypeError(`Eval scorer "${scorer.id}" must implement score`);
    }
    if (scorerIds.has(scorer.id)) throw new TypeError(`Eval scorer "${scorer.id}" is duplicated`);
    scorerIds.add(scorer.id);
  }
  if (
    options.reporters !== undefined &&
    (!Array.isArray(options.reporters) ||
      options.reporters.some((reporter) => typeof reporter.report !== 'function'))
  ) {
    throw new TypeError('reporters must implement report');
  }
}

async function evaluateCase<TInput>(
  options: RunEvaluationOptions<TInput>,
  testCase: EvalCase<TInput>,
): Promise<EvalCaseReport> {
  options.signal?.throwIfAborted();
  const startedAt = performance.now();
  const events: AgentEvent[] = [];
  let executionError: string | undefined;

  try {
    for await (const event of options.app.streamAgent(options.agentName, {
      input: testCase.input,
      context: testCase.context,
      signal: options.signal,
    })) {
      events.push(event);
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    executionError = errorMessage(error);
  }

  const latencyMs = performance.now() - startedAt;
  const completed = events.find((event) => event.type === 'run.completed');
  const failed = [...events]
    .reverse()
    .find((event) => event.type === 'run.failed' || event.type === 'run.cancelled');
  const output = completed?.type === 'run.completed' ? completed.payload.output : undefined;
  const usage = completed ? usageFromEvent(completed) : undefined;
  const selectedTools: string[] = [];
  const selectedIds = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool.started' || selectedIds.has(event.payload.toolCallId)) continue;
    selectedIds.add(event.payload.toolCallId);
    selectedTools.push(event.payload.toolName);
  }
  const cost =
    options.cost && usage
      ? options.cost.calculate({
          modelRegistryName: options.cost.modelRegistryName,
          model: options.cost.model,
          usage,
        })
      : undefined;
  if (cost && (!Number.isFinite(cost.amount) || cost.amount < 0 || !cost.currency.trim())) {
    throw new TypeError('CostCalculator must return a non-negative amount and currency');
  }
  const runError =
    executionError ??
    (failed?.type === 'run.failed'
      ? failed.payload.error
      : failed?.type === 'run.cancelled'
        ? failed.payload.reason
        : completed
          ? undefined
          : 'Run did not complete');
  const context: EvalScorerContext<TInput> = {
    testCase,
    output,
    tools: selectedTools,
    events,
    usage,
    cost,
    latencyMs,
    error: runError,
  };
  const scores: EvalScore[] = [];
  for (const scorer of options.scorers) {
    try {
      const result = await scorer.score(context);
      if ('skipped' in result) {
        scores.push({
          scorerId: scorer.id,
          status: 'skipped',
          ...(result.reason ? { details: result.reason } : {}),
        });
      } else {
        if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
          throw new TypeError('score must be between 0 and 1');
        }
        scores.push({
          scorerId: scorer.id,
          status: result.passed ? 'passed' : 'failed',
          score: result.score,
          ...(result.details === undefined ? {} : { details: result.details }),
        });
      }
    } catch (error) {
      scores.push({
        scorerId: scorer.id,
        status: 'error',
        error: errorMessage(error),
      });
    }
  }

  return {
    caseId: testCase.id,
    status: completed ? 'completed' : 'failed',
    ...(output === undefined ? {} : { output }),
    tools: selectedTools,
    ...(usage ? { usage } : {}),
    ...(cost ? { cost } : {}),
    latencyMs,
    scores,
    ...(runError ? { error: runError } : {}),
  };
}

function summarize(cases: readonly EvalCaseReport[]): EvalSummary {
  const scores = cases.flatMap((testCase) => testCase.scores);
  const numericScores = scores.flatMap((score) => (score.score === undefined ? [] : [score.score]));
  const usage: ModelUsage = {};
  for (const testCase of cases) addUsage(usage, testCase.usage);
  const costs = cases.flatMap((testCase) => (testCase.cost ? [testCase.cost] : []));
  const currencies = new Set(costs.map(({ currency }) => currency));
  const totalCost =
    costs.length && currencies.size === 1
      ? {
          amount: costs.reduce((sum, cost) => sum + cost.amount, 0),
          currency: costs[0]!.currency,
        }
      : undefined;
  return {
    caseCount: cases.length,
    completedCount: cases.filter(({ status }) => status === 'completed').length,
    failedCount: cases.filter(({ status }) => status === 'failed').length,
    passedScoreCount: scores.filter(({ status }) => status === 'passed').length,
    failedScoreCount: scores.filter(({ status }) => status === 'failed').length,
    skippedScoreCount: scores.filter(({ status }) => status === 'skipped').length,
    errorScoreCount: scores.filter(({ status }) => status === 'error').length,
    ...(numericScores.length
      ? { averageScore: numericScores.reduce((sum, score) => sum + score, 0) / numericScores.length }
      : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(totalCost ? { cost: totalCost } : {}),
    latencyMs: cases.reduce((sum, testCase) => sum + testCase.latencyMs, 0),
  };
}

/** Runs every case and scorer, producing a deterministic aggregate report. */
export async function runEvaluation<TInput = unknown>(
  options: RunEvaluationOptions<TInput>,
): Promise<EvalReport> {
  validateOptions(options);
  const cases: EvalCaseReport[] = [];
  for (const testCase of options.dataset.cases) {
    cases.push(await evaluateCase(options, testCase));
  }
  const report: EvalReport = {
    schemaVersion: 'fevex.eval.v1',
    suiteName: options.suiteName,
    targetVersion: options.targetVersion,
    agentName: options.agentName,
    dataset: { name: options.dataset.name, version: options.dataset.version },
    scorerIds: options.scorers.map(({ id }) => id),
    cases,
    summary: summarize(cases),
  };
  for (const reporter of options.reporters ?? []) await reporter.report(report);
  return report;
}

export function serializeEvalReport(report: EvalReport): string {
  return `${serializeCanonical(report)}\n`;
}

export function parseEvalReport(json: string): EvalReport {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 'fevex.eval.v1' ||
    typeof (value as { suiteName?: unknown }).suiteName !== 'string' ||
    typeof (value as { targetVersion?: unknown }).targetVersion !== 'string' ||
    typeof (value as { agentName?: unknown }).agentName !== 'string' ||
    typeof (value as { dataset?: unknown }).dataset !== 'object' ||
    (value as { dataset?: unknown }).dataset === null ||
    typeof (value as { dataset: { name?: unknown } }).dataset.name !== 'string' ||
    typeof (value as { dataset: { version?: unknown } }).dataset.version !== 'string' ||
    !Array.isArray((value as { cases?: unknown }).cases) ||
    !Array.isArray((value as { scorerIds?: unknown }).scorerIds) ||
    !(value as { scorerIds: unknown[] }).scorerIds.every(
      (scorerId) => typeof scorerId === 'string' && Boolean(scorerId),
    ) ||
    typeof (value as { summary?: unknown }).summary !== 'object' ||
    (value as { summary?: unknown }).summary === null
  ) {
    throw new TypeError('Invalid fevex.eval.v1 report');
  }
  const report = value as EvalReport;
  const caseIds = new Set<string>();
  for (const testCase of report.cases) {
    if (
      typeof testCase !== 'object' ||
      testCase === null ||
      typeof testCase.caseId !== 'string' ||
      !testCase.caseId ||
      caseIds.has(testCase.caseId) ||
      !['completed', 'failed'].includes(testCase.status) ||
      !Array.isArray(testCase.tools) ||
      !testCase.tools.every((tool) => typeof tool === 'string') ||
      !Number.isFinite(testCase.latencyMs) ||
      testCase.latencyMs < 0 ||
      !Array.isArray(testCase.scores)
    ) {
      throw new TypeError('Invalid fevex.eval.v1 report');
    }
    caseIds.add(testCase.caseId);
    for (const score of testCase.scores) {
      if (
        typeof score !== 'object' ||
        score === null ||
        typeof score.scorerId !== 'string' ||
        !report.scorerIds.includes(score.scorerId) ||
        !['passed', 'failed', 'skipped', 'error'].includes(score.status) ||
        (score.score !== undefined &&
          (!Number.isFinite(score.score) || score.score < 0 || score.score > 1))
      ) {
        throw new TypeError('Invalid fevex.eval.v1 report');
      }
    }
  }
  return value as EvalReport;
}

export function jsonReporter(
  write: (output: string) => void | Promise<void>,
): EvalReporter {
  return { report: (report) => write(serializeEvalReport(report as EvalReport)) };
}

export function textReporter(
  write: (output: string) => void | Promise<void>,
): EvalReporter {
  return {
    report(report) {
      const lines = [
        `${report.suiteName} (${report.targetVersion})`,
        `dataset ${report.dataset.name}@${report.dataset.version}`,
        ...report.cases.map((testCase) => {
          const passed = testCase.scores.filter(({ status }) => status === 'passed').length;
          const failed = testCase.scores.filter(
            ({ status }) => status === 'failed' || status === 'error',
          ).length;
          return `${testCase.caseId}: ${testCase.status}; ${passed} passed, ${failed} failed`;
        }),
        `summary: ${report.summary.completedCount}/${report.summary.caseCount} completed; ${report.summary.failedScoreCount + report.summary.errorScoreCount} failed scores`,
      ];
      return write(`${lines.join('\n')}\n`);
    },
  };
}

function assertRatio(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${name} must be non-negative`);
  }
}

export function compareEvaluationReports(
  baseline: EvalReport,
  current: EvalReport,
  options: RegressionOptions = {},
): RegressionReport {
  if (
    baseline.suiteName !== current.suiteName ||
    baseline.dataset.name !== current.dataset.name ||
    baseline.dataset.version !== current.dataset.version
  ) {
    throw new TypeError('Evaluation reports must use the same suite and dataset version');
  }
  assertRatio(options.maxScoreDrop, 'maxScoreDrop');
  assertRatio(options.maxLatencyIncreaseRatio, 'maxLatencyIncreaseRatio');
  assertRatio(options.maxCostIncreaseRatio, 'maxCostIncreaseRatio');
  const maxScoreDrop = options.maxScoreDrop ?? 0;
  const regressions: Regression[] = [];
  const currentCases = new Map(current.cases.map((testCase) => [testCase.caseId, testCase]));

  for (const baselineCase of baseline.cases) {
    const currentCase = currentCases.get(baselineCase.caseId);
    if (!currentCase) {
      regressions.push({
        kind: 'case_removed',
        caseId: baselineCase.caseId,
        message: `Case "${baselineCase.caseId}" was removed`,
      });
      continue;
    }
    if (baselineCase.status === 'completed' && currentCase.status === 'failed') {
      regressions.push({
        kind: 'case_failed',
        caseId: baselineCase.caseId,
        message: `Case "${baselineCase.caseId}" no longer completes`,
      });
    }
    const currentScores = new Map(currentCase.scores.map((score) => [score.scorerId, score]));
    for (const baselineScore of baselineCase.scores) {
      const currentScore = currentScores.get(baselineScore.scorerId);
      if (!currentScore) {
        regressions.push({
          kind: 'scorer_removed',
          caseId: baselineCase.caseId,
          scorerId: baselineScore.scorerId,
          message: `Scorer "${baselineScore.scorerId}" was removed from "${baselineCase.caseId}"`,
        });
        continue;
      }
      if (
        baselineScore.status === 'passed' &&
        currentScore.status !== 'passed'
      ) {
        regressions.push({
          kind: 'score_failed',
          caseId: baselineCase.caseId,
          scorerId: baselineScore.scorerId,
          message: `Scorer "${baselineScore.scorerId}" changed from pass to fail`,
        });
      } else if (
        baselineScore.score !== undefined &&
        currentScore.score !== undefined &&
        baselineScore.score - currentScore.score > maxScoreDrop
      ) {
        regressions.push({
          kind: 'score_dropped',
          caseId: baselineCase.caseId,
          scorerId: baselineScore.scorerId,
          message: `Scorer "${baselineScore.scorerId}" dropped from ${baselineScore.score} to ${currentScore.score}`,
        });
      }
    }
    if (
      options.maxLatencyIncreaseRatio !== undefined &&
      baselineCase.latencyMs > 0 &&
      currentCase.latencyMs / baselineCase.latencyMs - 1 > options.maxLatencyIncreaseRatio
    ) {
      regressions.push({
        kind: 'latency_increased',
        caseId: baselineCase.caseId,
        message: `Latency increased from ${baselineCase.latencyMs}ms to ${currentCase.latencyMs}ms`,
      });
    }
    if (
      options.maxCostIncreaseRatio !== undefined &&
      baselineCase.cost &&
      currentCase.cost
    ) {
      if (
        baselineCase.cost.currency !== currentCase.cost.currency ||
        (baselineCase.cost.amount > 0 &&
          currentCase.cost.amount / baselineCase.cost.amount - 1 > options.maxCostIncreaseRatio)
      ) {
        regressions.push({
          kind: 'cost_increased',
          caseId: baselineCase.caseId,
          message: `Cost changed from ${baselineCase.cost.amount} ${baselineCase.cost.currency} to ${currentCase.cost.amount} ${currentCase.cost.currency}`,
        });
      }
    }
  }

  return {
    passed: regressions.length === 0,
    baselineTargetVersion: baseline.targetVersion,
    currentTargetVersion: current.targetVersion,
    regressions,
  };
}
