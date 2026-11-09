import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runReleaseGateSuite, type ReleaseGateApi } from '../evals/release-gate';

export async function runReleaseGateCli(
  api: ReleaseGateApi,
  baselinePath: string,
  options: { write: boolean; label: string },
): Promise<number> {
  const report = await runReleaseGateSuite(api);

  if (options.write) {
    writeFileSync(baselinePath, api.serializeEvalReport(report));
    console.log(`Wrote ${options.label} release baseline to ${baselinePath}`);
    return 0;
  }

  if (!existsSync(baselinePath)) {
    console.error(`Missing release baseline: ${baselinePath}`);
    console.error('Run `bun run eval:gate --write` and commit the result.');
    return 1;
  }

  const baseline = api.parseEvalReport(readFileSync(baselinePath, 'utf8'));
  const result = api.evaluateReleaseGate(report, {
    baseline,
    minCompletionRate: 1,
    minPassRate: 1,
    maxFailedScores: 0,
    maxErrorScores: 0,
    requiredScorers: [
      'output.exact',
      'tools.selected',
      'trajectory',
      'guardrails.risk',
      'tokens.max',
      'cost.max',
    ],
    maxCost: { amount: 0.01, currency: 'USD' },
  });

  console.log(
    JSON.stringify(
      {
        target: options.label,
        passed: result.passed,
        scorecard: result.scorecard,
        checks: result.checks,
        regressions: result.regressions,
      },
      null,
      2,
    ),
  );

  return result.passed ? 0 : 1;
}
