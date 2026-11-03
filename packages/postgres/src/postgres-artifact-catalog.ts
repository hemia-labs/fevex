import { Pool } from 'pg';
import {
  ArtifactError,
  artifactTenantId,
  assertArtifactId,
  type ArtifactCatalog,
  type ArtifactQuery,
  type ArtifactRecord,
  type ArtifactStoreContext,
} from '@fevex/core/artifacts';
import { migration } from './migration';

export interface PostgresArtifactCatalog extends ArtifactCatalog {
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export type PostgresArtifactCatalogOptions =
  | { connectionString: string; pool?: never }
  | { pool: Pool; connectionString?: never };

class PgArtifactCatalog implements PostgresArtifactCatalog {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;

  constructor(options: PostgresArtifactCatalogOptions) {
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

  async save(record: ArtifactRecord, context?: ArtifactStoreContext): Promise<void> {
    const tenantId = artifactTenantId(context);
    if (record.tenantId !== tenantId) {
      throw new ArtifactError(
        'ARTIFACT_INVALID_CONTEXT',
        'Artifact record tenant does not match the store context',
      );
    }
    assertArtifactId(record.descriptor.artifactId);
    const result = await this.#pool.query(
      `INSERT INTO fevex.artifacts
        (id, tenant_id, run_id, session_id, actor_id, mime_type, created_at, expires_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         run_id = EXCLUDED.run_id,
         session_id = EXCLUDED.session_id,
         actor_id = EXCLUDED.actor_id,
         mime_type = EXCLUDED.mime_type,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at,
         data = EXCLUDED.data
       WHERE fevex.artifacts.tenant_id = EXCLUDED.tenant_id`,
      [
        record.descriptor.artifactId,
        tenantId,
        record.runId ?? null,
        record.sessionId ?? null,
        record.actorId ?? null,
        record.descriptor.mimeType,
        record.descriptor.createdAt,
        record.descriptor.expiresAt ?? null,
        record,
      ],
    );
    if (result.rowCount === 0) {
      throw new ArtifactError(
        'ARTIFACT_CONFLICT',
        `Artifact "${record.descriptor.artifactId}" already exists in another tenant`,
      );
    }
  }

  async get(artifactId: string, context?: ArtifactStoreContext): Promise<ArtifactRecord | null> {
    assertArtifactId(artifactId);
    const result = await this.#pool.query<{ data: ArtifactRecord }>(
      `SELECT data FROM fevex.artifacts
       WHERE id = $1 AND tenant_id = $2
         AND (expires_at IS NULL OR expires_at > now())`,
      [artifactId, artifactTenantId(context)],
    );
    return result.rows[0] ? structuredClone(result.rows[0].data) : null;
  }

  async list(query: ArtifactQuery = {}, context?: ArtifactStoreContext): Promise<ArtifactRecord[]> {
    const conditions = ['tenant_id = $1'];
    const values: unknown[] = [artifactTenantId(context)];
    if (query.runId !== undefined) {
      values.push(query.runId);
      conditions.push(`run_id = $${values.length}`);
    }
    if (query.sessionId !== undefined) {
      values.push(query.sessionId);
      conditions.push(`session_id = $${values.length}`);
    }
    if (query.actorId !== undefined) {
      values.push(query.actorId);
      conditions.push(`actor_id = $${values.length}`);
    }
    if (query.mimeType !== undefined) {
      values.push(query.mimeType);
      conditions.push(`mime_type = $${values.length}`);
    }
    if (!query.includeExpired) {
      conditions.push('(expires_at IS NULL OR expires_at > now())');
    }
    values.push(limit(query.limit));

    const result = await this.#pool.query<{ data: ArtifactRecord }>(
      `SELECT data FROM fevex.artifacts
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    );
    return structuredClone(result.rows.map(({ data }) => data));
  }

  async delete(artifactId: string, context?: ArtifactStoreContext): Promise<boolean> {
    assertArtifactId(artifactId);
    const result = await this.#pool.query(
      'DELETE FROM fevex.artifacts WHERE id = $1 AND tenant_id = $2',
      [artifactId, artifactTenantId(context)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteByRun(runId: string, context?: ArtifactStoreContext): Promise<number> {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact runId must be non-empty');
    }
    const result = await this.#pool.query(
      'DELETE FROM fevex.artifacts WHERE tenant_id = $1 AND run_id = $2',
      [artifactTenantId(context), runId],
    );
    return result.rowCount ?? 0;
  }
}

function limit(value: number | undefined): number {
  const resolved = value ?? 100;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact query limit must be a positive integer');
  }
  return Math.min(resolved, 1000);
}

export function createPostgresArtifactCatalog(
  options: PostgresArtifactCatalogOptions,
): PostgresArtifactCatalog {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('PostgreSQL artifact catalog options must be an object');
  }
  return new PgArtifactCatalog(options);
}
