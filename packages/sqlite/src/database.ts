import { chmodSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export interface SQLiteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
}

export interface SQLiteDatabase {
  close(): void;
  exec(sql: string): unknown;
  prepare(sql: string): SQLiteStatement;
}

type SQLiteDatabaseConstructor = new (filename: string) => SQLiteDatabase;

const require = createRequire(import.meta.url);
const schemaVersion = 1;
const schema = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    revision INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    data TEXT NOT NULL,
    UNIQUE (run_id, sequence)
  );

  CREATE TABLE IF NOT EXISTS tool_executions (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (run_id, tool_call_id)
  );

  CREATE TABLE IF NOT EXISTS leases (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`;

function openDriver(filename: string): SQLiteDatabase {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    const module = require('bun:sqlite') as {
      Database: SQLiteDatabaseConstructor;
    };
    return new module.Database(filename);
  }

  const module = require('better-sqlite3') as
    | SQLiteDatabaseConstructor
    | { default: SQLiteDatabaseConstructor };
  const Database = typeof module === 'function' ? module : module.default;
  return new Database(filename);
}

export function immediateTransaction<T>(
  database: SQLiteDatabase,
  work: () => T,
): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

function migrate(database: SQLiteDatabase): void {
  const version = (
    database.prepare('PRAGMA user_version').get() as {
      user_version: number;
    }
  ).user_version;
  if (version > schemaVersion) {
    throw new Error(
      `SQLite database version ${version} is newer than supported version ${schemaVersion}`,
    );
  }
  if (version === schemaVersion) return;
  immediateTransaction(database, () => {
    database.exec(schema);
    database.exec(`PRAGMA user_version = ${schemaVersion}`);
  });
}

export function openSQLiteDatabase(filename: string): SQLiteDatabase {
  const path = filename === ':memory:' ? filename : resolve(filename);
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  const database = openDriver(path);
  try {
    if (path !== ':memory:') {
      try {
        chmodSync(path, 0o600);
      } catch {
        // File permissions are best-effort on unsupported systems.
      }
    }
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
    `);
    migrate(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
