-- Runs as rag_migrator. The migration runner has already created the roles, the rag schema and
-- the vector extension, because pgvector is not a trusted extension and needs an administrator.

CREATE TABLE rag.instances (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  active_index_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rag.index_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id text NOT NULL REFERENCES rag.instances (id),
  status text NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready', 'active', 'retired')),
  embedding_provider text NOT NULL CHECK (length(embedding_provider) BETWEEN 1 AND 64),
  embedding_model text NOT NULL CHECK (length(embedding_model) BETWEEN 1 AND 128),
  -- One platform-wide dimension (ADR 0006); the chunks column is typed to match.
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions = 1024),
  chunker_hash text NOT NULL CHECK (chunker_hash ~ '^[0-9a-f]{64}$'),
  config_hash text NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  document_count integer NOT NULL DEFAULT 0 CHECK (document_count >= 0),
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  -- Retired versions were active once, so both carry an activation time.
  CHECK ((activated_at IS NULL) = (status IN ('building', 'ready'))),
  UNIQUE (instance_id, id)
);

CREATE UNIQUE INDEX index_versions_one_active
  ON rag.index_versions (instance_id) WHERE status = 'active';

-- The composite key stops an instance from pointing at another instance's version.
ALTER TABLE rag.instances
  ADD CONSTRAINT instances_active_index_version_fk
  FOREIGN KEY (id, active_index_version_id) REFERENCES rag.index_versions (instance_id, id);

CREATE TABLE rag.eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id text NOT NULL,
  index_version_id uuid NOT NULL,
  embedding_provider text NOT NULL,
  embedding_model text NOT NULL,
  passed boolean NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (instance_id, index_version_id)
    REFERENCES rag.index_versions (instance_id, id) ON DELETE CASCADE
);

CREATE INDEX eval_runs_version ON rag.eval_runs (instance_id, index_version_id, created_at);

CREATE TABLE rag.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id text NOT NULL,
  index_version_id uuid NOT NULL,
  source_uri text NOT NULL CHECK (length(source_uri) BETWEEN 1 AND 2048),
  title text NOT NULL DEFAULT '',
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  tenant_key text NOT NULL DEFAULT '_' CHECK (length(tenant_key) BETWEEN 1 AND 128),
  access_tags text[] NOT NULL CHECK (cardinality(access_tags) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (instance_id, index_version_id)
    REFERENCES rag.index_versions (instance_id, id) ON DELETE CASCADE,
  UNIQUE (instance_id, index_version_id, tenant_key, source_uri),
  UNIQUE (instance_id, index_version_id, tenant_key, id)
);

CREATE TABLE rag.chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id text NOT NULL,
  index_version_id uuid NOT NULL,
  document_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  heading_path text[] NOT NULL DEFAULT '{}',
  content text NOT NULL CHECK (length(content) >= 1),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding vector(1024) NOT NULL,
  tenant_key text NOT NULL DEFAULT '_' CHECK (length(tenant_key) BETWEEN 1 AND 128),
  access_tags text[] NOT NULL CHECK (cardinality(access_tags) >= 1),
  -- Including tenant_key means a chunk can never belong to another tenant than its document.
  FOREIGN KEY (instance_id, index_version_id, tenant_key, document_id)
    REFERENCES rag.documents (instance_id, index_version_id, tenant_key, id) ON DELETE CASCADE,
  UNIQUE (document_id, ordinal)
);

CREATE INDEX chunks_tsv ON rag.chunks USING gin (tsv);
CREATE INDEX chunks_access_tags ON rag.chunks USING gin (access_tags);
CREATE INDEX chunks_scope ON rag.chunks (instance_id, index_version_id, tenant_key);
CREATE INDEX chunks_embedding_hnsw ON rag.chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE rag.embedding_cache (
  instance_id text NOT NULL REFERENCES rag.instances (id),
  model text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  embedding vector(1024) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, model, content_sha256)
);
