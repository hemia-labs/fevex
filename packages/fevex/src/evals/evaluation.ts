import type { AgentEvent, JsonValue } from '../core';
import type { ModelUsage } from '../models';
import type { Fevex } from '../fevex';
import type { ResumeRunResolution } from '../runtime';
import { FevexRunError } from '../run-error';
import type {
  EvalApproval,
  EvalCase,
  EvalCaseReport,
  EvalElicitation,
  EvalGateCheck,
  EvalGateThresholds,
  EvalReport,
  EvalReporter,
  EvalScore,
  EvalScorecard,
  EvalScorerContext,
  EvalSummary,
  EvalTrajectoryEntry,
  Regression,
  RegressionOptions,
  RegressionReport,
  ReleaseGateOptions,
  ReleaseGateResult,
  RunEvaluationOptions,
} from './types';
import { serializeCanonical } from './canonical-json';

const DEFAULT_EVAL_DEADLINE_MS = 10 * 60_000;

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be non-empty`);
}

function assertDeadline(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addUsage(target: ModelUsage, usage: ModelUsage | undefined): void {
  if (!usage) return;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (usage[key] !== undefined) target[key] = (target[key] ?? 0) + usage[key]!;
  }
}

function usageFromEvent(event: AgentEvent): ModelUsage | undefined {
  if (event.type !== 'run.completed' || !event.payload.usage) return undefined;
  const usage: ModelUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const value = event.payload.usage[key];
    if (typeof value === 'number') usage[key] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function validateOptions<TInput>(options: RunEvaluationOptions<TInput>): void {
  assertNonEmpty(options.suiteName, 'suiteName');
  assertNonEmpty(options.targetVersion, 'targetVersion');
  assertNonEmpty(options.agentName, 'agentName');
  assertNonEmpty(options.dataset.name, 'dataset.name');
  assertNonEmpty(options.dataset.version, 'dataset.version');
  if (!Array.isArray(options.dataset.cases) || !options.dataset.cases.length) {
    throw new TypeError('dataset.cases must contain at least one case');
  }
  assertDeadline(options.deadlineMs, 'deadlineMs');
  const caseIds = new Set<string>();
  for (const testCase of options.dataset.cases) {
    assertNonEmpty(testCase.id, 'case.id');
    if (caseIds.has(testCase.id)) throw new TypeError(`Eval case "${testCase.id}" is duplicated`);
    caseIds.add(testCase.id);
    assertDeadline(testCase.deadlineMs, `case "${testCase.id}" deadlineMs`);
    for (const approval of testCase.approvals ?? []) {
      if (approval.decision !== 'approve' && approval.decision !== 'reject') {
        throw new TypeError(`Eval case "${testCase.id}" has an invalid approval decision`);
      }
      if (approval.toolName !== undefined && !approval.toolName.trim()) {
        throw new TypeError(`Eval case "${testCase.id}" approval toolName must be non-empty`);
      }
      if (approval.actor !== undefined && !approval.actor.id.trim()) {
        throw new TypeError(`Eval case "${testCase.id}" approval actor must be non-empty`);
      }
    }
    for (const elicitation of testCase.elicitations ?? []) {
      if (elicitation.prompt !== undefined && !elicitation.prompt.trim()) {
        throw new TypeError(`Eval case "${testCase.id}" elicitation prompt must be non-empty`);
      }
      if (elicitation.actor !== undefined && !elicitation.actor.id.trim()) {
        throw new TypeError(`Eval case "${testCase.id}" elicitation actor must be non-empty`);
      }
    }
  }
  if (!Array.isArray(options.scorers) || !options.scorers.length) {
    throw new TypeError('scorers must contain at least one scorer');
  }
  const scorerIds = new Set<string>();
  for (const scorer of options.scorers) {
    assertNonEmpty(scorer.id, 'scorer.id');
    if (typeof scorer.score !== 'function') {
      throw new TypeError(`Eval scorer "${scorer.id}" must implement score`);
    }
    if (scorerIds.has(scorer.id)) throw new TypeError(`Eval scorer "${scorer.id}" is duplicated`);
    scorerIds.add(scorer.id);
  }
  if (
    options.reporters !== undefined &&
    (!Array.isArray(options.reporters) ||
      options.reporters.some((reporter) => typeof reporter.report !== 'function'))
  ) {
    throw new TypeError('reporters must implement report');
  }
}

function appendEvent(events: AgentEvent[], seen: Set<string>, event: AgentEvent): void {
  if (seen.has(event.id)) return;
  seen.add(event.id);
  events.push(event);
}

function trajectoryFrom(events: readonly AgentEvent[]): EvalTrajectoryEntry[] {
  const trajectory: EvalTrajectoryEntry[] = [];
  const tools = new Map<string, Extract<EvalTrajectoryEntry, { type: 'tool' }>>();
  const toolNames = new Map<string, string>();
  const elicitationPrompts = new Map<string, string>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    switch (event.type) {
      case 'elicitation.requested':
        elicitationPrompts.set(event.payload.request.id, event.payload.request.prompt);
        elicitationPrompts.set(event.payload.request.toolCallId, event.payload.request.prompt);
        break;
      case 'approval.requested':
        toolNames.set(event.payload.toolCallId, event.payload.toolName);
        break;
      case 'tool.started': {
        toolNames.set(event.payload.toolCallId, event.payload.toolName);
        const startedAttempt = event.payload.attempt ?? 1;
        for (const previous of tools.values()) {
          if (
            previous.toolCallId === event.payload.toolCallId &&
            previous.status === 'retrying' &&
            previous.attempt < startedAttempt
          ) {
            previous.status = 'failed';
          }
        }
        const entry: Extract<EvalTrajectoryEntry, { type: 'tool' }> = {
          type: 'tool',
          step: event.payload.step,
          toolCallId: event.payload.toolCallId,
          name: event.payload.toolName,
          attempt: event.payload.attempt ?? 1,
          risk: event.payload.risk ?? 'read',
          ...(event.payload.declaredRisk === undefined
            ? {}
            : { declaredRisk: event.payload.declaredRisk }),
          status: 'started',
        };
        tools.set(`${entry.toolCallId}:${entry.attempt}`, entry);
        trajectory.push(entry);
        break;
      }
      case 'tool.completed':
      case 'tool.failed':
      case 'tool.retrying':
      case 'tool.execution_unknown': {
        const attempt = 'attempt' in event.payload ? event.payload.attempt : undefined;
        const targetAttempt =
          event.type === 'tool.retrying' ? Math.max(1, (attempt ?? 1) - 1) : attempt;
        const entry =
          targetAttempt === undefined
            ? [...tools.values()]
                .filter(({ toolCallId }) => toolCallId === event.payload.toolCallId)
                .sort((left, right) => right.attempt - left.attempt)[0]
            : tools.get(`${event.payload.toolCallId}:${targetAttempt}`);
        if (!entry) break;
        entry.status =
          event.type === 'tool.completed'
            ? 'completed'
            : event.type === 'tool.retrying'
              ? 'retrying'
              : event.type === 'tool.execution_unknown'
                ? 'unknown'
                : 'failed';
        break;
      }
      case 'approval.resolved':
        trajectory.push({
          type: 'approval',
          toolCallId: event.payload.toolCallId,
          toolName: toolNames.get(event.payload.toolCallId) ?? event.payload.toolCallId,
          decision: event.payload.decision,
          actorId: event.payload.actorId,
        });
        break;
      case 'elicitation.resolved': {
        const prompt = elicitationPrompts.get(event.payload.requestId);
        trajectory.push({
          type: 'elicitation',
          requestId: event.payload.requestId,
          toolCallId: event.payload.toolCallId,
          ...(prompt === undefined ? {} : { prompt }),
          actorId: event.payload.actorId,
        });
        break;
      }
      case 'policy.evaluated':
        if (event.payload.decision !== 'allow') {
          trajectory.push({
            type: 'policy',
            policyName: event.payload.policyName,
            toolName: event.payload.toolName,
            ...(event.payload.toolCallId === undefined
              ? {}
              : { toolCallId: event.payload.toolCallId }),
            action: event.payload.action,
            decision: event.payload.decision,
            risk: event.payload.risk,
            ...(event.payload.declaredRisk === undefined
              ? {}
              : { declaredRisk: event.payload.declaredRisk }),
          });
        }
        break;
    }
  }
  return trajectory;
}

function matchingApproval(
  approvals: readonly EvalApproval[],
  index: number,
  toolName: string,
): EvalApproval | undefined {
  const approval = approvals[index];
  if (!approval) return undefined;
  return approval.toolName === undefined || approval.toolName === toolName ? approval : undefined;
}

function matchingElicitation(
  elicitations: readonly EvalElicitation[],
  index: number,
  prompt: string,
): EvalElicitation | undefined {
  const elicitation = elicitations[index];
  if (!elicitation) return undefined;
  return elicitation.prompt === undefined || elicitation.prompt === prompt
    ? elicitation
    : undefined;
}

async function runCase<TInput>(
  app: Fevex,
  agentName: string,
  testCase: EvalCase<TInput>,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<{
  events: AgentEvent[];
  executionError?: string;
  timedOut?: boolean;
  unused: string[];
}> {
  const events: AgentEvent[] = [];
  const seen = new Set<string>();
  const deadlineAt = Date.now() + deadlineMs;
  let executionError: string | undefined;
  let timedOut = false;
  let runId: string | undefined;
  try {
    for await (const event of app.streamAgent(agentName, {
      input: testCase.input,
      context: testCase.context,
      signal,
      deadlineMs,
    })) {
      runId ??= event.runId;
      appendEvent(events, seen, event);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    executionError = errorMessage(error);
  }

  const syncEvents = async (): Promise<void> => {
    if (!runId) return;
    for (const event of await app.listEvents(runId)) appendEvent(events, seen, event);
  };
  await syncEvents();

  const approvals = testCase.approvals ?? [];
  const elicitations = testCase.elicitations ?? [];
  let approvalIndex = 0;
  let elicitationIndex = 0;
  while (runId) {
    signal?.throwIfAborted();
    const run = await app.getRun(runId);
    if (run?.status !== 'paused') break;
    let resolution: ResumeRunResolution | undefined;
    if (run.pause?.type === 'approval') {
      const pause = run.pause.approval;
      const approval = matchingApproval(approvals, approvalIndex, pause.toolName);
      if (!approval) break;
      approvalIndex += 1;
      resolution = {
        type: 'approval',
        approvalId: pause.id,
        decision: approval.decision,
        actor: approval.actor ?? { id: 'eval' },
      };
    } else if (run.pause?.type === 'elicitation') {
      const request = run.pause.request;
      const elicitation = matchingElicitation(elicitations, elicitationIndex, request.prompt);
      if (!elicitation) break;
      elicitationIndex += 1;
      resolution = {
        type: 'elicitation',
        requestId: request.id,
        value: elicitation.value,
        actor: elicitation.actor ?? { id: 'eval' },
      };
    } else {
      break;
    }

    try {
      await app.resumeRun(runId, resolution);
      await app.waitForRun(runId, {
        signal,
        timeoutMs: Math.max(0, deadlineAt - Date.now()),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof FevexRunError && error.code === 'RUN_WAIT_TIMEOUT') {
        timedOut = true;
        executionError = 'timeout';
        await app.cancelRun(runId).catch(() => {});
      } else {
        executionError = errorMessage(error);
      }
      await syncEvents();
      break;
    }
    await syncEvents();
  }

  const unused = [
    ...approvals.slice(approvalIndex).map((approval) =>
      approval.toolName === undefined
        ? 'Unused approval resolution'
        : `Unused approval resolution for tool "${approval.toolName}"`),
    ...elicitations.slice(elicitationIndex).map((elicitation) =>
      elicitation.prompt === undefined
        ? 'Unused elicitation resolution'
        : `Unused elicitation resolution for prompt "${elicitation.prompt}"`),
  ];

  return {
    events,
    ...(executionError === undefined ? {} : { executionError }),
    ...(timedOut ? { timedOut: true } : {}),
    unused,
  };
}

async function evaluateCase<TInput>(
  options: RunEvaluationOptions<TInput>,
  testCase: EvalCase<TInput>,
): Promise<EvalCaseReport> {
  options.signal?.throwIfAborted();
  const startedAt = performance.now();
  const deadlineMs = testCase.deadlineMs ?? options.deadlineMs ?? DEFAULT_EVAL_DEADLINE_MS;
  const { events, executionError, timedOut, unused } = await runCase(
    options.app,
    options.agentName,
    testCase,
    options.signal,
    deadlineMs,
  );

  const latencyMs = performance.now() - startedAt;
  const completed = events.find((event) => event.type === 'run.completed');
  const failed = [...events]
    .reverse()
    .find((event) => event.type === 'run.failed' || event.type === 'run.cancelled');
  const output = completed?.type === 'run.completed' ? completed.payload.output : undefined;
  const usage = completed ? usageFromEvent(completed) : undefined;
  const selectedTools: string[] = [];
  const selectedIds = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool.started' || selectedIds.has(event.payload.toolCallId)) continue;
    selectedIds.add(event.payload.toolCallId);
    selectedTools.push(event.payload.toolName);
  }
  const trajectory = trajectoryFrom(events);
  const cost =
    options.cost && usage
      ? options.cost.calculate({
          modelRegistryName: options.cost.modelRegistryName,
          model: options.cost.model,
          usage,
        })
      : undefined;
  if (cost && (!Number.isFinite(cost.amount) || cost.amount < 0 || !cost.currency.trim())) {
    throw new TypeError('CostCalculator must return a non-negative amount and currency');
  }
  const runError = timedOut
    ? 'timeout'
    : failed?.type === 'run.failed'
      ? failed.payload.error
      : failed?.type === 'run.cancelled'
        ? failed.payload.reason
        : (executionError ?? (completed ? undefined : 'Run did not complete'));
  const context: EvalScorerContext<TInput> = {
    testCase,
    output,
    tools: selectedTools,
    trajectory,
    events,
    usage,
    cost,
    latencyMs,
    error: runError,
  };
  const scores: EvalScore[] = [];
  for (const scorer of options.scorers) {
    try {
      const result = await scorer.score(context);
      if ('skipped' in result) {
        scores.push({
          scorerId: scorer.id,
          status: 'skipped',
          ...(result.reason ? { details: result.reason } : {}),
        });
      } else {
        if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
          throw new TypeError('score must be between 0 and 1');
        }
        scores.push({
          scorerId: scorer.id,
          status: result.passed ? 'passed' : 'failed',
          score: result.score,
          ...(result.details === undefined ? {} : { details: result.details }),
        });
      }
    } catch (error) {
      scores.push({
        scorerId: scorer.id,
        status: 'error',
        error: errorMessage(error),
      });
    }
  }

  return {
    caseId: testCase.id,
    status: completed ? 'completed' : 'failed',
    ...(output === undefined ? {} : { output }),
    tools: selectedTools,
    trajectory,
    ...(usage ? { usage } : {}),
    ...(cost ? { cost } : {}),
    latencyMs,
    scores,
    ...(unused.length ? { warnings: unused } : {}),
    ...(runError ? { error: runError } : {}),
  };
}

function summarize(cases: readonly EvalCaseReport[]): EvalSummary {
  const scores = cases.flatMap((testCase) => testCase.scores);
  const numericScores = scores.flatMap((score) => (score.score === undefined ? [] : [score.score]));
  const usage: ModelUsage = {};
  for (const testCase of cases) addUsage(usage, testCase.usage);
  const costs = cases.flatMap((testCase) => (testCase.cost ? [testCase.cost] : []));
  const currencies = new Set(costs.map(({ currency }) => currency));
  const totalCost =
    costs.length && currencies.size === 1
      ? {
          amount: costs.reduce((sum, cost) => sum + cost.amount, 0),
          currency: costs[0]!.currency,
        }
      : undefined;
  return {
    caseCount: cases.length,
    completedCount: cases.filter(({ status }) => status === 'completed').length,
    failedCount: cases.filter(({ status }) => status === 'failed').length,
    passedScoreCount: scores.filter(({ status }) => status === 'passed').length,
    failedScoreCount: scores.filter(({ status }) => status === 'failed').length,
    skippedScoreCount: scores.filter(({ status }) => status === 'skipped').length,
    errorScoreCount: scores.filter(({ status }) => status === 'error').length,
    warningCount: cases.reduce((sum, testCase) => sum + (testCase.warnings?.length ?? 0), 0),
    ...(numericScores.length
      ? { averageScore: numericScores.reduce((sum, score) => sum + score, 0) / numericScores.length }
      : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(totalCost ? { cost: totalCost } : {}),
    latencyMs: cases.reduce((sum, testCase) => sum + testCase.latencyMs, 0),
  };
}

/** Runs every case and scorer, producing a deterministic aggregate report. */
export async function runEvaluation<TInput = unknown>(
  options: RunEvaluationOptions<TInput>,
): Promise<EvalReport> {
  validateOptions(options);
  const cases: EvalCaseReport[] = [];
  for (const testCase of options.dataset.cases) {
    cases.push(await evaluateCase(options, testCase));
  }
  const report: EvalReport = {
    schemaVersion: 'fevex.eval.v1',
    suiteName: options.suiteName,
    targetVersion: options.targetVersion,
    agentName: options.agentName,
    dataset: { name: options.dataset.name, version: options.dataset.version },
    scorerIds: options.scorers.map(({ id }) => id),
    cases,
    summary: summarize(cases),
  };
  for (const reporter of options.reporters ?? []) await reporter.report(report);
  return report;
}

export function serializeEvalReport(report: EvalReport): string {
  return `${serializeCanonical(report)}\n`;
}

const TOOL_RISKS = new Set(['read', 'write', 'sensitive', 'destructive']);
const TOOL_STATUSES = new Set(['started', 'completed', 'failed', 'unknown', 'retrying']);

function isTrajectoryEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (entry.type === 'tool') {
    return (
      typeof entry.step === 'number' &&
      Number.isFinite(entry.step) &&
      typeof entry.toolCallId === 'string' &&
      typeof entry.name === 'string' &&
      typeof entry.attempt === 'number' &&
      Number.isSafeInteger(entry.attempt) &&
      TOOL_RISKS.has(entry.risk as string) &&
      (entry.declaredRisk === undefined || TOOL_RISKS.has(entry.declaredRisk as string)) &&
      TOOL_STATUSES.has(entry.status as string)
    );
  }
  if (entry.type === 'approval') {
    return (
      typeof entry.toolCallId === 'string' &&
      typeof entry.toolName === 'string' &&
      (entry.decision === 'approve' || entry.decision === 'reject') &&
      typeof entry.actorId === 'string'
    );
  }
  if (entry.type === 'elicitation') {
    return (
      typeof entry.requestId === 'string' &&
      typeof entry.toolCallId === 'string' &&
      (entry.prompt === undefined || typeof entry.prompt === 'string') &&
      typeof entry.actorId === 'string'
    );
  }
  if (entry.type === 'policy') {
    return (
      typeof entry.policyName === 'string' &&
      typeof entry.toolName === 'string' &&
      (entry.toolCallId === undefined || typeof entry.toolCallId === 'string') &&
      (entry.action === 'tool.execute' || entry.action === 'approval.resolve') &&
      (entry.decision === 'deny' || entry.decision === 'require_approval') &&
      TOOL_RISKS.has(entry.risk as string) &&
      (entry.declaredRisk === undefined || TOOL_RISKS.has(entry.declaredRisk as string))
    );
  }
  return false;
}

export function parseEvalReport(json: string): EvalReport {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 'fevex.eval.v1' ||
    typeof (value as { suiteName?: unknown }).suiteName !== 'string' ||
    typeof (value as { targetVersion?: unknown }).targetVersion !== 'string' ||
    typeof (value as { agentName?: unknown }).agentName !== 'string' ||
    typeof (value as { dataset?: unknown }).dataset !== 'object' ||
    (value as { dataset?: unknown }).dataset === null ||
    typeof (value as { dataset: { name?: unknown } }).dataset.name !== 'string' ||
    typeof (value as { dataset: { version?: unknown } }).dataset.version !== 'string' ||
    !Array.isArray((value as { cases?: unknown }).cases) ||
    !Array.isArray((value as { scorerIds?: unknown }).scorerIds) ||
    !(value as { scorerIds: unknown[] }).scorerIds.every(
      (scorerId) => typeof scorerId === 'string' && Boolean(scorerId),
    ) ||
    typeof (value as { summary?: unknown }).summary !== 'object' ||
    (value as { summary?: unknown }).summary === null
  ) {
    throw new TypeError('Invalid fevex.eval.v1 report');
  }
  const warningCount = (value as { summary: { warningCount?: unknown } }).summary.warningCount;
  if (
    warningCount !== undefined &&
    (typeof warningCount !== 'number' || !Number.isSafeInteger(warningCount) || warningCount < 0)
  ) {
    throw new TypeError('Invalid fevex.eval.v1 report');
  }
  const report = value as EvalReport;
  const caseIds = new Set<string>();
  for (const testCase of report.cases) {
    if (
      typeof testCase !== 'object' ||
      testCase === null ||
      typeof testCase.caseId !== 'string' ||
      !testCase.caseId ||
      caseIds.has(testCase.caseId) ||
      !['completed', 'failed'].includes(testCase.status) ||
      !Array.isArray(testCase.tools) ||
      !testCase.tools.every((tool) => typeof tool === 'string') ||
      (testCase.trajectory !== undefined &&
        (!Array.isArray(testCase.trajectory) ||
          !testCase.trajectory.every(isTrajectoryEntry))) ||
      (testCase.warnings !== undefined &&
        (!Array.isArray(testCase.warnings) ||
          !testCase.warnings.every((warning) => typeof warning === 'string'))) ||
      !Number.isFinite(testCase.latencyMs) ||
      testCase.latencyMs < 0 ||
      !Array.isArray(testCase.scores)
    ) {
      throw new TypeError('Invalid fevex.eval.v1 report');
    }
    caseIds.add(testCase.caseId);
    for (const score of testCase.scores) {
      if (
        typeof score !== 'object' ||
        score === null ||
        typeof score.scorerId !== 'string' ||
        !report.scorerIds.includes(score.scorerId) ||
        !['passed', 'failed', 'skipped', 'error'].includes(score.status) ||
        (score.score !== undefined &&
          (!Number.isFinite(score.score) || score.score < 0 || score.score > 1))
      ) {
        throw new TypeError('Invalid fevex.eval.v1 report');
      }
    }
  }
  return value as EvalReport;
}

export function jsonReporter(
  write: (output: string) => void | Promise<void>,
): EvalReporter {
  return { report: (report) => write(serializeEvalReport(report as EvalReport)) };
}

export function textReporter(
  write: (output: string) => void | Promise<void>,
): EvalReporter {
  return {
    report(report) {
      const lines = [
        `${report.suiteName} (${report.targetVersion})`,
        `dataset ${report.dataset.name}@${report.dataset.version}`,
        ...report.cases.map((testCase) => {
          const passed = testCase.scores.filter(({ status }) => status === 'passed').length;
          const failed = testCase.scores.filter(
            ({ status }) => status === 'failed' || status === 'error',
          ).length;
          const warnings = testCase.warnings?.length
            ? `; ${testCase.warnings.length} warnings`
            : '';
          return `${testCase.caseId}: ${testCase.status}; ${passed} passed, ${failed} failed${warnings}`;
        }),
        `summary: ${report.summary.completedCount}/${report.summary.caseCount} completed; ${report.summary.failedScoreCount + report.summary.errorScoreCount} failed scores${report.summary.warningCount ? `; ${report.summary.warningCount} warnings` : ''}`,
      ];
      return write(`${lines.join('\n')}\n`);
    },
  };
}

function assertRatio(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${name} must be non-negative`);
  }
}

