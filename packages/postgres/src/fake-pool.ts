import type { Pool } from 'pg';

/**
 * In-memory stand-in for a `pg` {@link Pool}, used to exercise `PgRunStore`
 * without a PostgreSQL server.
 *
 * It reproduces the server behaviours the store actually depends on:
 *
 * - unrecognised SQL throws, so changing a statement in the store fails loudly
 *   instead of silently passing against a stale fake;
 * - `data` columns round-trip through JSON, like `jsonb`;
 * - `revision` is returned as a string, like `bigint`;
 * - `BEGIN`/`COMMIT`/`ROLLBACK` snapshot and restore the whole dataset;
 * - primary keys and unique constraints are enforced, so `DO NOTHING` and
 *   `DO UPDATE` differ;
 * - `now()` is `Date.now()`, so lease expiry is driven by a past `expiresAt`;
 * - a released client rejects further statements.
 *
 * It cannot validate that PostgreSQL itself produces these results. The
 * `FEVEX_POSTGRES_URL` suite remains the source of truth for that.
 */
export interface FakePool extends Pool {
  /** Whether `end()` has been called. */
  readonly ended: boolean;
  /** Normalised statements in execution order. */
  readonly statements: readonly string[];
  /** Clients handed out by `connect()` that were never released. */
  readonly leakedClients: number;
  /** Makes the next statement containing `fragment` throw once. */
  failNext(fragment: string): void;
}

interface RunRow {
  sessionId: string | null;
  revision: number;
  data: string;
}

interface EventRow {
  id: string;
  runId: string;
  sequence: number;
  data: string;
}

interface LeaseRow {
  ownerId: string;
  expiresAt: string;
}

interface Tables {
  sessions: Map<string, string>;
  runs: Map<string, RunRow>;
  checkpoints: Map<string, string>;
  events: EventRow[];
  toolExecutions: Map<string, string>;
  leases: Map<string, LeaseRow>;
}

interface FakeResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

function emptyTables(): Tables {
  return {
    sessions: new Map(),
    runs: new Map(),
    checkpoints: new Map(),
    events: [],
    toolExecutions: new Map(),
    leases: new Map(),
  };
}

/** Rows are replaced rather than mutated, so a shallow copy is a full snapshot. */
function snapshot(tables: Tables): Tables {
  return {
    sessions: new Map(tables.sessions),
    runs: new Map(tables.runs),
    checkpoints: new Map(tables.checkpoints),
    events: [...tables.events],
    toolExecutions: new Map(tables.toolExecutions),
    leases: new Map(tables.leases),
  };
}

