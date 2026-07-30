import type {
  KnowledgeContext,
  MemoryQuery,
  MemoryRecord,
  MemoryStore,
  MemoryWrite,
} from './knowledge';

/** Volatile keyword-search memory store for tests and local development. */
export class InMemoryMemoryStore implements MemoryStore {
  readonly #records = new Map<string, MemoryRecord>();

  async search(query: MemoryQuery, context: KnowledgeContext): Promise<MemoryRecord[]> {
    context.signal?.throwIfAborted();
    const terms = query.query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [...this.#records.values()]
      .filter((record) => matchesScope(record, query))
      .map((record) => ({ record, score: score(record.content, terms) }))
      .filter(({ score }) => !terms.length || score > 0)
      .sort((left, right) => right.score - left.score || right.record.createdAt.localeCompare(left.record.createdAt));
    return scored.slice(0, query.limit ?? scored.length).map(({ record }) => structuredClone(record));
  }

  async write(record: MemoryWrite, context: KnowledgeContext): Promise<MemoryRecord> {
    context.signal?.throwIfAborted();
    const saved: MemoryRecord = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...structuredClone(record),
    };
    this.#records.set(saved.id, saved);
    return structuredClone(saved);
  }
}

function matchesScope(record: MemoryRecord, query: MemoryQuery): boolean {
  return (
    matches(record.agentName, query.agentName) &&
    matches(record.sessionId, query.sessionId) &&
    matches(record.namespace, query.namespace) &&
    matches(record.actor?.id, query.actor?.id)
  );
}

function matches(left: string | undefined, right: string | undefined): boolean {
  return right === undefined || left === undefined || left === right;
}

function score(content: string, terms: string[]): number {
  const text = content.toLowerCase();
  // ponytail: simple local ranking; replace with embeddings/vector search when adapters need it.
  return terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
}
