import type { JsonObject, ToolSpec } from '../core';
import type { EmbeddingModel } from '../models';

/** Cache of tool embedding vectors keyed by content hash. */
export interface ToolEmbeddingCache {
  get(key: string): number[] | undefined | Promise<number[] | undefined>;
  set(key: string, vector: number[]): void | Promise<void>;
  /** Optional batch read for durable caches with network/database latency. */
  getMany?(
    keys: readonly string[],
  ): Array<number[] | undefined> | Promise<Array<number[] | undefined>>;
  /** Optional batch write for durable caches with network/database latency. */
  setMany?(
    entries: ReadonlyArray<{ key: string; vector: number[] }>,
  ): void | Promise<void>;
}

export interface InMemoryToolEmbeddingCacheOptions {
  /** Maximum cached vectors. Defaults to 1,000. */
  maxEntries?: number;
}

/** Bounded LRU cache for tool embeddings. */
export class InMemoryToolEmbeddingCache implements ToolEmbeddingCache {
  readonly #entries = new Map<string, number[]>();
  readonly #maxEntries: number;

  constructor(options: InMemoryToolEmbeddingCacheOptions = {}) {
    const maxEntries = options.maxEntries ?? 1_000;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('Tool embedding cache maxEntries must be a positive safe integer');
    }
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): number[] | undefined {
    assertKey(key);
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return [...value];
  }

  set(key: string, vector: number[]): void {
    assertKey(key);
    assertVector(vector, 'Tool embedding cache vector');
    this.#entries.delete(key);
    this.#entries.set(key, [...vector]);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  getMany(keys: readonly string[]): Array<number[] | undefined> {
    return keys.map((key) => this.get(key));
  }

  setMany(entries: ReadonlyArray<{ key: string; vector: number[] }>): void {
    for (const entry of entries) this.set(entry.key, entry.vector);
  }
}

export interface ToolEmbeddingIndexEntry {
  tool: ToolSpec;
  vector: number[];
}

export interface ToolEmbeddingIndex {
  modelId: string;
  dimensions: number;
  entries: ToolEmbeddingIndexEntry[];
}

export interface BuildToolEmbeddingIndexOptions {
  tools: readonly ToolSpec[];
  embeddings: EmbeddingModel;
  cache?: ToolEmbeddingCache;
  /** Texts per embedding request. Defaults to 64. */
  batchSize?: number;
  signal?: AbortSignal;
}

export interface ToolEmbeddingMatch {
  tool: ToolSpec;
  score: number;
}

/**
 * Builds or refreshes a semantic index for a tool catalog. The content key is
 * `sha256(embeddingModel.id + text)`, so changing the model or the tool text
 * invalidates the cached vector.
 */
export async function buildToolEmbeddingIndex(
  options: BuildToolEmbeddingIndexOptions,
): Promise<ToolEmbeddingIndex> {
  assertEmbeddingModel(options.embeddings);
  const batchSize = options.batchSize ?? 64;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('Tool embedding batchSize must be a positive safe integer');
  }
  const tools = options.tools;
  const texts = tools.map(toolEmbeddingText);
  const keys = await Promise.all(
    texts.map((text) => toolEmbeddingKey(options.embeddings.id, text)),
  );
  const vectors = new Map<string, number[]>();
  const missing = new Map<string, string>();
  const batchCached = await readCacheMany(
    options.cache,
    keys,
    options.embeddings.dimensions,
  );

  for (let index = 0; index < tools.length; index += 1) {
    const key = keys[index]!;
    const cached = batchCached === undefined
      ? await readCache(options.cache, key, options.embeddings.dimensions)
      : batchCached[index];
    if (cached !== undefined) {
      vectors.set(key, cached);
      continue;
    }
    if (!missing.has(key)) missing.set(key, texts[index]!);
  }

  const pending = [...missing.entries()];
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    options.signal?.throwIfAborted();
    const batch = pending.slice(offset, offset + batchSize);
    const embedded = await options.embeddings.embed({
      texts: batch.map(([, text]) => text),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!Array.isArray(embedded) || embedded.length !== batch.length) {
      throw new Error(
        `Embedding model "${options.embeddings.id}" returned ${embedded.length} vectors for ${batch.length} texts`,
      );
    }
    const writes: Array<{ key: string; vector: number[] }> = [];
    for (let index = 0; index < batch.length; index += 1) {
      const vector = embedded[index];
      assertVector(vector, `Embedding for "${batch[index]![1]}"`);
      vectors.set(batch[index]![0], vector);
      writes.push({ key: batch[index]![0], vector });
    }
    if (options.cache?.setMany !== undefined) {
      try {
        await options.cache.setMany(writes);
      } catch {
        // A cache failure must not break indexing or search.
      }
    } else {
      for (const write of writes) {
        await writeCache(options.cache, write.key, write.vector);
      }
    }
  }

  const dimensions = options.embeddings.dimensions ?? vectors.values().next().value?.length ?? 0;
  for (const vector of vectors.values()) {
    if (vector.length !== dimensions) {
      throw new Error(
        `Embedding model "${options.embeddings.id}" returned mixed dimensions: ${dimensions} and ${vector.length}`,
      );
    }
  }
  return {
    modelId: options.embeddings.id,
    dimensions,
    entries: tools.map((tool, index) => ({
      tool,
      vector: [...vectors.get(keys[index]!)!],
    })),
  };
}

