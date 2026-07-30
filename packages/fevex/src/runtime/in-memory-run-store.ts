import type { AgentEvent, RunId } from '../core';
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
    this.#sessions.set(session.id, structuredClone(session));
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    const events = this.#events.get(event.runId);
    if (!events) throw new Error(`Run "${event.runId}" does not exist`);
    events.push(structuredClone(event));
  }

  async listEvents(runId: RunId, options: ListEventsOptions = {}): Promise<AgentEvent[]> {
    const events = this.#events.get(runId);
    if (!events) throw new Error(`Run "${runId}" does not exist`);

    let start = 0;
    if (options.after !== undefined) {
      const cursor = events.findIndex(({ id }) => id === options.after);
      if (cursor < 0) {
        throw new Error(`Event cursor "${options.after}" does not exist in run "${runId}"`);
      }
      start = cursor + 1;
    }

    return structuredClone(events.slice(start).sort((a, b) => a.sequence - b.sequence));
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
    const run = structuredClone(create.run);
    run.revision = 1;
    this.#runs.set(run.id, run);
    create.run.revision = 1;
    if (create.session) this.#sessions.set(create.session.id, structuredClone(create.session));
    this.#events.set(run.id, structuredClone(create.events));
    this.#checkpoints.set(run.id, structuredClone(create.checkpoint));
    this.#leases.set(run.id, structuredClone(create.lease));
    return true;
  }

  async commitExecution(commit: ExecutionCommit): Promise<boolean> {
    const current = this.#runs.get(commit.run.id);
    if (!current || current.revision !== commit.expectedRevision) return false;

    const run = structuredClone(commit.run);
    run.revision = commit.expectedRevision + 1;
    this.#runs.set(run.id, run);
    commit.run.revision = run.revision;
    if (commit.session) this.#sessions.set(commit.session.id, structuredClone(commit.session));
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

  async acquireLease(lease: RunLease): Promise<boolean> {
    const current = this.#leases.get(lease.runId);
    if (
      current
      && current.ownerId !== lease.ownerId
      && Date.parse(current.expiresAt) > Date.now()
    ) return false;
    this.#leases.set(lease.runId, structuredClone(lease));
    return true;
  }

  async renewLease(lease: RunLease): Promise<boolean> {
    const current = this.#leases.get(lease.runId);
    if (!current || current.ownerId !== lease.ownerId) return false;
    this.#leases.set(lease.runId, structuredClone(lease));
    return true;
  }

  async releaseLease(runId: RunId, ownerId: string): Promise<void> {
    if (this.#leases.get(runId)?.ownerId === ownerId) this.#leases.delete(runId);
  }
}
