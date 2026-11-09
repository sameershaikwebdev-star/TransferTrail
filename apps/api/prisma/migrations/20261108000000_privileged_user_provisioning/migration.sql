BEGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE balancevault_migration_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE public."UserInvitation" (
  id uuid PRIMARY KEY,
  "fullName" text NOT NULL,
  email text NOT NULL,
  role public."UserRole" NOT NULL,
  "tokenHash" char(64) NOT NULL UNIQUE,
  "createdByUserId" uuid NOT NULL,
  "acceptedByUserId" uuid,
  "expiresAt" timestamptz(6) NOT NULL,
  "acceptedAt" timestamptz(6),
  "revokedAt" timestamptz(6),
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserInvitation_privileged_role_check" CHECK (role IN ('ADMIN'::public."UserRole", 'AUDITOR'::public."UserRole")),
  CONSTRAINT "UserInvitation_name_check" CHECK ("fullName" = btrim("fullName") AND length("fullName") BETWEEN 1 AND 100),
  CONSTRAINT "UserInvitation_email_normalized_check" CHECK (email = lower(btrim(email)) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  CONSTRAINT "UserInvitation_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "UserInvitation_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "UserInvitation_terminal_state_check" CHECK ("acceptedAt" IS NULL OR "revokedAt" IS NULL),
  CONSTRAINT "UserInvitation_issuer_fkey" FOREIGN KEY ("createdByUserId") REFERENCES public."User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "UserInvitation_acceptor_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES public."User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "UserInvitation_email_createdAt_idx" ON public."UserInvitation" (email, "createdAt" DESC);
CREATE INDEX "UserInvitation_createdByUserId_createdAt_idx" ON public."UserInvitation" ("createdByUserId", "createdAt" DESC);

CREATE TABLE public."PrivilegedBootstrap" (
  id boolean PRIMARY KEY DEFAULT true,
  "adminUserId" uuid NOT NULL UNIQUE,
  "completedAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrivilegedBootstrap_singleton_check" CHECK (id IS TRUE),
  CONSTRAINT "PrivilegedBootstrap_admin_fkey" FOREIGN KEY ("adminUserId") REFERENCES public."User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

GRANT USAGE ON SCHEMA public TO balancevault_provisioning_owner;
GRANT USAGE ON SCHEMA public TO balancevault_bootstrap_operator;
GRANT USAGE ON TYPE public."UserRole" TO balancevault_provisioning_owner;
GRANT USAGE ON TYPE public."UserRole" TO balancevault_bootstrap_operator;
GRANT INSERT (id, "fullName", email, "passwordHash", role, "isActive", "updatedAt") ON public."User" TO balancevault_provisioning_owner;
GRANT SELECT (id, "fullName", email, role, "isActive", "createdAt") ON public."User" TO balancevault_provisioning_owner;
GRANT SELECT ON public."UserInvitation" TO balancevault_provisioning_owner;
GRANT INSERT (id, "fullName", email, role, "tokenHash", "createdByUserId", "expiresAt", "createdAt") ON public."UserInvitation" TO balancevault_provisioning_owner;
GRANT UPDATE ("acceptedByUserId", "acceptedAt", "revokedAt") ON public."UserInvitation" TO balancevault_provisioning_owner;
GRANT SELECT, INSERT ON public."PrivilegedBootstrap" TO balancevault_provisioning_owner;
GRANT INSERT (id, "actorId", action, "entityType", "entityId", metadata, "createdAt") ON public."AuditLog" TO balancevault_provisioning_owner;
GRANT SELECT (id, "fullName", email, role, "expiresAt", "acceptedAt", "revokedAt", "createdAt", "createdByUserId", "acceptedByUserId")
  ON public."UserInvitation" TO balancevault_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public."UserInvitation", public."PrivilegedBootstrap" FROM balancevault_runtime;

CREATE FUNCTION public.bootstrap_first_admin(
  p_user_id uuid, p_full_name text, p_email text, p_password_hash text
)
RETURNS TABLE (id uuid, "fullName" text, email text, role public."UserRole", "isActive" boolean, "createdAt" timestamptz(6))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $bootstrap_first_admin$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(731904113);
  IF p_user_id IS NULL
     OR p_full_name IS NULL OR p_full_name IS DISTINCT FROM pg_catalog.btrim(p_full_name)
     OR pg_catalog.length(p_full_name) NOT BETWEEN 1 AND 100
     OR p_email IS NULL OR p_email IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(p_email))
     OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR p_password_hash IS NULL OR p_password_hash !~ '^\$2[aby]\$(1[0-4])\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'Invalid first administrator input' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public."PrivilegedBootstrap")
     OR EXISTS (SELECT 1 FROM public."User" AS u WHERE u.role = 'ADMIN'::public."UserRole") THEN
    RAISE EXCEPTION 'First administrator bootstrap has already completed' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY
    INSERT INTO public."User" AS u (id, "fullName", email, "passwordHash", role, "isActive", "updatedAt")
    VALUES (p_user_id, p_full_name, p_email, p_password_hash, 'ADMIN'::public."UserRole", true, pg_catalog.clock_timestamp())
    RETURNING u.id, u."fullName", u.email, u.role, u."isActive", u."createdAt";
  INSERT INTO public."PrivilegedBootstrap" (id, "adminUserId", "completedAt")
  VALUES (true, p_user_id, pg_catalog.clock_timestamp());
  INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
  VALUES (pg_catalog.gen_random_uuid(), p_user_id, 'FIRST_ADMIN_BOOTSTRAPPED', 'User', p_user_id,
          pg_catalog.jsonb_build_object('role', 'ADMIN'), pg_catalog.clock_timestamp());
END;
$bootstrap_first_admin$;

CREATE FUNCTION public.create_privileged_user_invitation(
  p_actor_id uuid, p_invitation_id uuid, p_full_name text, p_email text,
  p_role public."UserRole", p_token_hash char(64), p_expires_at timestamptz(6)
)
RETURNS TABLE (id uuid, "fullName" text, email text, role public."UserRole", "expiresAt" timestamptz(6), "createdAt" timestamptz(6))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_privileged_user_invitation$
DECLARE v_now timestamptz(6) := pg_catalog.clock_timestamp(); v_previous record;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(731904112);
  PERFORM 1 FROM public."User" AS u
   WHERE u.id = p_actor_id AND u.role = 'ADMIN'::public."UserRole" AND u."isActive" = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501'; END IF;
  IF p_invitation_id IS NULL OR p_full_name IS NULL OR p_full_name IS DISTINCT FROM pg_catalog.btrim(p_full_name)
     OR pg_catalog.length(p_full_name) NOT BETWEEN 1 AND 100
     OR p_email IS NULL OR p_email IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(p_email))
     OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR p_role IS NULL OR p_role NOT IN ('ADMIN'::public."UserRole", 'AUDITOR'::public."UserRole")
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_expires_at IS NULL OR p_expires_at <= v_now OR p_expires_at > v_now + interval '7 days' THEN
    RAISE EXCEPTION 'Invalid privileged-user invitation' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public."User" AS u WHERE u.email = p_email) THEN
    RAISE EXCEPTION 'Email is already registered' USING ERRCODE = '23505';
  END IF;
  FOR v_previous IN
    UPDATE public."UserInvitation" AS i SET "revokedAt" = v_now
     WHERE i.email = p_email AND i."acceptedAt" IS NULL AND i."revokedAt" IS NULL
     RETURNING i.id, i.role
  LOOP
    INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
    VALUES (pg_catalog.gen_random_uuid(), p_actor_id, 'PRIVILEGED_USER_INVITATION_REVOKED', 'UserInvitation', v_previous.id,
            pg_catalog.jsonb_build_object('role', v_previous.role::text, 'reason', 'reissued'), v_now);
  END LOOP;
  RETURN QUERY
    INSERT INTO public."UserInvitation" AS i
      (id, "fullName", email, role, "tokenHash", "createdByUserId", "expiresAt", "createdAt")
    VALUES (p_invitation_id, p_full_name, p_email, p_role, p_token_hash, p_actor_id, p_expires_at, v_now)
    RETURNING i.id, i."fullName", i.email, i.role, i."expiresAt", i."createdAt";
  INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
  VALUES (pg_catalog.gen_random_uuid(), p_actor_id, 'PRIVILEGED_USER_INVITATION_CREATED', 'UserInvitation', p_invitation_id,
          pg_catalog.jsonb_build_object('role', p_role::text), v_now);
