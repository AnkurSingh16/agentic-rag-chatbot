-- Access context helpers. They read transaction-local settings written with
-- set_config(..., true). An unset setting reads as NULL, or as '' once the session has used it,
-- and both become NULL here so every policy comparison is NULL and no row matches.
CREATE FUNCTION rag.current_instance() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT NULLIF(current_setting('rag.instance_id', true), '')
$$;

CREATE FUNCTION rag.current_tenant() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT NULLIF(current_setting('rag.tenant_key', true), '')
$$;

CREATE FUNCTION rag.current_access_tags() RETURNS text[]
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT string_to_array(NULLIF(current_setting('rag.access_tags', true), ''), ',')
$$;

CREATE FUNCTION rag.current_owner() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT NULLIF(current_setting('rag.owner_key', true), '')
$$;

REVOKE ALL ON FUNCTION rag.current_instance(), rag.current_tenant(), rag.current_access_tags(),
  rag.current_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rag.current_instance(), rag.current_tenant(), rag.current_access_tags(),
  rag.current_owner() TO rag_runtime, rag_ingest;

REVOKE ALL ON SCHEMA rag FROM PUBLIC;
GRANT USAGE ON SCHEMA rag TO rag_runtime, rag_ingest;

-- FORCE also applies the policies to rag_migrator, the owner, so a SECURITY DEFINER function
-- sees only what a policy written for rag_migrator allows.
ALTER TABLE rag.instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.instances FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.index_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.index_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.eval_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.embedding_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.embedding_cache FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.messages FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.usage_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.usage_global ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.usage_global FORCE ROW LEVEL SECURITY;
ALTER TABLE rag.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag.schema_migrations FORCE ROW LEVEL SECURITY;

-- The migration runner records history as rag_migrator; no other role has a grant here.
CREATE POLICY schema_migrations_migrator ON rag.schema_migrations TO rag_migrator
  USING (true) WITH CHECK (true);

-- rag_runtime: reads the corpus of its instance, tenant and tags; writes conversations,
-- messages, feedback and usage counters (ADR 0003, ADR 0004).

CREATE POLICY instances_runtime ON rag.instances FOR SELECT TO rag_runtime
  USING (id = rag.current_instance());

CREATE POLICY index_versions_runtime ON rag.index_versions FOR SELECT TO rag_runtime
  USING (instance_id = rag.current_instance());

CREATE POLICY documents_runtime ON rag.documents FOR SELECT TO rag_runtime
  USING (instance_id = rag.current_instance()
    AND tenant_key = rag.current_tenant()
    AND access_tags && rag.current_access_tags());

CREATE POLICY chunks_runtime ON rag.chunks FOR SELECT TO rag_runtime
  USING (instance_id = rag.current_instance()
    AND tenant_key = rag.current_tenant()
    AND access_tags && rag.current_access_tags());

CREATE POLICY conversations_runtime ON rag.conversations TO rag_runtime
  USING (instance_id = rag.current_instance() AND owner_key = rag.current_owner())
  WITH CHECK (instance_id = rag.current_instance() AND owner_key = rag.current_owner());

CREATE POLICY messages_runtime ON rag.messages TO rag_runtime
  USING (instance_id = rag.current_instance() AND owner_key = rag.current_owner())
  WITH CHECK (instance_id = rag.current_instance() AND owner_key = rag.current_owner());

CREATE POLICY feedback_runtime ON rag.feedback TO rag_runtime
  USING (instance_id = rag.current_instance() AND owner_key = rag.current_owner())
  WITH CHECK (instance_id = rag.current_instance() AND owner_key = rag.current_owner());

CREATE POLICY usage_counters_runtime ON rag.usage_counters TO rag_runtime
  USING (instance_id = rag.current_instance())
  WITH CHECK (instance_id = rag.current_instance());

-- The global budget spans instances, so it cannot be scoped to one. Requiring an instance
-- context still keeps it out of reach of code that skipped the request transaction.
CREATE POLICY usage_global_runtime ON rag.usage_global TO rag_runtime
  USING (rag.current_instance() IS NOT NULL)
  WITH CHECK (rag.current_instance() IS NOT NULL);

