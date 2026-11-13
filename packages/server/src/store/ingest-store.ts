import { ChatbotError, toChatbotError } from '@agentic-rag/core';
import type {
  ActivationRequest,
  CachedEmbedding,
  ChunkRecord,
  DocumentRecord,
  IndexVersionStatus,
  IndexVersionSummary,
  IngestStore,
  NewEvalRun,
  NewIndexVersion,
} from '@agentic-rag/core';
import type { PooledClient } from './queryable.js';
import { withInstanceTransaction } from './transaction.js';

// Nine parameters per chunk row keeps one statement far below PostgreSQL's 65,535 limit.
const CHUNK_INSERT_BATCH = 100;
const CACHE_INSERT_BATCH = 100;

interface VersionRow {
  id: string;
  status: IndexVersionStatus;
  embedding_provider: string;
  embedding_model: string;
  embedding_dimensions: number;
  chunker_hash: string;
  config_hash: string;
  document_count: number;
  chunk_count: number;
  created_at: Date;
  activated_at: Date | null;
  eval_id: string | null;
  eval_provider: string | null;
  eval_model: string | null;
  eval_passed: boolean | null;
  eval_created_at: Date | null;
}

const VERSION_SELECT = `
  SELECT v.id, v.status, v.embedding_provider, v.embedding_model, v.embedding_dimensions,
         v.chunker_hash, v.config_hash, v.document_count, v.chunk_count, v.created_at,
         v.activated_at, e.id AS eval_id, e.embedding_provider AS eval_provider,
         e.embedding_model AS eval_model, e.passed AS eval_passed, e.created_at AS eval_created_at
  FROM rag.index_versions v
  LEFT JOIN LATERAL (
    SELECT r.id, r.embedding_provider, r.embedding_model, r.passed, r.created_at
    FROM rag.eval_runs r
    WHERE r.instance_id = v.instance_id AND r.index_version_id = v.id
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 1
  ) e ON true`;

