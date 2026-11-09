import { fileURLToPath } from 'node:url';
import * as Core from '../packages/fevex/src/index';
import * as Evals from '../packages/fevex/src/evals/index';
import * as Testing from '../packages/fevex/src/testing/index';
import { runReleaseGateCli } from './eval-gate-lib';

const baselinePath = fileURLToPath(new URL('../evals/release-baseline.json', import.meta.url));

process.exitCode = await runReleaseGateCli(
  {
    createFevex: Core.createFevex,
    defineAgent: Core.defineAgent,
    defineTool: Core.defineTool,
    riskGuardrail: Core.riskGuardrail,
    fakeModel: Testing.fakeModel,
    runEvaluation: Evals.runEvaluation,
    exactOutputScorer: Evals.exactOutputScorer,
    toolSelectionScorer: Evals.toolSelectionScorer,
    trajectoryExpectationScorer: Evals.trajectoryExpectationScorer,
    riskGuardrailScorer: Evals.riskGuardrailScorer,
    maxTokensScorer: Evals.maxTokensScorer,
    maxCostScorer: Evals.maxCostScorer,
    evaluateReleaseGate: Evals.evaluateReleaseGate,
    parseEvalReport: Evals.parseEvalReport,
    serializeEvalReport: Evals.serializeEvalReport,
  },
  baselinePath,
  { write: process.argv.includes('--write'), label: 'source' },
);
