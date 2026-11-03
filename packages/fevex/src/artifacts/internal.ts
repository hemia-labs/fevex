import { createHash, randomUUID } from 'node:crypto';
import type { JsonObject } from '../core';
import {
  ArtifactError,
  assertArtifactId,
  artifactTenantId,
  type ArtifactDescriptor,
  type ArtifactStoreContext,
  type ArtifactWrite,
} from './artifacts';

export { assertArtifactId, artifactTenantId as normalizeTenantId };

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

export interface ArtifactStoreLimits {
  maxBytes?: number;
  allowedMimeTypes?: readonly string[];
  retentionMs?: number;
}

export function resolveLimits(options: ArtifactStoreLimits = {}): Required<Pick<ArtifactStoreLimits, 'maxBytes'>> & ArtifactStoreLimits {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact maxBytes must be a non-negative integer');
  }
  if (options.retentionMs !== undefined && (!Number.isFinite(options.retentionMs) || options.retentionMs < 0)) {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact retentionMs must be a non-negative number');
  }
  return { ...options, maxBytes };
}

export function assertArtifactWrite(input: ArtifactWrite, limits: ArtifactStoreLimits): void {
  if (!input || typeof input !== 'object') {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact write input must be an object');
  }
  if (
    typeof input.filename !== 'string' ||
    input.filename.trim().length === 0 ||
    input.filename.length > 255 ||
    /[\\/\0]/u.test(input.filename)
  ) {
    throw new ArtifactError(
      'ARTIFACT_INVALID_INPUT',
      'Artifact filename must be a non-empty display name without path separators',
    );
  }
  if (typeof input.mimeType !== 'string' || !MIME_PATTERN.test(input.mimeType)) {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact mimeType must be a valid MIME type');
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact bytes must be a Uint8Array');
  }
  if (input.bytes.byteLength > (limits.maxBytes ?? DEFAULT_MAX_BYTES)) {
    throw new ArtifactError(
      'ARTIFACT_TOO_LARGE',
      `Artifact exceeds the ${limits.maxBytes ?? DEFAULT_MAX_BYTES} byte limit`,
    );
  }
  if (
    limits.allowedMimeTypes !== undefined &&
    !limits.allowedMimeTypes.some((mimeType) => mimeType.toLowerCase() === input.mimeType.toLowerCase())
  ) {
    throw new ArtifactError(
      'ARTIFACT_MIME_UNSUPPORTED',
      `Artifact MIME type "${input.mimeType}" is not allowed`,
    );
  }
  if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact expiresAt must be a valid ISO date');
  }
  if (input.metadata !== undefined && !isJsonObject(input.metadata)) {
    throw new ArtifactError('ARTIFACT_INVALID_INPUT', 'Artifact metadata must be a JSON object');
  }
}

export function createDescriptor(input: ArtifactWrite, limits: ArtifactStoreLimits): ArtifactDescriptor {
  const artifactId = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt =
    input.expiresAt ??
    (limits.retentionMs === undefined
      ? undefined
      : new Date(Date.now() + limits.retentionMs).toISOString());

  return {
    artifactId,
    uri: `artifact://${artifactId}`,
    filename: input.filename,
    mimeType: input.mimeType,
    size: input.bytes.byteLength,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    createdAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
  };
}

export function assertNotAborted(context?: ArtifactStoreContext): void {
  context?.signal?.throwIfAborted();
}

export function isExpired(descriptor: ArtifactDescriptor): boolean {
  return descriptor.expiresAt !== undefined && Date.parse(descriptor.expiresAt) <= Date.now();
}

export function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export function parseDescriptor(value: string): ArtifactDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ArtifactError('ARTIFACT_CORRUPT', 'Artifact metadata is not valid JSON');
  }
  if (
    !isJsonObject(parsed) ||
    typeof parsed.artifactId !== 'string' ||
    typeof parsed.uri !== 'string' ||
    typeof parsed.filename !== 'string' ||
    typeof parsed.mimeType !== 'string' ||
    typeof parsed.size !== 'number' ||
    typeof parsed.sha256 !== 'string' ||
    typeof parsed.createdAt !== 'string'
  ) {
    throw new ArtifactError('ARTIFACT_CORRUPT', 'Artifact metadata is malformed');
  }
  return parsed as unknown as ArtifactDescriptor;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
