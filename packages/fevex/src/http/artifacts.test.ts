import { describe, expect, test } from 'bun:test';
import {
  CatalogedArtifactStore,
  InMemoryArtifactCatalog,
  InMemoryArtifactStore,
  type ArtifactDescriptor,
} from '../artifacts';
import { defineAgent } from '../agents';
import type { ExecutionContext } from '../core';
import { createFevex } from '../fevex';
import { fakeModel } from '../testing';
import { createFevexHttpHandler, createFevexHttpClient, type FevexHttpHandler } from './index';

const alice: ExecutionContext = {
  actor: { id: 'alice' },
  attributes: { tenantId: 'tenant-a' },
};
const bob: ExecutionContext = {
  actor: { id: 'bob' },
  attributes: { tenantId: 'tenant-b' },
};

async function fixture() {
  const app = createFevex({
    models: { default: fakeModel({ output: 'ok' }) },
    agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
  });
  const result = await app.runAgent('assistant', { input: 'hello' });
  const bytes = new TextEncoder().encode('artifact body');
  const bytesStore = new InMemoryArtifactStore();
  const catalog = new InMemoryArtifactCatalog();
  const artifacts = new CatalogedArtifactStore({ store: bytesStore, catalog });
  const descriptor = await artifacts.put(
    { filename: 'report.txt', mimeType: 'text/plain', bytes },
    { tenantId: 'tenant-a', runId: result.runId, sessionId: result.sessionId },
  );
  const handler = createFevexHttpHandler({
    fevex: app,
    artifacts,
    artifactCatalog: catalog,
    authorizeArtifact(access) {
      return access.context?.actor?.id === 'alice';
    },
  });
  return { app, descriptor, bytes, artifacts, catalog, handler, result };
}

describe('HTTP artifacts', () => {
  test('serves bytes with metadata headers and supports HEAD', async () => {
    const { descriptor, bytes, handler } = await fixture();
    const response = await invoke(handler, `/v1/artifacts/${descriptor.artifactId}`, alice);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(response.headers.get('content-disposition')).toContain('report.txt');
    expect(response.headers.get('etag')).toBe(`"${descriptor.sha256}"`);
    expect(response.headers.get('fevex-artifact-id')).toBe(descriptor.artifactId);
    expect(response.headers.get('fevex-artifact-sha256')).toBe(descriptor.sha256);
    expect(await response.text()).toBe('artifact body');

    const head = await invoke(handler, `/v1/artifacts/${descriptor.artifactId}`, alice, {
      method: 'HEAD',
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(await head.text()).toBe('');
  });

  test('authorizes before revealing existence and returns 404 for missing artifacts', async () => {
    const { descriptor, handler } = await fixture();

    const denied = await invoke(handler, `/v1/artifacts/${descriptor.artifactId}`, bob);
    expect(denied.status).toBe(403);

    const missing = await invoke(handler, '/v1/artifacts/missing-artifact', alice);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
  });

  test('lists artifacts by run without exposing tenant metadata', async () => {
    const { descriptor, handler, result } = await fixture();
    const response = await invoke(handler, `/v1/runs/${result.runId}/artifacts`, alice);

    expect(response.status).toBe(200);
      const artifacts = await response.json() as ArtifactDescriptor[];
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toEqual(descriptor);
      expect(artifacts[0]).not.toHaveProperty('tenantId');
  });

  test('deletes artifacts and returns 404 afterwards', async () => {
    const { descriptor, handler } = await fixture();

    const deleted = await invoke(handler, `/v1/artifacts/${descriptor.artifactId}`, alice, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);

    const missing = await invoke(handler, `/v1/artifacts/${descriptor.artifactId}`, alice);
    expect(missing.status).toBe(404);
  });

  test('exposes the same routes through the TypeScript client', async () => {
    const { descriptor, handler, result } = await fixture();
    const client = createFevexHttpClient({
      baseUrl: 'http://local',
      fetch: (input, init) => handler(new Request(input, init), { context: alice }),
    });

    const response = await client.getArtifact(descriptor.artifactId);
    expect(await response.text()).toBe('artifact body');
    expect(await client.listArtifacts(result.runId)).toEqual([descriptor]);

    await client.deleteArtifact(descriptor.artifactId);
    await expect(client.getArtifact(descriptor.artifactId)).rejects.toMatchObject({
      code: 'ARTIFACT_NOT_FOUND',
    });
  });

  test('returns 501 when routes are not configured', async () => {
    const app = createFevex({
      models: { default: fakeModel({ output: 'ok' }) },
      agents: [defineAgent({ name: 'assistant', instructions: 'Answer.' })],
    });
    const handler = createFevexHttpHandler({ fevex: app });
    const response = await invoke(handler, '/v1/artifacts/missing-artifact', alice);
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: 'ARTIFACTS_NOT_CONFIGURED' });
  });

  test('rejects unsupported methods and invalid limits', async () => {
    const { descriptor, handler, result } = await fixture();

    const notAllowed = await invoke(handler, `/v1/artifacts/${descriptor.artifactId}`, alice, {
      method: 'POST',
    });
    expect(notAllowed.status).toBe(405);

    const badLimit = await invoke(
      handler,
      `/v1/runs/${result.runId}/artifacts?limit=0`,
      alice,
    );
    expect(badLimit.status).toBe(400);
  });
});

function invoke(
  handler: FevexHttpHandler,
  path: string,
  context: ExecutionContext,
  init: RequestInit = {},
) {
  return handler(new Request(`http://local${path}`, init), { context });
}
