-- Caps what one call to rag.consume_usage can add (issue #15). Without a cap, a single call close
-- to the bigint maximum made every later call overflow for the rest of the UTC day, for every
-- instance, because they all share the global counter. One call accounts for one chat turn: at
-- most one request, and at most 100,000 tokens of input and output together.
CREATE OR REPLACE FUNCTION rag.consume_usage(p_scopes text[], p_tokens bigint, p_requests bigint)
RETURNS TABLE (counter_scope text, total_tokens bigint, total_requests bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, rag, pg_temp AS $$
DECLARE
  v_instance text := rag.current_instance();
  -- UTC so that replicas in different time zones count the same day.
  v_day date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF v_instance IS NULL THEN
    RAISE EXCEPTION 'usage requires an instance context' USING ERRCODE = '42501';
  END IF;
  IF p_tokens IS NULL OR p_requests IS NULL OR p_tokens < 0 OR p_requests < 0 THEN
    RAISE EXCEPTION 'usage deltas must be non-negative' USING ERRCODE = '22023';
  END IF;
  IF p_tokens > 100000 OR p_requests > 1 THEN
    RAISE EXCEPTION 'usage deltas exceed one turn (at most 100000 tokens and 1 request per call)'
      USING ERRCODE = '22023';
  END IF;
  IF p_scopes IS NULL OR cardinality(p_scopes) = 0 OR array_position(p_scopes, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'at least one usage scope is required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    INSERT INTO rag.usage_counters AS c (instance_id, scope, day, tokens, requests)
    SELECT DISTINCT v_instance, s.name, v_day, p_tokens, p_requests FROM unnest(p_scopes) AS s (name)
    ON CONFLICT ON CONSTRAINT usage_counters_pkey DO UPDATE
      SET tokens = c.tokens + EXCLUDED.tokens, requests = c.requests + EXCLUDED.requests
    RETURNING c.scope, c.tokens, c.requests;

  RETURN QUERY
    INSERT INTO rag.usage_global AS g (day, tokens, requests)
    VALUES (v_day, p_tokens, p_requests)
    ON CONFLICT ON CONSTRAINT usage_global_pkey DO UPDATE
      SET tokens = g.tokens + EXCLUDED.tokens, requests = g.requests + EXCLUDED.requests
    RETURNING NULL::text, g.tokens, g.requests;
END;
$$;

-- CREATE OR REPLACE keeps the existing privileges; restating them keeps this file self-contained.
REVOKE ALL ON FUNCTION rag.consume_usage(text[], bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rag.consume_usage(text[], bigint, bigint) TO rag_runtime;