END;
$create_privileged_user_invitation$;

CREATE FUNCTION public.revoke_privileged_user_invitation(p_actor_id uuid, p_invitation_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $revoke_privileged_user_invitation$
DECLARE v_role public."UserRole"; v_changed boolean := false; v_now timestamptz(6) := pg_catalog.clock_timestamp();
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(731904112);
  PERFORM 1 FROM public."User" AS u
   WHERE u.id = p_actor_id AND u.role = 'ADMIN'::public."UserRole" AND u."isActive" = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501'; END IF;
  UPDATE public."UserInvitation" AS i SET "revokedAt" = v_now
   WHERE i.id = p_invitation_id AND i."acceptedAt" IS NULL AND i."revokedAt" IS NULL
   RETURNING i.role INTO v_role;
  v_changed := FOUND;
  IF v_changed THEN
    INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
    VALUES (pg_catalog.gen_random_uuid(), p_actor_id, 'PRIVILEGED_USER_INVITATION_REVOKED', 'UserInvitation', p_invitation_id,
            pg_catalog.jsonb_build_object('role', v_role::text), v_now);
  END IF;
  RETURN v_changed;
END;
$revoke_privileged_user_invitation$;

CREATE FUNCTION public.accept_privileged_user_invitation(
  p_user_id uuid, p_token_hash char(64), p_password_hash text
)
RETURNS TABLE (id uuid, "fullName" text, email text, role public."UserRole", "isActive" boolean, "createdAt" timestamptz(6))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $accept_privileged_user_invitation$
DECLARE v_invitation public."UserInvitation"%ROWTYPE; v_now timestamptz(6) := pg_catalog.clock_timestamp();
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(731904112);
  IF p_user_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_password_hash IS NULL OR p_password_hash !~ '^\$2[aby]\$(1[0-4])\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'Invalid invitation acceptance input' USING ERRCODE = '22023';
  END IF;
  SELECT i.* INTO v_invitation FROM public."UserInvitation" AS i
   WHERE i."tokenHash" = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_invitation."acceptedAt" IS NOT NULL OR v_invitation."revokedAt" IS NOT NULL
     OR v_invitation."expiresAt" <= v_now THEN
    RAISE EXCEPTION 'Invitation is invalid or unavailable' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."User" AS issuer
                  WHERE issuer.id = v_invitation."createdByUserId"
                    AND issuer.role = 'ADMIN'::public."UserRole" AND issuer."isActive" = true) THEN
    RAISE EXCEPTION 'Invitation issuer is no longer authorized' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
    INSERT INTO public."User" AS u (id, "fullName", email, "passwordHash", role, "isActive", "updatedAt")
    VALUES (p_user_id, v_invitation."fullName", v_invitation.email, p_password_hash, v_invitation.role, true, v_now)
    RETURNING u.id, u."fullName", u.email, u.role, u."isActive", u."createdAt";
  UPDATE public."UserInvitation" AS i SET "acceptedAt" = v_now, "acceptedByUserId" = p_user_id
   WHERE i.id = v_invitation.id;
  INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
  VALUES
    (pg_catalog.gen_random_uuid(), p_user_id, 'PRIVILEGED_USER_INVITATION_ACCEPTED', 'UserInvitation', v_invitation.id,
     pg_catalog.jsonb_build_object('issuedByUserId', v_invitation."createdByUserId", 'role', v_invitation.role::text), v_now),
    (pg_catalog.gen_random_uuid(), v_invitation."createdByUserId", 'PRIVILEGED_ROLE_PROVISIONED', 'User', p_user_id,
     pg_catalog.jsonb_build_object('invitationId', v_invitation.id, 'role', v_invitation.role::text), v_now);
