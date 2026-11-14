# @fevex/core

## 0.1.0-alpha.15

### Minor Changes

- 6596921: Add a public run listing API and a local Studio.
  
  `GET /v1/runs` lists runs newest first with `limit`, `status` and opaque `cursor`
  pagination, and filters runs through the host `authorize` hook. `Fevex.listRuns`
  and the HTTP client expose the same contract. The in-memory and SQLite stores
  implement `RunCatalog`; other stores return `RUN_LIST_UNSUPPORTED`.
  
  `examples/studio` consumes only public endpoints to show runs, event timelines,
  tool activity and approvals, and to resolve or cancel runs. It does not read the
  database or import server internals.

## 0.1.0-alpha.14

### Minor Changes

- 77059a9: Add the `@fevex/core/http/client` subpath. It exports the HTTP client and error
  type without the server handler or its Node-only dependencies, so browser
  bundles such as the Next playground can import it safely.

## 0.1.0-alpha.13

### Patch Changes

- 726eb18: Update the package inventory in the core README to include the Slack adapter.

## 0.1.0-alpha.12

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

## 0.1.0-alpha.11

### Patch Changes

- cea838e: Document the new `@fevex/anthropic` adapter in the core package README.

## 0.1.0-alpha.10

### Minor Changes

- 952e070: Add Docker-backed production sandbox provider. Each run gets a long-lived
  container and isolated workspace with `--network none` by default, dropped
  capabilities, read-only root, PID/memory/CPU limits, explicit environment only,
  forced termination and multibyte-safe output caps. Add optional
  `Sandbox.cleanupRun` and `Sandbox.dispose` lifecycle hooks so the runtime
  releases per-run resources after terminal runs and provider resources during
  shutdown. Paused runs keep their container and workspace for resume.

## 0.1.0-alpha.9

### Minor Changes

- 44e5474: Add hybrid tool retrieval. Configure `toolSearch.semantic` with an
  `EmbeddingModel`, optional `ToolEmbeddingCache`, `topK` and `minScore`. Fevex
  runs lexical and vector retrieval independently, fuses them with Reciprocal Rank
  Fusion and returns the configured limit. If the embedding model or index fails,
  search falls back to lexical results. Semantic adapters and vectors stay out of
  run checkpoints; only the serializable search options and loaded tool names are
  persisted.
- 44e5474: Add an optional tool reranker. `ToolSearchSemanticOptions.reranker` receives the
  query, the fused lexical/vector candidates with their scores, and the final
  limit. Fevex validates that the reranker only returns tools from the candidate
  set and falls back to the fused ranking when it throws, returns unknown tools or
  duplicates. The reranker remains optional and is never stored in run
  checkpoints.
- 44e5474: Add semantic tool indexing primitives. `EmbeddingModel` lives in
  `@fevex/core/models`; `@fevex/core/tools` exposes `ToolEmbeddingCache`,
  `InMemoryToolEmbeddingCache`, `buildToolEmbeddingIndex`,
  `searchToolEmbeddingIndex`, `toolEmbeddingText`, `toolEmbeddingKey` and
  `cosineSimilarity`. Indexed text covers the tool name, description and schema
  keywords. Cache keys are `sha256(embeddingModel.id + text)`, the in-memory cache
  is a bounded LRU, and durable adapters can implement the same `get`/`set`
  contract plus optional `getMany`/`setMany` batches. Vectors are derived data and
  are never stored in run checkpoints.
- 44e5474: Add on-demand tool search. `auto` mode is the default and enables search above
  30 tools or a configured token threshold; `on` always enables it and `off`
  disables it. Configure `threshold`, `tokenThreshold`, `limit` and `pinned`.
  Above the threshold the model sees `fevex__search_tools` instead of every
  schema; matching tools load for the next turn. Search only indexes the agent's
  own tools, and allowlists, policies and approvals still apply when a loaded tool
  executes. Loaded tools are persisted in the run checkpoint.
- 44e5474: Harden context compaction and tool results. Add `createModelContextCompactor`
  for semantic summaries with transcript chunking, `compaction.redactSummary` for
  event redaction, `getCompactionStats()` counters, cached tool-token estimates
  and compressed session summaries. Add per-tool `maxResultBytes` and
  per-agent/run `limits.maxToolResultBytes` with a 1 MiB default, `false` opt-out
  and a `TOOL_RESULT_TOO_LARGE` error so large outputs move to artifacts instead
  of the context window.

## 0.1.0-alpha.8

### Minor Changes

- 5752417: Add automatic context compaction. Agents can declare a `contextBudget` with
  `contextWindow`, `reserveOutputTokens`, `compactAt`, `targetTokens` and
  `safetyFactor`, or the runtime can provide a default budget. Before each model
  call Fevex estimates the prompt, replaces older completed turns and earlier
  tool batches with a summary, preserves system instructions, the current request
  and the latest tool batch, emits `context.compacted` and persists the summary in
  the run checkpoint. Summaries are cached on the session and reused across runs;
  the original history remains the source of truth. The compactor and token
  estimator are injectable through `compaction`; the default compactor is a
  deterministic digest with no extra model calls.