function restore(tables: Tables, from: Tables): void {
  tables.sessions = from.sessions;
  tables.runs = from.runs;
  tables.checkpoints = from.checkpoints;
  tables.events = from.events;
  tables.toolExecutions = from.toolExecutions;
  tables.leases = from.leases;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const json = (value: unknown): string => JSON.stringify(value) ?? 'null';
const rows = (values: Record<string, unknown>[]): FakeResult => ({
  rows: values,
  rowCount: values.length,
});
const NONE: FakeResult = { rows: [], rowCount: 0 };

export function createFakePool(): FakePool {
  const tables = emptyTables();
  const statements: string[] = [];
  let transaction: Tables | undefined;
  let openClients = 0;
  let ended = false;
  let failFragment: string | undefined;

  function execute(sql: string, values: readonly unknown[] = []): FakeResult {
    const statement = normalize(sql);
    statements.push(statement);

    if (failFragment !== undefined && statement.includes(failFragment)) {
      failFragment = undefined;
      throw new Error(`Fake PostgreSQL failure on: ${statement}`);
    }

    // Migration DDL. Every statement is IF NOT EXISTS, so replaying is a no-op.
    if (statement.startsWith('CREATE SCHEMA')) return NONE;

    switch (statement) {
      case 'BEGIN': {
        if (transaction) throw new Error('Fake PostgreSQL does not support nested transactions');
        transaction = snapshot(tables);
        return NONE;
      }
      case 'COMMIT': {
        transaction = undefined;
        return NONE;
      }
      case 'ROLLBACK': {
        if (transaction) restore(tables, transaction);
        transaction = undefined;
        return NONE;
      }

      case 'SELECT data FROM fevex.runs WHERE id = $1': {
        const row = tables.runs.get(values[0] as string);
        return row ? rows([{ data: JSON.parse(row.data) }]) : NONE;
      }

      case 'SELECT revision FROM fevex.runs WHERE id = $1 FOR UPDATE': {
        const row = tables.runs.get(values[0] as string);
        // bigint arrives as text over the wire; the store guards with Number().
        return row ? rows([{ revision: String(row.revision) }]) : NONE;
      }

      case 'INSERT INTO fevex.runs (id, session_id, revision, data) VALUES ($1, $2, $3, $4) '
        + 'ON CONFLICT (id) DO UPDATE SET session_id = EXCLUDED.session_id, '
        + 'revision = EXCLUDED.revision, data = EXCLUDED.data': {
        const id = values[0] as string;
        tables.runs.set(id, {
          sessionId: (values[1] as string | undefined) ?? null,
          revision: values[2] as number,
          data: json(values[3]),
        });
        return rows([{ id }]);
      }

      case 'INSERT INTO fevex.runs (id, session_id, revision, data) VALUES ($1, $2, $3, $4) '
        + 'ON CONFLICT (id) DO NOTHING RETURNING id': {
        const id = values[0] as string;
        if (tables.runs.has(id)) return NONE;
        tables.runs.set(id, {
          sessionId: (values[1] as string | undefined) ?? null,
          revision: values[2] as number,
          data: json(values[3]),
        });
        return rows([{ id }]);
      }

      case 'UPDATE fevex.runs SET session_id = $2, revision = $3, data = $4 WHERE id = $1': {
        const id = values[0] as string;
        if (!tables.runs.has(id)) return NONE;
        tables.runs.set(id, {
          sessionId: (values[1] as string | undefined) ?? null,
          revision: values[2] as number,
          data: json(values[3]),
        });
        return rows([{ id }]);
      }

      case 'SELECT data FROM fevex.sessions WHERE id = $1': {
        const data = tables.sessions.get(values[0] as string);
        return data ? rows([{ data: JSON.parse(data) }]) : NONE;
      }

      case 'INSERT INTO fevex.sessions (id, data) VALUES ($1, $2) '
        + 'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data': {
        const id = values[0] as string;
        tables.sessions.set(id, json(values[1]));
        return rows([{ id }]);
      }

      case 'INSERT INTO fevex.events (id, run_id, sequence, data) VALUES ($1, $2, $3, $4)': {
        const id = values[0] as string;
        const runId = values[1] as string;
        const sequence = values[2] as number;
        if (tables.events.some((event) => event.id === id)) {
          throw new Error(`duplicate key value violates unique constraint "events_pkey" (${id})`);
        }
        if (tables.events.some((event) => event.runId === runId && event.sequence === sequence)) {
          throw new Error(
            `duplicate key value violates unique constraint "events_run_id_sequence_key"`,
          );
        }
        tables.events.push({ id, runId, sequence, data: json(values[3]) });
        return rows([{ id }]);
      }

      case 'SELECT data FROM fevex.events WHERE run_id = $1 ORDER BY sequence': {
        const runId = values[0] as string;
        return rows(
          tables.events
            .filter((event) => event.runId === runId)
            .sort((a, b) => a.sequence - b.sequence)
            .map((event) => ({ data: JSON.parse(event.data) })),
        );
      }

      case 'SELECT data FROM fevex.checkpoints WHERE run_id = $1': {
        const data = tables.checkpoints.get(values[0] as string);
        return data ? rows([{ data: JSON.parse(data) }]) : NONE;
      }

      case 'INSERT INTO fevex.checkpoints (run_id, data) VALUES ($1, $2)': {
        const runId = values[0] as string;
        if (tables.checkpoints.has(runId)) {
          throw new Error(
            `duplicate key value violates unique constraint "checkpoints_pkey" (${runId})`,
          );
        }
        tables.checkpoints.set(runId, json(values[1]));
        return rows([{ run_id: runId }]);
      }

      case 'INSERT INTO fevex.checkpoints (run_id, data) VALUES ($1, $2) '
        + 'ON CONFLICT (run_id) DO UPDATE SET data = EXCLUDED.data': {
        const runId = values[0] as string;
        tables.checkpoints.set(runId, json(values[1]));
        return rows([{ run_id: runId }]);
      }

      case 'DELETE FROM fevex.checkpoints WHERE run_id = $1': {
        const runId = values[0] as string;
        const existed = tables.checkpoints.delete(runId);
        return existed ? rows([{ run_id: runId }]) : NONE;
      }

      case 'SELECT data FROM fevex.tool_executions WHERE run_id = $1 AND tool_call_id = $2': {
        const data = tables.toolExecutions.get(`${values[0] as string}:${values[1] as string}`);
        return data ? rows([{ data: JSON.parse(data) }]) : NONE;
      }

      case 'INSERT INTO fevex.tool_executions (run_id, tool_call_id, data) VALUES ($1, $2, $3) '
        + 'ON CONFLICT (run_id, tool_call_id) DO UPDATE SET data = EXCLUDED.data': {
        const key = `${values[0] as string}:${values[1] as string}`;
        tables.toolExecutions.set(key, json(values[2]));
        return rows([{ run_id: values[0] }]);
      }

      case 'INSERT INTO fevex.leases (run_id, owner_id, expires_at) VALUES ($1, $2, $3)': {
        const runId = values[0] as string;
        if (tables.leases.has(runId)) {
          throw new Error(
            `duplicate key value violates unique constraint "leases_pkey" (${runId})`,
          );
        }
        tables.leases.set(runId, {
          ownerId: values[1] as string,
          expiresAt: values[2] as string,
        });
        return rows([{ run_id: runId }]);
      }

      case 'INSERT INTO fevex.leases (run_id, owner_id, expires_at) VALUES ($1, $2, $3) '
        + 'ON CONFLICT (run_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, '
        + 'expires_at = EXCLUDED.expires_at WHERE fevex.leases.expires_at <= now() '
        + 'OR fevex.leases.owner_id = EXCLUDED.owner_id RETURNING run_id': {
        const runId = values[0] as string;
        const ownerId = values[1] as string;
        const expiresAt = values[2] as string;
        const current = tables.leases.get(runId);
        if (current) {
          const expired = Date.parse(current.expiresAt) <= Date.now();
          if (!expired && current.ownerId !== ownerId) return NONE;
        }
        tables.leases.set(runId, { ownerId, expiresAt });
        return rows([{ run_id: runId }]);
      }

      case 'UPDATE fevex.leases SET expires_at = $3 WHERE run_id = $1 AND owner_id = $2 '
        + 'RETURNING run_id': {
        const runId = values[0] as string;
        const ownerId = values[1] as string;
        const current = tables.leases.get(runId);
        if (!current || current.ownerId !== ownerId) return NONE;
        tables.leases.set(runId, { ownerId, expiresAt: values[2] as string });
        return rows([{ run_id: runId }]);
      }

      case 'DELETE FROM fevex.leases WHERE run_id = $1 AND owner_id = $2': {
        const runId = values[0] as string;
        const current = tables.leases.get(runId);
        if (!current || current.ownerId !== (values[1] as string)) return NONE;
        tables.leases.delete(runId);
        return rows([{ run_id: runId }]);
      }

      default:
        throw new Error(`Unhandled SQL in fake PostgreSQL pool: ${statement}`);
    }
  }

  const fake = {
    get ended() {
      return ended;
    },
    get statements() {
      return statements;
    },
    get leakedClients() {
      return openClients;
    },
    failNext(fragment: string) {
      failFragment = fragment;
    },
    async query(sql: string, values?: readonly unknown[]) {
      if (ended) throw new Error('Cannot use a pool after calling end()');
      return execute(sql, values);
    },
    async connect() {
      if (ended) throw new Error('Cannot use a pool after calling end()');
      openClients += 1;
      let released = false;
      return {
        async query(sql: string, values?: readonly unknown[]) {
          if (released) throw new Error('Cannot use a client after calling release()');
          return execute(sql, values);
        },
        release() {
          if (released) throw new Error('Client released twice');
          released = true;
          openClients -= 1;
        },
      };
    },
    async end() {
      ended = true;
    },
  };

  // Single documented cast: the fake implements the narrow slice of `Pool`
  // that `PgRunStore` uses, not the full driver surface.
  return fake as unknown as FakePool;
}
