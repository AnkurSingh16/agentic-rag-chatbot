-- rag.consume_usage runs as rag_migrator, which forced RLS also restricts. These policies limit
-- it to the caller's instance counters and the global counter.
CREATE POLICY usage_counters_consumption ON rag.usage_counters TO rag_migrator
  USING (instance_id = rag.current_instance())
  WITH CHECK (instance_id = rag.current_instance());

CREATE POLICY usage_global_consumption ON rag.usage_global TO rag_migrator
  USING (rag.current_instance() IS NOT NULL)
  WITH CHECK (rag.current_instance() IS NOT NULL);

-- Adds non-negative token and request counts to each named scope of the caller's instance, and
-- once to the global counter, for the current UTC day (ADR 0004). Counters can only grow, so a
-- runtime credential cannot reset a budget. Returns the new totals; the global row has a NULL
-- counter_scope.
CREATE FUNCTION rag.consume_usage(p_scopes text[], p_tokens bigint, p_requests bigint)
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

REVOKE ALL ON FUNCTION rag.consume_usage(text[], bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rag.consume_usage(text[], bigint, bigint) TO rag_runtime;
