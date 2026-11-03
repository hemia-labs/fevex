import {
  ArtifactError,
  artifactTenantId,
  assertArtifactId,
  type ArtifactCatalog,
  type ArtifactId,
  type ArtifactQuery,
  type ArtifactRecord,
  type ArtifactStoreContext,
} from './artifacts';

/** Volatile artifact metadata catalog for tests and local development. */
export class InMemoryArtifactCatalog implements ArtifactCatalog {
  readonly #records = new Map<string, ArtifactRecord>();

  async save(record: ArtifactRecord, context?: ArtifactStoreContext): Promise<void> {
    const tenantId = artifactTenantId(context);
    if (record.tenantId !== tenantId) {
      throw new ArtifactError(
        'ARTIFACT_INVALID_CONTEXT',
        'Artifact record tenant does not match the store context',
      );
    }
    assertArtifactId(record.descriptor.artifactId);
    this.#records.set(key(tenantId, record.descriptor.artifactId), structuredClone(record));
  }

  async get(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactRecord | null> {
    assertArtifactId(artifactId);
    const record = this.#records.get(key(artifactTenantId(context), artifactId));
    return record && !isExpired(record) ? structuredClone(record) : null;
  }

  async list(query: ArtifactQuery = {}, context?: ArtifactStoreContext): Promise<ArtifactRecord[]> {
    const tenantId = artifactTenantId(context);
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact query limit must be a positive integer');
    }
    return [...this.#records.values()]
      .filter((record) =>
        record.tenantId === tenantId
        && (query.includeExpired || !isExpired(record))
        && (query.runId === undefined || record.runId === query.runId)
        && (query.sessionId === undefined || record.sessionId === query.sessionId)
        && (query.actorId === undefined || record.actorId === query.actorId)
        && (query.mimeType === undefined || record.descriptor.mimeType === query.mimeType))
      .sort((left, right) =>
        right.descriptor.createdAt.localeCompare(left.descriptor.createdAt)
        || right.descriptor.artifactId.localeCompare(left.descriptor.artifactId))
      .slice(0, Math.min(limit, 1000))
      .map((record) => structuredClone(record));
  }

  async delete(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<boolean> {
    assertArtifactId(artifactId);
    return this.#records.delete(key(artifactTenantId(context), artifactId));
  }

  async deleteByRun(runId: string, context?: ArtifactStoreContext): Promise<number> {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact runId must be non-empty');
    }
    const tenantId = artifactTenantId(context);
    let deleted = 0;
    for (const [recordKey, record] of this.#records) {
      if (record.tenantId === tenantId && record.runId === runId) {
        this.#records.delete(recordKey);
        deleted += 1;
      }
    }
    return deleted;
  }
}

function key(tenantId: string, artifactId: string): string {
  return `${tenantId}:${artifactId}`;
}

function isExpired(record: ArtifactRecord): boolean {
  return record.descriptor.expiresAt !== undefined
    && Date.parse(record.descriptor.expiresAt) <= Date.now();
}
