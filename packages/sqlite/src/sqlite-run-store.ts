import type { AgentEvent, RunId } from '@fevex/core';
import type {
  AgentRun,
  DurableRunStore,
  ExecutionCommit,
  ListEventsOptions,
  RunCheckpoint,
  RunLease,
  Session,
  SessionId,
  ToolExecutionRecord,
} from '@fevex/core/runtime';
import {
  immediateTransaction,
  openSQLiteDatabase,
  type SQLiteDatabase,
} from './database';

export interface SQLiteRunStore extends DurableRunStore {
  close(): Promise<void>;
}

export interface SQLiteRunStoreOptions {
  filename: string;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

class LocalSQLiteRunStore implements SQLiteRunStore {
  readonly #database: SQLiteDatabase;
  #closed = false;

  constructor(filename: string) {
    this.#database = openSQLiteDatabase(filename);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  async getRun(runId: RunId): Promise<AgentRun | undefined> {
    const row = this.#database.prepare(
      'SELECT data FROM runs WHERE id = ?',
    ).get(runId) as { data: string } | undefined;
    return row ? parse(row.data) : undefined;
  }

  async saveRun(run: AgentRun): Promise<void> {
    this.#database.prepare(
      `INSERT INTO runs (id, session_id, revision, data)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         session_id = excluded.session_id,
         revision = excluded.revision,
         data = excluded.data`,
    ).run(run.id, run.sessionId, run.revision, json(run));
  }

  async getSession(sessionId: SessionId): Promise<Session | undefined> {
    const row = this.#database.prepare(
      'SELECT data FROM sessions WHERE id = ?',
    ).get(sessionId) as { data: string } | undefined;
    return row ? parse(row.data) : undefined;
  }

  async saveSession(session: Session): Promise<void> {
    this.#saveSession(session);
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    this.#database.prepare(
      'INSERT INTO events (id, run_id, sequence, data) VALUES (?, ?, ?, ?)',
    ).run(event.id, event.runId, event.sequence, json(event));
  }

  async listEvents(runId: RunId, options: ListEventsOptions = {}): Promise<AgentEvent[]> {
    if (!(await this.getRun(runId))) throw new Error(`Run "${runId}" does not exist`);
    const events = (this.#database.prepare(
      'SELECT data FROM events WHERE run_id = ? ORDER BY sequence',
    ).all(runId) as Array<{ data: string }>).map(({ data }) => parse<AgentEvent>(data));
    if (options.after === undefined) return events;
    const cursor = events.findIndex(({ id }) => id === options.after);
    if (cursor < 0) {
      throw new Error(`Event cursor "${options.after}" does not exist in run "${runId}"`);
    }
    return events.slice(cursor + 1);
  }

  async getCheckpoint(runId: RunId): Promise<RunCheckpoint | undefined> {
    const row = this.#database.prepare(
      'SELECT data FROM checkpoints WHERE run_id = ?',
    ).get(runId) as { data: string } | undefined;
    return row ? parse(row.data) : undefined;
  }

  async getToolExecution(
    runId: RunId,
    toolCallId: string,
  ): Promise<ToolExecutionRecord | undefined> {
    const row = this.#database.prepare(
      'SELECT data FROM tool_executions WHERE run_id = ? AND tool_call_id = ?',
    ).get(runId, toolCallId) as { data: string } | undefined;
    return row ? parse(row.data) : undefined;
  }

  async commitExecution(commit: ExecutionCommit): Promise<boolean> {
    let revision: number | undefined;
    const committed = immediateTransaction(this.#database, () => {
      const current = this.#database.prepare(
        'SELECT revision FROM runs WHERE id = ?',
      ).get(commit.run.id) as { revision: number } | undefined;
      if (!current || current.revision !== commit.expectedRevision) return false;

      revision = commit.expectedRevision + 1;
      const run = { ...commit.run, revision };
      this.#database.prepare(
        'UPDATE runs SET session_id = ?, revision = ?, data = ? WHERE id = ?',
      ).run(run.sessionId, revision, json(run), run.id);
      if (commit.session) this.#saveSession(commit.session);
      if (commit.checkpoint === null) {
        this.#database.prepare('DELETE FROM checkpoints WHERE run_id = ?').run(run.id);
      } else if (commit.checkpoint) {
        this.#database.prepare(
          `INSERT INTO checkpoints (run_id, data) VALUES (?, ?)
           ON CONFLICT (run_id) DO UPDATE SET data = excluded.data`,
        ).run(run.id, json(commit.checkpoint));
      }
      if (commit.toolExecution) {
        this.#database.prepare(
          `INSERT INTO tool_executions (run_id, tool_call_id, data)
           VALUES (?, ?, ?)
           ON CONFLICT (run_id, tool_call_id) DO UPDATE SET data = excluded.data`,
        ).run(
          run.id,
          commit.toolExecution.toolCallId,
          json(commit.toolExecution),
        );
      }
      const insertEvent = this.#database.prepare(
        'INSERT INTO events (id, run_id, sequence, data) VALUES (?, ?, ?, ?)',
      );
      for (const event of commit.events ?? []) {
        insertEvent.run(event.id, event.runId, event.sequence, json(event));
      }
      return true;
    });

    if (committed) commit.run.revision = revision!;
    return committed;
  }

  async acquireLease(lease: RunLease): Promise<boolean> {
    const row = this.#database.prepare(
      `INSERT INTO leases (run_id, owner_id, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET
         owner_id = excluded.owner_id,
         expires_at = excluded.expires_at
       WHERE leases.expires_at <= ? OR leases.owner_id = excluded.owner_id
       RETURNING run_id`,
    ).get(lease.runId, lease.ownerId, lease.expiresAt, new Date().toISOString());
    return row != null;
  }

  async renewLease(lease: RunLease): Promise<boolean> {
    return this.#database.prepare(
      `UPDATE leases SET expires_at = ?
       WHERE run_id = ? AND owner_id = ?`,
    ).run(lease.expiresAt, lease.runId, lease.ownerId).changes === 1;
  }

  async releaseLease(runId: RunId, ownerId: string): Promise<void> {
    this.#database.prepare(
      'DELETE FROM leases WHERE run_id = ? AND owner_id = ?',
    ).run(runId, ownerId);
  }

  #saveSession(session: Session): void {
    this.#database.prepare(
      `INSERT INTO sessions (id, data) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
    ).run(session.id, json(session));
  }
}

export function createSQLiteRunStore(options: SQLiteRunStoreOptions): SQLiteRunStore {
  if (
    typeof options !== 'object'
    || options === null
    || typeof options.filename !== 'string'
    || !options.filename.trim()
  ) {
    throw new TypeError('SQLite filename must be a non-empty string');
  }
  return new LocalSQLiteRunStore(options.filename);
}
