BEGIN;

-- Compare every signature byte before deciding whether the HMAC matches.
-- PostgreSQL text equality can stop at the first differing character.
SET ROLE balancevault_auth_owner;
CREATE OR REPLACE FUNCTION balancevault_auth_private.consume_actor_assertion(
  p_actor_id uuid, p_action text, p_issued_at bigint, p_nonce uuid,
  p_context_hash text, p_signature text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $consume_actor_assertion$
DECLARE
  v_secret bytea;
  v_payload text;
  v_now bigint;
  v_expected text;
  v_rows integer;
  v_difference integer := 0;
  v_index integer;
BEGIN
  IF p_actor_id IS NULL OR p_action NOT IN ('INVITATION_CREATE', 'INVITATION_REVOKE', 'CHANGE_PASSWORD')
     OR p_issued_at IS NULL OR p_nonce IS NULL OR p_signature IS NULL
     OR p_context_hash IS NULL OR p_context_hash !~ '^[0-9a-f]{64}$'
     OR p_signature !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid actor assertion' USING ERRCODE = '42501';
  END IF;
  v_now := pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()))::bigint;
  IF p_issued_at < v_now - 60 OR p_issued_at > v_now + 5 THEN
    RAISE EXCEPTION 'Expired actor assertion' USING ERRCODE = '42501';
  END IF;
  SELECT k.secret INTO v_secret
    FROM balancevault_auth_private.actor_assertion_key AS k
   WHERE k.singleton IS TRUE;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Actor assertion verifier is not provisioned' USING ERRCODE = '55000';
  END IF;
  v_payload := 'v1|' || pg_catalog.lower(p_actor_id::text) || '|' || p_action || '|'
    || p_issued_at::text || '|' || pg_catalog.lower(p_nonce::text) || '|' || p_context_hash;
  v_expected := pg_catalog.encode(
    public.hmac(pg_catalog.convert_to(v_payload, 'UTF8'), v_secret, 'sha256'), 'hex'
  );
  FOR v_index IN 1..64 LOOP
    v_difference := v_difference | (
      pg_catalog.ascii(pg_catalog.substr(v_expected, v_index, 1)) #
      pg_catalog.ascii(pg_catalog.substr(p_signature, v_index, 1))
    );
  END LOOP;
  IF v_difference <> 0 THEN
    RAISE EXCEPTION 'Actor assertion signature is invalid' USING ERRCODE = '42501';
  END IF;
  DELETE FROM balancevault_auth_private.actor_assertion_nonce AS n
   WHERE n.consumed_at < pg_catalog.clock_timestamp() - interval '1 day';
  INSERT INTO balancevault_auth_private.actor_assertion_nonce (nonce, actor_id, action, issued_at)
  VALUES (p_nonce, p_actor_id, p_action, p_issued_at)
  ON CONFLICT (nonce) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Actor assertion has already been used' USING ERRCODE = '42501';
  END IF;
END;
$consume_actor_assertion$;
RESET ROLE;

COMMIT;
