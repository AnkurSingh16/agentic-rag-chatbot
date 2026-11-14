import { RETRIEVAL } from '@agentic-rag/core';
import type {
  ActiveIndexVersion,
  RetrievalAccess,
  RetrievalStore,
  RetrievedChunk,
  SearchQuery,
} from '@agentic-rag/core';
import type { PooledClient } from './queryable.js';
import { withInstanceTransaction } from './transaction.js';

interface ChunkRow {
  id: string;
  source_uri: string;
  title: string;
  heading_path: string[];
  content: string;
  score: number;
}

// Hybrid search from ADR 0006 in one statement: full-text and vector candidates, fused with
// Reciprocal Rank Fusion. Row-level security limits both CTEs to chunks the caller may read; the
// explicit instance and version filters narrow the scope before the vector sort. The fused floor drops
// full-text-only matches; vector candidates within maxVectorDistance are kept whatever their score
// (ADR 0009).
const SEARCH_SQL = `
WITH fts AS (
  SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q.query) DESC, c.id) AS rank
  FROM rag.chunks c, websearch_to_tsquery('english', $3) AS q(query)
  WHERE c.instance_id = $1 AND c.index_version_id = $2 AND c.tsv @@ q.query
  ORDER BY rank
  LIMIT $5
),
scope AS MATERIALIZED (
  SELECT c.id, c.embedding
  FROM rag.chunks c
  WHERE c.instance_id = $1 AND c.index_version_id = $2
),
-- An exact sort over the visible scope, not an HNSW scan: the approximate index returns a fixed
-- candidate pool before row-level security filters it, so a small instance in a shared table can
-- get no candidates at all (ADR 0009 amendment). MATERIALIZED keeps the scope a plain scan.
vec AS (
  SELECT id, row_number() OVER (ORDER BY distance, id) AS rank
  FROM (
    SELECT s.id, s.embedding <=> $4::vector AS distance
    FROM scope s
    ORDER BY distance, s.id
    LIMIT $5
  ) nearest
  WHERE distance <= $6
)
SELECT c.id, d.source_uri, d.title, c.heading_path, c.content, f.score::float8 AS score
FROM (
  SELECT id, sum(1.0 / ($7 + rank)) AS score
  FROM (SELECT id, rank FROM fts UNION ALL SELECT id, rank FROM vec) ranked
  GROUP BY id
) f
JOIN rag.chunks c ON c.id = f.id
JOIN rag.documents d ON d.id = c.document_id
WHERE f.score >= $8 OR f.id IN (SELECT id FROM vec)
ORDER BY f.score DESC, c.id
LIMIT $9`;

/**
 * The PostgreSQL implementation of {@link RetrievalStore}. With a `rag_runtime` pool it serves
 * chat under the caller's tenant and access tags; with a `rag_ingest` pool it reads any version
 * of the instance, which is how `ragctl eval` scores a version before activation.
 */
export function createPostgresRetrievalStore(pool: {
  connect(): Promise<PooledClient>;
}): RetrievalStore {
  function inAccess<T>(access: RetrievalAccess, fn: (client: PooledClient) => Promise<T>) {
    return withInstanceTransaction(
      pool,
      { instanceId: access.instanceId, tenantKey: access.tenantKey, accessTags: access.accessTags },
      fn,
    );
  }

  return {
    activeVersion: (access) =>
      inAccess(access, async (client): Promise<ActiveIndexVersion | undefined> => {
        const result = await client.query<{
          id: string;
          embedding_provider: string;
          embedding_model: string;
        }>(
          `SELECT v.id, v.embedding_provider, v.embedding_model
           FROM rag.instances i
           JOIN rag.index_versions v ON v.instance_id = i.id AND v.id = i.active_index_version_id
           WHERE i.id = $1`,
          [access.instanceId],
        );
        const row = result.rows[0];
        return row === undefined
          ? undefined
          : {
              id: row.id,
              embeddingProvider: row.embedding_provider,
              embeddingModel: row.embedding_model,
            };
      }),

    search: (access, versionId, queries: readonly SearchQuery[]) =>
      inAccess(access, async (client) => {
        const lists: RetrievedChunk[][] = [];
        for (const query of queries) {
          const result = await client.query<ChunkRow>(SEARCH_SQL, [
            access.instanceId,
            versionId,
            query.text,
            `[${query.embedding.join(',')}]`,
            RETRIEVAL.candidates,
            RETRIEVAL.maxVectorDistance,
            RETRIEVAL.rrfK,
            RETRIEVAL.minFusedScore,
            query.limit,
          ]);
          lists.push(
            result.rows.map((row) => ({
              chunkId: row.id,
              sourceUri: row.source_uri,
              title: row.title,
              headingPath: row.heading_path,
              content: row.content,
              score: row.score,
            })),
          );
        }
        return lists;
      }),
  };
}
