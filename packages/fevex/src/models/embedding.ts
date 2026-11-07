/** Provider-neutral embedding model used to index tools and queries. */
export interface EmbeddingModel {
  /** Stable identity: provider, model and dimensions. Used in cache keys. */
  readonly id: string;
  /** Expected vector dimensions. Optional; inferred from the first result. */
  readonly dimensions?: number;
  embed(input: { texts: string[]; signal?: AbortSignal }): Promise<number[][]>;
}