## 0.1.0-alpha.7

### Minor Changes

- 1146dcf: Add explicit `SKILL.md` support with progressive disclosure. `loadSkillFile`
  and `loadSkillFiles` parse YAML frontmatter, advertise only name and
  description, and load instructions or resources on demand through the reserved
  `fevex__load_skill` tool. Add `createAgentsMdContextProvider` for explicit
  `AGENTS.md` context. Scripts under `scripts/` are listed but not executed.

## 0.1.0-alpha.6

### Minor Changes

- 7f203fe: Bound trace export work with a deduplicated queue, configurable concurrency,
  queue limits, per-exporter timeouts and retained failure caps. `flushObservability`
  accepts a deadline and `getObservabilityStats()` exposes exported, failed and
  dropped counts. Workflow and team runs now emit correlated traces with step
  spans and `childRunId`; child agent traces carry `parentRunId` and `rootRunId`,
  and tool spans are nested under their model call.
- 7f203fe: Add `shutdown({ timeoutMs })` with admission closure, graceful drain, forced
  cancellation at the deadline, a bounded trace flush and a result that reports
  timed-out or cancelled runs. New starts, resumes and recoveries fail with
  `RUNTIME_CLOSED` (HTTP 503) after shutdown begins. Add repeatable soak and
  crash-recovery harnesses covering memory stability, history integrity, overhead,
  retention and recovery after `SIGKILL`.

### Patch Changes

- 7f203fe: Document the official npm inventory: only `@fevex/core`, `@fevex/openai` and
  `@fevex/deepseek` are published. The other six integrations remain
  repository-validated and are not published by the release pipeline.
- 7f203fe: Publish the compatibility and release policy: public API surface, alpha
  versioning, breaking-change and deprecation rules, forward-only store
  migrations, private versioned checkpoints, upgrade guidance and the tested
  environment matrix. The repository `docs/` directory remains internal.

## 0.1.0-alpha.5

### Minor Changes

- 1a68a1d: Add `@fevex/core/artifacts` with artifact descriptors, in-memory and local filesystem stores, an S3-compatible adapter boundary, and an optional metadata catalog. `@fevex/sqlite` and `@fevex/postgres` add artifact catalogs for listing, authorizing and deleting artifacts by tenant, run, session or actor. `@fevex/core/http` exposes `GET`/`HEAD`/`DELETE /v1/artifacts/:id` and `GET /v1/runs/:runId/artifacts`, with `authorizeArtifact` and client helpers. Tools receive `context.artifacts` and emit `artifact.created`.
- 1a68a1d: Add optional resource authorization to the HTTP host. `createFevexHttpHandler`
  now accepts an `authorize` hook that runs before reads, event streams,
  cancellation, resume, recovery and every start, plus `onRunStarted` so the host
  can persist run and session ownership. The Nest example demonstrates two
  isolated identities with bearer authentication.
- 1a68a1d: Add per-runtime admission limits, per-run deadlines, event caps and terminal
  run retention through `purgeRuns`. SQLite and PostgreSQL implement the new
  retention capability.

## 0.1.0-alpha.4

### Minor Changes

- f4f8020: Deliver elicitation pauses through ChannelAdapter with run, conversation and stable delivery-key correlation. Add deliverChannelRun for retrying stored requests and delivering resumed results without starting another agent run, and extend testChannelAdapter to exercise elicitation retry receipts.

### Patch Changes

- f4f8020: Enforce local sandbox timeout/cancellation with forced process termination and
  bound Unicode output by UTF-8 bytes. Persist effective model identity on agent
  runs so terminal and resumed traces and costs respect model overrides.
  
  Invalidate expired MCP sessions on HTTP 404 and reinitialize on the next call,
  without replaying failed tool calls or invalidating a replacement session when
  an old request finishes late.

## 0.1.0-alpha.3

### Minor Changes

- c5595c5: - `@fevex/core`: Add durable workflows, HTTP transport, teams, channels, knowledge and sandbox APIs, and harden runtime sessions and connections.
  - `@fevex/openai`: Honor tool-choice requests and support `xhigh` and `max` reasoning efforts.
  - `@fevex/deepseek`: Honor tool-choice requests, support `low` and `xhigh` reasoning efforts, and accept null streaming usage.

## 0.1.0-alpha.2

### Minor Changes

- d6322c3: - `@fevex/core`: Add durable workflows, HTTP transport, teams, channels, knowledge and sandbox APIs, and harden runtime sessions and connections.
  - `@fevex/openai`: Honor tool-choice requests and support `xhigh` and `max` reasoning efforts.
  - `@fevex/deepseek`: Honor tool-choice requests, support `low` and `xhigh` reasoning efforts, and accept null streaming usage.
