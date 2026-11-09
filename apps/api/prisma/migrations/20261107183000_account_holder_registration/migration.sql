CREATE FUNCTION public.create_account_holder(
  p_user_id uuid,
  p_email text,
  p_password_hash text
)
RETURNS TABLE (
  id uuid,
  email text,
  role public."UserRole",
  "isActive" boolean,
  "createdAt" timestamptz(6)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_account_holder$
BEGIN
  IF p_user_id IS NULL
     OR p_email IS NULL
     OR p_email = ''
     OR p_email IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(p_email))
     OR p_password_hash IS NULL
     OR p_password_hash !~ '^\$2[aby]\$(1[0-4])\$[./A-Za-z0-9]{53}$'
  THEN
    RAISE EXCEPTION 'Invalid account-holder registration input'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    INSERT INTO public."User" AS u
      ("id", "email", "passwordHash", "role", "isActive", "updatedAt")
    VALUES
      (p_user_id, p_email, p_password_hash,
       'ACCOUNT_HOLDER'::public."UserRole", true, pg_catalog.clock_timestamp())
    RETURNING u."id", u."email", u."role", u."isActive", u."createdAt";
END;
$create_account_holder$;

GRANT USAGE ON SCHEMA public TO balancevault_auth_owner;
GRANT USAGE ON TYPE public."UserRole" TO balancevault_auth_owner;

GRANT INSERT ("id", "email", "passwordHash", "role", "isActive", "updatedAt")
  ON public."User" TO balancevault_auth_owner;
GRANT SELECT ("id", "email", "role", "isActive", "createdAt")
  ON public."User" TO balancevault_auth_owner;

-- PostgreSQL requires the future owner to have CREATE on the function schema
-- when ownership changes. Keep that grant only for the transfer itself.
GRANT CREATE ON SCHEMA public TO balancevault_auth_owner;
ALTER FUNCTION public.create_account_holder(uuid, text, text)
  OWNER TO balancevault_auth_owner;
REVOKE CREATE ON SCHEMA public FROM balancevault_auth_owner;

-- The migration login has NOINHERIT; switch to the designated owner for ACL
-- changes so the default PUBLIC EXECUTE grant is reliably removed.
SET ROLE balancevault_auth_owner;
REVOKE ALL ON FUNCTION public.create_account_holder(uuid, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_account_holder(uuid, text, text)
  TO balancevault_runtime;
RESET ROLE;

-- The runtime identity may read User but can never write it directly.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public."User" FROM balancevault_runtime;
REVOKE INSERT ("id", "email", "passwordHash", "role", "isActive", "createdAt", "updatedAt"),
       UPDATE ("id", "email", "passwordHash", "role", "isActive", "createdAt", "updatedAt")
  ON public."User" FROM balancevault_runtime;
