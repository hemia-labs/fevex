---
"@fevex/core": minor
"@fevex/opentelemetry": minor
---

Add trajectory evaluations, policy observability and release gates. Evaluation
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