function toSummary(row: VersionRow): IndexVersionSummary {
  return {
    id: row.id,
    status: row.status,
    embeddingProvider: row.embedding_provider,
    embeddingModel: row.embedding_model,
    embeddingDimensions: row.embedding_dimensions,
    chunkerHash: row.chunker_hash,
    configHash: row.config_hash,
    documentCount: row.document_count,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    latestEval:
      row.eval_id === null
        ? null
        : {
            id: row.eval_id,
            embeddingProvider: row.eval_provider ?? '',
            embeddingModel: row.eval_model ?? '',
            passed: row.eval_passed === true,
            createdAt: row.eval_created_at ?? row.created_at,
          },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** pgvector's text format, which is also a JSON array. */
function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

function parseVector(text: string): number[] {
  return JSON.parse(text) as number[];
}

function placeholders(rowCount: number, columns: number, casts: readonly string[] = []): string {
  return Array.from({ length: rowCount }, (_, row) => {
    const cells = Array.from(
      { length: columns },
      (_, column) => `$${row * columns + column + 1}${casts[column] ?? ''}`,
    );
    return `(${cells.join(', ')})`;
  }).join(', ');
}

function sqlState(error: unknown): string | undefined {
  const cause = error instanceof ChatbotError ? error.cause : error;
  return typeof cause === 'object' && cause !== null && 'code' in cause
    ? String(cause.code)
    : undefined;
}

/**
 * The PostgreSQL implementation of {@link IngestStore}. `pool` must log in as
 * `rag_ingest`. Every call runs in its own transaction under the instance's
 * access context, so a training run holds no connection while it embeds.
 */
export function createPostgresIngestStore(pool: { connect(): Promise<PooledClient> }): IngestStore {
  function inInstance<T>(instanceId: string, fn: (client: PooledClient) => Promise<T>) {
    // The ingest policies filter on the instance only; tenant and tags are not used for writes.
    return withInstanceTransaction(pool, { instanceId, tenantKey: '_', accessTags: [] }, fn);
  }

  return {
    ensureInstance: (instanceId) =>
      inInstance(instanceId, async (client) => {
        await client.query('INSERT INTO rag.instances (id) VALUES ($1) ON CONFLICT DO NOTHING', [
          instanceId,
        ]);
      }),

    createIndexVersion: (instanceId, version: NewIndexVersion) =>
      inInstance(instanceId, async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO rag.index_versions
             (instance_id, embedding_provider, embedding_model, embedding_dimensions,
              chunker_hash, config_hash)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            instanceId,
            version.embeddingProvider,
            version.embeddingModel,
            version.embeddingDimensions,
            version.chunkerHash,
            version.configHash,
          ],
        );
        const id = result.rows[0]?.id;
        if (id === undefined) throw new ChatbotError('internal', 'Index version was not created');
        return id;
      }),

    insertDocument: (
      instanceId,
      versionId,
      document: DocumentRecord,
      chunks: readonly ChunkRecord[],
    ) =>
      inInstance(instanceId, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO rag.documents
             (instance_id, index_version_id, source_uri, title, content_sha256, tenant_key, access_tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            instanceId,
            versionId,
            document.sourceUri,
            document.title,
            document.contentSha256,
            document.tenantKey,
            [...document.accessTags],
          ],
        );
        const documentId = inserted.rows[0]?.id;
        if (documentId === undefined) {
          throw new ChatbotError('internal', `Document ${document.sourceUri} was not created`);
        }
        for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
          const batch = chunks.slice(i, i + CHUNK_INSERT_BATCH);
          await client.query(
            `INSERT INTO rag.chunks
               (instance_id, index_version_id, document_id, ordinal, heading_path, content,
                embedding, tenant_key, access_tags)
             VALUES ${placeholders(batch.length, 9, ['', '', '', '', '', '', '::vector'])}`,
            batch.flatMap((chunk) => [
              instanceId,
              versionId,
              documentId,
              chunk.ordinal,
              [...chunk.headingPath],
              chunk.content,
              vectorLiteral(chunk.embedding),
              document.tenantKey,
              [...document.accessTags],
            ]),
          );
        }
      }),

    findCachedEmbeddings: (instanceId, model, hashes) =>
      inInstance(instanceId, async (client) => {
        if (hashes.length === 0) return new Map<string, number[]>();
        const result = await client.query<{ content_sha256: string; embedding: string }>(
          `SELECT content_sha256, embedding::text AS embedding FROM rag.embedding_cache
           WHERE instance_id = $1 AND model = $2 AND content_sha256 = ANY($3::text[])`,
          [instanceId, model, [...hashes]],
        );
        return new Map(result.rows.map((row) => [row.content_sha256, parseVector(row.embedding)]));
      }),

    cacheEmbeddings: (instanceId, model, entries: readonly CachedEmbedding[]) =>
      inInstance(instanceId, async (client) => {
        for (let i = 0; i < entries.length; i += CACHE_INSERT_BATCH) {
          const batch = entries.slice(i, i + CACHE_INSERT_BATCH);
          await client.query(
            `INSERT INTO rag.embedding_cache (instance_id, model, content_sha256, embedding)
             VALUES ${placeholders(batch.length, 4, ['', '', '', '::vector'])}
             ON CONFLICT DO NOTHING`,
            batch.flatMap((entry) => [
              instanceId,
              model,
              entry.contentSha256,
              vectorLiteral(entry.embedding),
            ]),
          );
        }
      }),

    markReady: (instanceId, versionId, counts) =>
      inInstance(instanceId, async (client) => {
        const result = await client.query(
          `UPDATE rag.index_versions SET status = 'ready', document_count = $2, chunk_count = $3
           WHERE id = $1 AND status = 'building'`,
          [versionId, counts.documents, counts.chunks],
        );
        if (result.rowCount !== 1) {
          throw new ChatbotError(
            'invalid_input',
            `Index version ${versionId} is not building and cannot be marked ready`,
          );
        }
      }),

    deleteVersion: (instanceId, versionId) =>
      inInstance(instanceId, async (client) => {
        // Documents, chunks and eval runs go with the version through ON DELETE CASCADE. The
        // ingest policy refuses to delete the active version.
        const result = await client.query(
          "DELETE FROM rag.index_versions WHERE id = $1 AND status <> 'active'",
          [versionId],
        );
        if (result.rowCount !== 1) {
          throw new ChatbotError(
            'invalid_input',
            `Index version ${versionId} does not exist or is active and cannot be deleted`,
          );
        }
      }),

    recordEvalRun: (instanceId, versionId, run: NewEvalRun) =>
      inInstance(instanceId, async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO rag.eval_runs
             (instance_id, index_version_id, embedding_provider, embedding_model, passed, metrics)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            instanceId,
            versionId,
            run.embeddingProvider,
            run.embeddingModel,
            run.passed,
            JSON.stringify(run.metrics),
          ],
        );
        const id = result.rows[0]?.id;
        if (id === undefined) throw new ChatbotError('internal', 'Eval run was not recorded');
        return id;
      }),

    activate: async (instanceId, versionId, request: ActivationRequest) => {
      try {
        return await inInstance(instanceId, async (client) => {
          // The function enforces the eval gate and writes rag.activation_log (migration 0007).
          const result = await client.query<{ previous: string | null }>(
            'SELECT rag.activate_index_version($1, $2, $3, $4, $5, $6) AS previous',
            [
              instanceId,
              versionId,
              request.force,
              request.reason ?? null,
              request.operator,
              request.configFingerprint,
            ],
          );
          return result.rows[0]?.previous ?? null;
        });
      } catch (error) {
        const state = sqlState(error);
        const message = error instanceof Error ? error.message : 'activation failed';
        if (state === 'P0002') throw new ChatbotError('not_found', message, { cause: error });
        if (state === '55000' || state === '22023') {
          throw new ChatbotError('invalid_input', message, { cause: error });
        }
        throw toChatbotError(error);
      }
    },

    listVersions: (instanceId) =>
      inInstance(instanceId, async (client) => {
        const result = await client.query<VersionRow>(
          `${VERSION_SELECT} WHERE v.instance_id = $1 ORDER BY v.created_at DESC, v.id DESC`,
          [instanceId],
        );
        return result.rows.map(toSummary);
      }),

    getVersion: (instanceId, versionId) =>
      inInstance(instanceId, async (client) => {
        // An operator-typed ID that is not a UUID would otherwise fail as a database error.
        if (!UUID.test(versionId)) return undefined;
        const result = await client.query<VersionRow>(
          `${VERSION_SELECT} WHERE v.instance_id = $1 AND v.id = $2`,
          [instanceId, versionId],
        );
        const row = result.rows[0];
        return row === undefined ? undefined : toSummary(row);
      }),
  };
}
