import { describe, expect, test } from 'bun:test';
import {
  CatalogedArtifactStore,
  InMemoryArtifactStore,
} from '@fevex/core/artifacts';
import { createSQLiteArtifactCatalog } from './index';

const bytes = new TextEncoder().encode('artifact body');

describe('SQLiteArtifactCatalog', () => {
  test('indexes metadata, lists by run and deletes bytes', async () => {
    const catalog = createSQLiteArtifactCatalog({ filename: ':memory:' });
    const bytesStore = new InMemoryArtifactStore();
    const store = new CatalogedArtifactStore({ store: bytesStore, catalog });
    try {
      const descriptor = await store.put(
        { filename: 'report.txt', mimeType: 'text/plain', bytes },
        { tenantId: 'acme', runId: 'run-1', sessionId: 'session-1' },
      );

      const records = await store.list({ runId: 'run-1' }, { tenantId: 'acme' });
      expect(records).toHaveLength(1);
      expect(records[0]?.descriptor).toEqual(descriptor);
      expect(records[0]?.runId).toBe('run-1');
      expect(await store.get(descriptor.artifactId, { tenantId: 'acme' })).not.toBeNull();

      expect(await store.list({ runId: 'run-1' }, { tenantId: 'other' })).toHaveLength(0);
      expect(await store.deleteByRun('run-1', { tenantId: 'acme' })).toBe(1);
      expect(await bytesStore.head(descriptor.artifactId, { tenantId: 'acme' })).toBeNull();
      expect(await store.list({ runId: 'run-1' }, { tenantId: 'acme' })).toHaveLength(0);
    } finally {
      await catalog.close();
    }
  });

  test('filters expired records unless requested', async () => {
    const catalog = createSQLiteArtifactCatalog({ filename: ':memory:' });
    try {
      await catalog.save(
        {
          tenantId: 'acme',
          descriptor: {
            artifactId: 'artifact-expired',
            uri: 'artifact://artifact-expired',
            filename: 'old.txt',
            mimeType: 'text/plain',
            size: bytes.byteLength,
            sha256: '0'.repeat(64),
            createdAt: new Date(0).toISOString(),
            expiresAt: new Date(0).toISOString(),
          },
        },
        { tenantId: 'acme' },
      );
      expect(await catalog.get('artifact-expired', { tenantId: 'acme' })).toBeNull();
      expect(await catalog.list({}, { tenantId: 'acme' })).toHaveLength(0);
      expect(await catalog.list({ includeExpired: true }, { tenantId: 'acme' })).toHaveLength(1);
    } finally {
      await catalog.close();
    }
  });

  test('rejects cross-tenant overwrites', async () => {
    const catalog = createSQLiteArtifactCatalog({ filename: ':memory:' });
    const record = {
      tenantId: 'acme',
      descriptor: {
        artifactId: 'artifact-shared',
        uri: 'artifact://artifact-shared',
        filename: 'shared.txt',
        mimeType: 'text/plain',
        size: 1,
        sha256: '0'.repeat(64),
        createdAt: new Date().toISOString(),
      },
    };
    try {
      await catalog.save(record, { tenantId: 'acme' });
      await expect(catalog.save({ ...record, tenantId: 'other' }, { tenantId: 'other' }))
        .rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' });
    } finally {
      await catalog.close();
    }
  });
});
