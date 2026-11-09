GRANT CREATE ON SCHEMA public TO balancevault_auth_owner;
SET ROLE balancevault_auth_owner;
CREATE OR REPLACE FUNCTION public.create_account_holder_profile(
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
     OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
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
  INSERT INTO public."AuditLog" (id, "actorId", action, "entityType", "entityId", metadata, "createdAt")
  VALUES (pg_catalog.gen_random_uuid(), p_user_id, 'ACCOUNT_HOLDER_REGISTERED', 'User', p_user_id,
          pg_catalog.jsonb_build_object('role', 'ACCOUNT_HOLDER'), pg_catalog.clock_timestamp());
END;
$create_account_holder_profile$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM balancevault_auth_owner;