GRANT SELECT ON rag.instances, rag.index_versions, rag.documents, rag.chunks TO rag_runtime;
-- created_at always comes from the default, so the expiry CHECK on conversations bounds every
-- conversation's lifetime from the moment it was really created.
GRANT SELECT, DELETE ON rag.conversations TO rag_runtime;
GRANT INSERT (instance_id, owner_key, expires_at), UPDATE (expires_at) ON rag.conversations
  TO rag_runtime;
GRANT SELECT, INSERT ON rag.messages, rag.feedback TO rag_runtime;
GRANT SELECT, INSERT ON rag.usage_counters, rag.usage_global TO rag_runtime;
GRANT UPDATE (tokens, requests) ON rag.usage_counters, rag.usage_global TO rag_runtime;

-- rag_ingest: writes the corpus of one instance at a time, for every tenant and tag. Corpus
-- rows can only be added to a version that is still building, so a ready, active or retired
-- version never changes and rollback returns exactly what was evaluated.

CREATE POLICY instances_ingest_select ON rag.instances FOR SELECT TO rag_ingest
  USING (id = rag.current_instance());
CREATE POLICY instances_ingest_insert ON rag.instances FOR INSERT TO rag_ingest
  WITH CHECK (id = rag.current_instance());

CREATE POLICY index_versions_ingest_select ON rag.index_versions FOR SELECT TO rag_ingest
  USING (instance_id = rag.current_instance());
CREATE POLICY index_versions_ingest_insert ON rag.index_versions FOR INSERT TO rag_ingest
  WITH CHECK (instance_id = rag.current_instance() AND status = 'building');
-- Ingest can edit a version only while it is building, and finish it by marking it ready.
-- A ready version is immutable to ingest; only rag.activate_index_version changes it further.
CREATE POLICY index_versions_ingest_update ON rag.index_versions FOR UPDATE TO rag_ingest
  USING (instance_id = rag.current_instance() AND status = 'building')
  WITH CHECK (instance_id = rag.current_instance() AND status IN ('building', 'ready'));
CREATE POLICY index_versions_ingest_delete ON rag.index_versions FOR DELETE TO rag_ingest
  USING (instance_id = rag.current_instance() AND status <> 'active');

CREATE POLICY eval_runs_ingest ON rag.eval_runs TO rag_ingest
  USING (instance_id = rag.current_instance())
  WITH CHECK (instance_id = rag.current_instance());

CREATE POLICY documents_ingest_select ON rag.documents FOR SELECT TO rag_ingest
  USING (instance_id = rag.current_instance());
CREATE POLICY documents_ingest_insert ON rag.documents FOR INSERT TO rag_ingest
  WITH CHECK (instance_id = rag.current_instance()
    AND EXISTS (SELECT 1 FROM rag.index_versions v
      WHERE v.instance_id = documents.instance_id
        AND v.id = documents.index_version_id
        AND v.status = 'building'));

CREATE POLICY chunks_ingest_select ON rag.chunks FOR SELECT TO rag_ingest
  USING (instance_id = rag.current_instance());
CREATE POLICY chunks_ingest_insert ON rag.chunks FOR INSERT TO rag_ingest
  WITH CHECK (instance_id = rag.current_instance()
    AND EXISTS (SELECT 1 FROM rag.index_versions v
      WHERE v.instance_id = chunks.instance_id
        AND v.id = chunks.index_version_id
        AND v.status = 'building'));

CREATE POLICY embedding_cache_ingest ON rag.embedding_cache TO rag_ingest
  USING (instance_id = rag.current_instance())
  WITH CHECK (instance_id = rag.current_instance());

GRANT SELECT ON rag.instances TO rag_ingest;
GRANT INSERT (id) ON rag.instances TO rag_ingest;
GRANT SELECT, INSERT, DELETE ON rag.index_versions TO rag_ingest;
GRANT UPDATE (status, document_count, chunk_count) ON rag.index_versions TO rag_ingest;
GRANT SELECT, INSERT ON rag.eval_runs, rag.documents, rag.chunks, rag.embedding_cache TO rag_ingest;
