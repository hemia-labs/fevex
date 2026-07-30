import type { ExecutionContext, JsonObject, JsonValue } from '../core';
import type { SessionId } from '../runtime';

/** Runtime context supplied to knowledge providers and memory stores. */
export interface KnowledgeContext {
  agentName: string;
  input: string;
  sessionId: SessionId;
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface ContextBlock {
  id: string;
  content: string;
  metadata?: JsonObject;
}

export interface ContextProvider {
  name: string;
  read(context: KnowledgeContext): Promise<ContextBlock[]>;
}

export interface MemoryQuery {
  query: string;
  limit?: number;
  agentName?: string;
  sessionId?: SessionId;
  namespace?: string;
  actor?: ExecutionContext['actor'];
}

export interface MemoryWrite {
  content: string;
  agentName?: string;
  sessionId?: SessionId;
  namespace?: string;
  actor?: ExecutionContext['actor'];
  metadata?: JsonObject;
}

export interface MemoryRecord extends MemoryWrite {
  id: string;
  createdAt: string;
}

export interface MemoryStore {
  search(query: MemoryQuery, context: KnowledgeContext): Promise<MemoryRecord[]>;
  write(record: MemoryWrite, context: KnowledgeContext): Promise<MemoryRecord>;
}

export interface SkillDefinition {
  name: string;
  instructions: string;
  resources?: Array<string | JsonValue | { id?: string; content: string | JsonValue; metadata?: JsonObject }>;
}

export function defineContextProvider<T extends ContextProvider>(provider: T): T {
  return provider;
}

export function defineSkill(skill: SkillDefinition): ContextProvider {
  return defineContextProvider({
    name: skill.name,
    async read() {
      return [
        { id: `${skill.name}:instructions`, content: skill.instructions },
        ...(skill.resources ?? []).map((resource, index) => {
          const normalized = isSkillResource(resource) ? resource : { content: resource };
          return {
            id: normalized.id ?? `${skill.name}:resource:${index + 1}`,
            content: stringifyKnowledge(normalized.content),
            ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
          };
        }),
      ];
    },
  });
}

function isSkillResource(
  value: string | JsonValue | { id?: string; content: string | JsonValue; metadata?: JsonObject },
): value is { id?: string; content: string | JsonValue; metadata?: JsonObject } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'content' in value &&
    (value.id === undefined || typeof value.id === 'string')
  );
}

export function createMemoryContextProvider(options: {
  name?: string;
  store: MemoryStore;
  limit?: number;
}): ContextProvider {
  return defineContextProvider({
    name: options.name ?? 'memory',
    async read(context) {
      const records = await options.store.search(
        {
          query: context.input,
          limit: options.limit,
          agentName: context.agentName,
          sessionId: context.sessionId,
          namespace: context.context?.namespace,
          actor: context.context?.actor,
        },
        context,
      );
      return records.map((record) => ({
        id: record.id,
        content: record.content,
        metadata: {
          ...(record.metadata ?? {}),
          createdAt: record.createdAt,
          ...(record.agentName === undefined ? {} : { agentName: record.agentName }),
          ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
        },
      }));
    },
  });
}

function stringifyKnowledge(value: string | JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
