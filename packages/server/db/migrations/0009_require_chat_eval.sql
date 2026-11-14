-- The activation gate now needs two passing eval runs for the version: the latest retrieval run and
-- the latest chat run (ADR 0009). A chat run cannot unlock activation alone, and a retrieval run
-- cannot stand in for the refusal check. Each run's embedding provider and model must match the
-- version. Everything else is unchanged from 0007.

CREATE OR REPLACE FUNCTION rag.activate_index_version(
  p_instance_id text,
  p_version_id uuid,
  p_force boolean,
  p_reason text,
  p_operator text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, rag, pg_temp AS $$
DECLARE
  v_status text;
  v_provider text;
  v_model text;
  v_previous uuid;
  v_reason text := NULLIF(btrim(p_reason), '');
  v_operator text := NULLIF(btrim(p_operator), '');
  v_eval record;
  v_eval_harness text;
BEGIN
  IF p_instance_id IS DISTINCT FROM rag.current_instance() THEN
    RAISE EXCEPTION 'activation requires a matching instance context' USING ERRCODE = '42501';
  END IF;
  IF p_force IS NULL THEN
    RAISE EXCEPTION 'p_force must be true or false' USING ERRCODE = '22023';
  END IF;
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'activation requires an operator' USING ERRCODE = '22023';
  END IF;
  IF p_force AND v_reason IS NULL THEN
    RAISE EXCEPTION 'forced activation requires a reason' USING ERRCODE = '22023';
  END IF;

  -- Locking the instance row serialises concurrent activations of the same instance.
  SELECT active_index_version_id INTO v_previous
    FROM rag.instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'instance does not exist' USING ERRCODE = 'P0002';
  END IF;

  SELECT status, embedding_provider, embedding_model INTO v_status, v_provider, v_model
    FROM rag.index_versions WHERE id = p_version_id AND instance_id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'index version does not exist for this instance' USING ERRCODE = 'P0002';
  END IF;
  IF v_status NOT IN ('ready', 'retired') THEN
    RAISE EXCEPTION 'index version is %, expected ready or retired', v_status
      USING ERRCODE = '55000';
  END IF;

  IF NOT p_force THEN
    FOREACH v_eval_harness IN ARRAY ARRAY['retrieval', 'chat'] LOOP
      -- Same ordering as the latest eval run that ragctl versions shows.
      SELECT id, passed, embedding_provider, embedding_model INTO v_eval
        FROM rag.eval_runs
        WHERE instance_id = p_instance_id
          AND index_version_id = p_version_id
          AND metrics->>'harness' = v_eval_harness
        ORDER BY created_at DESC, id DESC
        LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'eval gate: index version has no % eval run', v_eval_harness
          USING ERRCODE = '55000';
      END IF;
      IF NOT v_eval.passed THEN
        RAISE EXCEPTION 'eval gate: latest % eval run % failed', v_eval_harness, v_eval.id
          USING ERRCODE = '55000';
      END IF;
      IF v_eval.embedding_provider <> v_provider OR v_eval.embedding_model <> v_model THEN
        RAISE EXCEPTION 'eval gate: latest % eval run used %/%, but the version was built with %/%',
          v_eval_harness, v_eval.embedding_provider, v_eval.embedding_model, v_provider, v_model
          USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END IF;

  UPDATE rag.index_versions SET status = 'retired'
    WHERE instance_id = p_instance_id AND status = 'active';
  UPDATE rag.index_versions SET status = 'active', activated_at = now()
    WHERE id = p_version_id;
  UPDATE rag.instances SET active_index_version_id = p_version_id
    WHERE id = p_instance_id;
  INSERT INTO rag.activation_log (instance_id, index_version_id, forced, reason, operator)
    VALUES (p_instance_id, p_version_id, p_force, v_reason, v_operator);

  RETURN v_previous;
END;
$$;

REVOKE ALL ON FUNCTION rag.activate_index_version(text, uuid, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rag.activate_index_version(text, uuid, boolean, text, text) TO rag_ingest;
