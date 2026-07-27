export const migration = `
  CREATE SCHEMA IF NOT EXISTS fevex;

  CREATE TABLE IF NOT EXISTS fevex.sessions (
    id text PRIMARY KEY,
    data jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fevex.runs (
    id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES fevex.sessions(id),
    revision bigint NOT NULL,
    data jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fevex.checkpoints (
    run_id text PRIMARY KEY REFERENCES fevex.runs(id) ON DELETE CASCADE,
    data jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fevex.events (
    id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES fevex.runs(id) ON DELETE CASCADE,
    sequence integer NOT NULL,
    data jsonb NOT NULL,
    UNIQUE (run_id, sequence)
  );

  CREATE TABLE IF NOT EXISTS fevex.tool_executions (
    run_id text NOT NULL REFERENCES fevex.runs(id) ON DELETE CASCADE,
    tool_call_id text NOT NULL,
    data jsonb NOT NULL,
    PRIMARY KEY (run_id, tool_call_id)
  );

  CREATE TABLE IF NOT EXISTS fevex.leases (
    run_id text PRIMARY KEY REFERENCES fevex.runs(id) ON DELETE CASCADE,
    owner_id text NOT NULL,
    expires_at timestamptz NOT NULL
  );
`;
