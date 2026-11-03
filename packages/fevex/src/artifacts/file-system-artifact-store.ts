import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

export interface FileSystemArtifactStoreOptions extends ArtifactStoreLimits {
  /** Directory that owns artifact bytes and metadata. */
  rootDir: string;
}

/**
 * Local filesystem artifact store.
 *
 * Layout:
 *   <rootDir>/tenants/<tenantId>/artifacts/<artifactId>
 *   <rootDir>/tenants/<tenantId>/artifacts/<artifactId>.json
 *
 * Bytes are written before metadata, and both use an atomic rename. This is
 * intended for local development and single-node deployments; use
 * `S3ArtifactStore` for multi-instance production.
 */
export class FileSystemArtifactStore implements ArtifactStore {
  readonly #rootDir: string;
  readonly #limits: ArtifactStoreLimits;

  constructor(options: FileSystemArtifactStoreOptions) {
    if (typeof options.rootDir !== 'string' || !options.rootDir.trim()) {
      throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact rootDir must be non-empty');
    }
    this.#rootDir = resolve(options.rootDir);
    this.#limits = resolveLimits(options);
  }

  async put(input: ArtifactWrite, context?: ArtifactStoreContext): Promise<ArtifactDescriptor> {
    assertNotAborted(context);
    assertArtifactWrite(input, this.#limits);
    const tenantId = normalizeTenantId(context);
    const descriptor = createDescriptor(input, this.#limits);
    const dataPath = this.#dataPath(tenantId, descriptor.artifactId);
    const metadataPath = `${dataPath}.json`;

    await mkdir(join(this.#rootDir, 'tenants', tenantId, 'artifacts'), { recursive: true });
    await writeAtomic(dataPath, input.bytes);
    try {
      await writeAtomic(metadataPath, JSON.stringify(descriptor));
    } catch (error) {
      await remove(dataPath);
      throw error;
    }
    return structuredClone(descriptor);
  }

  async get(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactContent | null> {
    assertNotAborted(context);
    assertArtifactId(artifactId);
    const descriptor = await this.#readDescriptor(normalizeTenantId(context), artifactId);
    if (!descriptor || isExpired(descriptor)) return null;

    try {
      const bytes = await readFile(this.#dataPath(normalizeTenantId(context), artifactId));
      return { descriptor, bytes: copyBytes(bytes) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
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
    const dataPath = this.#dataPath(tenantId, artifactId);
    const existed = (await this.#readDescriptor(tenantId, artifactId)) !== null;
    await remove(dataPath);
    await remove(`${dataPath}.json`);
    return existed;
  }

  async #readDescriptor(tenantId: string, artifactId: string): Promise<ArtifactDescriptor | null> {
    try {
      const content = await readFile(`${this.#dataPath(tenantId, artifactId)}.json`, 'utf8');
      return parseDescriptor(content);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  #dataPath(tenantId: string, artifactId: string): string {
    return join(this.#rootDir, 'tenants', tenantId, 'artifacts', artifactId);
  }
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await remove(temporary);
    throw error;
  }
}

async function remove(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
