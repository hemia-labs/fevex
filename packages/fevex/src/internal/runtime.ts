import type {
  Fevex,
  FevexShutdownOptions,
  FevexShutdownResult,
} from '../fevex';
import { FevexRunError } from '../run-error';
import {
  isDurableRunStore,
  isRetainableRunStore,
  type AgentRun,
  type ResumeRunResolution,
  type RunRecord,
  type RunRequest,
  type RunResult,
  type Session,
  type CoordinatorCheckpoint,
  type TeamRun,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '../runtime';
import type { FevexComposition } from './configuration';
import { isCoordinatorRun } from './run-helpers';
import { createAgentEngine } from './agent-engine';
import { createRunCore } from './run-core';
import { createWorkflowEngine } from './workflow-engine';
import type { WorkflowExecutionState } from './run-state';
import { LEASE_MS } from './runtime-constants';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const SHUTDOWN_CLEANUP_MS = 5_000;

export function createRuntime(composition: FevexComposition): Fevex {
  const {
    models,
    agents,
    workflows,
    teams,
    tools,
    contextProviders,
    memoryStore,
    runStore,
    credentialStore,
    sandbox,
    policies,
  } = composition;

  const core = createRunCore(composition);
  const {
    activeRuns,
    activeWorkflowRuns,
    activeSessions,
    isIdle,
    waitForIdle,
    closeAdmission,
    isClosed,
    traceExports,
    runtimeOwner,
    createEvent,
    createCoordinatorEvent,
    notifyObserver,
    commit,
    startLease,
    cancelExecution,
    releaseWorkflowExecution,
    commitWorkflow,
  } = core;

  const agentEngine = createAgentEngine(composition, core);
  const {
    prepareExecution,
    executeAgent,
    nextEvent,
    drainExecution,
    resumeAgent,
    cancelStoredAgent,
    getCompactionStats,
  } = agentEngine;

  const {
    prepareWorkflowExecution,
    executeWorkflow,
    nextWorkflowEvent,
    drainWorkflowExecution,
    resumeWorkflow,
    cancelWorkflowExecution,
    cancelStoredWorkflow,
  } = createWorkflowEngine(composition, core, agentEngine);

  const resumeRun = async <TOutput>(
    runId: string,
    resolution: ResumeRunResolution,
  ): Promise<RunRecord<TOutput>> => {
    if (isClosed()) {
      throw new FevexRunError('RUNTIME_CLOSED', 'Runtime is not accepting new runs', runId);
    }
    const run = await runStore.getRun<RunRecord>(runId);
    if (run && isCoordinatorRun(run)) return resumeWorkflow<TOutput>(runId, resolution);
    return resumeAgent<TOutput>(runId, resolution);
  };

  const recoverRun = async <TOutput>(
    runId: string,
    actor: { id: string; type?: string },
  ): Promise<RunRecord<TOutput>> => {
    if (isClosed()) {
      throw new FevexRunError(
        'RUNTIME_CLOSED',
        'Runtime is not accepting new runs',
        runId,
      );
    }
    const run = await runStore.getRun<RunRecord>(runId);
    if (!run) {
      throw new FevexRunError(
        'RUN_NOT_RECOVERABLE',
        `Run "${runId}" cannot be recovered`,
        runId,
      );
    }
    if (isCoordinatorRun(run)) return resumeWorkflow<TOutput>(runId, undefined, actor);
    return resumeAgent<TOutput>(runId, undefined, false, actor);
  };

  const waitForIdleUntil = async (deadline: number): Promise<boolean> => {
    if (isIdle()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(idle);
      };
      timer = setTimeout(() => finish(false), remaining);
      void waitForIdle().then(() => finish(true));
    });
  };

  const shutdown = async (options: FevexShutdownOptions = {}): Promise<FevexShutdownResult> => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('Shutdown timeoutMs must be a non-negative safe integer');
    }
    closeAdmission();
    const deadline = Date.now() + timeoutMs;
    let cleanupDeadline = deadline;
    let timedOut = false;
    const cancelled = new Set<string>();

    if (!(await waitForIdleUntil(deadline))) {
      timedOut = true;
      cleanupDeadline = Date.now() + SHUTDOWN_CLEANUP_MS;
      for (const { run } of activeWorkflowRuns.values()) cancelled.add(run.id);
      for (const { run } of activeRuns.values()) cancelled.add(run.id);
      for (const state of [...activeWorkflowRuns.values(), ...activeRuns.values()]) {
        if (!state.request.signal.aborted) {
          state.controller.abort(new DOMException('Run cancelled', 'AbortError'));
        }
      }
      for (const state of [...activeWorkflowRuns.values()]) {
        if (!state.advancing) await cancelWorkflowExecution(state).catch(() => {});
      }
      for (const state of [...activeRuns.values()]) {
        if (!state.advancing) await cancelExecution(state).catch(() => {});
      }
      await waitForIdleUntil(cleanupDeadline);
    }

    let exportError: unknown;
    try {
      await traceExports.flush({
        timeoutMs: Math.max(1, cleanupDeadline - Date.now()),
      });
    } catch (error) {
      exportError = error;
    }

    return {
      cancelledRunIds: [...cancelled],
      timedOut,
      ...(exportError === undefined ? {} : { exportError }),
      observability: traceExports.stats(),
    };
  };

  return {
    async startAgent<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareExecution(name, request);
      void drainExecution(name, state, false).catch(() => {});
      return structuredClone(state.run) as AgentRun<TOutput>;
    },
    async runAgent<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareExecution(name, request);
      return (await drainExecution(name, state, true)) as RunResult<TOutput>;
    },
    streamAgent<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      return {
        async *[Symbol.asyncIterator]() {
          const state = await prepareExecution(name, request);
          const execution = executeAgent(name, state);
          let finished = false;
          try {
            while (true) {
              const next = await nextEvent(state, execution);
              if (next.done) {
                finished = true;
                return;
              }
              yield next.value;
            }
          } finally {
            if (!finished && state.run.status === 'running') {
              state.controller.abort(new DOMException('Stream abandoned', 'AbortError'));
              try {
                while (state.run.status === 'running') {
                  const next = await nextEvent(state, execution);
                  if (next.done) break;
                }
              } catch {
                // The execution persists its buffered deltas and cancellation event.
              }
              if (state.run.status === 'running') await cancelExecution(state);
            }
            await execution.return(undefined);
          }
        },
      };
    },
    async startWorkflow<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareWorkflowExecution(name, request);
      void drainWorkflowExecution(name, state, false).catch(() => {});
      return structuredClone(state.run) as WorkflowRun<TOutput>;
    },
    async runWorkflow<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareWorkflowExecution(name, request);
      return (await drainWorkflowExecution(name, state, true)) as RunResult<TOutput>;
    },
    async startTeam<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareWorkflowExecution(name, request, 'team');
      void drainWorkflowExecution(name, state, false).catch(() => {});
      return structuredClone(state.run) as TeamRun<TOutput>;
    },
    async runTeam<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      const state = await prepareWorkflowExecution(name, request, 'team');
      return (await drainWorkflowExecution(name, state, true)) as RunResult<TOutput>;
    },
    streamTeam<TInput = unknown, TOutput = unknown>(
      name: string,
      request: RunRequest<TInput, TOutput>,
    ) {
      return {
        async *[Symbol.asyncIterator]() {
          const state = await prepareWorkflowExecution(name, request, 'team');
          const execution = executeWorkflow(name, state);
          let finished = false;
          try {
            while (true) {
              const next = await nextWorkflowEvent(state, execution);
              if (next.done) {
                finished = true;
                return;
              }
              yield next.value;
            }
          } finally {
            if (!finished && state.run.status === 'running') {
              state.controller.abort(new DOMException('Stream abandoned', 'AbortError'));
              try {
                while (state.run.status === 'running') {
                  const next = await nextWorkflowEvent(state, execution);
                  if (next.done) break;
                }
              } catch {
                // The coordinator persists its cancellation event.
              }
              if (state.run.status === 'running') await cancelWorkflowExecution(state);
            }
            await execution.return(undefined);
          }
        },
      };
    },
    async getTeamRun<TOutput = unknown>(runId: string) {
      const run = await runStore.getRun<RunRecord<TOutput>>(runId);
      return run?.kind === 'team' ? run : undefined;
    },
    getRun<TOutput = unknown>(runId: string) {
      return runStore.getRun<RunRecord<TOutput>>(runId);
    },
    listEvents(runId, options) {
      return runStore.listEvents(runId, options);
    },
    async cancelRun(runId) {
      const activeWorkflow = activeWorkflowRuns.get(runId);
      if (activeWorkflow && !activeWorkflow.request.signal.aborted) {
        activeWorkflow.controller.abort(new DOMException('Run cancelled', 'AbortError'));
        if (!activeWorkflow.advancing) await cancelWorkflowExecution(activeWorkflow);
        return true;
      }
      const active = activeRuns.get(runId);
      if (active && !active.request.signal.aborted) {
        active.controller.abort(new DOMException('Run cancelled', 'AbortError'));
        if (!active.advancing) await cancelExecution(active);
        return true;
      }
      const run = await runStore.getRun<RunRecord>(runId);
      if (!run || (run.status !== 'paused' && run.status !== 'running')) return false;
      if (isCoordinatorRun(run)) return cancelStoredWorkflow(runId);
      return cancelStoredAgent(runId);
    },
    resumeRun<TOutput = unknown>(runId: string, resolution: ResumeRunResolution) {
      return resumeRun<TOutput>(runId, resolution);
    },
    recoverRun<TOutput = unknown>(
      runId: string,
      options: { actor: { id: string; type?: string } },
    ) {
      return recoverRun<TOutput>(runId, options.actor);
    },
    async purgeRuns(options) {
      if (!isRetainableRunStore(runStore)) {
        throw new FevexRunError(
          'RETENTION_UNSUPPORTED',
          'The configured run store does not support purgeRuns',
        );
      }
      return runStore.purgeRuns(options);
    },
    async compactSession(sessionId, summary) {
      if (typeof summary !== 'string' || !summary.trim()) {
        throw new Error('Session summary must be a non-empty string');
      }
      if (activeSessions.has(sessionId))
        throw new Error(`Session "${sessionId}" has an active run`);
      const session = await runStore.getSession(sessionId);
      if (!session) throw new Error(`Session "${sessionId}" does not exist`);
      session.history = [{ role: 'system', content: summary }];
      session.compaction = undefined;
      session.updatedAt = new Date().toISOString();
      await runStore.saveSession(session);
      return structuredClone(session);
    },
    flushObservability(options) {
      return traceExports.flush(options);
    },
    getObservabilityStats() {
      return traceExports.stats();
    },
    getCompactionStats() {
      return getCompactionStats();
    },
    shutdown,
  };
}
