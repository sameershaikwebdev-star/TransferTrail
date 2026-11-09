BEGIN;

-- Prevent the default PUBLIC EXECUTE ACL at CREATE FUNCTION time. Prisma Migrate
-- does not implicitly wrap PostgreSQL migration files in a transaction.
ALTER DEFAULT PRIVILEGES FOR ROLE balancevault_migration_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
DO $verify_pgcrypto_schema$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname='pgcrypto' AND n.nspname='public'
  ) THEN
    RAISE EXCEPTION 'pgcrypto must be installed in schema public';
  END IF;
END;
$verify_pgcrypto_schema$;

CREATE SCHEMA balancevault_auth_private AUTHORIZATION balancevault_auth_owner;
SET ROLE balancevault_auth_owner;
REVOKE ALL ON SCHEMA balancevault_auth_private FROM PUBLIC;
GRANT USAGE ON SCHEMA balancevault_auth_private TO balancevault_provisioning_owner;

CREATE TABLE balancevault_auth_private.actor_assertion_key (
  singleton boolean PRIMARY KEY CHECK (singleton IS TRUE),
  secret bytea NOT NULL CHECK (pg_catalog.octet_length(secret) >= 32)
);
CREATE TABLE balancevault_auth_private.actor_assertion_nonce (
  nonce uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('INVITATION_CREATE', 'INVITATION_REVOKE', 'CHANGE_PASSWORD')),
  issued_at bigint NOT NULL,
  consumed_at timestamptz(6) NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE FUNCTION balancevault_auth_private.consume_actor_assertion(
  p_actor_id uuid, p_action text, p_issued_at bigint, p_nonce uuid,
  p_context_hash text, p_signature text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $consume_actor_assertion$
DECLARE v_secret bytea; v_payload text; v_now bigint; v_expected text; v_rows integer;
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
  IF v_expected <> p_signature THEN
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
REVOKE ALL ON FUNCTION balancevault_auth_private.consume_actor_assertion(uuid, text, bigint, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION balancevault_auth_private.consume_actor_assertion(uuid, text, bigint, uuid, text, text)
  TO balancevault_provisioning_owner, balancevault_auth_owner;
RESET ROLE;

-- These legacy entry points trust a UUID and are no longer callable by runtime.
SET ROLE balancevault_provisioning_owner;
REVOKE EXECUTE ON FUNCTION public.create_privileged_user_invitation(uuid, uuid, text, text, public."UserRole", char(64), timestamptz)
  FROM PUBLIC, balancevault_runtime;
REVOKE EXECUTE ON FUNCTION public.revoke_privileged_user_invitation(uuid, uuid)
  FROM PUBLIC, balancevault_runtime;
RESET ROLE;
SET ROLE balancevault_auth_owner;
REVOKE EXECUTE ON FUNCTION public.change_user_password(uuid, integer, text)
  FROM PUBLIC, balancevault_runtime;
RESET ROLE;

CREATE FUNCTION public.create_privileged_user_invitation_asserted(
  p_actor_id uuid, p_invitation_id uuid, p_full_name text, p_email text,
  p_role public."UserRole", p_token_hash char(64), p_expires_at timestamptz(6), p_expires_at_ms bigint,
  p_issued_at bigint, p_nonce uuid, p_context_hash text, p_signature text
)
RETURNS TABLE (id uuid, "fullName" text, email text, role public."UserRole", "expiresAt" timestamptz(6), "createdAt" timestamptz(6))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_privileged_user_invitation_asserted$
DECLARE v_context text; v_hash text;
BEGIN
  IF p_expires_at_ms IS NULL OR pg_catalog.floor(pg_catalog.date_part('epoch', p_expires_at) * 1000)::bigint <> p_expires_at_ms THEN
    RAISE EXCEPTION 'Invitation expiration does not match signed input' USING ERRCODE = '22023';
  END IF;
  v_context := pg_catalog.octet_length(pg_catalog.convert_to(p_invitation_id::text, 'UTF8'))::text || ':' || p_invitation_id::text || '|'
    || pg_catalog.octet_length(pg_catalog.convert_to(p_full_name, 'UTF8'))::text || ':' || p_full_name || '|'
    || pg_catalog.octet_length(pg_catalog.convert_to(p_email, 'UTF8'))::text || ':' || p_email || '|'
    || pg_catalog.octet_length(pg_catalog.convert_to(p_role::text, 'UTF8'))::text || ':' || p_role::text || '|'
    || pg_catalog.octet_length(pg_catalog.convert_to(p_token_hash::text, 'UTF8'))::text || ':' || p_token_hash::text || '|'
    || pg_catalog.octet_length(pg_catalog.convert_to(p_expires_at_ms::text, 'UTF8'))::text || ':' || p_expires_at_ms::text;
  v_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(v_context, 'UTF8'), 'sha256'), 'hex');
  IF v_hash <> p_context_hash THEN RAISE EXCEPTION 'Actor assertion payload does not match' USING ERRCODE = '42501'; END IF;
  PERFORM balancevault_auth_private.consume_actor_assertion(p_actor_id, 'INVITATION_CREATE', p_issued_at, p_nonce, v_hash, p_signature);
  RETURN QUERY SELECT * FROM public.create_privileged_user_invitation(
    p_actor_id, p_invitation_id, p_full_name, p_email, p_role, p_token_hash, p_expires_at
  );
