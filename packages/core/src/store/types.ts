import type { EmbeddingProviderName } from '../config/schema.js';

export type IndexVersionStatus = 'building' | 'ready' | 'active' | 'retired';

/** The settings an index version is built with; stored so activation and serving can check them (ADR 0002). */
export interface NewIndexVersion {
  embeddingProvider: EmbeddingProviderName;
  embeddingModel: string;
  embeddingDimensions: number;
  chunkerHash: string;
  configHash: string;
}

/** The most recent evaluation of an index version. */
export interface EvalRunSummary {
  id: string;
  embeddingProvider: string;
  embeddingModel: string;
  passed: boolean;
  createdAt: Date;
}

export interface IndexVersionSummary {
  id: string;
  status: IndexVersionStatus;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  chunkerHash: string;
  configHash: string;
  documentCount: number;
  chunkCount: number;
  createdAt: Date;
  activatedAt: Date | null;
  latestEval: EvalRunSummary | null;
}

export interface DocumentRecord {
  sourceUri: string;
  title: string;
  contentSha256: string;
  tenantKey: string;
  accessTags: readonly string[];
}

export interface ChunkRecord {
  ordinal: number;
  headingPath: readonly string[];
  content: string;
  embedding: readonly number[];
}

export interface CachedEmbedding {
  contentSha256: string;
  embedding: readonly number[];
}

/** Who activated a version and how; every activation is logged with it (ADR 0002). */
export interface ActivationRequest {
  /** Skips the eval gate. Requires `reason`. */
  force: boolean;
  reason: string | undefined;
  operator: string;
}

export interface NewEvalRun {
  embeddingProvider: string;
  embeddingModel: string;
  passed: boolean;
  metrics: Readonly<Record<string, unknown>>;
}

/**
 * The ingest side of the storage port: everything training and activation
 * need. Every method acts on one instance only, and implementations must run
 * it under that instance's access context so row-level security applies
 * (ADR 0003). Retrieval methods are planned and will be a separate interface.
 */
export interface IngestStore {
  /** Creates the instance row if it does not exist. */
  ensureInstance(instanceId: string): Promise<void>;
  /** Creates a version in status `building` and returns its ID. */
  createIndexVersion(instanceId: string, version: NewIndexVersion): Promise<string>;
  /** Writes one document and all of its chunks atomically into a `building` version. */
  insertDocument(
    instanceId: string,
    versionId: string,
    document: DocumentRecord,
    chunks: readonly ChunkRecord[],
  ): Promise<void>;
  /** Returns the cached embeddings found for `hashes`, keyed by content hash. */
  findCachedEmbeddings(
    instanceId: string,
    model: string,
    hashes: readonly string[],
  ): Promise<Map<string, number[]>>;
  /** Adds embeddings to the cache; entries that already exist are left unchanged. */
  cacheEmbeddings(
    instanceId: string,
    model: string,
    entries: readonly CachedEmbedding[],
  ): Promise<void>;
  /** Moves a `building` version to `ready` with its final counts. */
  markReady(
    instanceId: string,
    versionId: string,
    counts: { documents: number; chunks: number },
  ): Promise<void>;
  /** Deletes a version that is not active, with its documents, chunks and eval runs. */
  deleteVersion(instanceId: string, versionId: string): Promise<void>;
  recordEvalRun(instanceId: string, versionId: string, run: NewEvalRun): Promise<string>;
  /**
   * Makes a `ready` or `retired` version active, logs the activation and
   * returns the previously active version ID. Unless `request.force` is set,
   * the store itself must refuse a version that fails the eval gate.
   */
  activate(
    instanceId: string,
    versionId: string,
    request: ActivationRequest,
  ): Promise<string | null>;
  /** All versions of the instance, newest first. */
  listVersions(instanceId: string): Promise<IndexVersionSummary[]>;
  getVersion(instanceId: string, versionId: string): Promise<IndexVersionSummary | undefined>;
}
