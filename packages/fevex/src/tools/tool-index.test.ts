import { describe, expect, test } from 'bun:test';
import type { JsonObject, ToolSpec } from '../core';
import type { EmbeddingModel } from '../models';
import {
  buildToolEmbeddingIndex,
  cosineSimilarity,
  InMemoryToolEmbeddingCache,
  schemaKeywords,
  searchToolEmbeddingIndex,
  toolEmbeddingKey,
  toolEmbeddingText,
  type ToolEmbeddingCache,
} from './tool-index';

const tool = (name: string, description: string, inputSchema?: JsonObject): ToolSpec => ({
  name,
  description,
  ...(inputSchema === undefined ? {} : { inputSchema }),
});

class FakeEmbeddings implements EmbeddingModel {
  readonly id = 'fake-v1';
  readonly dimensions = 2;
  readonly calls: string[][] = [];
  readonly #vectorFor: (text: string) => number[];

  constructor(vectorFor: (text: string) => number[]) {
    this.#vectorFor = vectorFor;
  }

  async embed({ texts }: { texts: string[] }): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) => this.#vectorFor(text));
  }
}

const vectorFor = (text: string): number[] => {
  if (text.includes('email')) return [1, 0];
  if (text.includes('sql')) return [0, 1];
  return [0.5, 0.5];
};

describe('tool embedding text', () => {
  test('includes the name, description and schema keywords', () => {
    const spec = tool('send_email', 'Send a message.', {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Recipient email address' },
        role: { type: 'string', enum: ['admin', 'user'] },
      },
      required: ['recipient'],
    });
    const text = toolEmbeddingText(spec);
    expect(text).toContain('send_email');
    expect(text).toContain('Send a message.');
    expect(text).toContain('recipient');
    expect(text).toContain('Recipient email address');
    expect(text).toContain('admin');
    expect(schemaKeywords(spec.inputSchema)).not.toContain('"type"');
  });

  test('hashes model id and text together', async () => {
    const first = await toolEmbeddingKey('model-a', 'send_email');
    expect(await toolEmbeddingKey('model-a', 'send_email')).toBe(first);
    expect(await toolEmbeddingKey('model-b', 'send_email')).not.toBe(first);
  });
});

describe('in-memory tool embedding cache', () => {
  test('evicts least-recently-used entries and copies vectors', () => {
    const cache = new InMemoryToolEmbeddingCache({ maxEntries: 2 });
    cache.set('a', [1, 0]);
    cache.set('b', [0, 1]);
    expect(cache.get('a')).toEqual([1, 0]);
    cache.set('c', [0.5, 0.5]);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual([1, 0]);
    const copy = cache.get('a')!;
    copy[0] = 99;
    expect(cache.get('a')).toEqual([1, 0]);
  });

  test('validates keys and vectors', () => {
    const cache = new InMemoryToolEmbeddingCache();
    expect(() => cache.set('', [1])).toThrow('key');
    expect(() => cache.set('a', [])).toThrow('non-empty');
    expect(() => cache.set('a', [1, Number.NaN])).toThrow('finite');
  });
});

describe('tool embedding index', () => {
  test('reuses cached vectors across builds', async () => {
    const tools = [tool('send_email', 'Send email.'), tool('query_database', 'Run SQL.')];
    const embeddings = new FakeEmbeddings(vectorFor);
    const cache = new InMemoryToolEmbeddingCache();
    const first = await buildToolEmbeddingIndex({ tools, embeddings, cache });
    expect(first.modelId).toBe('fake-v1');
    expect(first.dimensions).toBe(2);
    expect(embeddings.calls).toHaveLength(1);
    expect(embeddings.calls[0]).toHaveLength(2);

    const second = await buildToolEmbeddingIndex({ tools, embeddings, cache });
    expect(embeddings.calls).toHaveLength(1);
    expect(second.entries.map((entry) => entry.tool.name)).toEqual([
      'send_email',
      'query_database',
    ]);
  });

  test('uses batch cache methods when available', async () => {
    let getManyCalls = 0;
    let setManyCalls = 0;
    const cache: ToolEmbeddingCache = {
      get() {
        return undefined;
      },
      set() {},
      getMany(keys) {
        getManyCalls += 1;
        return keys.map(() => undefined);
      },
      setMany() {
        setManyCalls += 1;
      },
    };
    const tools = [tool('send_email', 'Send email.'), tool('query_database', 'Run SQL.')];
    await buildToolEmbeddingIndex({
      tools,
      embeddings: new FakeEmbeddings(vectorFor),
      cache,
    });
    expect(getManyCalls).toBe(1);
    expect(setManyCalls).toBe(1);
  });

  test('batches missing texts', async () => {
    const tools = Array.from({ length: 5 }, (_, index) =>
      tool(`tool_${index}`, `Capability ${index}.`),
    );
    const embeddings = new FakeEmbeddings(vectorFor);
    await buildToolEmbeddingIndex({ tools, embeddings, batchSize: 2 });
    expect(embeddings.calls.map((call) => call.length)).toEqual([2, 2, 1]);
  });

  test('rejects mixed dimensions', async () => {
    const embeddings: EmbeddingModel = {
      id: 'mixed',
      dimensions: 3,
      async embed({ texts }) {
        return texts.map(() => [1, 0]);
      },
    };
    await expect(
      buildToolEmbeddingIndex({
        tools: [tool('send_email', 'Send email.')],
        embeddings,
      }),
    ).rejects.toThrow('mixed dimensions');
  });

  test('searches by cosine similarity and filters by score', async () => {
    const tools = [tool('send_email', 'Send email.'), tool('query_database', 'Run SQL.')];
    const embeddings = new FakeEmbeddings(vectorFor);
    const index = await buildToolEmbeddingIndex({ tools, embeddings });
    expect(searchToolEmbeddingIndex(index, [1, 0], 1)[0]?.tool.name).toBe('send_email');
    expect(searchToolEmbeddingIndex(index, [1, 0], 5, 0.9)).toHaveLength(1);
    expect(searchToolEmbeddingIndex(index, [0, 1], 1)[0]?.tool.name).toBe('query_database');
    expect(() => searchToolEmbeddingIndex(index, [1, 0, 0], 1)).toThrow('dimensions');
    expect(() => searchToolEmbeddingIndex(index, [1, 0], 0)).toThrow('limit');
  });

  test('computes cosine similarity with zero vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow('dimensions');
  });
});
