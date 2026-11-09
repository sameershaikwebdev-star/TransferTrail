-- Forward-only profile and customer account-opening workflow.
-- Apply only after reviewing this SQL and provisioning the existing owner roles.
BEGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE balancevault_migration_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER TABLE public."User"
  ADD COLUMN "fullName" text,
  ADD COLUMN "tokenVersion" integer NOT NULL DEFAULT 0;

CREATE TYPE public."AccountOpeningStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE public."AccountOpeningRequest" (
  id uuid PRIMARY KEY,
  "userId" uuid NOT NULL REFERENCES public."User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestedType" public."AccountType" NOT NULL DEFAULT 'PERSONAL',
  status public."AccountOpeningStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedByUserId" uuid REFERENCES public."User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "accountId" uuid UNIQUE REFERENCES public."Account"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "reviewNote" text,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" timestamptz(6),
  CONSTRAINT "AccountOpeningRequest_customer_type_check"
    CHECK ("requestedType" IN ('PERSONAL'::public."AccountType", 'BUSINESS'::public."AccountType")),
  CONSTRAINT "AccountOpeningRequest_resolution_check" CHECK (
    (status = 'PENDING' AND "reviewedByUserId" IS NULL AND "accountId" IS NULL AND "resolvedAt" IS NULL)
    OR (status = 'APPROVED' AND "reviewedByUserId" IS NOT NULL AND "accountId" IS NOT NULL AND "resolvedAt" IS NOT NULL)
    OR (status = 'REJECTED' AND "reviewedByUserId" IS NOT NULL AND "accountId" IS NULL AND "resolvedAt" IS NOT NULL)
  )
);
CREATE INDEX "AccountOpeningRequest_userId_status_createdAt_idx"
  ON public."AccountOpeningRequest" ("userId", status, "createdAt" DESC, id DESC);
CREATE INDEX "AccountOpeningRequest_status_createdAt_idx"
  ON public."AccountOpeningRequest" (status, "createdAt" DESC, id DESC);
CREATE UNIQUE INDEX "AccountOpeningRequest_one_pending_per_user_key"
  ON public."AccountOpeningRequest" ("userId") WHERE status = 'PENDING';

-- Revoke the old registration entry point so the runtime cannot bypass full-name capture.
SET ROLE balancevault_auth_owner;
REVOKE ALL ON FUNCTION public.create_account_holder(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_account_holder(uuid, text, text) FROM balancevault_runtime;
RESET ROLE;

CREATE FUNCTION public.create_account_holder_profile(
  p_user_id uuid, p_full_name text, p_email text, p_password_hash text
)
RETURNS TABLE (id uuid, "fullName" text, email text, role public."UserRole", "isActive" boolean, "createdAt" timestamptz(6))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_account_holder_profile$
BEGIN
  IF p_user_id IS NULL OR p_full_name IS NULL
     OR p_full_name IS DISTINCT FROM pg_catalog.btrim(p_full_name)
     OR pg_catalog.length(p_full_name) NOT BETWEEN 1 AND 100
     OR p_email IS NULL OR p_email = ''
     OR p_email IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(p_email))
     OR p_password_hash IS NULL
     OR p_password_hash !~ '^\$2[aby]\$(1[0-4])\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'Invalid account-holder registration input' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    INSERT INTO public."User" AS u
      (id, "fullName", email, "passwordHash", "role", "isActive", "updatedAt")
    VALUES
      (p_user_id, p_full_name, p_email, p_password_hash,
       'ACCOUNT_HOLDER'::public."UserRole", true, pg_catalog.clock_timestamp())
    RETURNING u.id, u."fullName", u.email, u."role", u."isActive", u."createdAt";
END;
$create_account_holder_profile$;

