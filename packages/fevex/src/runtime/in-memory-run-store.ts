import { validateListEventsOptions } from './run-store';
import type { AgentEvent, RunId } from '../core';
import { FevexRunError } from '../run-error';
import type {
  AgentRun,
  DurableRunStore,
  ExecutionCommit,
  ExecutionCreate,
  ListEventsOptions,
  RunCheckpoint,
  RunLease,
  RunRecord,
  Session,
  SessionId,
  StoredRunCheckpoint,
  ToolExecutionRecord,
} from './run-store';

/**
 * In-process durable store intended for development and tests.
 *
 * Values are cloned at the boundary so callers cannot mutate persisted state.
 * Data is lost when the process exits.
 */
export class InMemoryRunStore implements DurableRunStore {
  readonly #runs = new Map<RunId, RunRecord>();
  readonly #sessions = new Map<SessionId, Session>();
  readonly #events = new Map<RunId, AgentEvent[]>();
  readonly #checkpoints = new Map<RunId, StoredRunCheckpoint>();
  readonly #toolExecutions = new Map<string, ToolExecutionRecord>();
  readonly #leases = new Map<RunId, RunLease>();

  async getRun<TRun extends RunRecord<unknown> = AgentRun>(
    runId: RunId,
  ): Promise<TRun | undefined> {
    const run = this.#runs.get(runId);
    return run === undefined ? undefined : structuredClone(run) as TRun;
  }

  async saveRun(run: RunRecord): Promise<void> {
    this.#runs.set(run.id, structuredClone(run));
    if (!this.#events.has(run.id)) this.#events.set(run.id, []);
  }

  async getSession(sessionId: SessionId): Promise<Session | undefined> {
    const session = this.#sessions.get(sessionId);
    return session === undefined ? undefined : structuredClone(session);
  }

  async saveSession(session: Session): Promise<void> {
    const current = this.#sessions.get(session.id);
    if (this.#sessionBusy(session.id) || (current?.revision ?? 0) !== (session.revision ?? 0)) {
      throw new FevexRunError('RUN_CONFLICT', `Session "${session.id}" is active or was modified`);
    }
    session.revision = (session.revision ?? 0) + 1;
    this.#sessions.set(session.id, structuredClone(session));
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    const events = this.#events.get(event.runId);
    if (!events) throw new Error(`Run "${event.runId}" does not exist`);
    events.push(structuredClone(event));
  }

  async listEvents(runId: RunId, options: ListEventsOptions = {}): Promise<AgentEvent[]> {
    validateListEventsOptions(options);
    const events = this.#events.get(runId);
    if (!events) throw new Error(`Run "${runId}" does not exist`);

    let start = 0;
    if (options.after !== undefined) {
      const cursor = events.findIndex(({ id }) => id === options.after);
      if (cursor < 0) {
        throw new FevexRunError('INVALID_CURSOR', `Event cursor "${options.after}" does not exist in run "${runId}"`, runId);
      }
      start = cursor + 1;
    }

    const sequence = start ? events[start - 1]!.sequence : -1;
    const ordered = events.filter((event) => event.sequence > sequence)
      .sort((a, b) => options.order === 'desc' ? b.sequence - a.sequence : a.sequence - b.sequence);
    return structuredClone(ordered.slice(0, options.limit));
  }

  async getCheckpoint<TCheckpoint extends StoredRunCheckpoint = RunCheckpoint>(
    runId: RunId,
  ): Promise<TCheckpoint | undefined> {
    const checkpoint = this.#checkpoints.get(runId);
    return checkpoint === undefined ? undefined : structuredClone(checkpoint) as TCheckpoint;
  }

  async getToolExecution(
    runId: RunId,
    toolCallId: string,
  ): Promise<ToolExecutionRecord | undefined> {
    const execution = this.#toolExecutions.get(`${runId}:${toolCallId}`);
    return execution === undefined ? undefined : structuredClone(execution);
  }

  async createExecution(create: ExecutionCreate): Promise<boolean> {
    if (this.#runs.has(create.run.id)) return false;
    const session = create.session;
    const currentSession = this.#sessions.get(create.run.sessionId);
    if (!session || session.id !== create.run.sessionId
      || this.#sessionBusy(session.id)
      || (currentSession?.revision ?? 0) !== (session.revision ?? 0)) return false;
    const run = structuredClone(create.run);
    run.revision = 1;
    this.#runs.set(run.id, run);
    create.run.revision = 1;
    session.revision = (session.revision ?? 0) + 1;
    this.#sessions.set(session.id, structuredClone(session));
    this.#events.set(run.id, structuredClone(create.events));
    this.#checkpoints.set(run.id, structuredClone(create.checkpoint));
    create.lease.generation = 1;
    this.#leases.set(run.id, structuredClone(create.lease));
    return true;
  }

  async commitExecution(commit: ExecutionCommit): Promise<boolean> {
    const current = this.#runs.get(commit.run.id);
    if (!current || current.revision !== commit.expectedRevision) return false;
    const lease = this.#leases.get(commit.run.id);
    if (!lease || !commit.lease || !(commit.lease.generation > 0) || lease.ownerId !== commit.lease.ownerId
      || lease.generation !== commit.lease.generation || !(Date.parse(lease.expiresAt) > Date.now())) return false;

    if (commit.session && (commit.session.id !== current.sessionId
      || (this.#sessions.get(current.sessionId)?.revision ?? 0) !== (commit.session.revision ?? 0)
      || this.#sessionBusy(current.sessionId, current.id))) return false;
    const run = structuredClone(commit.run);
    run.revision = commit.expectedRevision + 1;
    this.#runs.set(run.id, run);
    commit.run.revision = run.revision;
    if (commit.session) {
      commit.session.revision = (commit.session.revision ?? 0) + 1;
      this.#sessions.set(commit.session.id, structuredClone(commit.session));
    }
    if (commit.checkpoint === null) this.#checkpoints.delete(run.id);
    else if (commit.checkpoint) this.#checkpoints.set(run.id, structuredClone(commit.checkpoint));
    if (commit.toolExecution) {
      this.#toolExecutions.set(
        `${run.id}:${commit.toolExecution.toolCallId}`,
        structuredClone(commit.toolExecution),
      );
    }
    const events = this.#events.get(run.id);
    if (!events) throw new Error(`Run "${run.id}" does not exist`);
    for (const event of commit.events ?? []) events.push(structuredClone(event));
    return true;
  }

  #sessionBusy(sessionId: string, exceptRunId?: string): boolean {
    return [...this.#runs.values()].some((run) => run.sessionId === sessionId
      && run.id !== exceptRunId && (run.status === 'running' || run.status === 'paused'));
  }

  async acquireLease(lease: RunLease): Promise<boolean> {
    const current = this.#leases.get(lease.runId);
    if (current && Date.parse(current.expiresAt) > Date.now()) return false;
    lease.generation = (current?.generation ?? 0) + 1;
    this.#leases.set(lease.runId, structuredClone(lease));
    return true;
  }

  async renewLease(lease: RunLease): Promise<boolean> {
    const current = this.#leases.get(lease.runId);
    if (!current || current.ownerId !== lease.ownerId
      || current.generation !== lease.generation || !(Date.parse(current.expiresAt) > Date.now())) return false;
    this.#leases.set(lease.runId, structuredClone(lease));
    return true;
  }

  async releaseLease(runId: RunId, ownerId: string, generation: number): Promise<void> {
    if (!(generation > 0)) return;
    const current = this.#leases.get(runId);
    if (current?.ownerId === ownerId && current.generation === generation) {
      current.expiresAt = new Date(0).toISOString();
    }
  }
}
