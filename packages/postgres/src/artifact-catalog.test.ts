import { describe, expect, test } from 'bun:test';
import {
  CatalogedArtifactStore,
  InMemoryArtifactStore,
  type ArtifactRecord,
} from '@fevex/core/artifacts';
import { createPostgresArtifactCatalog } from './index';

const connectionString = process.env.FEVEX_POSTGRES_URL;
if (process.env.FEVEX_REQUIRE_POSTGRES === '1' && !connectionString?.trim()) {
  throw new Error('FEVEX_POSTGRES_URL is required for PostgreSQL integration tests');
}
const integration = connectionString ? describe : describe.skip;
const bytes = new TextEncoder().encode('artifact body');

integration('PostgresArtifactCatalog', () => {
  test('indexes metadata, lists by run and deletes bytes', async () => {
    const catalog = createPostgresArtifactCatalog({ connectionString: connectionString! });
    const bytesStore = new InMemoryArtifactStore();
    const store = new CatalogedArtifactStore({ store: bytesStore, catalog });
    const tenantId = `tenant-${crypto.randomUUID()}`;
    try {
      await catalog.migrate();
      const descriptor = await store.put(
        { filename: 'report.txt', mimeType: 'text/plain', bytes },
        { tenantId, runId: 'run-1', sessionId: 'session-1' },
      );

      const records = await store.list({ runId: 'run-1' }, { tenantId });
      expect(records).toHaveLength(1);
      expect(records[0]?.descriptor).toEqual(descriptor);
      expect(records[0]?.runId).toBe('run-1');
      expect(await store.get(descriptor.artifactId, { tenantId })).not.toBeNull();

      expect(await store.list({ runId: 'run-1' }, { tenantId: `${tenantId}-other` }))
        .toHaveLength(0);
      expect(await store.deleteByRun('run-1', { tenantId })).toBe(1);
      expect(await bytesStore.head(descriptor.artifactId, { tenantId })).toBeNull();
      expect(await store.list({ runId: 'run-1' }, { tenantId })).toHaveLength(0);
    } finally {
      await catalog.deleteByRun('run-1', { tenantId });
      await catalog.close();
    }
  });

  test('filters expired records unless requested', async () => {
    const catalog = createPostgresArtifactCatalog({ connectionString: connectionString! });
    const tenantId = `tenant-${crypto.randomUUID()}`;
    const record: ArtifactRecord = {
      tenantId,
      descriptor: {
        artifactId: `artifact-${crypto.randomUUID()}`,
        uri: 'artifact://expired',
        filename: 'old.txt',
        mimeType: 'text/plain',
        size: bytes.byteLength,
        sha256: '0'.repeat(64),
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(0).toISOString(),
      },
    };
    try {
      await catalog.migrate();
      await catalog.save(record, { tenantId });
      expect(await catalog.get(record.descriptor.artifactId, { tenantId })).toBeNull();
      expect(await catalog.list({}, { tenantId })).toHaveLength(0);
      expect(await catalog.list({ includeExpired: true }, { tenantId })).toHaveLength(1);
    } finally {
      await catalog.delete(record.descriptor.artifactId, { tenantId });
      await catalog.close();
    }
  });
});
