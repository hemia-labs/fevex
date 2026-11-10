# @fevex/opentelemetry

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies [726eb18]
  - @fevex/core@0.1.0-alpha.13

## 0.1.0-alpha.11

### Minor Changes

- 79956a0: Add trajectory evaluations, policy observability and release gates. Evaluation
  cases can resolve approvals and elicitations and assert tool, approval,
  elicitation and non-allow policy decisions through `trajectory`, `approvals`,
  `elicitations`, `policies` and `guardrails.risk` scorers. Cases have a 10-minute deadline by
  default, configurable per suite or case, so a stuck run fails instead of waiting
  forever. New `evaluateReleaseGate`
  and `assertReleaseGate` helpers enforce minimum scorecards and baseline
  regressions, and the repository runs a deterministic `bun run eval:gate` suite
  in CI.
  
  Add `waitForRun(runId, { signal, timeoutMs })`, an event-driven wait for a run to
  pause or terminate without polling. It returns immediately for paused and
  terminal runs, resolves `undefined` for missing runs, and fails with
  `RUN_WAIT_TIMEOUT` when the deadline expires.
  
  Evaluation cases now report warnings for `approvals` and `elicitations`
  fixtures that were never consumed, and release gates reject warnings by
  default through `maxWarnings`. Memory is loaded after `run.started` and recorded
  in the checkpoint, so failed memory searches produce a failed `search_memory`
  span and failed writes produce a failed `create_memory` span. Add
  `bun run eval:gate:package` to run the release suite against the built package
  entrypoints.
  
  Policies now emit `policy.evaluated` with the policy, tool, risk, action and
  decision; tool events carry `risk`; memory search and write operations emit
  `memory.completed`. Traces annotate policy decisions, add `search_memory` and
  `create_memory` GenAI spans, and expose `fevex.tool.risk` and
  `gen_ai.memory.*` attributes in OpenTelemetry. Add
  the `riskGuardrail` policy helper to deny destructive tools and require approval
  for sensitive tools. Policy authorization now exposes `declaredRisk`, and
  `riskGuardrail`/`riskGuardrailScorer` accept `undeclaredRisk: 'allow' |
  'require_approval' | 'deny'` so tools that omit `risk` can fail closed instead
  of defaulting silently to `read`.

### Patch Changes

- Updated dependencies [79956a0]
  - @fevex/core@0.1.0-alpha.12

## 0.1.0-alpha.10

### Patch Changes

- Updated dependencies [cea838e]
  - @fevex/core@0.1.0-alpha.11

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies [952e070]
  - @fevex/core@0.1.0-alpha.10

## 0.1.0-alpha.8

### Patch Changes

- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
- Updated dependencies [44e5474]
  - @fevex/core@0.1.0-alpha.9

## 0.1.0-alpha.7

### Patch Changes

- Updated dependencies [5752417]
  - @fevex/core@0.1.0-alpha.8

## 0.1.0-alpha.6

### Patch Changes

- Updated dependencies [1146dcf]
  - @fevex/core@0.1.0-alpha.7

## 0.1.0-alpha.5

### Minor Changes

- 7f203fe: Bound trace export work with a deduplicated queue, configurable concurrency,
  queue limits, per-exporter timeouts and retained failure caps. `flushObservability`
  accepts a deadline and `getObservabilityStats()` exposes exported, failed and
  dropped counts. Workflow and team runs now emit correlated traces with step
  spans and `childRunId`; child agent traces carry `parentRunId` and `rootRunId`,
  and tool spans are nested under their model call.

### Patch Changes

- 7f203fe: Document the official npm inventory: only `@fevex/core`, `@fevex/openai` and
  `@fevex/deepseek` are published. The other six integrations remain
  repository-validated and are not published by the release pipeline.
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
- Updated dependencies [7f203fe]
  - @fevex/core@0.1.0-alpha.6

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies [1a68a1d]
- Updated dependencies [1a68a1d]
- Updated dependencies [1a68a1d]
  - @fevex/core@0.1.0-alpha.5

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies [f4f8020]
- Updated dependencies [f4f8020]
  - @fevex/core@0.1.0-alpha.4

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies [c5595c5]
  - @fevex/core@0.1.0-alpha.3

## 0.1.0-alpha.1

### Patch Changes

- Updated dependencies [d6322c3]
  - @fevex/core@0.1.0-alpha.2
