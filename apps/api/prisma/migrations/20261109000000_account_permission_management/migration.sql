BEGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE balancevault_migration_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

SET ROLE balancevault_auth_owner;
ALTER TABLE balancevault_auth_private.actor_assertion_nonce
  DROP CONSTRAINT actor_assertion_nonce_action_check;
ALTER TABLE balancevault_auth_private.actor_assertion_nonce
  ADD CONSTRAINT actor_assertion_nonce_action_check
  CHECK (action IN ('INVITATION_CREATE', 'INVITATION_REVOKE', 'CHANGE_PASSWORD', 'ACCOUNT_PERMISSIONS_UPDATE'));
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
  IF p_actor_id IS NULL OR p_action NOT IN ('INVITATION_CREATE', 'INVITATION_REVOKE', 'CHANGE_PASSWORD', 'ACCOUNT_PERMISSIONS_UPDATE')
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

GRANT UPDATE (id) ON public."Account", public."User" TO balancevault_provisioning_owner;
GRANT SELECT ON public."Account", public."AccountPermission" TO balancevault_provisioning_owner;
GRANT UPDATE ("canDeposit", "canWithdraw", "canTransfer", "updatedAt")
  ON public."AccountPermission" TO balancevault_provisioning_owner;

CREATE FUNCTION public.set_account_permissions_asserted(
  p_actor uuid, p_account uuid, p_holder uuid,
  p_deposit boolean, p_withdraw boolean, p_transfer boolean,
  p_expected_deposit boolean, p_expected_withdraw boolean, p_expected_transfer boolean,
  p_issued_at bigint, p_nonce uuid, p_context_hash text, p_signature text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_context text;
  v_hash text;
  v_permission public."AccountPermission"%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR p_account IS NULL OR p_holder IS NULL
     OR p_deposit IS NULL OR p_withdraw IS NULL OR p_transfer IS NULL
     OR p_expected_deposit IS NULL OR p_expected_withdraw IS NULL OR p_expected_transfer IS NULL THEN
    RAISE EXCEPTION 'Invalid permission input' USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(octet_length(value)::text || ':' || value, '|' ORDER BY position)
    INTO v_context
    FROM unnest(ARRAY[p_account::text, p_holder::text,
      p_deposit::text, p_withdraw::text, p_transfer::text,
      p_expected_deposit::text, p_expected_withdraw::text, p_expected_transfer::text])
      WITH ORDINALITY AS parts(value, position);
  v_hash := encode(public.digest(convert_to(v_context, 'UTF8'), 'sha256'), 'hex');
  IF v_hash IS DISTINCT FROM p_context_hash THEN
    RAISE EXCEPTION 'Assertion payload mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM balancevault_auth_private.consume_actor_assertion(
    p_actor, 'ACCOUNT_PERMISSIONS_UPDATE', p_issued_at, p_nonce, v_hash, p_signature);

  PERFORM 1 FROM public."User"
    WHERE id = p_actor AND role = 'ADMIN' AND "isActive" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public."User"
    WHERE id = p_holder AND role = 'ACCOUNT_HOLDER' AND "isActive" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active account holder required' USING ERRCODE = '22023';
  END IF;
  -- Serialize against postings, which also lock the account before checking permissions.
  PERFORM 1 FROM public."Account"
    WHERE id = p_account AND type IN ('PERSONAL', 'BUSINESS')
      AND "systemCode" IS NULL AND status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active customer account required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_permission FROM public."AccountPermission"
    WHERE "accountId" = p_account AND "userId" = p_holder AND "canView" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assigned account holder not found' USING ERRCODE = 'P0002';
  END IF;
  IF (v_permission."canDeposit", v_permission."canWithdraw", v_permission."canTransfer")
      IS DISTINCT FROM (p_expected_deposit, p_expected_withdraw, p_expected_transfer) THEN
    RAISE EXCEPTION 'Permissions changed since they were loaded' USING ERRCODE = '40001';
  END IF;
  IF (v_permission."canDeposit", v_permission."canWithdraw", v_permission."canTransfer")
      IS NOT DISTINCT FROM (p_deposit, p_withdraw, p_transfer) THEN
    RETURN false;
  END IF;
  UPDATE public."AccountPermission"
    SET "canDeposit" = p_deposit, "canWithdraw" = p_withdraw,
        "canTransfer" = p_transfer, "updatedAt" = clock_timestamp()
    WHERE id = v_permission.id;
  INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata)
    VALUES (gen_random_uuid(), p_actor, 'ACCOUNT_PERMISSIONS_UPDATED', 'Account', p_account,
      jsonb_build_object('holderId', p_holder,
        'previous', jsonb_build_object('canDeposit', v_permission."canDeposit",
          'canWithdraw', v_permission."canWithdraw", 'canTransfer', v_permission."canTransfer"),
        'current', jsonb_build_object('canDeposit', p_deposit,
          'canWithdraw', p_withdraw, 'canTransfer', p_transfer)));
  RETURN true;
END;
$$;
GRANT CREATE ON SCHEMA public TO balancevault_provisioning_owner;
ALTER FUNCTION public.set_account_permissions_asserted(uuid,uuid,uuid,boolean,boolean,boolean,boolean,boolean,boolean,bigint,uuid,text,text)
  OWNER TO balancevault_provisioning_owner;
REVOKE CREATE ON SCHEMA public FROM balancevault_provisioning_owner;
SET ROLE balancevault_provisioning_owner;
REVOKE ALL ON FUNCTION public.set_account_permissions_asserted(uuid,uuid,uuid,boolean,boolean,boolean,boolean,boolean,boolean,bigint,uuid,text,text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_account_permissions_asserted(uuid,uuid,uuid,boolean,boolean,boolean,boolean,boolean,boolean,bigint,uuid,text,text)
  TO balancevault_runtime;
RESET ROLE;
COMMIT;
