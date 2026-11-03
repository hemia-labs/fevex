import {
  ArtifactError,
  type ArtifactCatalog,
  type ArtifactContent,
  type ArtifactDescriptor,
  type ArtifactId,
  type ArtifactQuery,
  type ArtifactRecord,
  type ArtifactStore,
  type ArtifactStoreContext,
  type ArtifactWrite,
} from './artifacts';
import { assertArtifactId, assertNotAborted, normalizeTenantId } from './internal';

export interface CatalogedArtifactStoreOptions {
  /** Byte store, for example `FileSystemArtifactStore` or `S3ArtifactStore`. */
  store: ArtifactStore;
  /** Metadata index, for example `SQLiteArtifactCatalog` or `PostgresArtifactCatalog`. */
  catalog: ArtifactCatalog;
}

/**
 * Composes a byte store with a queryable metadata catalog.
 *
 * `put` writes bytes first and then indexes metadata. If indexing fails, the
 * bytes are deleted so the catalog never points at a half-written artifact.
 */
export class CatalogedArtifactStore implements ArtifactStore {
  readonly #store: ArtifactStore;
  readonly #catalog: ArtifactCatalog;

  constructor(options: CatalogedArtifactStoreOptions) {
    this.#store = options.store;
    this.#catalog = options.catalog;
  }

  async put(input: ArtifactWrite, context?: ArtifactStoreContext): Promise<ArtifactDescriptor> {
    const descriptor = await this.#store.put(input, context);
    try {
      await this.#catalog.save(this.#record(descriptor, context), context);
    } catch (error) {
      await this.#store.delete?.(descriptor.artifactId, context);
      throw error;
    }
    return descriptor;
  }

  async get(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactContent | null> {
    assertNotAborted(context);
    assertArtifactId(artifactId);
    if (!(await this.#catalog.get(artifactId, context))) return null;
    const content = await this.#store.get(artifactId, context);
    if (!content) {
      throw new ArtifactError(
        'ARTIFACT_CORRUPT',
        `Artifact "${artifactId}" is indexed but its bytes are missing`,
      );
    }
    return content;
  }

  async head(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactDescriptor | null> {
    assertNotAborted(context);
    assertArtifactId(artifactId);
    return (await this.#catalog.get(artifactId, context))?.descriptor ?? null;
  }

  async delete(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<boolean> {
    assertNotAborted(context);
    assertArtifactId(artifactId);
    const existed = (await this.#catalog.get(artifactId, context)) !== null;
    await this.#catalog.delete(artifactId, context);
    await this.#store.delete?.(artifactId, context);
    return existed;
  }

  async list(
    query: ArtifactQuery = {},
    context?: ArtifactStoreContext,
  ): Promise<ArtifactRecord[]> {
    assertNotAborted(context);
    return this.#catalog.list(query, context);
  }

  async deleteByRun(runId: string, context?: ArtifactStoreContext): Promise<number> {
    assertNotAborted(context);
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact runId must be non-empty');
    }
    let deleted = 0;
    for (;;) {
      const records = await this.#catalog.list(
        { runId, includeExpired: true, limit: 100 },
        context,
      );
      if (records.length === 0) break;
      for (const record of records) {
        await this.delete(record.descriptor.artifactId, context);
        deleted += 1;
      }
    }
    return deleted;
  }

  #record(descriptor: ArtifactDescriptor, context?: ArtifactStoreContext): ArtifactRecord {
    return {
      descriptor,
      tenantId: normalizeTenantId(context),
      ...(context?.runId === undefined ? {} : { runId: context.runId }),
      ...(context?.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context?.actor?.id === undefined ? {} : { actorId: context.actor.id }),
    };
  }
}
