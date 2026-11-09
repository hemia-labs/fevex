import { describe, expect, test } from 'bun:test';
import {
  ReleaseGateError,
  assertReleaseGate,
  evaluateReleaseGate,
} from './evaluation';
import type { EvalReport } from './types';

function report(overrides: Partial<EvalReport['summary']> = {}): EvalReport {
  return {
    schemaVersion: 'fevex.eval.v1',
    suiteName: 'gate',
    targetVersion: 'v1',
    agentName: 'assistant',
    dataset: { name: 'cases', version: '1' },
    scorerIds: ['output.exact'],
    cases: [
      {
        caseId: 'case',
        status: 'completed',
        tools: [],
        trajectory: [],
        latencyMs: 10,
        scores: [{ scorerId: 'output.exact', status: 'passed', score: 1 }],
      },
    ],
    summary: {
      caseCount: 1,
      completedCount: 1,
      failedCount: 0,
      passedScoreCount: 1,
      failedScoreCount: 0,
      skippedScoreCount: 0,
      errorScoreCount: 0,
      warningCount: 0,
      averageScore: 1,
      latencyMs: 10,
      ...overrides,
    },
  };
}

describe('release gate', () => {
  test('passes a clean scorecard with explicit thresholds', () => {
    const result = evaluateReleaseGate(report(), {
      minCompletionRate: 1,
      minPassRate: 1,
      minAverageScore: 1,
      maxLatencyMs: 20,
      requiredScorers: ['output.exact'],
    });
    expect(result.passed).toBe(true);
    expect(result.scorecard).toMatchObject({
      caseCount: 1,
      completedCount: 1,
      completionRate: 1,
      passRate: 1,
      averageScore: 1,
    });
  });

  test('reports every failed threshold in one run', () => {
    const result = evaluateReleaseGate(
      report({
        completedCount: 0,
        failedCount: 1,
        passedScoreCount: 0,
        failedScoreCount: 1,
        averageScore: 0,
        latencyMs: 100,
      }),
      {
        minCompletionRate: 1,
        minPassRate: 1,
        minAverageScore: 0.5,
        maxLatencyMs: 50,
        maxFailedScores: 0,
        requiredScorers: ['missing'],
        maxCost: { amount: 0.01, currency: 'USD' },
      },
    );

    expect(result.passed).toBe(false);
    expect(result.checks.filter(({ passed }) => !passed).map(({ name }) => name)).toEqual([
      'completion_rate',
      'pass_rate',
      'failed_scores',
      'average_score',
      'required_scorers',
      'latency',
      'cost',
    ]);
  });

  test('fails on unused resolution warnings by default', () => {
    const withWarnings = report({ warningCount: 1 });
    withWarnings.cases[0]!.warnings = ['Unused approval resolution for tool "delete"'];
    const strict = evaluateReleaseGate(withWarnings);
    expect(strict.passed).toBe(false);
    expect(strict.checks.find(({ name }) => name === 'warnings')).toMatchObject({
      passed: false,
      expected: 0,
      actual: 1,
    });
    expect(evaluateReleaseGate(withWarnings, { maxWarnings: 1 }).passed).toBe(true);
  });

  test('treats an empty score denominator as a failed pass rate', () => {
    const skipped = report({
      passedScoreCount: 0,
      skippedScoreCount: 1,
      averageScore: undefined,
    });
    skipped.cases[0]!.scores = [{ scorerId: 'output.exact', status: 'skipped' }];
    const result = evaluateReleaseGate(
      skipped,
      { minPassRate: 0.9, requiredScorers: ['output.exact'] },
    );
    expect(result.scorecard.passRate).toBe(0);
    expect(result.checks.find(({ name }) => name === 'required_scorers')).toMatchObject({
      passed: false,
      message: expect.stringContaining('without a passing result'),
    });
    expect(result.passed).toBe(false);
  });

  test('throws a typed error with the scorecard attached', () => {
    const failing = report({ failedScoreCount: 1, passedScoreCount: 0, averageScore: 0 });
    expect(() => assertReleaseGate(failing)).toThrow(ReleaseGateError);
    try {
      assertReleaseGate(failing);
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseGateError);
      expect((error as ReleaseGateError).result.scorecard.failedScoreCount).toBe(1);
    }
  });

  test('validates thresholds and cost units', () => {
    expect(() => evaluateReleaseGate(report(), { minPassRate: 2 })).toThrow('minPassRate');
    expect(() => evaluateReleaseGate(report(), { maxFailedScores: -1 })).toThrow('maxFailedScores');
    expect(() => evaluateReleaseGate(report(), { maxLatencyMs: Number.NaN })).toThrow('maxLatencyMs');
    expect(() => evaluateReleaseGate(report(), {
      maxCost: { amount: 1, currency: ' ' },
    })).toThrow('maxCost.currency');
  });
});
