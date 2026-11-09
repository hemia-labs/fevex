---
title: Evaluations & release gates
description: Assert tool, approval and policy trajectories, then block releases with a minimum scorecard.
---

FEVEX evaluates the whole run, not only the final output. A dataset case can
assert the model output, the selected tools, the approval and elicitation
decisions and the policy decisions that led to a result. A regression in any of them blocks the
release gate even when the final answer looks correct.

## Trajectory evals

`@fevex/core/evals` records one trajectory entry per tool attempt, approval
decision, elicitation resolution and non-allow policy decision:

```ts
import {
  approvalScorer,
  policyScorer,
  riskGuardrailScorer,
  runEvaluation,
  trajectoryExpectationScorer,
} from '@fevex/core/evals';

const report = await runEvaluation({
  app,
  suiteName: 'support-regression',
  targetVersion: 'v2',
  agentName: 'support',
  dataset: {
    name: 'support',
    version: '1',
    cases: [{
      id: 'approved-sensitive-write',
      input: 'Update account 42',
      approvals: [{ toolName: 'accounts_update', decision: 'approve' }],
      expected: {
        output: { answer: 'Account 42 updated.' },
        tools: ['accounts_update'],
        trajectory: [
          {
            type: 'policy',
            toolName: 'accounts_update',
            decision: 'require_approval',
            action: 'tool.execute',
          },
          { type: 'approval', toolName: 'accounts_update', decision: 'approve' },
          {
            type: 'tool',
            name: 'accounts_update',
            status: 'completed',
            risk: 'sensitive',
          },
        ],
      },
    }],
  },
  scorers: [
    trajectoryExpectationScorer({ allowAdditional: true }),
    riskGuardrailScorer(),
  ],
});
```

Each case has a 10-minute wall-clock deadline by default. Override it for the
whole suite with `deadlineMs` or for one case with `case.deadlineMs`; the run is
cancelled at the deadline and the case is reported as failed with `timeout`
instead of waiting forever.

Approval pauses are resolved with `approvals`. Elicitation pauses use
`elicitations`, matched by prompt when supplied:

```ts
case: {
  id: 'asks-for-account',
  input: 'Which account?',
  elicitations: [{
    prompt: 'Which account should I use?',
    value: { accountId: 'account-42' },
    actor: { id: 'operator' },
  }],
}
```

The runtime still validates the value against the request's `responseSchema`.

The built-in scorers cover:

- `trajectoryExpectationScorer()` reads `expected.trajectory` from each case.
- `trajectoryScorer(steps)` fixes one expected trajectory for every case.
- `approvalScorer(steps)`, `elicitationScorer(steps)` and `policyScorer(steps)`
  restrict the assertion to one entry kind.
- `riskGuardrailScorer()` fails when a denied-risk tool executes, a
  sensitive-risk tool executes without an approved approval, or an unlabeled
  tool violates the configured `undeclaredRisk` policy.

Policy entries include only `deny` and `require_approval`; allow decisions stay
available as `policy.evaluated` events. Ordered matching is the default. Use
`{ ordered: false }` to ignore order and `{ allowAdditional: true }` to permit
extra entries of the asserted kinds.

`EvalScorerContext` exposes `trajectory`, `events`, `tools`, `output`, `usage`,
`cost`, `latencyMs` and `error`, so custom scorers can inspect the full run.

## Runtime guardrail

`riskGuardrail()` is a small policy for hosts that do not need custom
authorization logic. It denies `destructive` tools and requires approval for
`sensitive` tools by default:

```ts
import { riskGuardrail } from '@fevex/core/policies';

const app = createFevex({
  models,
  agents,
  tools,
  policies: [riskGuardrail()],
});
```

Pass `{ deny, requireApproval }` to change the thresholds. Tools that omit
`risk` are treated as `read`; set `{ undeclaredRisk: 'require_approval' }` or
`{ undeclaredRisk: 'deny' }` to fail closed for unlabeled tools. Every policy
decision emits `policy.evaluated` and appears in local traces and OpenTelemetry
span events.

## Release gate

`evaluateReleaseGate` checks a minimum scorecard and, optionally, a checked-in
baseline report:

```ts
import {
  assertReleaseGate,
  evaluateReleaseGate,
  parseEvalReport,
} from '@fevex/core/evals';

const baseline = parseEvalReport(await readFile('evals/baseline.json', 'utf8'));
const result = evaluateReleaseGate(report, {
  baseline,
  minCompletionRate: 1,
  minPassRate: 1,
  maxFailedScores: 0,
  maxErrorScores: 0,
  requiredScorers: ['output.exact', 'trajectory', 'guardrails.risk'],
  maxCost: { amount: 0.01, currency: 'USD' },
});

if (!result.passed) {
  throw new Error(result.checks.filter(({ passed }) => !passed).map(({ message }) => message).join('\n'));
}
```

`assertReleaseGate(report, options)` throws a typed `ReleaseGateError` with the
scorecard and failed checks attached. Thresholds cover completion rate, pass
rate, failed and errored scores, warnings, average score, required scorers,
latency and cost. By default every case must complete, every non-skipped score
must pass, and no case may report warnings; lower the thresholds explicitly for
suites with expected failures. Required scorers must also produce at least one
passing result.

Cases warn when an `approvals` or `elicitations` fixture was declared but the
run never paused for it. Use `maxWarnings` to allow a known number. When a baseline is
supplied, removed cases, pass-to-fail changes, score drops, latency increases
and cost increases are reported as regressions.

This repository runs its deterministic release suite in CI:

```bash
bun run eval:gate          # compare source against evals/release-baseline.json
bun run eval:gate:package  # build and compare the dist entrypoints
bun run eval:gate --write  # regenerate the baseline after an intentional change
```

The packaged gate builds `@fevex/core` and imports only its public `dist`
entrypoints, so a missing export or build regression fails before the slower
tarball consumer jobs run.

The suite uses `fakeModel`, so it has no provider cost or network dependency.
Custom scorers may call a model judge, but LLM-as-judge is optional and must
never be the only evaluation: deterministic trajectory, policy and cost
assertions remain the gate.
