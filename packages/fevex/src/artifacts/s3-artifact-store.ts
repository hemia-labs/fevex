import {
  ArtifactError,
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
  parseDescriptor,
  resolveLimits,
  type ArtifactStoreLimits,
} from './internal';

/**
 * Minimal S3-compatible object client.
 *
 * Wrap `@aws-sdk/client-s3`, a Cloudflare R2 client, MinIO or any other
 * S3-compatible SDK with this interface. Fevex does not depend on an object
 * storage SDK.
 */
export interface S3ObjectClient {
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<void>;
  getObject(input: { key: string }): Promise<Uint8Array | null>;
  deleteObject(input: { key: string }): Promise<void>;
}

export interface S3ArtifactStoreOptions extends ArtifactStoreLimits {
  client: S3ObjectClient;
  /** Key prefix. Defaults to `fevex`. */
  prefix?: string;
}

/**
 * Artifact store for S3-compatible object storage (S3, R2, MinIO, GCS via an
 * S3 gateway, and similar).
 *
 * Bytes are stored at `<prefix>/<tenant>/artifacts/<artifactId>` and metadata
 * in a `.json` sidecar next to them. The bucket should stay private; the host
 * serves downloads through its authenticated API or short-lived signed URLs.
 */
export class S3ArtifactStore implements ArtifactStore {
  readonly #client: S3ObjectClient;
  readonly #prefix: string;
  readonly #limits: ArtifactStoreLimits;

  constructor(options: S3ArtifactStoreOptions) {
    if (!options.client) {
      throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'S3 artifact client is required');
    }
    this.#client = options.client;
    this.#prefix = normalizePrefix(options.prefix ?? 'fevex');
    this.#limits = resolveLimits(options);
  }

  async put(input: ArtifactWrite, context?: ArtifactStoreContext): Promise<ArtifactDescriptor> {
    assertNotAborted(context);
    assertArtifactWrite(input, this.#limits);
    const descriptor = createDescriptor(input, this.#limits);
    const dataKey = this.#key(normalizeTenantId(context), descriptor.artifactId);
    const metadataKey = `${dataKey}.json`;

    await this.#client.putObject({
      key: dataKey,
      body: copyBytes(input.bytes),
      contentType: descriptor.mimeType,
    });
    try {
      await this.#client.putObject({
        key: metadataKey,
        body: new TextEncoder().encode(JSON.stringify(descriptor)),
        contentType: 'application/json',
      });
    } catch (error) {
      await this.#client.deleteObject({ key: dataKey });
      throw error;
    }
    return structuredClone(descriptor);
  }

  async get(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactContent | null> {
    assertNotAborted(context);
    assertArtifactId(artifactId);
    const descriptor = await this.#readDescriptor(normalizeTenantId(context), artifactId);
    if (!descriptor || isExpired(descriptor)) return null;

    const bytes = await this.#client.getObject({
      key: this.#key(normalizeTenantId(context), artifactId),
    });
    if (!bytes) {
      throw new ArtifactError('ARTIFACT_CORRUPT', `Artifact "${artifactId}" metadata exists without bytes`);
    }
    return { descriptor, bytes: copyBytes(bytes) };
  }

  async head(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactDescriptor | null> {
    assertNotAborted(context);
    assertArtifactId(artifactId);
    const descriptor = await this.#readDescriptor(normalizeTenantId(context), artifactId);
    return descriptor && !isExpired(descriptor) ? descriptor : null;
  }

  async delete(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<boolean> {
    assertNotAborted(context);
    assertArtifactId(artifactId);
    const tenantId = normalizeTenantId(context);
    const dataKey = this.#key(tenantId, artifactId);
    const existed = (await this.#readDescriptor(tenantId, artifactId)) !== null;
    await this.#client.deleteObject({ key: dataKey });
    await this.#client.deleteObject({ key: `${dataKey}.json` });
    return existed;
  }

  async #readDescriptor(tenantId: string, artifactId: string): Promise<ArtifactDescriptor | null> {
    const metadata = await this.#client.getObject({
      key: `${this.#key(tenantId, artifactId)}.json`,
    });
    return metadata ? parseDescriptor(new TextDecoder().decode(metadata)) : null;
  }

  #key(tenantId: string, artifactId: string): string {
    return `${this.#prefix}/${tenantId}/artifacts/${artifactId}`;
  }
}

function normalizePrefix(prefix: string): string {
  if (typeof prefix !== 'string') {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'S3 artifact prefix must be a string');
  }
  const normalized = prefix.replace(/^\/+|\/+$/gu, '');
  if (
    normalized.length === 0 ||
    normalized.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'S3 artifact prefix is not valid');
  }
  return normalized;
}
