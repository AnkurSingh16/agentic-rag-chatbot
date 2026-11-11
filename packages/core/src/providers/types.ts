import type { EmbeddingProviderName } from '../config/schema.js';

/** Turns texts into vectors. One vector per input text, in input order. */
export interface EmbeddingProvider {
  readonly provider: EmbeddingProviderName;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], signal: AbortSignal): Promise<number[][]>;
}

export interface RerankCandidate {
  content: string;
}

/** Reorders retrieved chunks by relevance to the query (ADR 0006). */
export interface Reranker {
  rerank<T extends RerankCandidate>(
    query: string,
    candidates: readonly T[],
    signal: AbortSignal,
  ): Promise<T[]>;
}
