import type * as Core from '../packages/fevex/src/index';
import type * as Evals from '../packages/fevex/src/evals/index';
import type * as Testing from '../packages/fevex/src/testing/index';
import type { EvalReport } from '../packages/fevex/src/evals/index';

/** Runtime entry points used by the release suite, from source or a built package. */
export interface ReleaseGateApi {
  createFevex: typeof Core.createFevex;
  defineAgent: typeof Core.defineAgent;
  defineTool: typeof Core.defineTool;
  riskGuardrail: typeof Core.riskGuardrail;
  fakeModel: typeof Testing.fakeModel;
  runEvaluation: typeof Evals.runEvaluation;
  exactOutputScorer: typeof Evals.exactOutputScorer;
  toolSelectionScorer: typeof Evals.toolSelectionScorer;
  trajectoryExpectationScorer: typeof Evals.trajectoryExpectationScorer;
  riskGuardrailScorer: typeof Evals.riskGuardrailScorer;
  maxTokensScorer: typeof Evals.maxTokensScorer;
  maxCostScorer: typeof Evals.maxCostScorer;
  evaluateReleaseGate: typeof Evals.evaluateReleaseGate;
  parseEvalReport: typeof Evals.parseEvalReport;
  serializeEvalReport: typeof Evals.serializeEvalReport;
}

/**
 * Deterministic release-gate suite. It exercises a read-only run and a
 * sensitive write that requires human approval, then asserts the policy and
 * approval trajectory as well as output, tools, tokens and cost.
 */
export function runReleaseGateSuite(api: ReleaseGateApi): Promise<EvalReport> {
  const app = api.createFevex({
    models: {
      default: api.fakeModel(
        { output: { answer: 'Read-only answer.' }, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
        {
          toolCalls: [{ id: 'call-update', name: 'update_record', input: { id: 42 } }],
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
        {
          output: { answer: 'Updated record 42.' },
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      ),
    },
    agents: [
      api.defineAgent({
        name: 'release-agent',
        instructions: 'Answer or update the requested record.',
        tools: ['lookup', 'update_record'],
      }),
    ],
    tools: [
      api.defineTool({ name: 'lookup', risk: 'read', execute: () => 'record 42' }),
      api.defineTool({ name: 'update_record', risk: 'sensitive', execute: () => 'updated' }),
    ],
    policies: [api.riskGuardrail()],
  });

  return api.runEvaluation({
    app,
    suiteName: 'release-gate',
    targetVersion: 'release-gate-v1',
    agentName: 'release-agent',
    dataset: {
      name: 'release-trajectories',
      version: '1',
      cases: [
        {
          id: 'read-only',
          input: 'read record 42',
          expected: {
            output: { answer: 'Read-only answer.' },
            tools: [],
            trajectory: [],
          },
        },
        {
          id: 'approved-sensitive-write',
          input: 'update record 42',
          approvals: [{ toolName: 'update_record', decision: 'approve' }],
          expected: {
            output: { answer: 'Updated record 42.' },
            tools: ['update_record'],
            trajectory: [
              {
                type: 'policy',
                toolName: 'update_record',
                decision: 'require_approval',
                action: 'tool.execute',
              },
              { type: 'approval', toolName: 'update_record', decision: 'approve' },
              {
                type: 'tool',
                name: 'update_record',
                status: 'completed',
                risk: 'sensitive',
              },
            ],
          },
        },
      ],
    },
    scorers: [
      api.exactOutputScorer(),
      api.toolSelectionScorer(),
      api.trajectoryExpectationScorer({ allowAdditional: true }),
      api.riskGuardrailScorer(),
      api.maxTokensScorer({ total: 20 }),
      api.maxCostScorer(0.01, 'USD'),
    ],
    cost: {
      modelRegistryName: 'default',
      calculate: ({ usage }) => ({
        amount: (usage.totalTokens ?? 0) * 0.000_001,
        currency: 'USD',
      }),
    },
  });
}