END;
$accept_privileged_user_invitation$;

GRANT CREATE ON SCHEMA public TO balancevault_provisioning_owner;
ALTER FUNCTION public.bootstrap_first_admin(uuid, text, text, text) OWNER TO balancevault_provisioning_owner;
ALTER FUNCTION public.create_privileged_user_invitation(uuid, uuid, text, text, public."UserRole", char(64), timestamptz) OWNER TO balancevault_provisioning_owner;
ALTER FUNCTION public.revoke_privileged_user_invitation(uuid, uuid) OWNER TO balancevault_provisioning_owner;
ALTER FUNCTION public.accept_privileged_user_invitation(uuid, char(64), text) OWNER TO balancevault_provisioning_owner;
REVOKE CREATE ON SCHEMA public FROM balancevault_provisioning_owner;

SET ROLE balancevault_provisioning_owner;
REVOKE ALL ON FUNCTION public.bootstrap_first_admin(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_privileged_user_invitation(uuid, uuid, text, text, public."UserRole", char(64), timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_privileged_user_invitation(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_privileged_user_invitation(uuid, char(64), text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bootstrap_first_admin(uuid, text, text, text) TO balancevault_bootstrap_operator;
GRANT EXECUTE ON FUNCTION public.create_privileged_user_invitation(uuid, uuid, text, text, public."UserRole", char(64), timestamptz) TO balancevault_runtime;
GRANT EXECUTE ON FUNCTION public.revoke_privileged_user_invitation(uuid, uuid) TO balancevault_runtime;
GRANT EXECUTE ON FUNCTION public.accept_privileged_user_invitation(uuid, char(64), text) TO balancevault_runtime;
RESET ROLE;
COMMIT;
