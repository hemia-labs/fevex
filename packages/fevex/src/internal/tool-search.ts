import type { ToolSearchCheckpointOptions, ToolSearchOptions } from '../agents';
import type { JsonValue, ToolSpec } from '../core';
import type { EmbeddingModel } from '../models';
import type {
  ToolEmbeddingCache,
  ToolReranker,
  ToolSearchCandidate,
} from '../tools';

export interface ResolvedToolSearchSemanticOptions {
  embeddings: EmbeddingModel;
  cache: ToolEmbeddingCache;
  topK: number;
  minScore: number;
  reranker?: ToolReranker;
}

export interface ResolvedToolSearchOptions {
  mode: 'auto' | 'on' | 'off';
  threshold: number;
  tokenThreshold?: number;
  limit: number;
  pinned: string[];
  semantic?: ResolvedToolSearchSemanticOptions;
}

export function resolveToolSearchOptions(
  options: ToolSearchOptions | undefined,
  label: string,
  defaultCache?: ToolEmbeddingCache,
): ResolvedToolSearchOptions {
  if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
    throw new TypeError(`${label} must be an object`);
  }
  const mode = options?.mode ?? 'auto';
  if (mode !== 'auto' && mode !== 'on' && mode !== 'off') {
    throw new TypeError(`${label}.mode must be auto, on or off`);
  }
  const threshold = options?.threshold ?? 30;
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new TypeError(`${label}.threshold must be a positive safe integer`);
  }
  const tokenThreshold = options?.tokenThreshold;
  if (
    tokenThreshold !== undefined
    && (!Number.isSafeInteger(tokenThreshold) || tokenThreshold < 1)
  ) {
    throw new TypeError(`${label}.tokenThreshold must be a positive safe integer`);
  }
  const limit = options?.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new TypeError(`${label}.limit must be a safe integer between 1 and 20`);
  }
  const pinned = options?.pinned ?? [];
  if (
    !Array.isArray(pinned)
    || pinned.some((name) => typeof name !== 'string' || !name.trim())
  ) {
    throw new TypeError(`${label}.pinned must contain non-empty tool names`);
  }
  const normalizedPinned = [...new Set(pinned.map((name) => name.trim()))];
  if (normalizedPinned.length !== pinned.length) {
    throw new TypeError(`${label}.pinned must contain unique tool names`);
  }
  const semantic = options?.semantic;
  return {
    mode,
    threshold,
    ...(tokenThreshold === undefined ? {} : { tokenThreshold }),
    limit,
    pinned: normalizedPinned,
    ...(semantic === undefined
      ? {}
      : { semantic: resolveSemanticOptions(semantic, `${label}.semantic`, defaultCache) }),
  };
}

export function serializeToolSearchOptions(
  options: ResolvedToolSearchOptions,
): ToolSearchCheckpointOptions {
  return {
    mode: options.mode,
    threshold: options.threshold,
    ...(options.tokenThreshold === undefined
      ? {}
      : { tokenThreshold: options.tokenThreshold }),
    limit: options.limit,
    pinned: [...options.pinned],
  };
}

export function reciprocalRankFusion(
  lexical: readonly ToolSpec[],
  semantic: readonly ToolSpec[],
  limit: number,
  rankConstant = 60,
): ToolSpec[] {
  return reciprocalRankFusionCandidates(lexical, semantic, limit, rankConstant)
    .map((candidate) => candidate.tool);
}

export function reciprocalRankFusionCandidates(
  lexical: readonly ToolSpec[],
  semantic: readonly ToolSpec[],
  limit: number,
  rankConstant = 60,
): ToolSearchCandidate[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Tool search fusion limit must be a positive safe integer');
  }
  if (!Number.isSafeInteger(rankConstant) || rankConstant < 1) {
    throw new TypeError('Tool search fusion rankConstant must be a positive safe integer');
  }
  const scores = new Map<string, ToolSearchCandidate>();
  const add = (tools: readonly ToolSpec[]): void => {
    for (let index = 0; index < tools.length; index += 1) {
      const tool = tools[index]!;
      const entry = scores.get(tool.name) ?? { tool, score: 0 };
      entry.score += 1 / (rankConstant + index + 1);
      scores.set(tool.name, entry);
    }
  };
  add(lexical);
  add(semantic);
  return [...scores.values()]
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit);
}

