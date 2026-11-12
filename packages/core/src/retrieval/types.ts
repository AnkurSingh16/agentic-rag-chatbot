import type { AccessContext } from '../access/access.js';

/** Hybrid search settings from ADR 0006. */
export const RETRIEVAL = {
  /** Candidates taken from each of the full-text and vector searches. */
  candidates: 40,
  /** Reciprocal Rank Fusion constant. */
  rrfK: 60,
  /** Chunks passed to the answer model. */
  limit: 8,
  /** Chunks on the verification retry (ADR 0005). */
  retryLimit: 16,
  /**
   * Fused scores below this are dropped. A chunk found by only one search scores at most
   * 1 / (60 + 1) = 0.01639, so this keeps only chunks that both searches found (see ADR 0006's amendment and
   * docs/reference/instance-config.md). Calibrated on the demo eval set with all-MiniLM-L6-v2.
   */
  minFusedScore: 0.0165,
  /**
   * Vector candidates further than this cosine distance (similarity below 0.2) are dropped, so a
   * question unrelated to every document returns nothing instead of the nearest neighbours.
   */
  maxVectorDistance: 0.8,
} as const;

/** The parts of an access context that row-level security filters on (ADR 0003). */
export type RetrievalAccess = Pick<AccessContext, 'instanceId' | 'tenantKey' | 'accessTags'>;

export interface ActiveIndexVersion {
  id: string;
  embeddingProvider: string;
  embeddingModel: string;
}

export interface SearchQuery {
  /** Searched with `websearch_to_tsquery`. */
  text: string;
  embedding: readonly number[];
  limit: number;
}

export interface RetrievedChunk {
  chunkId: string;
  sourceUri: string;
  title: string;
  headingPath: string[];
  /** Chunk text, heading prefix included. */
  content: string;
  /** Reciprocal Rank Fusion score. */
  score: number;
}

/**
 * The read side of the storage port. Implementations run under the caller's access context so
 * row-level security decides which chunks are visible.
 */
export interface RetrievalStore {
  /** The version the instance serves, or undefined when none is active. */
  activeVersion(access: RetrievalAccess): Promise<ActiveIndexVersion | undefined>;
  /** Runs each query against one version and returns one ranked list per query. */
  search(
    access: RetrievalAccess,
    versionId: string,
    queries: readonly SearchQuery[],
  ): Promise<RetrievedChunk[][]>;
}
