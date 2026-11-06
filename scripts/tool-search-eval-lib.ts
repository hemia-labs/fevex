import type { ToolSpec } from '../packages/fevex/src/core';
import {
  reciprocalRankFusion,
  searchToolSpecs,
} from '../packages/fevex/src/internal/tool-search';
import type { EmbeddingModel } from '../packages/fevex/src/models';
import { estimateContextTokens } from '../packages/fevex/src/runtime/compaction';
import {
  buildToolEmbeddingIndex,
  searchToolEmbeddingIndex,
  type ToolEmbeddingCache,
  type ToolEmbeddingIndex,
} from '../packages/fevex/src/tools';

export interface ToolSearchEvalCase {
  query: string;
  expected: string[];
  tags?: string[];
}

export interface ToolSearchEvalDataset {
  name: string;
  tools: ToolSpec[];
  cases: ToolSearchEvalCase[];
}

export interface ToolSearchStrategy {
  name: string;
  search(
    query: string,
    tools: readonly ToolSpec[],
    limit: number,
  ): Promise<ToolSpec[]> | ToolSpec[];
}

export interface ToolSearchEvalMiss {
  query: string;
  expected: string[];
  returned: string[];
}

export interface ToolSearchEvalTag {
  cases: number;
  hitAtK: number;
  mrr: number;
}

export interface ToolSearchEvalResult {
  dataset: string;
  strategy: string;
  k: number;
  cases: number;
  hitAt1: number;
  hitAt3: number;
  hitAtK: number;
  recallAtK: number;
  mrr: number;
  ndcgAtK: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  allToolTokens: number;
  averageRetrievedTokens: number;
  tokenReduction: number;
  byTag: Record<string, ToolSearchEvalTag>;
  misses: ToolSearchEvalMiss[];
}

export const lexicalStrategy: ToolSearchStrategy = {
  name: 'lexical',
  search(query, tools, limit) {
    return searchToolSpecs(tools, query, limit);
  },
};

export function createHybridStrategy(options: {
  embeddings: EmbeddingModel;
  cache: ToolEmbeddingCache;
  topK?: number;
  minScore?: number;
  name?: string;
}): ToolSearchStrategy {
  let index: ToolEmbeddingIndex | undefined;
  let indexedTools: readonly ToolSpec[] | undefined;
  return {
    name: options.name ?? 'hybrid',
    async search(query, tools, limit) {
      const topK = options.topK ?? 20;
      const lexical = searchToolSpecs(tools, query, Math.max(limit, topK));
      if (index === undefined || indexedTools !== tools) {
        index = await buildToolEmbeddingIndex({
          tools,
          embeddings: options.embeddings,
          cache: options.cache,
        });
        indexedTools = tools;
      }
      const [queryVector] = await options.embeddings.embed({ texts: [query] });
      if (!queryVector) throw new Error('Embedding model returned no query vector');
      const semantic = searchToolEmbeddingIndex(
        index,
        queryVector,
        topK,
        options.minScore ?? 0,
      ).map((match) => match.tool);
      return reciprocalRankFusion(lexical, semantic, limit);
    },
  };
}

