import { Pool, type PoolClient } from 'pg';
import type { AgentEvent, RunId } from '@fevex/core';
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
import { migration } from './migration';

export interface PostgresRunStore extends DurableRunStore {
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export type PostgresRunStoreOptions =
  | { connectionString: string; pool?: never }
  | { pool: Pool; connectionString?: never };

function clone<T>(value: T): T {
  return structuredClone(value);
}

class PgRunStore implements PostgresRunStore {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;

  constructor(options: PostgresRunStoreOptions) {
    if ('pool' in options && options.pool) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      if (typeof options.connectionString !== 'string' || !options.connectionString.trim()) {
        throw new TypeError('PostgreSQL connectionString cannot be empty');
      }
      this.#pool = new Pool({ connectionString: options.connectionString });
      this.#ownsPool = true;
    }
  }

  async migrate(): Promise<void> {
    await this.#pool.query(migration);
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async getRun<TRun extends RunRecord<unknown> = AgentRun>(
    runId: RunId,
  ): Promise<TRun | undefined> {
    const result = await this.#pool.query<{ data: TRun }>(
      'SELECT data FROM fevex.runs WHERE id = $1',
      [runId],
    );
    return result.rows[0] ? clone(result.rows[0].data) : undefined;
  }

  async saveRun(run: RunRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO fevex.runs (id, session_id, revision, data)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
       SET session_id = EXCLUDED.session_id,
           revision = EXCLUDED.revision,
           data = EXCLUDED.data`,
      [run.id, run.sessionId, run.revision, run],
    );
  }

  async getSession(sessionId: SessionId): Promise<Session | undefined> {
    const result = await this.#pool.query<{ data: Session }>(
      'SELECT data FROM fevex.sessions WHERE id = $1',
      [sessionId],
    );
    return result.rows[0] ? clone(result.rows[0].data) : undefined;
  }

  async saveSession(session: Session): Promise<void> {
    await this.#pool.query(
      `INSERT INTO fevex.sessions (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [session.id, session],
    );
  }