END;
$create_privileged_user_invitation_asserted$;

CREATE FUNCTION public.revoke_privileged_user_invitation_asserted(
  p_actor_id uuid, p_invitation_id uuid, p_issued_at bigint, p_nonce uuid, p_context_hash text, p_signature text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $revoke_privileged_user_invitation_asserted$
DECLARE v_context text; v_hash text;
BEGIN
  v_context := pg_catalog.octet_length(pg_catalog.convert_to(p_invitation_id::text, 'UTF8'))::text || ':' || p_invitation_id::text;
  v_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(v_context, 'UTF8'), 'sha256'), 'hex');
  IF v_hash <> p_context_hash THEN RAISE EXCEPTION 'Actor assertion payload does not match' USING ERRCODE = '42501'; END IF;
  PERFORM balancevault_auth_private.consume_actor_assertion(p_actor_id, 'INVITATION_REVOKE', p_issued_at, p_nonce, v_hash, p_signature);
  RETURN public.revoke_privileged_user_invitation(p_actor_id, p_invitation_id);
END;
$revoke_privileged_user_invitation_asserted$;

CREATE FUNCTION public.change_user_password_asserted(
  p_user_id uuid, p_expected_version integer, p_new_hash text,
  p_issued_at bigint, p_nonce uuid, p_context_hash text, p_signature text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $change_user_password_asserted$
DECLARE v_context text; v_hash text;
BEGIN
  v_context := pg_catalog.octet_length(pg_catalog.convert_to(p_user_id::text, 'UTF8'))::text || ':' || p_user_id::text || '|'
    || pg_catalog.octet_length(pg_catalog.convert_to(p_expected_version::text, 'UTF8'))::text || ':' || p_expected_version::text || '|'
    || pg_catalog.octet_length(pg_catalog.convert_to(p_new_hash, 'UTF8'))::text || ':' || p_new_hash;
  v_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(v_context, 'UTF8'), 'sha256'), 'hex');
  IF v_hash <> p_context_hash THEN RAISE EXCEPTION 'Actor assertion payload does not match' USING ERRCODE = '42501'; END IF;
  PERFORM balancevault_auth_private.consume_actor_assertion(p_user_id, 'CHANGE_PASSWORD', p_issued_at, p_nonce, v_hash, p_signature);
  RETURN public.change_user_password(p_user_id, p_expected_version, p_new_hash);
END;
$change_user_password_asserted$;

GRANT CREATE ON SCHEMA public TO balancevault_provisioning_owner, balancevault_auth_owner;
ALTER FUNCTION public.create_privileged_user_invitation_asserted(uuid, uuid, text, text, public."UserRole", char(64), timestamptz, bigint, bigint, uuid, text, text)
  OWNER TO balancevault_provisioning_owner;
ALTER FUNCTION public.revoke_privileged_user_invitation_asserted(uuid, uuid, bigint, uuid, text, text)
  OWNER TO balancevault_provisioning_owner;
ALTER FUNCTION public.change_user_password_asserted(uuid, integer, text, bigint, uuid, text, text)
  OWNER TO balancevault_auth_owner;
REVOKE CREATE ON SCHEMA public FROM balancevault_provisioning_owner, balancevault_auth_owner;

SET ROLE balancevault_provisioning_owner;
REVOKE ALL ON FUNCTION public.create_privileged_user_invitation_asserted(uuid, uuid, text, text, public."UserRole", char(64), timestamptz, bigint, bigint, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_privileged_user_invitation_asserted(uuid, uuid, bigint, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_privileged_user_invitation_asserted(uuid, uuid, text, text, public."UserRole", char(64), timestamptz, bigint, bigint, uuid, text, text) TO balancevault_runtime;
GRANT EXECUTE ON FUNCTION public.revoke_privileged_user_invitation_asserted(uuid, uuid, bigint, uuid, text, text) TO balancevault_runtime;
RESET ROLE;
SET ROLE balancevault_auth_owner;
REVOKE ALL ON FUNCTION public.change_user_password_asserted(uuid, integer, text, bigint, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.change_user_password_asserted(uuid, integer, text, bigint, uuid, text, text) TO balancevault_runtime;
RESET ROLE;

-- Remove broad User table reads; general runtime keeps only non-secret fields.
REVOKE SELECT ON public."User" FROM balancevault_runtime;
REVOKE SELECT (id, "fullName", email, "passwordHash", role, "isActive", "createdAt", "updatedAt", "tokenVersion")
  ON public."User" FROM balancevault_runtime;
GRANT SELECT (id, "fullName", email, role, "isActive", "createdAt", "updatedAt", "tokenVersion")
  ON public."User" TO balancevault_runtime;
GRANT SELECT (id, "fullName", email, "passwordHash", role, "isActive", "createdAt", "tokenVersion")
  ON public."User" TO balancevault_auth_runtime;

COMMIT;