export function compareEvaluationReports(
  baseline: EvalReport,
  current: EvalReport,
  options: RegressionOptions = {},
): RegressionReport {
  if (
    baseline.suiteName !== current.suiteName ||
    baseline.dataset.name !== current.dataset.name ||
    baseline.dataset.version !== current.dataset.version
  ) {
    throw new TypeError('Evaluation reports must use the same suite and dataset version');
  }
  assertRatio(options.maxScoreDrop, 'maxScoreDrop');
  assertRatio(options.maxLatencyIncreaseRatio, 'maxLatencyIncreaseRatio');
  assertRatio(options.maxCostIncreaseRatio, 'maxCostIncreaseRatio');
  const maxScoreDrop = options.maxScoreDrop ?? 0;
  const regressions: Regression[] = [];
  const currentCases = new Map(current.cases.map((testCase) => [testCase.caseId, testCase]));

  for (const baselineCase of baseline.cases) {
    const currentCase = currentCases.get(baselineCase.caseId);
    if (!currentCase) {
      regressions.push({
        kind: 'case_removed',
        caseId: baselineCase.caseId,
        message: `Case "${baselineCase.caseId}" was removed`,
      });
      continue;
    }
    if (baselineCase.status === 'completed' && currentCase.status === 'failed') {
      regressions.push({
        kind: 'case_failed',
        caseId: baselineCase.caseId,
        message: `Case "${baselineCase.caseId}" no longer completes`,
      });
    }
    const currentScores = new Map(currentCase.scores.map((score) => [score.scorerId, score]));
    for (const baselineScore of baselineCase.scores) {
      const currentScore = currentScores.get(baselineScore.scorerId);
      if (!currentScore) {
        regressions.push({
          kind: 'scorer_removed',
          caseId: baselineCase.caseId,
          scorerId: baselineScore.scorerId,
          message: `Scorer "${baselineScore.scorerId}" was removed from "${baselineCase.caseId}"`,
        });
        continue;
      }
      if (
        baselineScore.status === 'passed' &&
        currentScore.status !== 'passed'
      ) {
        regressions.push({
          kind: 'score_failed',
          caseId: baselineCase.caseId,
          scorerId: baselineScore.scorerId,
          message: `Scorer "${baselineScore.scorerId}" changed from pass to fail`,
        });
      } else if (
        baselineScore.score !== undefined &&
        currentScore.score !== undefined &&
        baselineScore.score - currentScore.score > maxScoreDrop
      ) {
        regressions.push({
          kind: 'score_dropped',
          caseId: baselineCase.caseId,
          scorerId: baselineScore.scorerId,
          message: `Scorer "${baselineScore.scorerId}" dropped from ${baselineScore.score} to ${currentScore.score}`,
        });
      }
    }
    if (
      options.maxLatencyIncreaseRatio !== undefined &&
      baselineCase.latencyMs > 0 &&
      currentCase.latencyMs / baselineCase.latencyMs - 1 > options.maxLatencyIncreaseRatio
    ) {
      regressions.push({
        kind: 'latency_increased',
        caseId: baselineCase.caseId,
        message: `Latency increased from ${baselineCase.latencyMs}ms to ${currentCase.latencyMs}ms`,
      });
    }
    if (
      options.maxCostIncreaseRatio !== undefined &&
      baselineCase.cost &&
      currentCase.cost
    ) {
      if (
        baselineCase.cost.currency !== currentCase.cost.currency ||
        (baselineCase.cost.amount > 0 &&
          currentCase.cost.amount / baselineCase.cost.amount - 1 > options.maxCostIncreaseRatio)
      ) {
        regressions.push({
          kind: 'cost_increased',
          caseId: baselineCase.caseId,
          message: `Cost changed from ${baselineCase.cost.amount} ${baselineCase.cost.currency} to ${currentCase.cost.amount} ${currentCase.cost.currency}`,
        });
      }
    }
  }

  return {
    passed: regressions.length === 0,
    baselineTargetVersion: baseline.targetVersion,
    currentTargetVersion: current.targetVersion,
    regressions,
  };
}

