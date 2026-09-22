import { Pool, type PoolClient } from 'pg';
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
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const current = await this.#lockSession(client, session.id, session);
      if ((current?.revision ?? 0) !== (session.revision ?? 0)
        || await this.#sessionBusy(client, session.id)) {
        throw new FevexRunError('RUN_CONFLICT', `Session "${session.id}" is active or was modified`);
      }
      await this.#upsertSession(client, { ...session, revision: (session.revision ?? 0) + 1 });
      await client.query('COMMIT');
      session.revision = (session.revision ?? 0) + 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
      const session = create.session;
      if (!session || session.id !== create.run.sessionId) {
        await client.query('ROLLBACK');
        return false;
      }
      const currentSession = await this.#lockSession(client, session.id, session);
      if ((currentSession?.revision ?? 0) !== (session.revision ?? 0)
        || await this.#sessionBusy(client, session.id)) {
        await client.query('ROLLBACK');
        return false;
      }
      await this.#upsertSession(client, { ...session, revision: (session.revision ?? 0) + 1 });
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
        'INSERT INTO fevex.leases (run_id, owner_id, expires_at, generation) VALUES ($1, $2, $3, 1)',
        [create.lease.runId, create.lease.ownerId, create.lease.expiresAt],
      );
      await client.query('COMMIT');
      create.run.revision = 1;
      create.lease.generation = 1;
      session.revision = (session.revision ?? 0) + 1;
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
      // Match creation's session-before-run lock order, including duplicate run IDs.
      if (commit.session) {
        const currentSession = await this.#lockSession(client, commit.run.sessionId);
        if (!currentSession || commit.session.id !== commit.run.sessionId
          || (currentSession.revision ?? 0) !== (commit.session.revision ?? 0)
          || await this.#sessionBusy(client, commit.run.sessionId, commit.run.id)) {
          await client.query('ROLLBACK');
          return false;
        }
      }
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

      if (!commit.lease || !(commit.lease.generation > 0)) {
        await client.query('ROLLBACK');
        return false;
      }
      // Lock the lease row against takeover/renewal, then check the current clock.
      await client.query('SELECT run_id FROM fevex.leases WHERE run_id = $1 FOR UPDATE', [commit.run.id]);
      const owned = await client.query(
        `SELECT run_id FROM fevex.leases WHERE run_id = $1 AND owner_id = $2
         AND generation = $3 AND expires_at > clock_timestamp()`,
        [commit.run.id, commit.lease.ownerId, commit.lease.generation],
      );
      if (owned.rowCount !== 1) {
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
      if (commit.session) await this.#upsertSession(client, {
        ...commit.session, revision: (commit.session.revision ?? 0) + 1,
      });
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
      if (commit.session) commit.session.revision = (commit.session.revision ?? 0) + 1;
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async acquireLease(lease: RunLease): Promise<boolean> {
    const result = await this.#pool.query<{ generation: string }>(
      `INSERT INTO fevex.leases (run_id, owner_id, expires_at, generation)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (run_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id, expires_at = EXCLUDED.expires_at,
           generation = fevex.leases.generation + 1
       WHERE fevex.leases.expires_at <= clock_timestamp()
       RETURNING generation`,
      [lease.runId, lease.ownerId, lease.expiresAt],
    );
    if (result.rowCount !== 1) return false;
    lease.generation = Number(result.rows[0]!.generation);
    return true;
  }

  async renewLease(lease: RunLease): Promise<boolean> {
    if (!(lease.generation > 0)) return false;
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT run_id FROM fevex.leases WHERE run_id = $1 FOR UPDATE', [lease.runId]);
      const result = await client.query(
        `UPDATE fevex.leases SET expires_at = $3
         WHERE run_id = $1 AND owner_id = $2 AND generation = $4
           AND expires_at > clock_timestamp()
         RETURNING run_id`,
        [lease.runId, lease.ownerId, lease.expiresAt, lease.generation],
      );
      await client.query('COMMIT');
      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseLease(runId: RunId, ownerId: string, generation: number): Promise<void> {
    if (!(generation > 0)) return;
    await this.#pool.query(
      `UPDATE fevex.leases SET expires_at = 'epoch'
       WHERE run_id = $1 AND owner_id = $2 AND generation = $3`,
      [runId, ownerId, generation],
    );
  }

  async #lockSession(client: PoolClient, id: string, initial?: Session): Promise<Session | undefined> {
    if (initial) await client.query(
      'INSERT INTO fevex.sessions (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [id, { ...initial, revision: 0 }],
    );
    const result = await client.query<{ data: Session }>(
      'SELECT data FROM fevex.sessions WHERE id = $1 FOR UPDATE', [id],
    );
    return result.rows[0]?.data;
  }

  async #sessionBusy(client: PoolClient, sessionId: string, exceptRunId = ''): Promise<boolean> {
    const result = await client.query(
      "SELECT 1 FROM fevex.runs WHERE session_id = $1 AND id != $2 AND data->>'status' IN ('running', 'paused') LIMIT 1",
      [sessionId, exceptRunId],
    );
    return result.rows.length !== 0;
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
