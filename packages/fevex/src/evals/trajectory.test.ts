import { describe, expect, test } from 'bun:test';
import { defineAgent } from '../agents';
import { createFevex } from '../fevex';
import type { ModelGateway, ModelResult } from '../models';
import { riskGuardrail } from '../policies';
import { ReleaseGateError, assertReleaseGate, evaluateReleaseGate } from '../evals/evaluation';
import { fakeModel } from '../testing';
import { defineTool } from '../tools';
import {
  approvalScorer,
  elicitationScorer,
  exactOutputScorer,
  parseEvalReport,
  policyScorer,
  riskGuardrailScorer,
  runEvaluation,
  serializeEvalReport,
  trajectoryExpectationScorer,
  trajectoryScorer,
  type EvalReport,
} from './index';

function guardedApp(...responses: ModelResult[]) {
  return createFevex({
    models: {
      default: fakeModel(...responses),
    },
    agents: [
      defineAgent({
        name: 'assistant',
        instructions: 'Help.',
        tools: ['update_record', 'delete_record'],
      }),
    ],
    tools: [
      defineTool({ name: 'update_record', risk: 'sensitive', execute: () => 'updated' }),
      defineTool({ name: 'delete_record', risk: 'destructive', execute: () => 'deleted' }),
    ],
    policies: [riskGuardrail()],
  });
}

