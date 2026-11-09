CREATE FUNCTION public.create_customer_account(
  p_actor_id uuid,
  p_account_number text,
  p_account_type public."AccountType",
  p_holder_user_id uuid
)
RETURNS TABLE (
  id uuid,
  "accountNumber" text,
  type public."AccountType",
  status public."AccountStatus",
  "currencyCode" character(3),
  "createdAt" timestamptz(6)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_customer_account$
DECLARE
  v_actor_role public."UserRole";
  v_actor_active boolean;
  v_holder_role public."UserRole";
  v_holder_active boolean;
  v_account_id uuid := pg_catalog.gen_random_uuid();
  v_now timestamptz(6) := pg_catalog.clock_timestamp();
BEGIN
  IF p_actor_id IS NULL
     OR p_holder_user_id IS NULL
     OR p_account_type IS NULL
     OR p_account_type NOT IN ('PERSONAL'::public."AccountType", 'BUSINESS'::public."AccountType")
     OR p_account_number IS NULL
     OR p_account_number IS DISTINCT FROM pg_catalog.btrim(p_account_number)
     OR pg_catalog.length(p_account_number) NOT BETWEEN 1 AND 64
  THEN
    RAISE EXCEPTION 'Invalid customer account creation input'
      USING ERRCODE = '22023';
  END IF;

  SELECT u."role", u."isActive"
    INTO v_actor_role, v_actor_active
    FROM public."User" AS u
   WHERE u."id" = p_actor_id;
  IF NOT FOUND OR v_actor_active IS DISTINCT FROM true OR v_actor_role <> 'ADMIN'::public."UserRole" THEN
    RAISE EXCEPTION 'Active ADMIN actor required'
      USING ERRCODE = '42501';
  END IF;

  SELECT u."role", u."isActive"
    INTO v_holder_role, v_holder_active
    FROM public."User" AS u
   WHERE u."id" = p_holder_user_id;
  IF NOT FOUND OR v_holder_active IS DISTINCT FROM true OR v_holder_role <> 'ACCOUNT_HOLDER'::public."UserRole" THEN
    RAISE EXCEPTION 'Active ACCOUNT_HOLDER required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public."Account"
    ("id", "accountNumber", "systemCode", "type", "status", "balancePaise", "currencyCode", "createdAt", "updatedAt")
  VALUES
    (v_account_id, p_account_number, NULL, p_account_type, 'ACTIVE'::public."AccountStatus", 0, 'INR', v_now, v_now);

  INSERT INTO public."AccountPermission"
    ("id", "userId", "accountId", "canView", "canDeposit", "canWithdraw", "canTransfer", "createdAt", "updatedAt")
  VALUES
    (pg_catalog.gen_random_uuid(), p_holder_user_id, v_account_id, true, false, false, false, v_now, v_now);

  INSERT INTO public."AuditLog"
    ("id", "actorId", "action", "entityType", "entityId", "metadata", "createdAt")
  VALUES
    (pg_catalog.gen_random_uuid(), p_actor_id, 'ACCOUNT_CREATED', 'Account', v_account_id,
     pg_catalog.jsonb_build_object(
       'accountNumber', p_account_number,
       'accountType', p_account_type,
       'initialHolderId', p_holder_user_id
     ), v_now);

  RETURN QUERY
    SELECT a."id", a."accountNumber", a."type", a."status", a."currencyCode", a."createdAt"
      FROM public."Account" AS a
     WHERE a."id" = v_account_id;
END;
$create_customer_account$;

GRANT USAGE ON SCHEMA public TO balancevault_account_owner;
GRANT USAGE ON TYPE public."AccountType", public."AccountStatus", public."UserRole"
  TO balancevault_account_owner;

GRANT SELECT ("id", "role", "isActive") ON public."User" TO balancevault_account_owner;
GRANT INSERT ("id", "accountNumber", "systemCode", "type", "status", "balancePaise", "currencyCode", "createdAt", "updatedAt")
  ON public."Account" TO balancevault_account_owner;
GRANT SELECT ("id", "accountNumber", "type", "status", "currencyCode", "createdAt")
  ON public."Account" TO balancevault_account_owner;
GRANT INSERT ("id", "userId", "accountId", "canView", "canDeposit", "canWithdraw", "canTransfer", "createdAt", "updatedAt")
  ON public."AccountPermission" TO balancevault_account_owner;
GRANT INSERT ("id", "actorId", "action", "entityType", "entityId", "metadata", "createdAt")
  ON public."AuditLog" TO balancevault_account_owner;

GRANT CREATE ON SCHEMA public TO balancevault_account_owner;
ALTER FUNCTION public.create_customer_account(uuid, text, public."AccountType", uuid)
  OWNER TO balancevault_account_owner;
REVOKE CREATE ON SCHEMA public FROM balancevault_account_owner;

SET ROLE balancevault_account_owner;
REVOKE ALL ON FUNCTION public.create_customer_account(uuid, text, public."AccountType", uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_customer_account(uuid, text, public."AccountType", uuid)
  TO balancevault_runtime;
RESET ROLE;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public."Account", public."AccountPermission"
  FROM balancevault_runtime;
REVOKE INSERT ("id", "accountNumber", "systemCode", "type", "status", "balancePaise", "currencyCode", "createdAt", "updatedAt"),
       UPDATE ("id", "accountNumber", "systemCode", "type", "status", "balancePaise", "currencyCode", "createdAt", "updatedAt")
  ON public."Account" FROM balancevault_runtime;
REVOKE INSERT ("id", "userId", "accountId", "canView", "canDeposit", "canWithdraw", "canTransfer", "createdAt", "updatedAt"),
       UPDATE ("id", "userId", "accountId", "canView", "canDeposit", "canWithdraw", "canTransfer", "createdAt", "updatedAt")
  ON public."AccountPermission" FROM balancevault_runtime;
