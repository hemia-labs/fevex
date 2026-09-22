import { FevexRunError, type AgentEvent, type RunId } from '@fevex/core';
import type {
  AgentRun,
  DurableRunStore,
  ExecutionCommit,
  ExecutionCreate,
  ListEventsOptions,
  RunRecord,
  RunCheckpoint,
  RunLease,
  Session,
  SessionId,
  StoredRunCheckpoint,
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

  async getRun<TRun extends RunRecord<unknown> = AgentRun>(
    runId: RunId,
  ): Promise<TRun | undefined> {
    const row = this.#database.prepare(
      'SELECT data FROM runs WHERE id = ?',
    ).get(runId) as { data: string } | undefined;
    return row ? parse(row.data) : undefined;
  }

  async saveRun(run: RunRecord): Promise<void> {
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
    return this.#readSession(sessionId);
  }

  async saveSession(session: Session): Promise<void> {
    immediateTransaction(this.#database, () => {
      const current = this.#readSession(session.id);
      if (this.#sessionBusy(session.id) || (current?.revision ?? 0) !== (session.revision ?? 0)) {
        throw new FevexRunError('RUN_CONFLICT', `Session "${session.id}" is active or was modified`);
      }
      this.#saveSession({ ...session, revision: (session.revision ?? 0) + 1 });
    });
    session.revision = (session.revision ?? 0) + 1;
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

  async getCheckpoint<TCheckpoint extends StoredRunCheckpoint = RunCheckpoint>(
    runId: RunId,
  ): Promise<TCheckpoint | undefined> {
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

  async createExecution(create: ExecutionCreate): Promise<boolean> {
    const created = immediateTransaction(this.#database, () => {
      const existing = this.#database.prepare(
        'SELECT 1 FROM runs WHERE id = ?',
      ).get(create.run.id);
      if (existing) return false;
      const session = create.session;
      if (!session || session.id !== create.run.sessionId
        || this.#sessionBusy(session.id)
        || (this.#readSession(session.id)?.revision ?? 0) !== (session.revision ?? 0)) return false;
      this.#saveSession({ ...session, revision: (session.revision ?? 0) + 1 });
      const run = { ...create.run, revision: 1 };
      this.#database.prepare(
        'INSERT INTO runs (id, session_id, revision, data) VALUES (?, ?, ?, ?)',
      ).run(run.id, run.sessionId, run.revision, json(run));
      this.#database.prepare(
        'INSERT INTO checkpoints (run_id, data) VALUES (?, ?)',
      ).run(run.id, json(create.checkpoint));
      const insertEvent = this.#database.prepare(
        'INSERT INTO events (id, run_id, sequence, data) VALUES (?, ?, ?, ?)',
      );
      for (const event of create.events) {
        insertEvent.run(event.id, event.runId, event.sequence, json(event));
      }
      this.#database.prepare(
        'INSERT INTO leases (run_id, owner_id, expires_at, generation) VALUES (?, ?, ?, 1)',
      ).run(create.lease.runId, create.lease.ownerId, create.lease.expiresAt);
      return true;
    });
    if (created) {
      create.run.revision = 1;
      create.lease.generation = 1;
      create.session.revision = (create.session.revision ?? 0) + 1;
    }
    return created;
  }

  async commitExecution(commit: ExecutionCommit): Promise<boolean> {
    let revision: number | undefined;
    const committed = immediateTransaction(this.#database, () => {
      const current = this.#database.prepare(
        'SELECT revision FROM runs WHERE id = ?',
      ).get(commit.run.id) as { revision: number } | undefined;
      if (!current || current.revision !== commit.expectedRevision) return false;
      if (!commit.lease || !(commit.lease.generation > 0)) return false;
      const lease = this.#database.prepare(
        'SELECT owner_id, generation, expires_at FROM leases WHERE run_id = ?',
      ).get(commit.run.id) as { owner_id: string; generation: number; expires_at: string } | undefined;
      if (!lease || lease.owner_id !== commit.lease.ownerId
        || lease.generation !== commit.lease.generation || !(Date.parse(lease.expires_at) > Date.now())) return false;


      if (commit.session && (commit.session.id !== commit.run.sessionId
        || this.#sessionBusy(commit.session.id, commit.run.id)
        || (this.#readSession(commit.session.id)?.revision ?? 0) !== (commit.session.revision ?? 0))) return false;
      revision = commit.expectedRevision + 1;
      const run = { ...commit.run, revision };
      this.#database.prepare(
        'UPDATE runs SET session_id = ?, revision = ?, data = ? WHERE id = ?',
      ).run(run.sessionId, revision, json(run), run.id);
      if (commit.session) this.#saveSession({
        ...commit.session, revision: (commit.session.revision ?? 0) + 1,
      });
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

    if (committed) {
      commit.run.revision = revision!;
      if (commit.session) commit.session.revision = (commit.session.revision ?? 0) + 1;
    }
    return committed;
  }

  async acquireLease(lease: RunLease): Promise<boolean> {
    const row = immediateTransaction(this.#database, () => this.#database.prepare(
      `INSERT INTO leases (run_id, owner_id, expires_at, generation)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (run_id) DO UPDATE SET
         owner_id = excluded.owner_id,
         expires_at = excluded.expires_at,
         generation = leases.generation + 1
       WHERE leases.expires_at <= ?
       RETURNING generation`,
    ).get(lease.runId, lease.ownerId, lease.expiresAt, new Date().toISOString()) as { generation: number } | undefined);
    if (!row) return false;
    lease.generation = row.generation;
    return true;
  }

  async renewLease(lease: RunLease): Promise<boolean> {
    if (!(lease.generation > 0)) return false;
    return immediateTransaction(this.#database, () => this.#database.prepare(
      `UPDATE leases SET expires_at = ?
       WHERE run_id = ? AND owner_id = ? AND generation = ? AND expires_at > ?`,
    ).run(lease.expiresAt, lease.runId, lease.ownerId, lease.generation, new Date().toISOString()).changes === 1);
  }

  async releaseLease(runId: RunId, ownerId: string, generation: number): Promise<void> {
    if (!(generation > 0)) return;
    this.#database.prepare(
      'UPDATE leases SET expires_at = ? WHERE run_id = ? AND owner_id = ? AND generation = ?',
    ).run(new Date(0).toISOString(), runId, ownerId, generation);
  }

  #readSession(id: string): Session | undefined {
    const row = this.#database.prepare('SELECT data FROM sessions WHERE id = ?')
      .get(id) as { data: string } | undefined;
    return row ? parse<Session>(row.data) : undefined;
  }

  #sessionBusy(sessionId: string, exceptRunId = ''): boolean {
    return this.#database.prepare(
      "SELECT 1 FROM runs WHERE session_id = ? AND id != ? AND json_extract(data, '$.status') IN ('running', 'paused') LIMIT 1",
    ).get(sessionId, exceptRunId) != null;
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
