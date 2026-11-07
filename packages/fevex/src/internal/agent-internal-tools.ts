import type { JsonValue, ToolCall, ToolSpec } from '../core';
import type { KnowledgeContext, ProgressiveSkillProvider } from '../knowledge';
import {
  buildToolEmbeddingIndex,
  searchToolEmbeddingIndex,
  type ToolEmbeddingIndex,
  type ToolReranker,
  type ToolSearchCandidate,
} from '../tools';
import { serializeValue } from './json';
import { abortable, toErrorMessage } from './run-support';
import {
  LOAD_SKILL_TOOL_NAME,
  SEARCH_TOOLS_TOOL_NAME,
} from './runtime-constants';
import {
  readToolSearchInput,
  reciprocalRankFusionCandidates,
  searchToolSpecs,
  type ResolvedToolSearchOptions,
} from './tool-search';

export interface InternalToolExecution {
  content: string;
}

export interface SemanticToolIndexState {
  index?: ToolEmbeddingIndex;
  attempted: boolean;
}

export async function executeInternalTool(input: {
  call: ToolCall;
  input: JsonValue;
  tools: ToolSpec[];
  searchEnabled: boolean;
  toolSearch: ResolvedToolSearchOptions;
  loadedTools: Set<string>;
  progressiveSkills: ProgressiveSkillProvider[];
  knowledgeContext: KnowledgeContext;
  semanticState: SemanticToolIndexState;
  signal?: AbortSignal;
}): Promise<InternalToolExecution | undefined> {
  if (input.call.name === SEARCH_TOOLS_TOOL_NAME) {
    if (!input.searchEnabled) return undefined;
    const search = readToolSearchInput(input.input);
    const limit = Math.min(search.limit ?? input.toolSearch.limit, input.toolSearch.limit);
    const semantic = input.toolSearch.semantic;
    const candidateLimit = Math.max(limit, semantic?.topK ?? limit);
    const lexical = searchToolSpecs(input.tools, search.query, candidateLimit);
    let matches = lexical;
    if (semantic !== undefined) {
      try {
        if (input.semanticState.index === undefined && !input.semanticState.attempted) {
          input.semanticState.attempted = true;
          input.semanticState.index = await buildToolEmbeddingIndex({
            tools: input.tools,
            embeddings: semantic.embeddings,
            cache: semantic.cache,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
        }
        if (input.semanticState.index !== undefined) {
          const queryVectors = await semantic.embeddings.embed({
            texts: [search.query],
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          const queryVector = queryVectors[0];
          if (!queryVector) throw new Error('Embedding model returned no query vector');
          const semanticMatches = searchToolEmbeddingIndex(
            input.semanticState.index,
            queryVector,
            semantic.topK,
            semantic.minScore,
          );
          if (semanticMatches.length > 0) {
            const fusionLimit = semantic.reranker === undefined
              ? limit
              : Math.max(limit, semantic.topK);
            const fused = reciprocalRankFusionCandidates(
              lexical,
              semanticMatches.map((match) => match.tool),
              fusionLimit,
            );
            if (semantic.reranker !== undefined && fused.length > 1) {
              const reranked = await rerankToolCandidates(
                semantic.reranker,
                search.query,
                fused,
                limit,
                input.signal,
              );
              matches = (reranked ?? fused).map((candidate) => candidate.tool);
            } else {
              matches = fused.map((candidate) => candidate.tool);
            }
          }
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        matches = lexical;
      }
    }
    const selected = matches.slice(0, limit);
    for (const match of selected) input.loadedTools.add(match.name);
    return {
      content: serializeValue(
        {
          tools: selected.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
          })),
          ...(selected.length === 0
            ? { message: 'No tools matched; try a different query.' }
            : {}),
        },
        'Tool search result must be serializable',
      ),
    };
  }

  if (input.call.name === LOAD_SKILL_TOOL_NAME) {
    if (input.progressiveSkills.length === 0) return undefined;
    const skillInput = readSkillInput(input.input);
    const skill = input.progressiveSkills.find((item) => item.name === skillInput.name);
    if (!skill) {
      throw new Error(`Skill "${skillInput.name}" is not available`);
    }
    try {
      const blocks = await abortable(
        () => skill.load(input.knowledgeContext, skillInput.resource),
        input.signal,
      );
      return {
        content: blocks
          .filter((block) => block.content.trim())
          .map((block) => `[Skill: ${skill.name}/${block.id}]\n${block.content}`)
          .join('\n\n'),
      };
    } catch (error) {
      throw new Error(`Skill provider "${skill.name}" failed: ${toErrorMessage(error)}`, {
        cause: error,
      });
    }
  }

  return undefined;
}

async function rerankToolCandidates(
  reranker: ToolReranker,
  query: string,
  candidates: ToolSearchCandidate[],
  limit: number,
  signal?: AbortSignal,
): Promise<ToolSearchCandidate[] | undefined> {
  try {
    const result = await reranker.rerank({
      query,
      tools: candidates,
      limit,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!Array.isArray(result)) return undefined;
    const byName = new Map(candidates.map((candidate) => [candidate.tool.name, candidate]));
    const seen = new Set<string>();
    const ordered: ToolSearchCandidate[] = [];
    for (const candidate of result) {
      const name = candidate?.tool?.name;
      const original = typeof name === 'string' ? byName.get(name) : undefined;
      if (!original || seen.has(name)) return undefined;
      seen.add(name);
      ordered.push(original);
    }
    return ordered.slice(0, limit);
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

function readSkillInput(input: JsonValue): { name: string; resource?: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${LOAD_SKILL_TOOL_NAME} input must be an object`);
  }
  const record = input as Record<string, JsonValue>;
  const name = record.name;
  const resource = record.resource;
  if (typeof name !== 'string' || !name.trim()) {
    throw new TypeError(`${LOAD_SKILL_TOOL_NAME} name must be a non-empty string`);
  }
  if (resource !== undefined && (typeof resource !== 'string' || !resource.trim())) {
    throw new TypeError(`${LOAD_SKILL_TOOL_NAME} resource must be a non-empty string`);
  }
  return {
    name: name.trim(),
    ...(resource === undefined ? {} : { resource: resource.trim() }),
  };
}