  async appendEvent(event: AgentEvent): Promise<void> {
    await this.#pool.query(
      'INSERT INTO fevex.events (id, run_id, sequence, data) VALUES ($1, $2, $3, $4)',
      [event.id, event.runId, event.sequence, event],
    );
  }

  async listEvents(runId: RunId, options: ListEventsOptions = {}): Promise<AgentEvent[]> {
    const result = await this.#pool.query<{ data: AgentEvent }>(
      'SELECT data FROM fevex.events WHERE run_id = $1 ORDER BY sequence',
      [runId],
    );
    if (!(await this.getRun(runId))) throw new Error(`Run "${runId}" does not exist`);
    let start = 0;
    if (options.after !== undefined) {
      const cursor = result.rows.findIndex(({ data }) => data.id === options.after);
      if (cursor < 0) {
        throw new Error(`Event cursor "${options.after}" does not exist in run "${runId}"`);
      }
      start = cursor + 1;
    }
    return clone(result.rows.slice(start).map(({ data }) => data));
  }

  async getCheckpoint<TCheckpoint extends StoredRunCheckpoint = RunCheckpoint>(
    runId: RunId,
  ): Promise<TCheckpoint | undefined> {
    const result = await this.#pool.query<{ data: TCheckpoint }>(
      'SELECT data FROM fevex.checkpoints WHERE run_id = $1',
      [runId],
    );
    return result.rows[0] ? clone(result.rows[0].data) : undefined;
  }

  async getToolExecution(
    runId: RunId,
    toolCallId: string,
  ): Promise<ToolExecutionRecord | undefined> {
    const result = await this.#pool.query<{ data: ToolExecutionRecord }>(
      `SELECT data FROM fevex.tool_executions
       WHERE run_id = $1 AND tool_call_id = $2`,
      [runId, toolCallId],
    );
    return result.rows[0] ? clone(result.rows[0].data) : undefined;
  }

  async createExecution(create: ExecutionCreate): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      if (create.session) await this.#upsertSession(client, create.session);
      const run = { ...clone(create.run), revision: 1 };
      const inserted = await client.query(
        `INSERT INTO fevex.runs (id, session_id, revision, data)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [run.id, run.sessionId, run.revision, run],
      );
      if (inserted.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        'INSERT INTO fevex.checkpoints (run_id, data) VALUES ($1, $2)',
        [run.id, create.checkpoint],
      );
      for (const event of create.events) {
        await client.query(
          'INSERT INTO fevex.events (id, run_id, sequence, data) VALUES ($1, $2, $3, $4)',
          [event.id, event.runId, event.sequence, event],
        );
      }
      await client.query(
        'INSERT INTO fevex.leases (run_id, owner_id, expires_at) VALUES ($1, $2, $3)',
        [create.lease.runId, create.lease.ownerId, create.lease.expiresAt],
      );
      await client.query('COMMIT');
      create.run.revision = 1;
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async commitExecution(commit: ExecutionCommit): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ revision: string }>(
        'SELECT revision FROM fevex.runs WHERE id = $1 FOR UPDATE',
        [commit.run.id],
      );
      if (
        !current.rows[0]
        || Number(current.rows[0].revision) !== commit.expectedRevision
      ) {
        await client.query('ROLLBACK');
        return false;
      }

      const run = clone(commit.run);
      run.revision = commit.expectedRevision + 1;
      await client.query(
        `UPDATE fevex.runs
         SET session_id = $2, revision = $3, data = $4
         WHERE id = $1`,
        [run.id, run.sessionId, run.revision, run],
      );
      if (commit.session) await this.#upsertSession(client, commit.session);
      if (commit.checkpoint === null) {
        await client.query('DELETE FROM fevex.checkpoints WHERE run_id = $1', [run.id]);
      } else if (commit.checkpoint) {
        await client.query(
          `INSERT INTO fevex.checkpoints (run_id, data) VALUES ($1, $2)
           ON CONFLICT (run_id) DO UPDATE SET data = EXCLUDED.data`,
          [run.id, commit.checkpoint],
        );
      }
      if (commit.toolExecution) {
        await client.query(
          `INSERT INTO fevex.tool_executions (run_id, tool_call_id, data)
           VALUES ($1, $2, $3)
           ON CONFLICT (run_id, tool_call_id) DO UPDATE SET data = EXCLUDED.data`,
          [run.id, commit.toolExecution.toolCallId, commit.toolExecution],
        );
      }
      for (const event of commit.events ?? []) {
        await client.query(
          'INSERT INTO fevex.events (id, run_id, sequence, data) VALUES ($1, $2, $3, $4)',
          [event.id, event.runId, event.sequence, event],
        );
      }
      await client.query('COMMIT');
      commit.run.revision = run.revision;
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async acquireLease(lease: RunLease): Promise<boolean> {
    const result = await this.#pool.query(
      `INSERT INTO fevex.leases (run_id, owner_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (run_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id, expires_at = EXCLUDED.expires_at
       WHERE fevex.leases.expires_at <= now()
          OR fevex.leases.owner_id = EXCLUDED.owner_id
       RETURNING run_id`,
      [lease.runId, lease.ownerId, lease.expiresAt],
    );
    return result.rowCount === 1;
  }

  async renewLease(lease: RunLease): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE fevex.leases SET expires_at = $3
       WHERE run_id = $1 AND owner_id = $2
       RETURNING run_id`,
      [lease.runId, lease.ownerId, lease.expiresAt],
    );
    return result.rowCount === 1;
  }

  async releaseLease(runId: RunId, ownerId: string): Promise<void> {
    await this.#pool.query(
      'DELETE FROM fevex.leases WHERE run_id = $1 AND owner_id = $2',
      [runId, ownerId],
    );
  }

  async #upsertSession(client: PoolClient, session: Session): Promise<void> {
    await client.query(
      `INSERT INTO fevex.sessions (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [session.id, session],
    );
  }
}

export function createPostgresRunStore(
  options: PostgresRunStoreOptions,
): PostgresRunStore {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('PostgreSQL run store options must be an object');
  }
  return new PgRunStore(options);
}