export async function evaluateToolSearch(options: {
  dataset: ToolSearchEvalDataset;
  strategy: ToolSearchStrategy;
  k?: number;
}): Promise<ToolSearchEvalResult> {
  const k = options.k ?? 5;
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new TypeError('Evaluation k must be a positive safe integer');
  }
  const latencies: number[] = [];
  let hitAt1 = 0;
  let hitAt3 = 0;
  let hitAtK = 0;
  let recallAtK = 0;
  let mrr = 0;
  let ndcg = 0;
  let retrievedTokens = 0;
  const misses: ToolSearchEvalMiss[] = [];
  const tags = new Map<string, { cases: number; hits: number; reciprocalRank: number }>();

  for (const testCase of options.dataset.cases) {
    const started = performance.now();
    const returned = (
      await options.strategy.search(testCase.query, options.dataset.tools, k)
    ).slice(0, k);
    latencies.push(performance.now() - started);

    const names = returned.map((tool) => tool.name);
    const rank = rankOfExpected(testCase.expected, names);
    if (rank === 1) hitAt1 += 1;
    if (rank > 0 && rank <= Math.min(3, k)) hitAt3 += 1;
    if (rank > 0) hitAtK += 1;
    recallAtK += names.filter((name) => testCase.expected.includes(name)).length
      / testCase.expected.length;
    mrr += rank > 0 ? 1 / rank : 0;
    ndcg += ndcgAtK(testCase.expected, names, k);
    retrievedTokens += estimateContextTokens({ messages: [], tools: returned });
    if (rank === 0) {
      misses.push({
        query: testCase.query,
        expected: testCase.expected,
        returned: names,
      });
    }

    for (const tag of testCase.tags ?? ['untagged']) {
      const entry = tags.get(tag) ?? { cases: 0, hits: 0, reciprocalRank: 0 };
      entry.cases += 1;
      if (rank > 0) entry.hits += 1;
      entry.reciprocalRank += rank > 0 ? 1 / rank : 0;
      tags.set(tag, entry);
    }
  }

  const cases = options.dataset.cases.length;
  const allToolTokens = estimateContextTokens({
    messages: [],
    tools: options.dataset.tools,
  });
  const averageRetrievedTokens = cases === 0 ? 0 : retrievedTokens / cases;
  return {
    dataset: options.dataset.name,
    strategy: options.strategy.name,
    k,
    cases,
    hitAt1: ratio(hitAt1, cases),
    hitAt3: ratio(hitAt3, cases),
    hitAtK: ratio(hitAtK, cases),
    recallAtK: ratio(recallAtK, cases),
    mrr: ratio(mrr, cases),
    ndcgAtK: ratio(ndcg, cases),
    averageLatencyMs: average(latencies),
    p95LatencyMs: percentile(latencies, 0.95),
    allToolTokens,
    averageRetrievedTokens,
    tokenReduction: allToolTokens === 0 ? 0 : 1 - averageRetrievedTokens / allToolTokens,
    byTag: Object.fromEntries(
      [...tags.entries()].map(([tag, entry]) => [
        tag,
        {
          cases: entry.cases,
          hitAtK: ratio(entry.hits, entry.cases),
          mrr: ratio(entry.reciprocalRank, entry.cases),
        },
      ]),
    ),
    misses: misses.slice(0, 10),
  };
}

export function rankOfExpected(expected: readonly string[], returned: readonly string[]): number {
  for (let index = 0; index < returned.length; index += 1) {
    if (expected.includes(returned[index]!)) return index + 1;
  }
  return 0;
}

export function ndcgAtK(
  expected: readonly string[],
  returned: readonly string[],
  k: number,
): number {
  const top = returned.slice(0, k);
  const dcg = top.reduce(
    (sum, name, index) => sum + (expected.includes(name) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealCount = Math.min(expected.length, k);
  const idcg = Array.from({ length: idealCount }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function formatReport(result: ToolSearchEvalResult): string {
  const lines = [
    `Tool search evaluation: ${result.strategy}`,
    `Dataset: ${result.dataset}  cases: ${result.cases}  k: ${result.k}`,
    '',
    `Hit@1: ${percent(result.hitAt1)}  Hit@3: ${percent(result.hitAt3)}  Hit@${result.k}: ${percent(result.hitAtK)}`,
    `Recall@${result.k}: ${percent(result.recallAtK)}  MRR: ${result.mrr.toFixed(3)}  nDCG@${result.k}: ${result.ndcgAtK.toFixed(3)}`,
    `Latency: avg ${result.averageLatencyMs.toFixed(3)} ms  p95 ${result.p95LatencyMs.toFixed(3)} ms`,
    `Tool schema tokens: all ${result.allToolTokens}, retrieved avg ${result.averageRetrievedTokens.toFixed(0)}, reduction ${percent(result.tokenReduction)}`,
    '',
    'By tag:',
    ...Object.entries(result.byTag).map(
      ([tag, value]) =>
        `  ${tag.padEnd(12)} cases ${String(value.cases).padStart(2)}  hit@${result.k} ${percent(value.hitAtK)}  MRR ${value.mrr.toFixed(3)}`,
    ),
  ];
  if (result.misses.length > 0) {
    lines.push('', 'Misses:');
    for (const miss of result.misses) {
      lines.push(
        `  - "${miss.query}" expected [${miss.expected.join(', ')}] got [${miss.returned.join(', ')}]`,
      );
    }
  }
  return lines.join('\n');
}

export function formatJson(result: ToolSearchEvalResult): string {
  return JSON.stringify(result, null, 2);
}

function ratio(value: number, total: number): number {
  return total === 0 ? 0 : value / total;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
