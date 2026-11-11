import { RETRIEVAL, evalGateFailure } from '../src/index.js';
import type {
  ActivationRequest,
  ChunkRecord,
  DocumentRecord,
  IndexVersionSummary,
  IngestStore,
  NewEvalRun,
  RetrievalStore,
} from '../src/index.js';

interface StoredVersion extends IndexVersionSummary {
  instanceId: string;
  documents: { document: DocumentRecord; chunks: ChunkRecord[] }[];
  evals: (NewEvalRun & { id: string; createdAt: Date })[];
}

// An in-memory IngestStore with the same state rules as the PostgreSQL one: writes only into
// building versions, no deleting the active version, one active version per instance, the eval
// gate on activation unless forced, and a log entry for every activation.
export class MemoryStore implements IngestStore {
  readonly instances = new Set<string>();
  readonly versions: StoredVersion[] = [];
  readonly cache = new Map<string, number[]>();
  readonly calls: string[] = [];
  readonly activations: (ActivationRequest & { instanceId: string; versionId: string })[] = [];
  private clock = 0;
  private ids = 0;

  private nextDate(): Date {
    return new Date(Date.UTC(2026, 0, 1) + ++this.clock * 1000);
  }

  private version(instanceId: string, versionId: string): StoredVersion {
    const found = this.versions.find((v) => v.instanceId === instanceId && v.id === versionId);
    if (!found) throw new Error(`no version ${versionId}`);
    return found;
  }

  ensureInstance(instanceId: string): Promise<void> {
    this.calls.push('ensureInstance');
    this.instances.add(instanceId);
    return Promise.resolve();
  }

  createIndexVersion(
    instanceId: string,
    version: Parameters<IngestStore['createIndexVersion']>[1],
  ): Promise<string> {
    this.calls.push('createIndexVersion');
    const id = `00000000-0000-4000-8000-${String(++this.ids).padStart(12, '0')}`;
    this.versions.push({
      ...version,
      id,
      instanceId,
      status: 'building',
      documentCount: 0,
      chunkCount: 0,
      createdAt: this.nextDate(),
      activatedAt: null,
      latestEval: null,
      documents: [],
      evals: [],
    });
    return Promise.resolve(id);
  }

  insertDocument(
    instanceId: string,
    versionId: string,
    document: DocumentRecord,
    chunks: readonly ChunkRecord[],
  ): Promise<void> {
    this.calls.push('insertDocument');
    const version = this.version(instanceId, versionId);
    if (version.status !== 'building') throw new Error('version is not building');
    version.documents.push({ document, chunks: [...chunks] });
    return Promise.resolve();
  }

  findCachedEmbeddings(
    instanceId: string,
    model: string,
    hashes: readonly string[],
  ): Promise<Map<string, number[]>> {
    this.calls.push('findCachedEmbeddings');
    const found = new Map<string, number[]>();
    for (const hash of hashes) {
      const vector = this.cache.get(`${instanceId}|${model}|${hash}`);
      if (vector) found.set(hash, vector);
    }
    return Promise.resolve(found);
  }

  cacheEmbeddings(
    instanceId: string,
    model: string,
    entries: readonly { contentSha256: string; embedding: readonly number[] }[],
  ): Promise<void> {
    this.calls.push('cacheEmbeddings');
    for (const entry of entries) {
      const key = `${instanceId}|${model}|${entry.contentSha256}`;
      if (!this.cache.has(key)) this.cache.set(key, [...entry.embedding]);
    }
    return Promise.resolve();
  }

  markReady(
    instanceId: string,
    versionId: string,
    counts: { documents: number; chunks: number },
  ): Promise<void> {
    this.calls.push('markReady');
    const version = this.version(instanceId, versionId);
    if (version.status !== 'building') throw new Error('version is not building');
    Object.assign(version, {
      status: 'ready',
      documentCount: counts.documents,
      chunkCount: counts.chunks,
    });
    return Promise.resolve();
  }

  deleteVersion(instanceId: string, versionId: string): Promise<void> {
    this.calls.push('deleteVersion');
    const version = this.version(instanceId, versionId);
    if (version.status === 'active') throw new Error('cannot delete the active version');
    this.versions.splice(this.versions.indexOf(version), 1);
    return Promise.resolve();
  }

  recordEvalRun(instanceId: string, versionId: string, run: NewEvalRun): Promise<string> {
    const version = this.version(instanceId, versionId);
    const id = `eval-${++this.ids}`;
    const createdAt = this.nextDate();
    version.evals.push({ ...run, id, createdAt });
    version.latestEval = {
      id,
      embeddingProvider: run.embeddingProvider,
      embeddingModel: run.embeddingModel,
      passed: run.passed,
      createdAt,
    };
    return Promise.resolve(id);
  }

  activate(
    instanceId: string,
    versionId: string,
    request: ActivationRequest,
  ): Promise<string | null> {
    this.calls.push('activate');
    const version = this.version(instanceId, versionId);
    if (version.status !== 'ready' && version.status !== 'retired') {
      throw new Error('not activatable');
    }
    if (request.force && (request.reason ?? '').trim() === '') {
      throw new Error('forced activation requires a reason');
    }
    const failure = request.force ? undefined : evalGateFailure(version);
    if (failure !== undefined) throw new Error(`eval gate: ${failure}`);
    this.activations.push({ ...request, instanceId, versionId });
    const previous = this.versions.find(
      (v) => v.instanceId === instanceId && v.status === 'active',
    );
    if (previous) previous.status = 'retired';
    version.status = 'active';
    version.activatedAt = this.nextDate();
    return Promise.resolve(previous?.id ?? null);
  }

  listVersions(instanceId: string): Promise<IndexVersionSummary[]> {
    return Promise.resolve(
      this.versions
        .filter((v) => v.instanceId === instanceId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }

  getVersion(instanceId: string, versionId: string): Promise<IndexVersionSummary | undefined> {
    return Promise.resolve(
      this.versions.find((v) => v.instanceId === instanceId && v.id === versionId),
    );
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/**
 * A vector-only RetrievalStore over a MemoryStore's chunks, using the same similarity floor as
 * the PostgreSQL store. Scores are cosine similarities rather than fused ranks.
 */
export function memoryRetrieval(store: MemoryStore): RetrievalStore {
  return {
    activeVersion: (access) => {
      const version = store.versions.find(
        (v) => v.instanceId === access.instanceId && v.status === 'active',
      );
      return Promise.resolve(
        version && {
          id: version.id,
          embeddingProvider: version.embeddingProvider,
          embeddingModel: version.embeddingModel,
        },
      );
    },
    search: (access, versionId, queries) => {
      const version = store.versions.find(
        (v) => v.instanceId === access.instanceId && v.id === versionId,
      );
      const chunks = (version?.documents ?? []).flatMap(({ document, chunks: list }) =>
        list.map((chunk) => ({ document, chunk })),
      );
      return Promise.resolve(
        queries.map((query) =>
          chunks
            .map(({ document, chunk }) => ({
              chunkId: `${document.sourceUri}#${chunk.ordinal}`,
              sourceUri: document.sourceUri,
              title: document.title,
              headingPath: [...chunk.headingPath],
              content: chunk.content,
              score: cosine(query.embedding, chunk.embedding),
            }))
            .filter((result) => result.score >= 1 - RETRIEVAL.maxVectorDistance)
            .sort((a, b) => b.score - a.score)
            .slice(0, query.limit),
        ),
      );
    },
  };
}
