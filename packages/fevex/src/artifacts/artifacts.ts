import type { ExecutionContext, JsonObject } from '../core';

/** Stable identifier for a stored artifact. */
export type ArtifactId = string;

/**
 * Small, JSON-serializable reference to a stored artifact.
 *
 * The bytes live in an `ArtifactStore`; runs, events and prompts only carry
 * this descriptor.
 */
export interface ArtifactDescriptor {
  artifactId: ArtifactId;
  /** Stable URI for host and protocol hand-offs, for example `artifact://<id>`. */
  uri: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt?: string;
  metadata?: JsonObject;
}

export interface ArtifactWrite {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  metadata?: JsonObject;
  expiresAt?: string;
}

export interface ArtifactContent {
  descriptor: ArtifactDescriptor;
  bytes: Uint8Array;
}

/** Scope supplied by the host when reading or writing an artifact. */
export interface ArtifactStoreContext {
  tenantId?: string;
  runId?: string;
  sessionId?: string;
  actor?: ExecutionContext['actor'];
  signal?: AbortSignal;
}

/**
 * Durable storage for large or binary outputs.
 *
 * Implementations must never return mutable internal state; callers may mutate
 * the returned descriptor or bytes.
 */
export interface ArtifactStore {
  put(input: ArtifactWrite, context?: ArtifactStoreContext): Promise<ArtifactDescriptor>;
  get(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactContent | null>;
  head?(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactDescriptor | null>;
  delete?(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<boolean>;
}

export type ArtifactErrorCode =
  | 'ARTIFACT_INVALID_INPUT'
  | 'ARTIFACT_TOO_LARGE'
  | 'ARTIFACT_MIME_UNSUPPORTED'
  | 'ARTIFACT_INVALID_ID'
  | 'ARTIFACT_INVALID_CONTEXT'
  | 'ARTIFACT_CONFLICT'
  | 'ARTIFACT_CORRUPT';

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}

/** Metadata record indexed by an `ArtifactCatalog`. */
export interface ArtifactRecord {
  descriptor: ArtifactDescriptor;
  tenantId: string;
  runId?: string;
  sessionId?: string;
  actorId?: string;
}

export interface ArtifactQuery {
  runId?: string;
  sessionId?: string;
  actorId?: string;
  mimeType?: string;
  /** Include expired artifacts. Defaults to false. */
  includeExpired?: boolean;
  /** Maximum records to return. Defaults to 100 and is capped at 1000. */
  limit?: number;
}

/**
 * Queryable metadata index for artifacts.
 *
 * The bytes stay in an `ArtifactStore`; the catalog lets hosts list, authorize
 * and delete by tenant, run, session or actor without scanning object storage.
 */
export interface ArtifactCatalog {
  save(record: ArtifactRecord, context?: ArtifactStoreContext): Promise<void>;
  get(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<ArtifactRecord | null>;
  list(query?: ArtifactQuery, context?: ArtifactStoreContext): Promise<ArtifactRecord[]>;
  delete(artifactId: ArtifactId, context?: ArtifactStoreContext): Promise<boolean>;
  deleteByRun(runId: string, context?: ArtifactStoreContext): Promise<number>;
}

const TENANT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;

/** Resolves and validates the tenant scope used by stores and catalogs. */
export function artifactTenantId(context?: ArtifactStoreContext): string {
  const tenantId = context?.tenantId ?? 'default';
  if (
    typeof tenantId !== 'string' ||
    !TENANT_PATTERN.test(tenantId) ||
    tenantId === '.' ||
    tenantId === '..'
  ) {
    throw new ArtifactError(
      'ARTIFACT_INVALID_CONTEXT',
      'Artifact tenantId must contain only letters, numbers, dot, underscore or hyphen',
    );
  }
  return tenantId;
}

/** Validates an artifact id before using it in a query or storage key. */
export function assertArtifactId(artifactId: string): void {
  if (typeof artifactId !== 'string' || !ARTIFACT_ID_PATTERN.test(artifactId)) {
    throw new ArtifactError('ARTIFACT_INVALID_ID', 'Artifact id is not valid');
  }
}
