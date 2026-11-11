-- Embeddings move from 1024 to 384 dimensions for all-MiniLM-L6-v2 (ADR 0008).
--
-- pgvector cannot convert a 1024-dimension vector to 384, and the new CHECK rejects existing
-- 1024-dimension versions, so this migration fails while rag.chunks, rag.embedding_cache or
-- rag.index_versions hold rows from the old dimension. Indexes are rebuilt by retraining: as an
-- administrator, delete the instances' index versions (documents and chunks cascade) and the
-- embedding cache, run the migration, then run `ragctl train` for each instance.

DROP INDEX rag.chunks_embedding_hnsw;

ALTER TABLE rag.chunks ALTER COLUMN embedding TYPE vector(384);
ALTER TABLE rag.embedding_cache ALTER COLUMN embedding TYPE vector(384);

ALTER TABLE rag.index_versions DROP CONSTRAINT index_versions_embedding_dimensions_check;
ALTER TABLE rag.index_versions
  ADD CONSTRAINT index_versions_embedding_dimensions_check CHECK (embedding_dimensions = 384);

CREATE INDEX chunks_embedding_hnsw ON rag.chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