function resolveSemanticOptions(
  semantic: NonNullable<ToolSearchOptions['semantic']>,
  label: string,
  defaultCache: ToolEmbeddingCache | undefined,
): ResolvedToolSearchSemanticOptions {
  if (typeof semantic !== 'object' || semantic === null || Array.isArray(semantic)) {
    throw new TypeError(`${label} must be an object`);
  }
  const embeddings = semantic.embeddings;
  if (
    typeof embeddings !== 'object'
    || embeddings === null
    || typeof embeddings.id !== 'string'
    || !embeddings.id.trim()
    || typeof embeddings.embed !== 'function'
  ) {
    throw new TypeError(`${label}.embeddings must implement EmbeddingModel`);
  }
  if (
    embeddings.dimensions !== undefined
    && (!Number.isSafeInteger(embeddings.dimensions) || embeddings.dimensions < 1)
  ) {
    throw new TypeError(`${label}.embeddings.dimensions must be a positive safe integer`);
  }
  const cache = semantic.cache ?? defaultCache;
  if (
    cache === undefined
    || typeof cache.get !== 'function'
    || typeof cache.set !== 'function'
  ) {
    throw new TypeError(`${label}.cache must implement get and set`);
  }
  const topK = semantic.topK ?? 20;
  if (!Number.isSafeInteger(topK) || topK < 1) {
    throw new TypeError(`${label}.topK must be a positive safe integer`);
  }
  const minScore = semantic.minScore ?? 0;
  if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < -1 || minScore > 1) {
    throw new TypeError(`${label}.minScore must be a finite number between -1 and 1`);
  }
  const reranker = semantic.reranker;
  if (
    reranker !== undefined
    && (typeof reranker !== 'object' || reranker === null || typeof reranker.rerank !== 'function')
  ) {
    throw new TypeError(`${label}.reranker must implement rerank`);
  }
  return {
    embeddings,
    cache,
    topK,
    minScore,
    ...(reranker === undefined ? {} : { reranker }),
  };
}

export function shouldUseToolSearch(
  options: ResolvedToolSearchOptions,
  tools: readonly ToolSpec[],
): boolean {
  if (options.mode === 'off' || tools.length === 0) return false;
  if (options.mode === 'on') return true;
  if (tools.length > options.threshold) return true;
  if (options.tokenThreshold === undefined) return false;
  return Math.ceil(JSON.stringify(tools).length / 4) > options.tokenThreshold;
}

interface IndexedTool {
  tool: ToolSpec;
  name: string;
  nameTerms: Set<string>;
  description: string;
  descriptionTerms: Set<string>;
  schema: string;
}

const searchIndex = new WeakMap<readonly ToolSpec[], IndexedTool[]>();

function indexedTools(tools: readonly ToolSpec[]): IndexedTool[] {
  const cached = searchIndex.get(tools);
  if (cached !== undefined) return cached;
  const index = tools.map((tool) => {
    const name = tool.name.toLowerCase();
    const description = (tool.description ?? '').toLowerCase();
    return {
      tool,
      name,
      nameTerms: new Set(name.split(/[^a-z0-9]+/).filter(Boolean)),
      description,
      descriptionTerms: new Set(description.split(/[^a-z0-9]+/).filter(Boolean)),
      schema: JSON.stringify(tool.inputSchema ?? {}).toLowerCase(),
    };
  });
  searchIndex.set(tools, index);
  return index;
}

export function searchToolSpecs(
  tools: readonly ToolSpec[],
  query: string,
  limit: number,
): ToolSpec[] {
  const terms = [
    ...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 1)),
  ];
  if (terms.length === 0) return [];
  return indexedTools(tools)
    .map(({ tool, name, nameTerms, description, descriptionTerms, schema }) => {
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 100;
        else if (nameTerms.has(term)) score += 40;
        else if (name.startsWith(term)) score += 30;
        else if (name.includes(term)) score += 20;
        if (descriptionTerms.has(term)) score += 8;
        else if (description.includes(term)) score += 5;
        if (schema.includes(term)) score += 1;
      }
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, limit)
    .map(({ tool }) => tool);
}

export function readToolSearchInput(input: JsonValue): { query: string; limit?: number } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Tool search input must be an object');
  }
  const record = input as Record<string, JsonValue>;
  const query = record.query;
  const limit = record.limit;
  if (typeof query !== 'string' || !query.trim()) {
    throw new TypeError('Tool search query must be a non-empty string');
  }
  if (
    limit !== undefined
    && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
  ) {
    throw new TypeError('Tool search limit must be a positive safe integer');
  }
  return {
    query: query.trim(),
    ...(limit === undefined ? {} : { limit }),
  };
}