/** Returns cosine matches above `minScore`, ordered by score. */
export function searchToolEmbeddingIndex(
  index: ToolEmbeddingIndex,
  query: readonly number[],
  limit: number,
  minScore = 0,
): ToolEmbeddingMatch[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Tool embedding search limit must be a positive safe integer');
  }
  if (query.length !== index.dimensions) {
    throw new TypeError(
      `Query embedding has ${query.length} dimensions; index expects ${index.dimensions}`,
    );
  }
  assertVector([...query], 'Query embedding');
  if (typeof minScore !== 'number' || !Number.isFinite(minScore)) {
    throw new TypeError('Tool embedding minScore must be a finite number');
  }
  return index.entries
    .map((entry) => ({ tool: entry.tool, score: cosineSimilarity(query, entry.vector) }))
    .filter(({ score }) => score >= minScore)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit);
}

/** Canonical text indexed for one tool: name, description and schema keywords. */
export function toolEmbeddingText(tool: ToolSpec): string {
  return [tool.name, tool.description ?? '', schemaKeywords(tool.inputSchema)]
    .filter(Boolean)
    .join('\n');
}

/** Extracts property names, descriptions, titles, required fields and enum values. */
export function schemaKeywords(schema: JsonObject | undefined): string {
  if (schema === undefined) return '';
  const terms = new Set<string>();
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key === 'description' || key === 'title' || key === 'const') terms.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === 'properties' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        for (const property of Object.keys(child)) terms.add(property);
        visit(child, childKey);
        continue;
      }
      if (childKey === 'required' && Array.isArray(child)) {
        for (const item of child) {
          if (typeof item === 'string') terms.add(item);
        }
        continue;
      }
      if (childKey === 'enum' && Array.isArray(child)) {
        for (const item of child) terms.add(String(item));
        continue;
      }
      visit(child, childKey);
    }
  };
  visit(schema);
  return [...terms].join(' ');
}

/** Stable content key for one embedding model and tool text. */
export async function toolEmbeddingKey(modelId: string, text: string): Promise<string> {
  if (!modelId.trim()) throw new TypeError('Embedding model id cannot be empty');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${modelId}\n${text}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  assertVector(left, 'Left cosine vector');
  assertVector(right, 'Right cosine vector');
  if (left.length !== right.length) {
    throw new TypeError(`Cosine vectors must have the same dimensions: ${left.length} and ${right.length}`);
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function assertEmbeddingModel(model: EmbeddingModel): void {
  if (typeof model.id !== 'string' || !model.id.trim()) {
    throw new TypeError('Embedding model id must be a non-empty string');
  }
  if (typeof model.embed !== 'function') {
    throw new TypeError('Embedding model must implement embed');
  }
  if (
    model.dimensions !== undefined
    && (!Number.isSafeInteger(model.dimensions) || model.dimensions < 1)
  ) {
    throw new TypeError('Embedding model dimensions must be a positive safe integer');
  }
}

function assertKey(key: string): void {
  if (typeof key !== 'string' || !key.trim()) {
    throw new TypeError('Tool embedding cache key must be a non-empty string');
  }
}

function assertVector(vector: unknown, label: string): asserts vector is number[] {
  if (
    !Array.isArray(vector)
    || vector.length === 0
    || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new TypeError(`${label} must be a non-empty array of finite numbers`);
  }
}

async function readCache(
  cache: ToolEmbeddingCache | undefined,
  key: string,
  dimensions: number | undefined,
): Promise<number[] | undefined> {
  if (cache === undefined) return undefined;
  try {
    return normalizeCached(await cache.get(key), dimensions);
  } catch {
    return undefined;
  }
}

async function readCacheMany(
  cache: ToolEmbeddingCache | undefined,
  keys: readonly string[],
  dimensions: number | undefined,
): Promise<Array<number[] | undefined> | undefined> {
  if (cache?.getMany === undefined) return undefined;
  try {
    const values = await cache.getMany(keys);
    if (!Array.isArray(values) || values.length !== keys.length) return undefined;
    return values.map((value) => normalizeCached(value, dimensions));
  } catch {
    return undefined;
  }
}

function normalizeCached(
  value: unknown,
  dimensions: number | undefined,
): number[] | undefined {
  if (value === undefined) return undefined;
  try {
    assertVector(value, 'Cached tool embedding');
    if (dimensions !== undefined && value.length !== dimensions) return undefined;
    return [...value];
  } catch {
    return undefined;
  }
}

async function writeCache(
  cache: ToolEmbeddingCache | undefined,
  key: string,
  vector: number[],
): Promise<void> {
  if (cache === undefined) return;
  try {
    await cache.set(key, [...vector]);
  } catch {
    // A cache failure must not break indexing or search.
  }
}
