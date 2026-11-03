import {
  type ArtifactContent,
  type ArtifactDescriptor,
  type ArtifactId,
  type ArtifactStore,
  type ArtifactStoreContext,
  type ArtifactWrite,
} from './artifacts';
import {
  assertArtifactId,
  assertArtifactWrite,
  assertNotAborted,
  copyBytes,
  createDescriptor,
  isExpired,
  normalizeTenantId,
  resolveLimits,
  type ArtifactStoreLimits,
} from './internal';

export interface InMemoryArtifactStoreOptions extends ArtifactStoreLimits {}

interface StoredArtifact {
  tenantId: string;
  descriptor: ArtifactDescriptor;
  bytes: Uint8Array;
}

/** Volatile artifact store for tests and local development. */
export class InMemoryArtifactStore implements ArtifactStore {
  readonly #records = new Map<string, StoredArtifact>();
  readonly #limits: ArtifactStoreLimits;

  constructor(options: InMemoryArtifactStoreOptions = {}) {
    this.#limits = resolveLimits(options);
  }

  async put(input: ArtifactWrite, context?: ArtifactStoreContext): Promise<ArtifactDescriptor> {
    assertNotAborted(context);
    assertArtifactWrite(input, this.#limits);
    const tenantId = normalizeTenantId(context);
    const descriptor = createDescriptor(input, this.#limits);
    this.#records.set(key(tenantId, descriptor.artifactId), {
      tenantId,
      descriptor: structuredClone(descriptor),
      bytes: copyBytes(input.bytes),
    });
    return structuredClone(descriptor);
  }

  async get(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactContent | null> {
    assertNotAborted(context);
    assertArtifactId(artifactId);
    const record = this.#records.get(key(normalizeTenantId(context), artifactId));
    if (!record || isExpired(record.descriptor)) return null;
    return {
      descriptor: structuredClone(record.descriptor),
      bytes: copyBytes(record.bytes),
    };
  }

  async head(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactDescriptor | null> {
    assertNotAborted(context);
    assertArtifactId(artifactId);
    const record = this.#records.get(key(normalizeTenantId(context), artifactId));
    return record && !isExpired(record.descriptor) ? structuredClone(record.descriptor) : null;
  }

  async delete(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<boolean> {
    assertNotAborted(context);
    assertArtifactId(artifactId);
    return this.#records.delete(key(normalizeTenantId(context), artifactId));
  }
}

function key(tenantId: string, artifactId: string): string {
  return `${tenantId}:${artifactId}`;
}
