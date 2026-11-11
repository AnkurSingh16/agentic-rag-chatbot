import { chunkMarkdown, chunkerHash, contentSha256 } from '../chunking/chunker.js';
import type { Chunk } from '../chunking/chunker.js';
import type { InstanceConfig } from '../config/schema.js';
import { ChatbotError, toChatbotError } from '../errors.js';
import type { EmbeddingProvider } from '../providers/types.js';
import type { IngestStore } from '../store/types.js';
import { loadDocuments } from './sources.js';
import type { LoadedDocument, SourceAccess } from './sources.js';

/** Texts sent to the embedding provider per request. */
export const EMBEDDING_BATCH_SIZE = 64;

/** Ready or retired versions kept besides the active one (ADR 0002). */
export const RETAINED_VERSIONS = 3;

// Bounds the size of one cache lookup query.
const CACHE_LOOKUP_BATCH = 500;

export interface TrainOptions {
  config: InstanceConfig;
  configHash: string;
  sources: SourceAccess;
  store: IngestStore;
  embeddings: EmbeddingProvider;
  signal: AbortSignal;
  log?: (message: string) => void;
}

export interface TrainResult {
  versionId: string;
  documents: number;
  chunks: number;
  /** Chunks whose embedding was computed in this run. */
  embeddedChunks: number;
  /** Chunks whose embedding came from the cache. */
  reusedChunks: number;
  /** Older versions deleted to keep {@link RETAINED_VERSIONS}. */
  prunedVersions: string[];
}

