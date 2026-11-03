import { describe, expect, test } from 'bun:test';
import {
  CatalogedArtifactStore,
  InMemoryArtifactCatalog,
  InMemoryArtifactStore,
  type ArtifactStore,
} from './artifacts';
import { defineAgent } from './agents';
import type { AgentEvent } from './core';
import { createFevex, type ExecutionContext } from './index';
import { defineTool } from './tools';
import { fakeModel } from './testing';

const alice: ExecutionContext = {
  actor: { id: 'alice' },
  attributes: { tenantId: 'tenant-a' },
};

function saveTool() {
  return defineTool({
    name: 'save_report',
    async execute(input: { filename: string }, context) {
      return context.artifacts!.put({
        filename: input.filename,
        mimeType: 'text/plain',
        bytes: new TextEncoder().encode('artifact body'),
      });
    },
  });
}

describe('tool artifacts', () => {
  test('exposes the artifact store and emits artifact.created before tool.completed', async () => {
    const catalog = new InMemoryArtifactCatalog();
    const artifacts = new CatalogedArtifactStore({
      store: new InMemoryArtifactStore(),
      catalog,
    });
    const model = fakeModel(
      {
        toolCalls: [{
          id: 'call-1',
          name: 'save_report',
          input: { filename: 'report.txt' },
        }],
      },
      { output: 'done' },
    );
    const app = createFevex({
      models: { default: model },
      agents: [defineAgent({
        name: 'writer',
        instructions: 'Write.',
        tools: ['save_report'],
      })],
      tools: [saveTool()],
      artifacts,
    });

    const events: AgentEvent[] = [];
    for await (const event of app.streamAgent('writer', { input: 'go', context: alice })) {
      events.push(event);
    }

    const artifactIndex = events.findIndex((event) => event.type === 'artifact.created');
    expect(artifactIndex).toBeGreaterThan(events.findIndex((event) => event.type === 'tool.started'));
    expect(artifactIndex).toBeLessThan(events.findIndex((event) => event.type === 'tool.completed'));

    const created = events[artifactIndex];
    if (created?.type !== 'artifact.created') throw new Error('missing artifact event');
    const descriptor = created.payload.descriptor;
    expect(descriptor.filename).toBe('report.txt');

    const stored = await artifacts.get(descriptor.artifactId, { tenantId: 'tenant-a' });
    expect(stored?.bytes).toEqual(new TextEncoder().encode('artifact body'));

    const records = await catalog.list({}, { tenantId: 'tenant-a' });
    expect(records).toHaveLength(1);
    expect(records[0]?.runId).toBe(created.runId);
    expect(records[0]?.sessionId).toBeDefined();
    expect((await app.listEvents(created.runId)).some((event) => event.type === 'artifact.created'))
      .toBe(true);
  });

  test('emits artifact.created even when the tool fails afterwards', async () => {
    const catalog = new InMemoryArtifactCatalog();
    const artifacts = new CatalogedArtifactStore({
      store: new InMemoryArtifactStore(),
      catalog,
    });
    const failing = defineTool({
      name: 'save_then_fail',
      async execute(_input: unknown, context) {
        await context.artifacts!.put({
          filename: 'partial.txt',
          mimeType: 'text/plain',
          bytes: new TextEncoder().encode('partial'),
        });
        throw new Error('tool failed after writing');
      },
    });
    const app = createFevex({
      models: {
        default: fakeModel({
          toolCalls: [{
            id: 'call-1',
            name: 'save_then_fail',
            input: {},
          }],
        }),
      },
      agents: [defineAgent({
        name: 'writer',
        instructions: 'Write.',
        tools: ['save_then_fail'],
      })],
      tools: [failing],
      artifacts,
    });

    await expect(app.runAgent('writer', { input: 'go', context: alice })).rejects.toThrow(
      'tool failed after writing',
    );

    const records = await catalog.list({}, { tenantId: 'tenant-a' });
    expect(records).toHaveLength(1);
    expect(records[0]?.descriptor.filename).toBe('partial.txt');
  });

  test('rejects an invalid artifact store at configuration time', () => {
    expect(() =>
      createFevex({
        models: {},
        agents: [],
        artifacts: {} as ArtifactStore,
      }),
    ).toThrow('Fevex config "artifacts" must implement ArtifactStore');
  });

  test('leaves context.artifacts undefined when the runtime has no store', async () => {
    let seen: ArtifactStore | undefined;
    const tool = defineTool({
      name: 'inspect',
      execute(_input: unknown, context) {
        seen = context.artifacts;
        return { ok: true };
      },
    });
    const app = createFevex({
      models: {
        default: fakeModel(
          { toolCalls: [{ id: 'call-1', name: 'inspect', input: {} }] },
          { output: 'done' },
        ),
      },
      agents: [defineAgent({ name: 'writer', instructions: 'Write.', tools: ['inspect'] })],
      tools: [tool],
    });

    await app.runAgent('writer', { input: 'go', context: alice });
    expect(seen).toBeUndefined();
  });
});
