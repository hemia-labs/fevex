import { describe, expect, test } from 'bun:test';
import { defineAgent } from '../agents';
import { createFevex } from '../fevex';
import { fakeModel } from '../testing';
import { defineTool } from '../tools';
import {
  compareEvaluationReports,
  exactOutputScorer,
  forbiddenToolsScorer,
  jsonReporter,
  maxCostScorer,
  maxTokensScorer,
  parseEvalReport,
  runEvaluation,
  serializeEvalReport,
  textReporter,
  toolSelectionScorer,
  type EvalReporter,
  type EvalScorer,
} from './index';

describe('evals', () => {
  test('runs deterministic cases sequentially and reports output, tools, usage and cost', async () => {
    const model = fakeModel(
      {
        toolCalls: [{ id: 'call-1', name: 'lookup', input: { query: 'x' } }],
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      },
      {
        output: { answer: 'found' },
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
      {
        output: { answer: 'direct' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    );
    const app = createFevex({
      models: { default: model },
      agents: [
        defineAgent({ name: 'assistant', instructions: 'Help.', tools: ['lookup'] }),
      ],
      tools: [defineTool({ name: 'lookup', execute: () => ({ value: 'found' }) })],
    });
    const outputs: string[] = [];
    const report = await runEvaluation({
      app,
      suiteName: 'support',
      targetVersion: 'v2',
      agentName: 'assistant',
      dataset: {
        name: 'support-cases',
        version: '1',
        cases: [
          {
            id: 'uses-tool',
            input: 'lookup',
            expected: { output: { answer: 'found' }, tools: ['lookup'] },
          },
          {
            id: 'direct',
            input: 'direct',
            expected: { output: { answer: 'direct' }, tools: [] },
          },
        ],
      },
      scorers: [
        exactOutputScorer(),
        toolSelectionScorer(),
        forbiddenToolsScorer(['delete']),
        maxTokensScorer({ total: 10 }),
        maxCostScorer(0.01, 'USD'),
      ],
      cost: {
        modelRegistryName: 'default',
        calculate: ({ usage }) => ({
          amount: (usage.totalTokens ?? 0) / 1_000,
          currency: 'USD',
        }),
      },
      reporters: [
        jsonReporter((value) => {
          outputs.push(value);
        }),
        textReporter((value) => {
          outputs.push(value);
        }),
      ],
    });

    expect(report.cases.map(({ tools }) => tools)).toEqual([['lookup'], []]);
    expect(report.cases[0]?.usage).toEqual({ inputTokens: 5, outputTokens: 3, totalTokens: 8 });
    expect(report.summary).toMatchObject({
      caseCount: 2,
      completedCount: 2,
      failedCount: 0,
      passedScoreCount: 10,
      failedScoreCount: 0,
      cost: { amount: 0.01, currency: 'USD' },
    });
    expect(parseEvalReport(outputs[0]!)).toEqual(report);
    expect(outputs[1]).toContain('uses-tool: completed; 5 passed, 0 failed');
    expect(serializeEvalReport(report)).toBe(serializeEvalReport(report));
  });

  test('continues after run and scorer failures', async () => {
    const explodingScorer: EvalScorer = {
      id: 'explodes',
      score() {
        throw new Error('scorer failed');
      },
    };
    let reports = 0;
    const reporter: EvalReporter = { report: () => void (reports += 1) };
    const app = createFevex({
      models: { default: fakeModel({ output: 'first' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
    });
    const report = await runEvaluation({
      app,
      suiteName: 'failures',
      targetVersion: 'v1',
      agentName: 'assistant',
      dataset: {
        name: 'cases',
        version: '1',
        cases: [
          { id: 'first', input: 'one', expected: { output: 'first' } },
          { id: 'second', input: 'two', expected: { output: 'second' } },
        ],
      },
      scorers: [exactOutputScorer(), explodingScorer],
      reporters: [reporter],
    });

    expect(report.cases.map(({ status }) => status)).toEqual(['completed', 'failed']);
    expect(report.cases.every(({ scores }) => scores[1]?.status === 'error')).toBe(true);
    expect(report.summary.errorScoreCount).toBe(2);
    expect(reports).toBe(1);
  });

  test('detects removed cases, pass-to-fail and score regressions while allowing additions', async () => {
    const baseline = parseEvalReport(`{
      "schemaVersion": "fevex.eval.v1",
      "suiteName": "suite",
      "targetVersion": "v1",
      "agentName": "assistant",
      "dataset": {"name": "cases", "version": "1"},
      "scorerIds": ["exact"],
      "cases": [
        {"caseId":"kept","status":"completed","tools":[],"latencyMs":10,"scores":[{"scorerId":"exact","status":"passed","score":1}]},
        {"caseId":"removed","status":"completed","tools":[],"latencyMs":10,"scores":[{"scorerId":"exact","status":"passed","score":1}]}
      ],
      "summary": {"caseCount":2,"completedCount":2,"failedCount":0,"passedScoreCount":2,"failedScoreCount":0,"skippedScoreCount":0,"errorScoreCount":0,"latencyMs":20}
    }`);
    const current = structuredClone(baseline);
    current.targetVersion = 'v2';
    current.cases = [
      {
        ...current.cases[0]!,
        scores: [{ scorerId: 'exact', status: 'failed', score: 0 }],
        latencyMs: 30,
      },
      {
        caseId: 'new',
        status: 'completed',
        tools: [],
        latencyMs: 1,
        scores: [{ scorerId: 'exact', status: 'passed', score: 1 }],
      },
    ];

    const comparison = compareEvaluationReports(baseline, current, {
      maxLatencyIncreaseRatio: 0.5,
    });
    expect(comparison.passed).toBe(false);
    expect(comparison.regressions.map(({ kind }) => kind)).toEqual([
      'score_failed',
      'latency_increased',
      'case_removed',
    ]);
    expect(comparison.regressions.some(({ caseId }) => caseId === 'new')).toBe(false);
  });

  test('propagates reporter failures after producing the suite', async () => {
    const app = createFevex({
      models: { default: fakeModel({ output: 'ok' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
    });
    await expect(
      runEvaluation({
        app,
        suiteName: 'suite',
        targetVersion: 'v1',
        agentName: 'assistant',
        dataset: {
          name: 'cases',
          version: '1',
          cases: [{ id: 'case', input: 'go', expected: { output: 'ok' } }],
        },
        scorers: [exactOutputScorer()],
        reporters: [{ report: () => Promise.reject(new Error('write failed')) }],
      }),
    ).rejects.toThrow('write failed');
  });
});
