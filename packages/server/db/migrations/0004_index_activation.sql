-- The function runs as rag_migrator, which forced RLS also restricts. These policies give it the
-- caller's instance and nothing else, so activation cannot reach another instance's rows.
CREATE POLICY instances_activation ON rag.instances TO rag_migrator
  USING (id = rag.current_instance())
  WITH CHECK (id = rag.current_instance());

CREATE POLICY index_versions_activation ON rag.index_versions TO rag_migrator
  USING (instance_id = rag.current_instance())
  WITH CHECK (instance_id = rag.current_instance());

-- Makes a ready version active, or a retired one again for rollback (ADR 0002). The previous
-- active version becomes retired. Returns the previously active version, or NULL.
CREATE FUNCTION rag.activate_index_version(p_instance_id text, p_version_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, rag, pg_temp AS $$
DECLARE
  v_status text;
  v_previous uuid;
BEGIN
  IF p_instance_id IS DISTINCT FROM rag.current_instance() THEN
    RAISE EXCEPTION 'activation requires a matching instance context' USING ERRCODE = '42501';
  END IF;

  -- Locking the instance row serialises concurrent activations of the same instance.
  SELECT active_index_version_id INTO v_previous
    FROM rag.instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'instance does not exist' USING ERRCODE = 'P0002';
  END IF;

  SELECT status INTO v_status
    FROM rag.index_versions WHERE id = p_version_id AND instance_id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'index version does not exist for this instance' USING ERRCODE = 'P0002';
  END IF;
  IF v_status NOT IN ('ready', 'retired') THEN
    RAISE EXCEPTION 'index version is %, expected ready or retired', v_status
      USING ERRCODE = '55000';
  END IF;

  UPDATE rag.index_versions SET status = 'retired'
    WHERE instance_id = p_instance_id AND status = 'active';
  UPDATE rag.index_versions SET status = 'active', activated_at = now()
    WHERE id = p_version_id;
  UPDATE rag.instances SET active_index_version_id = p_version_id
    WHERE id = p_instance_id;

  RETURN v_previous;
END;
$$;

REVOKE ALL ON FUNCTION rag.activate_index_version(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rag.activate_index_version(text, uuid) TO rag_ingest;
