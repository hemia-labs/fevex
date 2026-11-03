import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CatalogedArtifactStore,
  FileSystemArtifactStore,
  InMemoryArtifactCatalog,
  InMemoryArtifactStore,
  S3ArtifactStore,
  type ArtifactCatalog,
  type ArtifactQuery,
  type ArtifactRecord,
  type ArtifactStoreContext,
  type S3ObjectClient,
} from './index';

const bytes = new TextEncoder().encode('artifact body');

describe('in-memory artifact store', () => {
  test('stores and returns a descriptor plus copied bytes', async () => {
    const store = new InMemoryArtifactStore();
    const descriptor = await store.put(
      {
        filename: 'report.txt',
        mimeType: 'text/plain',
        bytes,
        metadata: { source: 'test' },
      },
      { tenantId: 'acme', runId: 'run-1' },
    );

    expect(descriptor.artifactId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(descriptor.uri).toBe(`artifact://${descriptor.artifactId}`);
    expect(descriptor.size).toBe(bytes.byteLength);
    expect(descriptor.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(descriptor.metadata).toEqual({ source: 'test' });

    const stored = await store.get(descriptor.artifactId, { tenantId: 'acme' });
    expect(stored?.descriptor).toEqual(descriptor);
    expect(stored?.bytes).toEqual(bytes);

    stored!.bytes[0] = 0;
    expect((await store.get(descriptor.artifactId, { tenantId: 'acme' }))?.bytes).toEqual(bytes);
    expect(await store.head(descriptor.artifactId, { tenantId: 'acme' })).toEqual(descriptor);
  });

  test('isolates tenants and deletes idempotently', async () => {
    const store = new InMemoryArtifactStore();
    const descriptor = await store.put(
      { filename: 'data.bin', mimeType: 'application/octet-stream', bytes },
      { tenantId: 'acme' },
    );

    expect(await store.get(descriptor.artifactId, { tenantId: 'other' })).toBeNull();
    expect(await store.delete(descriptor.artifactId, { tenantId: 'other' })).toBe(false);
    expect(await store.delete(descriptor.artifactId, { tenantId: 'acme' })).toBe(true);
    expect(await store.delete(descriptor.artifactId, { tenantId: 'acme' })).toBe(false);
  });

  test('enforces limits, MIME allowlists and expiry', async () => {
    const store = new InMemoryArtifactStore({
      maxBytes: 3,
      allowedMimeTypes: ['image/png'],
      retentionMs: 0,
    });

    await expect(
      store.put({ filename: 'big.txt', mimeType: 'text/plain', bytes }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_TOO_LARGE' });

    const descriptor = await store.put({
      filename: 'small.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(await store.get(descriptor.artifactId)).toBeNull();
    expect(await store.head(descriptor.artifactId)).toBeNull();
  });

  test('rejects unsafe ids, filenames and tenant scopes', async () => {
    const store = new InMemoryArtifactStore();

    await expect(
      store.put({ filename: '../escape.txt', mimeType: 'text/plain', bytes }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INVALID_INPUT' });
    await expect(store.get('../escape')).rejects.toMatchObject({ code: 'ARTIFACT_INVALID_ID' });
    await expect(
      store.put({ filename: 'safe.txt', mimeType: 'text/plain', bytes }, { tenantId: '..' }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_INVALID_CONTEXT' });
  });
});

describe('filesystem artifact store', () => {
  test('persists bytes and metadata across instances', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'fevex-artifacts-'));
    try {
      const first = new FileSystemArtifactStore({ rootDir });
      const descriptor = await first.put(
        { filename: 'report.txt', mimeType: 'text/plain', bytes },
        { tenantId: 'acme' },
      );

      const dataPath = join(rootDir, 'tenants', 'acme', 'artifacts', descriptor.artifactId);
      expect(existsSync(dataPath)).toBe(true);
      expect(existsSync(`${dataPath}.json`)).toBe(true);

      const second = new FileSystemArtifactStore({ rootDir });
      const stored = await second.get(descriptor.artifactId, { tenantId: 'acme' });
      expect(stored?.descriptor).toEqual(descriptor);
      expect(stored?.bytes).toEqual(bytes);
      expect(await second.head(descriptor.artifactId, { tenantId: 'acme' })).toEqual(descriptor);
      expect(await second.get(descriptor.artifactId, { tenantId: 'other' })).toBeNull();

      expect(await second.delete(descriptor.artifactId, { tenantId: 'acme' })).toBe(true);
      expect(existsSync(dataPath)).toBe(false);
      expect(existsSync(`${dataPath}.json`)).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('cataloged artifact store', () => {
  test('indexes metadata and deletes bytes with the catalog record', async () => {
    const bytesStore = new InMemoryArtifactStore();
    const catalog = new InMemoryArtifactCatalog();
    const store = new CatalogedArtifactStore({ store: bytesStore, catalog });
    const descriptor = await store.put(
      { filename: 'report.txt', mimeType: 'text/plain', bytes },
      { tenantId: 'acme', runId: 'run-1', sessionId: 'session-1' },
    );

    expect(await store.list({ runId: 'run-1' }, { tenantId: 'acme' })).toHaveLength(1);
    expect(await store.get(descriptor.artifactId, { tenantId: 'acme' })).not.toBeNull();
    expect(await store.head(descriptor.artifactId, { tenantId: 'acme' })).toEqual(descriptor);
    expect(await store.deleteByRun('run-1', { tenantId: 'acme' })).toBe(1);
    expect(await bytesStore.head(descriptor.artifactId, { tenantId: 'acme' })).toBeNull();
    expect(await store.list({ runId: 'run-1' }, { tenantId: 'acme' })).toHaveLength(0);
  });

  test('rolls back bytes when metadata indexing fails', async () => {
    const bytesStore = new InMemoryArtifactStore();
    const catalog = new FakeCatalog(true);
    const store = new CatalogedArtifactStore({ store: bytesStore, catalog });

    await expect(
      store.put({ filename: 'report.txt', mimeType: 'text/plain', bytes }, { tenantId: 'acme' }),
    ).rejects.toThrow('catalog unavailable');

    expect(
      await bytesStore.head(catalog.attempted!.descriptor.artifactId, { tenantId: 'acme' }),
    ).toBeNull();
  });
});

describe('S3-compatible artifact store', () => {
  test('uses object keys, sidecar metadata and tenant isolation', async () => {
    const client = new FakeS3Client();
    const store = new S3ArtifactStore({ client, prefix: 'fevex-test' });
    const descriptor = await store.put(
      { filename: 'report.txt', mimeType: 'text/plain', bytes },
      { tenantId: 'acme' },
    );

    const dataKey = `fevex-test/acme/artifacts/${descriptor.artifactId}`;
    expect([...client.objects.keys()].sort()).toEqual([dataKey, `${dataKey}.json`].sort());

    const stored = await store.get(descriptor.artifactId, { tenantId: 'acme' });
    expect(stored?.descriptor).toEqual(descriptor);
    expect(stored?.bytes).toEqual(bytes);
    expect(await store.head(descriptor.artifactId, { tenantId: 'acme' })).toEqual(descriptor);
    expect(await store.get(descriptor.artifactId, { tenantId: 'other' })).toBeNull();

    expect(await store.delete(descriptor.artifactId, { tenantId: 'acme' })).toBe(true);
    expect(client.objects.size).toBe(0);
    expect(await store.delete(descriptor.artifactId, { tenantId: 'acme' })).toBe(false);
  });
});

class FakeS3Client implements S3ObjectClient {
  readonly objects = new Map<string, Uint8Array>();

  async putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<void> {
    this.objects.set(input.key, new Uint8Array(input.body));
  }

  async getObject(input: { key: string }): Promise<Uint8Array | null> {
    const object = this.objects.get(input.key);
    return object ? new Uint8Array(object) : null;
  }

  async deleteObject(input: { key: string }): Promise<void> {
    this.objects.delete(input.key);
  }
}

class FakeCatalog implements ArtifactCatalog {
  readonly records = new Map<string, ArtifactRecord>();
  attempted?: ArtifactRecord;

  constructor(private readonly fail = false) {}

  async save(record: ArtifactRecord): Promise<void> {
    this.attempted = structuredClone(record);
    if (this.fail) throw new Error('catalog unavailable');
    this.records.set(`${record.tenantId}:${record.descriptor.artifactId}`, structuredClone(record));
  }

  async get(artifactId: string, context?: ArtifactStoreContext): Promise<ArtifactRecord | null> {
    return this.records.get(`${context?.tenantId ?? 'default'}:${artifactId}`) ?? null;
  }

  async list(query: ArtifactQuery = {}, context?: ArtifactStoreContext): Promise<ArtifactRecord[]> {
    const tenantId = context?.tenantId ?? 'default';
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    return [...this.records.values()]
      .filter((record) =>
        record.tenantId === tenantId
        && (query.runId === undefined || record.runId === query.runId)
        && (query.sessionId === undefined || record.sessionId === query.sessionId)
        && (query.actorId === undefined || record.actorId === query.actorId)
        && (query.mimeType === undefined || record.descriptor.mimeType === query.mimeType)
        && (query.includeExpired || record.descriptor.expiresAt === undefined
          || Date.parse(record.descriptor.expiresAt) > Date.now()))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async delete(artifactId: string, context?: ArtifactStoreContext): Promise<boolean> {
    return this.records.delete(`${context?.tenantId ?? 'default'}:${artifactId}`);
  }

  async deleteByRun(runId: string, context?: ArtifactStoreContext): Promise<number> {
    const tenantId = context?.tenantId ?? 'default';
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (record.tenantId === tenantId && record.runId === runId) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}
