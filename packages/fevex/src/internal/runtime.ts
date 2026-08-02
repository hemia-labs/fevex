import type { Fevex } from '../fevex';
import { FevexRunError } from '../run-error';
import {
  isDurableRunStore,
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
    pendingExports,
    exportFailures,
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
  } = agentEngine;

  const {
    prepareWorkflowExecution,
    executeWorkflow,
    nextWorkflowEvent,
    drainWorkflowExecution,
    resumeWorkflow,
    cancelWorkflowExecution,
  } = createWorkflowEngine(composition, core, agentEngine);

  const resumeRun = async <TOutput>(
    runId: string,
    resolution: ResumeRunResolution,
  ): Promise<RunRecord<TOutput>> => {
    const run = await runStore.getRun<RunRecord>(runId);
    if (run && isCoordinatorRun(run)) return resumeWorkflow<TOutput>(runId, resolution);
    return resumeAgent<TOutput>(runId, resolution);
  };

  const recoverRun = async <TOutput>(
    runId: string,
    actor: { id: string; type?: string },
  ): Promise<RunRecord<TOutput>> => {
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
      if (!isDurableRunStore(runStore)) return false;
      const session = await runStore.getSession(run.sessionId);
      if (!session) return false;
      if (isCoordinatorRun(run)) {
        const checkpoint = await runStore.getCheckpoint<CoordinatorCheckpoint>(runId);
        if (!checkpoint) return false;
        const ownerId = `${runtimeOwner}:${crypto.randomUUID()}`;
        const acquired = await runStore.acquireLease({
          runId,
          ownerId,
          expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
        });
        if (!acquired) return false;
        try {
          const childRunIds = Object.values(checkpoint.steps)
            .filter(
              (record): record is Extract<
                WorkflowStepRecord,
                { type: 'agent'; status: 'running' }
              > => record.type === 'agent' && record.status === 'running',
            )
            .map(({ childRunId }) => childRunId);
          for (const childRunId of childRunIds) {
            if (!(await cancelStoredAgent(childRunId))) return false;
          }
          const state: WorkflowExecutionState = {
            run,
            session,
            request: {
              input: checkpoint.input,
              ...(checkpoint.reasoning === undefined ? {} : { reasoning: checkpoint.reasoning }),
              sessionId: session.id,
              context: checkpoint.context,
              limits: checkpoint.limits,
              signal: new AbortController().signal,
            },
            controller: new AbortController(),
            eventSequence: (await runStore.listEvents(runId)).at(-1)?.sequence ?? 0,
            checkpoint,
            advancing: false,
            leaseOwner: ownerId,
            commitQueue: Promise.resolve(),
          };
          run.status = 'cancelled';
          run.pause = undefined;
          run.error = 'aborted';
          run.usage = checkpoint.budget?.usage;
          const cancelled = createCoordinatorEvent(
            state,
            'workflow.run.cancelled',
            { reason: 'aborted' },
            'team.run.cancelled',
          );
          await commit(state, { checkpoint: null, events: [cancelled] });
          return true;
        } catch (error) {
          if (
            error instanceof FevexRunError &&
            error.code === 'RUN_CONFLICT' &&
            (await runStore.getRun<RunRecord>(runId))?.status !== 'paused'
          )
            return false;
          throw error;
        } finally {
          await runStore.releaseLease(runId, ownerId).catch(() => {});
        }
      }
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
    async compactSession(sessionId, summary) {
      if (typeof summary !== 'string' || !summary.trim()) {
        throw new Error('Session summary must be a non-empty string');
      }
      if (activeSessions.has(sessionId))
        throw new Error(`Session "${sessionId}" has an active run`);
      const session = await runStore.getSession(sessionId);
      if (!session) throw new Error(`Session "${sessionId}" does not exist`);
      session.history = [{ role: 'system', content: summary }];
      session.updatedAt = new Date().toISOString();
      await runStore.saveSession(session);
      return structuredClone(session);
    },
    async flushObservability() {
      while (pendingExports.size) await Promise.all([...pendingExports]);
      if (exportFailures.length) {
        const failures = exportFailures.splice(0);
        throw new AggregateError(failures, 'Observability export failed');
      }
    },
  };
}