CREATE FUNCTION public.update_user_profile(p_user_id uuid, p_full_name text)
RETURNS TABLE (id uuid, "fullName" text, email text, role public."UserRole", "isActive" boolean, "createdAt" timestamptz(6))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $update_user_profile$
BEGIN
  IF p_user_id IS NULL OR p_full_name IS NULL
     OR p_full_name IS DISTINCT FROM pg_catalog.btrim(p_full_name)
     OR pg_catalog.length(p_full_name) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid profile input' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY UPDATE public."User" AS u
    SET "fullName" = p_full_name, "updatedAt" = pg_catalog.clock_timestamp()
    WHERE u.id = p_user_id AND u."isActive" = true
    RETURNING u.id, u."fullName", u.email, u."role", u."isActive", u."createdAt";
  IF NOT FOUND THEN RAISE EXCEPTION 'Active user not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
  VALUES (pg_catalog.gen_random_uuid(), p_user_id, 'PROFILE_UPDATED', 'User', p_user_id,
          pg_catalog.jsonb_build_object('fields', pg_catalog.jsonb_build_array('fullName')), pg_catalog.clock_timestamp());
END;
$update_user_profile$;

CREATE FUNCTION public.change_user_password(p_user_id uuid, p_expected_version integer, p_new_hash text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $change_user_password$
DECLARE v_version integer;
BEGIN
  IF p_user_id IS NULL OR p_expected_version IS NULL OR p_new_hash IS NULL
     OR p_new_hash !~ '^\$2[aby]\$(1[0-4])\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'Invalid password update input' USING ERRCODE = '22023';
  END IF;
  UPDATE public."User" AS u
     SET "passwordHash" = p_new_hash, "tokenVersion" = u."tokenVersion" + 1,
         "updatedAt" = pg_catalog.clock_timestamp()
   WHERE u.id = p_user_id AND u."isActive" = true AND u."tokenVersion" = p_expected_version
   RETURNING u."tokenVersion" INTO v_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Password changed concurrently or user unavailable' USING ERRCODE = '40001'; END IF;
  INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
  VALUES (pg_catalog.gen_random_uuid(), p_user_id, 'PASSWORD_CHANGED', 'User', p_user_id,
          '{}'::jsonb, pg_catalog.clock_timestamp());
  RETURN v_version;
END;
$change_user_password$;

CREATE FUNCTION public.admin_set_user_active(p_actor_id uuid, p_target_id uuid, p_active boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $admin_set_user_active$
DECLARE v_changed boolean;
BEGIN
  IF p_actor_id IS NULL OR p_target_id IS NULL OR p_active IS NULL THEN
    RAISE EXCEPTION 'Invalid user status input' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(731904112);
  PERFORM 1 FROM public."User" u WHERE u.id IN (p_actor_id, p_target_id) ORDER BY u.id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public."User" WHERE id=p_actor_id AND "isActive"=true AND role='ADMIN'::public."UserRole") THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id = p_target_id AND NOT p_active THEN
    RAISE EXCEPTION 'Administrator cannot deactivate self' USING ERRCODE = '42501';
  END IF;
  IF NOT p_active AND EXISTS (
    SELECT 1 FROM public."User" WHERE id=p_target_id AND role='ADMIN'::public."UserRole" AND "isActive"=true
  ) AND (SELECT count(*) FROM public."User" WHERE role='ADMIN'::public."UserRole" AND "isActive"=true) <= 1 THEN
    RAISE EXCEPTION 'Cannot deactivate the last active administrator' USING ERRCODE = '42501';
  END IF;
  UPDATE public."User" SET "isActive"=p_active, "tokenVersion"="tokenVersion"+1,
         "updatedAt"=pg_catalog.clock_timestamp()
   WHERE id=p_target_id AND "isActive" IS DISTINCT FROM p_active;
  v_changed := FOUND;
  IF v_changed THEN
    INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
    VALUES (pg_catalog.gen_random_uuid(), p_actor_id, CASE WHEN p_active THEN 'USER_REACTIVATED' ELSE 'USER_DEACTIVATED' END,
            'User', p_target_id, '{}'::jsonb, pg_catalog.clock_timestamp());
  END IF;
  RETURN v_changed;
END;
$admin_set_user_active$;

CREATE FUNCTION public.request_account_opening(p_user_id uuid, p_type public."AccountType")
RETURNS TABLE (id uuid, "requestedType" public."AccountType", status public."AccountOpeningStatus", "createdAt" timestamptz(6))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $request_account_opening$
DECLARE v_role public."UserRole"; v_active boolean; v_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(731904112);
  SELECT role, "isActive" INTO v_role, v_active FROM public."User" WHERE id=p_user_id;
  IF NOT FOUND OR v_active IS DISTINCT FROM true OR v_role <> 'ACCOUNT_HOLDER'::public."UserRole" THEN
    RAISE EXCEPTION 'Active account holder required' USING ERRCODE = '42501';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('PERSONAL'::public."AccountType", 'BUSINESS'::public."AccountType") THEN
    RAISE EXCEPTION 'Customer account type required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY INSERT INTO public."AccountOpeningRequest" AS r (id, "userId", "requestedType")
    VALUES (v_id, p_user_id, p_type)
    RETURNING r.id, r."requestedType", r.status, r."createdAt";
  INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
    VALUES (pg_catalog.gen_random_uuid(), p_user_id, 'ACCOUNT_OPENING_REQUESTED', 'AccountOpeningRequest', v_id,
      pg_catalog.jsonb_build_object('requestedType', p_type), pg_catalog.clock_timestamp());
END;
$request_account_opening$;

CREATE FUNCTION public.approve_account_opening(p_actor_id uuid, p_request_id uuid, p_account_number text)
RETURNS TABLE (id uuid, "accountNumber" text, type public."AccountType", status public."AccountStatus", "currencyCode" character(3), "createdAt" timestamptz(6))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $approve_account_opening$
DECLARE v_request public."AccountOpeningRequest"%ROWTYPE; v_account record; v_now timestamptz(6);
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(731904112);
  IF NOT EXISTS (SELECT 1 FROM public."User" WHERE id=p_actor_id AND role='ADMIN'::public."UserRole" AND "isActive"=true) THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_request FROM public."AccountOpeningRequest" AS r WHERE r.id=p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'PENDING'::public."AccountOpeningStatus" THEN
    RAISE EXCEPTION 'Pending account request not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_account FROM public.create_customer_account(p_actor_id, p_account_number, v_request."requestedType", v_request."userId");
  v_now := pg_catalog.clock_timestamp();
  UPDATE public."AccountOpeningRequest" AS r SET status='APPROVED', "reviewedByUserId"=p_actor_id,
    "accountId"=v_account.id, "resolvedAt"=v_now, "updatedAt"=v_now WHERE r.id=p_request_id;
  RETURN QUERY SELECT v_account.id, v_account."accountNumber", v_account.type, v_account.status, v_account."currencyCode", v_account."createdAt";
END;
$approve_account_opening$;

CREATE FUNCTION public.reject_account_opening(p_actor_id uuid, p_request_id uuid, p_note text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $reject_account_opening$
DECLARE v_user_id uuid; v_now timestamptz(6);
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(731904112);
  IF NOT EXISTS (SELECT 1 FROM public."User" WHERE id=p_actor_id AND role='ADMIN'::public."UserRole" AND "isActive"=true) THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;
  SELECT r."userId" INTO v_user_id FROM public."AccountOpeningRequest" AS r WHERE r.id=p_request_id AND r.status='PENDING' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pending account request not found' USING ERRCODE = 'P0002'; END IF;
  v_now := pg_catalog.clock_timestamp();
  UPDATE public."AccountOpeningRequest" AS r SET status='REJECTED', "reviewedByUserId"=p_actor_id,
    "reviewNote"=NULLIF(pg_catalog.btrim(p_note), ''), "resolvedAt"=v_now, "updatedAt"=v_now WHERE r.id=p_request_id;
  INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
  VALUES (pg_catalog.gen_random_uuid(), p_actor_id, 'ACCOUNT_OPENING_REJECTED', 'AccountOpeningRequest', p_request_id,
    pg_catalog.jsonb_build_object('requesterId', v_user_id), v_now);
  RETURN true;
END;
$reject_account_opening$;

-- Owner grants are column-scoped. Runtime receives no direct table writes.
GRANT USAGE ON SCHEMA public TO balancevault_auth_owner, balancevault_account_owner;
GRANT USAGE ON TYPE public."AccountOpeningStatus", public."AccountType", public."UserRole", public."AccountStatus"
  TO balancevault_auth_owner, balancevault_account_owner;
GRANT USAGE ON TYPE public."AccountOpeningStatus" TO balancevault_runtime;
GRANT INSERT (id, "fullName", email, "passwordHash", role, "isActive", "updatedAt") ON public."User" TO balancevault_auth_owner;
GRANT SELECT (id, "fullName", email, role, "isActive", "tokenVersion", "createdAt") ON public."User" TO balancevault_auth_owner;
GRANT UPDATE ("fullName", "passwordHash", "tokenVersion", "updatedAt", "isActive") ON public."User" TO balancevault_auth_owner;
GRANT INSERT (id, "actorId", action, "entityType", "entityId", metadata, "createdAt") ON public."AuditLog" TO balancevault_auth_owner;
GRANT INSERT, SELECT, UPDATE ON public."AccountOpeningRequest" TO balancevault_account_owner;
GRANT SELECT (id, role, "isActive") ON public."User" TO balancevault_account_owner;
GRANT INSERT (id, "actorId", action, "entityType", "entityId", metadata, "createdAt") ON public."AuditLog" TO balancevault_account_owner;
GRANT SELECT ON public."AccountOpeningRequest" TO balancevault_runtime;
REVOKE SELECT ON public."User" FROM balancevault_runtime;
REVOKE SELECT (id, "fullName", email, "passwordHash", role, "isActive", "createdAt", "updatedAt", "tokenVersion")
  ON public."User" FROM balancevault_runtime;
GRANT SELECT (id, "fullName", email, role, "isActive", "createdAt", "updatedAt", "tokenVersion")
  ON public."User" TO balancevault_runtime;
GRANT SELECT (id, "fullName", email, "passwordHash", role, "isActive", "createdAt", "tokenVersion")
  ON public."User" TO balancevault_auth_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public."AccountOpeningRequest" FROM balancevault_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public."User" FROM balancevault_runtime;
REVOKE INSERT (id, "fullName", email, "passwordHash", "role", "isActive", "createdAt", "updatedAt", "tokenVersion"),
       UPDATE (id, "fullName", email, "passwordHash", "role", "isActive", "createdAt", "updatedAt", "tokenVersion")
  ON public."User" FROM balancevault_runtime;

GRANT CREATE ON SCHEMA public TO balancevault_auth_owner, balancevault_account_owner;
ALTER FUNCTION public.create_account_holder_profile(uuid, text, text, text) OWNER TO balancevault_auth_owner;
ALTER FUNCTION public.update_user_profile(uuid, text) OWNER TO balancevault_auth_owner;
ALTER FUNCTION public.change_user_password(uuid, integer, text) OWNER TO balancevault_auth_owner;
ALTER FUNCTION public.admin_set_user_active(uuid, uuid, boolean) OWNER TO balancevault_auth_owner;
ALTER FUNCTION public.request_account_opening(uuid, public."AccountType") OWNER TO balancevault_account_owner;
ALTER FUNCTION public.approve_account_opening(uuid, uuid, text) OWNER TO balancevault_account_owner;
ALTER FUNCTION public.reject_account_opening(uuid, uuid, text) OWNER TO balancevault_account_owner;
REVOKE CREATE ON SCHEMA public FROM balancevault_auth_owner, balancevault_account_owner;

SET ROLE balancevault_auth_owner;
REVOKE ALL ON FUNCTION public.create_account_holder_profile(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_user_profile(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.change_user_password(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_user_active(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_account_holder_profile(uuid, text, text, text) TO balancevault_runtime;
GRANT EXECUTE ON FUNCTION public.update_user_profile(uuid, text) TO balancevault_runtime;
GRANT EXECUTE ON FUNCTION public.change_user_password(uuid, integer, text) TO balancevault_runtime;
GRANT EXECUTE ON FUNCTION public.admin_set_user_active(uuid, uuid, boolean) TO balancevault_runtime;
RESET ROLE;
SET ROLE balancevault_account_owner;
REVOKE ALL ON FUNCTION public.request_account_opening(uuid, public."AccountType") FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_account_opening(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_account_opening(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_account_opening(uuid, public."AccountType") TO balancevault_runtime;
GRANT EXECUTE ON FUNCTION public.approve_account_opening(uuid, uuid, text) TO balancevault_runtime;
GRANT EXECUTE ON FUNCTION public.reject_account_opening(uuid, uuid, text) TO balancevault_runtime;
RESET ROLE;
COMMIT;
