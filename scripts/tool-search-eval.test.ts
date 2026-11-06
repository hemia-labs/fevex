import { describe, expect, test } from 'bun:test';
import type { ToolSpec } from '../packages/fevex/src/core';
import type { EmbeddingModel } from '../packages/fevex/src/models';
import { InMemoryToolEmbeddingCache } from '../packages/fevex/src/tools';
import type { ToolSearchEvalDataset } from './tool-search-eval-lib';
import {
  createHybridStrategy,
  evaluateToolSearch,
  formatReport,
  lexicalStrategy,
  ndcgAtK,
  rankOfExpected,
} from './tool-search-eval-lib';

const tools: ToolSpec[] = [
  { name: 'send_email', description: 'Send an email message.' },
  { name: 'query_database', description: 'Run a read-only SQL query.' },
];

const dataset: ToolSearchEvalDataset = {
  name: 'fixture',
  tools,
  cases: [
    { query: 'email', expected: ['send_email'] },
    { query: 'sql', expected: ['query_database'] },
    { query: 'unknown capability', expected: ['send_email'] },
  ],
};

describe('tool search evaluation', () => {
  test('computes rank and nDCG', () => {
    expect(rankOfExpected(['a'], ['b', 'a'])).toBe(2);
    expect(rankOfExpected(['a'], ['b'])).toBe(0);
    expect(ndcgAtK(['a'], ['b', 'a'], 5)).toBeCloseTo(1 / Math.log2(3), 6);
    expect(ndcgAtK(['a'], ['a'], 5)).toBe(1);
  });

  test('evaluates the lexical baseline', async () => {
    const result = await evaluateToolSearch({
      dataset,
      strategy: lexicalStrategy,
      k: 1,
    });
    expect(result.cases).toBe(3);
    expect(result.hitAt1).toBeCloseTo(2 / 3, 6);
    expect(result.hitAtK).toBeCloseTo(2 / 3, 6);
    expect(result.recallAtK).toBeCloseTo(2 / 3, 6);
    expect(result.mrr).toBeCloseTo(2 / 3, 6);
    expect(result.misses).toHaveLength(1);
    expect(result.misses[0]?.query).toBe('unknown capability');
    expect(result.tokenReduction).toBeGreaterThan(0);
    expect(result.p95LatencyMs).toBeGreaterThanOrEqual(0);
  });

  test('compares a hybrid strategy against the lexical baseline', async () => {
    const embeddings: EmbeddingModel = {
      id: 'fixture',
      dimensions: 2,
      async embed({ texts }) {
        return texts.map((text) =>
          text.includes('send_email') || text.includes('notify') ? [1, 0] : [0, 1],
        );
      },
    };
    const hybridDataset: ToolSearchEvalDataset = {
      name: 'hybrid-fixture',
      tools,
      cases: [{ query: 'notify the customer', expected: ['send_email'] }],
    };
    const lexical = await evaluateToolSearch({
      dataset: hybridDataset,
      strategy: lexicalStrategy,
      k: 1,
    });
    const hybrid = await evaluateToolSearch({
      dataset: hybridDataset,
      strategy: createHybridStrategy({
        embeddings,
        cache: new InMemoryToolEmbeddingCache(),
      }),
      k: 1,
    });
    expect(lexical.hitAt1).toBe(0);
    expect(hybrid.hitAt1).toBe(1);
  });

  test('formats a readable report', async () => {
    const result = await evaluateToolSearch({
      dataset,
      strategy: lexicalStrategy,
      k: 2,
    });
    const report = formatReport(result);
    expect(report).toContain('Tool search evaluation: lexical');
    expect(report).toContain('Hit@1:');
    expect(report).toContain('Misses:');
  });
});