function assertRate(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new TypeError(`${name} must be between 0 and 1`);
  }
}

function assertCount(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function scorecardFrom(report: EvalReport): EvalScorecard {
  const { summary } = report;
  const scored = summary.passedScoreCount + summary.failedScoreCount + summary.errorScoreCount;
  return {
    caseCount: summary.caseCount,
    completedCount: summary.completedCount,
    completionRate: summary.caseCount === 0 ? 0 : summary.completedCount / summary.caseCount,
    passedScoreCount: summary.passedScoreCount,
    failedScoreCount: summary.failedScoreCount,
    skippedScoreCount: summary.skippedScoreCount,
    errorScoreCount: summary.errorScoreCount,
    warningCount: summary.warningCount ?? 0,
    passRate: scored === 0 ? 0 : summary.passedScoreCount / scored,
    ...(summary.averageScore === undefined ? {} : { averageScore: summary.averageScore }),
    latencyMs: summary.latencyMs,
    ...(summary.cost === undefined ? {} : { cost: summary.cost }),
  };
}

function gateCheck(
  name: string,
  passed: boolean,
  message: string,
  expected: JsonValue,
  actual: JsonValue,
): EvalGateCheck {
  return { name, passed, message, expected, actual };
}

/**
 * Evaluates minimum scorecard thresholds and an optional baseline. A trajectory
 * or policy regression appears as a failed score and blocks the gate even when
 * the final output is correct.
 */
export function evaluateReleaseGate(
  report: EvalReport,
  options: ReleaseGateOptions = {},
): ReleaseGateResult {
  assertRate(options.minCompletionRate, 'minCompletionRate');
  assertRate(options.minPassRate, 'minPassRate');
  assertRate(options.minAverageScore, 'minAverageScore');
  assertCount(options.maxFailedScores, 'maxFailedScores');
  assertCount(options.maxErrorScores, 'maxErrorScores');
  assertCount(options.maxWarnings, 'maxWarnings');
  if (
    options.maxLatencyMs !== undefined &&
    (!Number.isFinite(options.maxLatencyMs) || options.maxLatencyMs < 0)
  ) {
    throw new TypeError('maxLatencyMs must be non-negative');
  }
  if (options.maxCost) {
    if (!Number.isFinite(options.maxCost.amount) || options.maxCost.amount < 0) {
      throw new TypeError('maxCost.amount must be non-negative');
    }
    if (!options.maxCost.currency.trim()) throw new TypeError('maxCost.currency must be non-empty');
  }
  for (const scorerId of options.requiredScorers ?? []) {
    assertNonEmpty(scorerId, 'requiredScorers entry');
  }

  const scorecard = scorecardFrom(report);
  const checks: EvalGateCheck[] = [];
  const minCompletionRate = options.minCompletionRate ?? 1;
  checks.push(
    gateCheck(
      'completion_rate',
      scorecard.completionRate >= minCompletionRate,
      `Completion rate ${scorecard.completionRate} (minimum ${minCompletionRate})`,
      minCompletionRate,
      scorecard.completionRate,
    ),
  );
  const minPassRate = options.minPassRate ?? 1;
  checks.push(
    gateCheck(
      'pass_rate',
      scorecard.passRate >= minPassRate,
      `Pass rate ${scorecard.passRate} (minimum ${minPassRate})`,
      minPassRate,
      scorecard.passRate,
    ),
  );
  const maxFailedScores = options.maxFailedScores ?? 0;
  checks.push(
    gateCheck(
      'failed_scores',
      scorecard.failedScoreCount <= maxFailedScores,
      `Failed scores ${scorecard.failedScoreCount} (maximum ${maxFailedScores})`,
      maxFailedScores,
      scorecard.failedScoreCount,
    ),
  );
  const maxErrorScores = options.maxErrorScores ?? 0;
  checks.push(
    gateCheck(
      'error_scores',
      scorecard.errorScoreCount <= maxErrorScores,
      `Scorer errors ${scorecard.errorScoreCount} (maximum ${maxErrorScores})`,
      maxErrorScores,
      scorecard.errorScoreCount,
    ),
  );
  const maxWarnings = options.maxWarnings ?? 0;
  checks.push(
    gateCheck(
      'warnings',
      scorecard.warningCount <= maxWarnings,
      `Warnings ${scorecard.warningCount} (maximum ${maxWarnings})`,
      maxWarnings,
      scorecard.warningCount,
    ),
  );
  if (options.minAverageScore !== undefined) {
    checks.push(
      gateCheck(
        'average_score',
        scorecard.averageScore !== undefined && scorecard.averageScore >= options.minAverageScore,
        `Average score ${scorecard.averageScore ?? 'unavailable'} (minimum ${options.minAverageScore})`,
        options.minAverageScore,
        scorecard.averageScore ?? null,
      ),
    );
  }
  if (options.requiredScorers?.length) {
    const present = new Set(report.scorerIds);
    const passed = new Set(
      report.cases.flatMap(({ scores }) =>
        scores.filter(({ status }) => status === 'passed').map(({ scorerId }) => scorerId)),
    );
    const missing = options.requiredScorers.filter((scorerId) => !present.has(scorerId));
    const unverified = options.requiredScorers.filter(
      (scorerId) => present.has(scorerId) && !passed.has(scorerId),
    );
    const problems = [
      ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
      ...(unverified.length ? [`without a passing result: ${unverified.join(', ')}`] : []),
    ];
    checks.push(
      gateCheck(
        'required_scorers',
        problems.length === 0,
        problems.length
          ? `Required scorer problems: ${problems.join('; ')}`
          : 'All required scorers passed at least once',
        [...options.requiredScorers],
        report.scorerIds,
      ),
    );
  }
  if (options.maxLatencyMs !== undefined) {
    checks.push(
      gateCheck(
        'latency',
        scorecard.latencyMs <= options.maxLatencyMs,
        `Latency ${scorecard.latencyMs}ms (maximum ${options.maxLatencyMs}ms)`,
        options.maxLatencyMs,
        scorecard.latencyMs,
      ),
    );
  }
  if (options.maxCost) {
    const cost = scorecard.cost;
    const passed =
      cost !== undefined &&
      cost.currency === options.maxCost.currency &&
      cost.amount <= options.maxCost.amount;
    checks.push(
      gateCheck(
        'cost',
        passed,
        `Cost ${cost === undefined ? 'is unavailable' : `${cost.amount} ${cost.currency}`} (maximum ${options.maxCost.amount} ${options.maxCost.currency})`,
        options.maxCost.amount,
        cost?.amount ?? null,
      ),
    );
  }

  const regressions =
    options.baseline === undefined
      ? []
      : compareEvaluationReports(options.baseline, report, options.regression).regressions;
  for (const regression of regressions) {
    checks.push({
      name: `regression.${regression.kind}`,
      passed: false,
      message: regression.message,
      ...(regression.scorerId === undefined ? {} : { actual: regression.scorerId }),
      expected: null,
    });
  }

  return {
    passed: checks.every(({ passed }) => passed),
    scorecard,
    checks,
    regressions,
  };
}

export class ReleaseGateError extends Error {
  override readonly name = 'ReleaseGateError';

  constructor(readonly result: ReleaseGateResult) {
    super(
      `Release gate failed: ${result.checks
        .filter(({ passed }) => !passed)
        .map(({ message }) => message)
        .join('; ')}`,
    );
  }
}

export function assertReleaseGate(
  report: EvalReport,
  options: ReleaseGateOptions = {},
): ReleaseGateResult {
  const result = evaluateReleaseGate(report, options);
  if (!result.passed) throw new ReleaseGateError(result);
  return result;
}