describe('trajectory evals', () => {
  test('resolves approvals and asserts policy, approval and tool order', async () => {
    const report = await runEvaluation({
      app: guardedApp(
        { toolCalls: [{ id: 'call-update', name: 'update_record', input: { id: 1 } }] },
        { output: { answer: 'updated' } },
      ),
      suiteName: 'trajectory',
      targetVersion: 'v1',
      agentName: 'assistant',
      dataset: {
        name: 'guarded',
        version: '1',
        cases: [
          {
            id: 'approved-write',
            input: 'update 1',
            approvals: [{ toolName: 'update_record', decision: 'approve' }],
          },
        ],
      },
      scorers: [
        trajectoryScorer([
          { type: 'policy', toolName: 'update_record', decision: 'require_approval', action: 'tool.execute' },
          { type: 'policy', toolName: 'update_record', decision: 'require_approval', action: 'approval.resolve' },
          { type: 'approval', toolName: 'update_record', decision: 'approve' },
          { type: 'policy', toolName: 'update_record', decision: 'require_approval', action: 'tool.execute' },
          { type: 'tool', name: 'update_record', status: 'completed', risk: 'sensitive' },
        ]),
        approvalScorer([{ type: 'approval', toolName: 'update_record', decision: 'approve' }]),
        policyScorer([
          { type: 'policy', toolName: 'update_record', decision: 'require_approval' },
        ], { allowAdditional: true }),
        riskGuardrailScorer(),
      ],
    });

    expect(report.cases[0]?.status).toBe('completed');
    expect(report.cases[0]?.trajectory).toMatchObject([
      { type: 'policy', action: 'tool.execute', decision: 'require_approval' },
      { type: 'policy', action: 'approval.resolve', decision: 'require_approval' },
      { type: 'approval', decision: 'approve' },
      { type: 'policy', action: 'tool.execute', decision: 'require_approval' },
      { type: 'tool', name: 'update_record', status: 'completed' },
    ]);
    expect(report.cases[0]?.scores.every(({ status }) => status === 'passed')).toBe(true);
  });

  test('records denied policies without executing the tool', async () => {
    const report = await runEvaluation({
      app: guardedApp({
        toolCalls: [{ id: 'call-delete', name: 'delete_record', input: { id: 2 } }],
      }),
      suiteName: 'trajectory',
      targetVersion: 'v1',
      agentName: 'assistant',
      dataset: {
        name: 'guarded',
        version: '1',
        cases: [{ id: 'denied-delete', input: 'delete 2' }],
      },
      scorers: [
        policyScorer([
          { type: 'policy', toolName: 'delete_record', decision: 'deny', action: 'tool.execute' },
        ]),
        riskGuardrailScorer(),
      ],
    });

    expect(report.cases[0]?.status).toBe('failed');
    expect(report.cases[0]?.tools).toEqual([]);
    expect(report.cases[0]?.trajectory).toEqual([
      {
        type: 'policy',
        policyName: 'risk',
        toolName: 'delete_record',
        toolCallId: 'call-delete',
        action: 'tool.execute',
        decision: 'deny',
        risk: 'destructive',
        declaredRisk: 'destructive',
      },
    ]);
    expect(report.cases[0]?.scores.every(({ status }) => status === 'passed')).toBe(true);
    expect(report.cases[0]?.error).toContain('denied');
  });

  test('blocks release gates on trajectory or policy score regressions', async () => {
    const report = await runEvaluation({
      app: guardedApp(
        { toolCalls: [{ id: 'call-update', name: 'update_record', input: { id: 1 } }] },
        { output: { answer: 'updated' } },
      ),
      suiteName: 'trajectory',
      targetVersion: 'v1',
      agentName: 'assistant',
      dataset: {
        name: 'guarded',
        version: '1',
        cases: [
          {
            id: 'approved-write',
            input: 'update 1',
            approvals: [{ toolName: 'update_record', decision: 'approve' }],
          },
        ],
      },
      scorers: [riskGuardrailScorer()],
    });

    expect(
      evaluateReleaseGate(report, { requiredScorers: ['guardrails.risk'], maxFailedScores: 0 })
        .passed,
    ).toBe(true);

    const regressed: EvalReport = structuredClone(report);
    regressed.cases[0]!.scores[0] = {
      scorerId: 'guardrails.risk',
      status: 'failed',
      score: 0,
      details: { violations: [{ tool: 'update_record', reason: 'missing_approval' }] },
    };

    const gate = evaluateReleaseGate(regressed, { baseline: report });
    expect(gate.passed).toBe(false);
    expect(gate.regressions.map(({ kind }) => kind)).toContain('score_failed');
    expect(() => assertReleaseGate(regressed, { baseline: report })).toThrow(ReleaseGateError);
  });

  test('resolves elicitation pauses and continues the run', async () => {
    const elicitationCall = {
      id: 'elicit-account',
      name: 'fevex__elicit',
      input: {
        prompt: 'Which account should I use?',
        responseSchema: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
          additionalProperties: false,
        },
      },
    };
    const app = createFevex({
      models: {
        default: fakeModel(
          { toolCalls: [elicitationCall] },
          { output: { answer: 'account-42' } },
        ),
      },
      agents: [
        defineAgent({
          name: 'assistant',
          instructions: 'Help.',
          elicitation: 'pause',
        }),
      ],
    });
    const report = await runEvaluation({
      app,
      suiteName: 'elicitation',
      targetVersion: 'v1',
      agentName: 'assistant',
      dataset: {
        name: 'elicitation',
        version: '1',
        cases: [{
          id: 'asks-for-account',
          input: 'Which account?',
          elicitations: [{
            prompt: 'Which account should I use?',
            value: { accountId: 'account-42' },
            actor: { id: 'operator' },
          }],
          expected: { output: { answer: 'account-42' } },
        }],
      },
      scorers: [
        exactOutputScorer(),
        elicitationScorer([{
          type: 'elicitation',
          toolCallId: 'elicit-account',
          prompt: 'Which account should I use?',
          actorId: 'operator',
        }]),
      ],
    });

    expect(report.cases[0]?.status).toBe('completed');
    expect(report.cases[0]?.output).toEqual({ answer: 'account-42' });
    expect(report.cases[0]?.trajectory).toMatchObject([{
      type: 'elicitation',
      toolCallId: 'elicit-account',
      prompt: 'Which account should I use?',
      actorId: 'operator',
    }]);
    expect(report.cases[0]?.scores.every(({ status }) => status === 'passed')).toBe(true);
    expect(parseEvalReport(serializeEvalReport(report)).cases[0]?.trajectory).toEqual(
      report.cases[0]?.trajectory,
    );
  });

  test('warns about approval and elicitation fixtures that were never used', async () => {
    const app = createFevex({
      models: { default: fakeModel({ output: 'ok' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
    });
    const report = await runEvaluation({
      app,
      suiteName: 'warnings',
      targetVersion: 'v1',
      agentName: 'assistant',
      dataset: {
        name: 'warnings',
        version: '1',
        cases: [{
          id: 'unused',
          input: 'go',
          approvals: [{ toolName: 'delete', decision: 'approve' }],
          elicitations: [{ prompt: 'Which account?', value: { accountId: '42' } }],
          expected: { output: 'ok' },
        }],
      },
      scorers: [exactOutputScorer()],
    });

    expect(report.cases[0]?.warnings).toEqual([
      'Unused approval resolution for tool "delete"',
      'Unused elicitation resolution for prompt "Which account?"',
    ]);
    expect(report.summary.warningCount).toBe(2);
    expect(evaluateReleaseGate(report).passed).toBe(false);
    expect(evaluateReleaseGate(report, { maxWarnings: 2 }).passed).toBe(true);
  });

  test('bounds a case with deadlineMs instead of waiting forever', async () => {
    const app = createFevex({
      models: {
        default: {
          async *stream(input) {
            await new Promise<never>((_resolve, reject) => {
              const abort = () => reject(input.signal?.reason ?? new Error('aborted'));
              if (input.signal?.aborted) abort();
              else input.signal?.addEventListener('abort', abort, { once: true });
            });
            yield { type: 'completed' as const, result: { output: 'never' } };
          },
        },
      },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.' })],
    });
    const report = await runEvaluation({
      app,
      suiteName: 'deadline',
      targetVersion: 'v1',
      agentName: 'assistant',
      deadlineMs: 30,
      dataset: { name: 'deadline', version: '1', cases: [{ id: 'slow', input: 'go' }] },
      scorers: [trajectoryExpectationScorer()],
    });

    expect(report.cases[0]?.status).toBe('failed');
    expect(report.cases[0]?.error).toBe('timeout');
    expect(report.cases[0]?.scores[0]?.status).toBe('skipped');
  });

  test('denies tools that omit risk when the guardrail fails closed', async () => {
    const app = createFevex({
      models: {
        default: fakeModel({ toolCalls: [{ id: 'call-unlabeled', name: 'unlabeled', input: {} }] }),
      },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.', tools: ['unlabeled'] })],
      tools: [defineTool({ name: 'unlabeled', execute: () => 'ran' })],
      policies: [riskGuardrail({ undeclaredRisk: 'deny' })],
    });
    const report = await runEvaluation({
      app,
      suiteName: 'trajectory',
      targetVersion: 'v1',
      agentName: 'assistant',
      dataset: { name: 'undeclared', version: '1', cases: [{ id: 'denied', input: 'go' }] },
      scorers: [
        policyScorer([
          { type: 'policy', toolName: 'unlabeled', decision: 'deny' },
        ]),
        riskGuardrailScorer({ undeclaredRisk: 'deny' }),
      ],
    });

    expect(report.cases[0]?.status).toBe('failed');
    expect(report.cases[0]?.tools).toEqual([]);
    expect(report.cases[0]?.error).toContain('denied');
    expect(report.cases[0]?.scores.every(({ status }) => status === 'passed')).toBe(true);
  });

  test('requires approval for undeclared risks when configured', async () => {
    const app = createFevex({
      models: {
        default: fakeModel(
          { toolCalls: [{ id: 'call-unlabeled', name: 'unlabeled', input: {} }] },
          { output: { answer: 'ran' } },
        ),
      },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.', tools: ['unlabeled'] })],
      tools: [defineTool({ name: 'unlabeled', execute: () => 'ran' })],
      policies: [riskGuardrail({ undeclaredRisk: 'require_approval' })],
    });
    const report = await runEvaluation({
      app,
      suiteName: 'trajectory',
      targetVersion: 'v1',
      agentName: 'assistant',
      dataset: {
        name: 'undeclared',
        version: '1',
        cases: [{
          id: 'approved',
          input: 'go',
          approvals: [{ toolName: 'unlabeled', decision: 'approve' }],
          expected: { output: { answer: 'ran' } },
        }],
      },
      scorers: [
        exactOutputScorer(),
        policyScorer([
          { type: 'policy', toolName: 'unlabeled', decision: 'require_approval' },
        ], { allowAdditional: true }),
        riskGuardrailScorer({ undeclaredRisk: 'require_approval' }),
      ],
    });

    expect(report.cases[0]?.status).toBe('completed');
    expect(report.cases[0]?.tools).toEqual(['unlabeled']);
    expect(report.cases[0]?.scores.every(({ status }) => status === 'passed')).toBe(true);
  });

  test('risk guardrail scorer detects undeclared risks', async () => {
    const scorer = riskGuardrailScorer({ undeclaredRisk: 'require_approval' });
    const result = await scorer.score({
      testCase: { id: 'case', input: 'x' },
      output: undefined,
      tools: ['unlabeled'],
      trajectory: [{
        type: 'tool',
        step: 1,
        toolCallId: 'call-1',
        name: 'unlabeled',
        attempt: 1,
        risk: 'read',
        status: 'completed',
      }],
      events: [],
      latencyMs: 0,
    });
    expect(result).toMatchObject({
      passed: false,
      details: {
        violations: [{ tool: 'unlabeled', reason: 'undeclared_risk_missing_approval' }],
      },
    });
  });

  test('bounds a resumed run with the same case deadline', async () => {
    let calls = 0;
    const model: ModelGateway = {
      async *stream(input) {
        calls += 1;
        if (calls === 1) {
          yield {
            type: 'completed' as const,
            result: {
              toolCalls: [{ id: 'call-update', name: 'update_record', input: {} }],
            },
          };
          return;
        }
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(input.signal?.reason ?? new Error('aborted'));
          if (input.signal?.aborted) abort();
          else input.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    };
    const app = createFevex({
      models: { default: model },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.', tools: ['update_record'] })],
      tools: [defineTool({ name: 'update_record', approval: 'required', execute: () => 'ok' })],
    });
    const report = await runEvaluation({
      app,
      suiteName: 'deadline',
      targetVersion: 'v1',
      agentName: 'assistant',
      deadlineMs: 30,
      dataset: {
        name: 'deadline',
        version: '1',
        cases: [{
          id: 'slow-resume',
          input: 'update',
          approvals: [{ toolName: 'update_record', decision: 'approve' }],
        }],
      },
      scorers: [trajectoryExpectationScorer()],
    });

    expect(report.cases[0]?.status).toBe('failed');
    expect(report.cases[0]?.error).toBe('timeout');
    expect(report.cases[0]?.tools).toEqual(['update_record']);
  });

  test('records policy denials raised while resolving an approval', async () => {
    const app = createFevex({
      models: {
        default: fakeModel({ toolCalls: [{ id: 'call-update', name: 'update_record', input: {} }] }),
      },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.', tools: ['update_record'] })],
      tools: [defineTool({ name: 'update_record', risk: 'sensitive', execute: () => 'ok' })],
      policies: [{
        name: 'approval-only',
        authorize({ action }) {
          return action === 'approval.resolve' ? 'deny' : 'require_approval';
        },
      }],
    });
    const report = await runEvaluation({
      app,
      suiteName: 'trajectory',
      targetVersion: 'v1',
      agentName: 'assistant',
      dataset: {
        name: 'approval-policy',
        version: '1',
        cases: [{
          id: 'denied-on-resolve',
          input: 'update',
          approvals: [{ toolName: 'update_record', decision: 'approve' }],
        }],
      },
      scorers: [
        policyScorer([
          { type: 'policy', toolName: 'update_record', decision: 'require_approval' },
          { type: 'policy', toolName: 'update_record', decision: 'deny', action: 'approval.resolve' },
        ]),
      ],
    });

    expect(report.cases[0]?.status).toBe('failed');
    expect(report.cases[0]?.error).toContain('denied');
    expect(report.cases[0]?.trajectory).toMatchObject([
      { type: 'policy', decision: 'require_approval', action: 'tool.execute' },
      { type: 'policy', decision: 'deny', action: 'approval.resolve' },
    ]);
    expect(report.cases[0]?.scores[0]?.status).toBe('passed');
  });

  test('marks the final retry attempt as failed when the tool is exhausted', async () => {
    const app = createFevex({
      models: {
        default: fakeModel(
          { toolCalls: [{ id: 'call-retry', name: 'flaky', input: {} }] },
        ),
      },
      agents: [defineAgent({ name: 'assistant', instructions: 'Help.', tools: ['flaky'] })],
      tools: [
        defineTool({
          name: 'flaky',
          idempotency: 'keyed',
          retry: { maxAttempts: 2, backoffMs: 0 },
          execute() {
            throw new Error('temporary failure');
          },
        }),
      ],
    });
    const report = await runEvaluation({
      app,
      suiteName: 'trajectory',
      targetVersion: 'v1',
      agentName: 'assistant',
      dataset: { name: 'retry', version: '1', cases: [{ id: 'retry', input: 'go' }] },
      scorers: [
        trajectoryScorer([
          { type: 'tool', name: 'flaky', attempt: 1, status: 'failed' },
          { type: 'tool', name: 'flaky', attempt: 2, status: 'failed' },
        ]),
      ],
    });

    expect(report.cases[0]?.status).toBe('failed');
    expect(report.cases[0]?.trajectory).toMatchObject([
      { type: 'tool', name: 'flaky', attempt: 1, status: 'failed' },
      { type: 'tool', name: 'flaky', attempt: 2, status: 'failed' },
    ]);
    expect(report.cases[0]?.scores[0]?.status).toBe('passed');
  });

  test('ordered allowAdditional matches expected steps as a subsequence', async () => {
    const scorer = trajectoryScorer(
      [
        { type: 'policy', toolName: 'update_record', decision: 'require_approval' },
        { type: 'approval', toolName: 'update_record', decision: 'approve' },
        { type: 'tool', name: 'update_record', status: 'completed' },
      ],
      { allowAdditional: true },
    );
    const result = await scorer.score({
      testCase: { id: 'case', input: 'x' },
      output: undefined,
      tools: ['update_record'],
      trajectory: [
        {
          type: 'policy',
          policyName: 'risk',
          toolName: 'update_record',
          action: 'tool.execute',
          decision: 'require_approval',
          risk: 'sensitive',
        },
        {
          type: 'policy',
          policyName: 'risk',
          toolName: 'update_record',
          action: 'approval.resolve',
          decision: 'require_approval',
          risk: 'sensitive',
        },
        {
          type: 'approval',
          toolCallId: 'call-update',
          toolName: 'update_record',
          decision: 'approve',
          actorId: 'eval',
        },
        {
          type: 'policy',
          policyName: 'risk',
          toolName: 'update_record',
          action: 'tool.execute',
          decision: 'require_approval',
          risk: 'sensitive',
        },
        {
          type: 'tool',
          step: 1,
          toolCallId: 'call-update',
          name: 'update_record',
          attempt: 1,
          risk: 'sensitive',
          status: 'completed',
        },
      ],
      events: [],
      latencyMs: 0,
    });
    expect(result).toMatchObject({ passed: true, score: 1 });
  });

  test('risk guardrail scorer detects denied and unapproved tool execution', async () => {
    const scorer = riskGuardrailScorer();
    const result = await scorer.score({
      testCase: { id: 'case', input: 'x' },
      output: undefined,
      tools: ['delete_record', 'update_record'],
      trajectory: [
        {
          type: 'tool',
          step: 1,
          toolCallId: 'call-1',
          name: 'delete_record',
          attempt: 1,
          risk: 'destructive',
          status: 'completed',
        },
        {
          type: 'tool',
          step: 1,
          toolCallId: 'call-2',
          name: 'update_record',
          attempt: 1,
          risk: 'sensitive',
          status: 'completed',
        },
      ],
      events: [],
      latencyMs: 0,
    });

    expect(result).toMatchObject({
      passed: false,
      details: {
        violations: [
          { tool: 'delete_record', reason: 'denied_risk_executed' },
          { tool: 'update_record', reason: 'missing_approval' },
        ],
      },
    });
  });
});
