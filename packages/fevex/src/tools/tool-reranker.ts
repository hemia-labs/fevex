import type { ToolSpec } from '../core';

/** One tool candidate passed to a reranker. */
export interface ToolSearchCandidate {
  tool: ToolSpec;
  /** Lexical/vector fusion score. Rerankers may ignore it. */
  score: number;
}

/** Optional second-stage ranking over the top lexical/vector candidates. */
export interface ToolReranker {
  rerank(input: {
    query: string;
    tools: ToolSearchCandidate[];
    limit: number;
    signal?: AbortSignal;
  }): Promise<ToolSearchCandidate[]>;
}