interface PreparedDocument {
  document: LoadedDocument;
  accessTags: string[];
  chunks: (Chunk & { contentSha256: string })[];
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

// Tags follow the instance's access mode (ADR 0003): a public instance may only hold `public`
// documents, an authenticated one defaults to the tags every caller holds, and rbac has no safe
// default, so every document must say who may read it.
function resolveAccessTags(config: InstanceConfig, documents: readonly LoadedDocument[]) {
  const { auth } = config;
  const tags = new Map<string, string[]>();
  const rejected: string[] = [];
  for (const document of documents) {
    const own = document.accessTags;
    switch (auth.mode) {
      case 'public':
        if (own !== undefined && !sameTags(own, ['public'])) {
          rejected.push(`${document.sourceUri} (${own.join(', ')})`);
        }
        tags.set(document.sourceUri, ['public']);
        break;
      case 'authenticated':
        tags.set(document.sourceUri, own ?? [...new Set(auth.defaultTags)].sort());
        break;
      case 'rbac':
        if (own === undefined) rejected.push(document.sourceUri);
        else tags.set(document.sourceUri, own);
        break;
    }
  }
  if (rejected.length > 0) {
    throw new ChatbotError(
      'invalid_input',
      auth.mode === 'public'
        ? `Public instance "${config.id}" can only hold documents tagged public; other tags in: ${rejected.join('; ')}`
        : `rbac instance "${config.id}" needs access tags in the front-matter of every document; missing in: ${rejected.join(', ')}`,
    );
  }
  return tags;
}

function checkProvider(config: InstanceConfig, embeddings: EmbeddingProvider): void {
  const { embedding } = config;
  if (
    embeddings.provider !== embedding.provider ||
    embeddings.model !== embedding.model ||
    embeddings.dimensions !== embedding.dimensions
  ) {
    throw new ChatbotError(
      'invalid_config',
      `Embedding provider ${embeddings.provider}/${embeddings.model}/${embeddings.dimensions} does not match ` +
        `the instance config ${embedding.provider}/${embedding.model}/${embedding.dimensions}`,
    );
  }
}

async function embedBatch(
  embeddings: EmbeddingProvider,
  texts: readonly string[],
  signal: AbortSignal,
): Promise<number[][]> {
  let vectors: number[][];
  try {
    vectors = await embeddings.embed(texts, signal);
  } catch (error) {
    signal.throwIfAborted();
    throw toChatbotError(error, 'provider_unavailable');
  }
  const valid =
    vectors.length === texts.length &&
    vectors.every(
      (vector) =>
        vector.length === embeddings.dimensions && vector.every((value) => Number.isFinite(value)),
    );
  if (!valid) {
    throw new ChatbotError(
      'provider_unavailable',
      `Embedding provider returned ${vectors.length} vectors for ${texts.length} texts or a vector of the wrong size`,
    );
  }
  return vectors;
}

/**
 * Builds a new index version for an instance (ADR 0002): loads its sources,
 * chunks them, embeds chunks that are not in the instance's embedding cache in
 * batches of {@link EMBEDDING_BATCH_SIZE}, writes the version and marks it
 * `ready`. It does not activate the version. Older ready and retired versions
 * beyond {@link RETAINED_VERSIONS} are deleted afterwards.
 *
 * Documents are processed in source URI order, so the same inputs produce the
 * same version. A failure after the version was created deletes it again;
 * embeddings already cached stay cached for the next run.
 */
export async function train(options: TrainOptions): Promise<TrainResult> {
  const { config, configHash, store, embeddings, signal } = options;
  const log = options.log ?? (() => undefined);
  const instanceId = config.id;
  checkProvider(config, embeddings);

  const loaded = await loadDocuments(config.sources, options.sources, signal);
  const tags = resolveAccessTags(config, loaded);
  const prepared: PreparedDocument[] = [];
  for (const document of loaded) {
    const chunks = chunkMarkdown(
      { sourceUri: document.sourceUri, title: document.title, text: document.text },
      config.chunking,
    ).map((chunk) => ({ ...chunk, contentSha256: contentSha256(chunk.content) }));
    if (chunks.length === 0) {
      log(`Skipped ${document.sourceUri}: no text to index`);
      continue;
    }
    prepared.push({ document, accessTags: tags.get(document.sourceUri) ?? [], chunks });
  }
  if (prepared.length === 0) {
    throw new ChatbotError('invalid_config', `No documents with text found for "${instanceId}"`);
  }
  const allChunks = prepared.flatMap((entry) => entry.chunks);
  log(`Loaded ${prepared.length} documents, ${allChunks.length} chunks`);

  await store.ensureInstance(instanceId);
  const model = embeddings.model;
  const hashes = [...new Set(allChunks.map((chunk) => chunk.contentSha256))];
  const vectors = new Map<string, number[]>();
  for (let i = 0; i < hashes.length; i += CACHE_LOOKUP_BATCH) {
    const found = await store.findCachedEmbeddings(
      instanceId,
      model,
      hashes.slice(i, i + CACHE_LOOKUP_BATCH),
    );
    for (const [hash, vector] of found) vectors.set(hash, vector);
  }
  const reusedChunks = allChunks.filter((chunk) => vectors.has(chunk.contentSha256)).length;

  const textByHash = new Map(allChunks.map((chunk) => [chunk.contentSha256, chunk.content]));
  const missing = hashes.filter((hash) => !vectors.has(hash));
  for (let i = 0; i < missing.length; i += EMBEDDING_BATCH_SIZE) {
    signal.throwIfAborted();
    const batch = missing.slice(i, i + EMBEDDING_BATCH_SIZE);
    const embedded = await embedBatch(
      embeddings,
      batch.map((hash) => textByHash.get(hash) ?? ''),
      signal,
    );
    const entries = batch.map((hash, j) => ({ contentSha256: hash, embedding: embedded[j] ?? [] }));
    // Cached per batch, so a run that fails later does not pay for these embeddings again.
    await store.cacheEmbeddings(instanceId, model, entries);
    for (const entry of entries) vectors.set(entry.contentSha256, entry.embedding);
    log(`Embedded ${Math.min(i + batch.length, missing.length)} of ${missing.length} new chunks`);
  }

  signal.throwIfAborted();
  const versionId = await store.createIndexVersion(instanceId, {
    embeddingProvider: embeddings.provider,
    embeddingModel: model,
    embeddingDimensions: embeddings.dimensions,
    chunkerHash: chunkerHash(config.chunking),
    configHash,
  });
  try {
    for (const { document, accessTags, chunks } of prepared) {
      signal.throwIfAborted();
      await store.insertDocument(
        instanceId,
        versionId,
        {
          sourceUri: document.sourceUri,
          title: document.title,
          contentSha256: document.contentSha256,
          tenantKey: '_',
          accessTags,
        },
        chunks.map((chunk) => ({
          ordinal: chunk.ordinal,
          headingPath: chunk.headingPath,
          content: chunk.content,
          embedding: vectors.get(chunk.contentSha256) ?? [],
        })),
      );
    }
    await store.markReady(instanceId, versionId, {
      documents: prepared.length,
      chunks: allChunks.length,
    });
  } catch (error) {
    await store.deleteVersion(instanceId, versionId).catch((cleanup: unknown) => {
      log(`Could not delete unfinished version ${versionId}: ${toChatbotError(cleanup).message}`);
    });
    throw toChatbotError(error);
  }
  log(`Version ${versionId} is ready`);

  return {
    versionId,
    documents: prepared.length,
    chunks: allChunks.length,
    embeddedChunks: allChunks.length - reusedChunks,
    reusedChunks,
    prunedVersions: await pruneVersions(store, instanceId, log),
  };
}

// Housekeeping after a successful build: a failure here is logged rather than thrown, because
// the new version is already complete and usable.
async function pruneVersions(
  store: IngestStore,
  instanceId: string,
  log: (message: string) => void,
): Promise<string[]> {
  const pruned: string[] = [];
  try {
    const stale = (await store.listVersions(instanceId))
      .filter((version) => version.status === 'ready' || version.status === 'retired')
      .slice(RETAINED_VERSIONS);
    for (const version of stale) {
      await store.deleteVersion(instanceId, version.id);
      pruned.push(version.id);
      log(`Deleted old version ${version.id} (${version.status})`);
    }
  } catch (error) {
    log(`Could not delete old versions: ${toChatbotError(error).message}`);
  }
  return pruned;
}
