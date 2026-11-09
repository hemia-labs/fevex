import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runReleaseGateCli } from './eval-gate-lib';

const distEntry = fileURLToPath(new URL('../packages/fevex/dist/index.mjs', import.meta.url));
if (!existsSync(distEntry)) {
  console.error(`Missing built package: ${distEntry}`);
  console.error('Run `bun run --cwd packages/fevex build` first.');
  process.exit(1);
}

const Core = await import('../packages/fevex/dist/index.mjs');
const Evals = await import('../packages/fevex/dist/evals/index.mjs');
const Testing = await import('../packages/fevex/dist/testing/index.mjs');
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
  { write: process.argv.includes('--write'), label: 'built package' },
);
