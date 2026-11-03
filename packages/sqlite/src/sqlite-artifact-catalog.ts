import {
  ArtifactError,
  artifactTenantId,
  assertArtifactId,
  type ArtifactCatalog,
  type ArtifactQuery,
  type ArtifactRecord,
  type ArtifactStoreContext,
} from '@fevex/core/artifacts';
import { openSQLiteDatabase, type SQLiteDatabase } from './database';

export interface SQLiteArtifactCatalog extends ArtifactCatalog {
  close(): Promise<void>;
}

export interface SQLiteArtifactCatalogOptions {
  filename: string;
}

class LocalSQLiteArtifactCatalog implements SQLiteArtifactCatalog {
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

  async save(record: ArtifactRecord, context?: ArtifactStoreContext): Promise<void> {
    const tenantId = artifactTenantId(context);
    if (record.tenantId !== tenantId) {
      throw new ArtifactError(
        'ARTIFACT_INVALID_CONTEXT',
        'Artifact record tenant does not match the store context',
      );
    }
    assertArtifactId(record.descriptor.artifactId);
    const result = this.#database.prepare(
      `INSERT INTO artifacts
        (id, tenant_id, run_id, session_id, actor_id, mime_type, created_at, expires_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         run_id = excluded.run_id,
         session_id = excluded.session_id,
         actor_id = excluded.actor_id,
         mime_type = excluded.mime_type,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         data = excluded.data
       WHERE artifacts.tenant_id = excluded.tenant_id`,
    ).run(
      record.descriptor.artifactId,
      tenantId,
      record.runId ?? null,
      record.sessionId ?? null,
      record.actorId ?? null,
      record.descriptor.mimeType,
      record.descriptor.createdAt,
      record.descriptor.expiresAt ?? null,
      JSON.stringify(record),
    );
    if (result.changes === 0) {
      throw new ArtifactError(
        'ARTIFACT_CONFLICT',
        `Artifact "${record.descriptor.artifactId}" already exists in another tenant`,
      );
    }
  }

  async get(artifactId: string, context?: ArtifactStoreContext): Promise<ArtifactRecord | null> {
    assertArtifactId(artifactId);
    const row = this.#database.prepare(
      `SELECT data FROM artifacts
       WHERE id = ? AND tenant_id = ?
         AND (expires_at IS NULL OR expires_at > ?)`,
    ).get(artifactId, artifactTenantId(context), new Date().toISOString()) as
      | { data: string }
      | undefined;
    return row ? parseRecord(row.data) : null;
  }

  async list(query: ArtifactQuery = {}, context?: ArtifactStoreContext): Promise<ArtifactRecord[]> {
    const tenantId = artifactTenantId(context);
    const conditions = ['tenant_id = ?'];
    const values: unknown[] = [tenantId];
    if (query.runId !== undefined) {
      conditions.push('run_id = ?');
      values.push(query.runId);
    }
    if (query.sessionId !== undefined) {
      conditions.push('session_id = ?');
      values.push(query.sessionId);
    }
    if (query.actorId !== undefined) {
      conditions.push('actor_id = ?');
      values.push(query.actorId);
    }
    if (query.mimeType !== undefined) {
      conditions.push('mime_type = ?');
      values.push(query.mimeType);
    }
    if (!query.includeExpired) {
      conditions.push('(expires_at IS NULL OR expires_at > ?)');
      values.push(new Date().toISOString());
    }
    values.push(limit(query.limit));

    const rows = this.#database.prepare(
      `SELECT data FROM artifacts
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).all(...values) as Array<{ data: string }>;
    return rows.map(({ data }) => parseRecord(data));
  }

  async delete(artifactId: string, context?: ArtifactStoreContext): Promise<boolean> {
    assertArtifactId(artifactId);
    const result = this.#database.prepare(
      'DELETE FROM artifacts WHERE id = ? AND tenant_id = ?',
    ).run(artifactId, artifactTenantId(context));
    return result.changes > 0;
  }

  async deleteByRun(runId: string, context?: ArtifactStoreContext): Promise<number> {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact runId must be non-empty');
    }
    const result = this.#database.prepare(
      'DELETE FROM artifacts WHERE tenant_id = ? AND run_id = ?',
    ).run(artifactTenantId(context), runId);
    return result.changes;
  }
}

function limit(value: number | undefined): number {
  const resolved = value ?? 100;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact query limit must be a positive integer');
  }
  return Math.min(resolved, 1000);
}

function parseRecord(value: string): ArtifactRecord {
  try {
    const parsed = JSON.parse(value) as ArtifactRecord;
    if (
      !parsed
      || typeof parsed !== 'object'
      || typeof parsed.tenantId !== 'string'
      || !parsed.descriptor
      || typeof parsed.descriptor.artifactId !== 'string'
    ) {
      throw new Error('malformed');
    }
    return parsed;
  } catch {
    throw new ArtifactError('ARTIFACT_CORRUPT', 'Artifact metadata is malformed');
  }
}

export function createSQLiteArtifactCatalog(
  options: SQLiteArtifactCatalogOptions,
): SQLiteArtifactCatalog {
  if (
    typeof options !== 'object'
    || options === null
    || typeof options.filename !== 'string'
    || !options.filename.trim()
  ) {
    throw new TypeError('SQLite filename must be a non-empty string');
  }
  return new LocalSQLiteArtifactCatalog(options.filename);
}
