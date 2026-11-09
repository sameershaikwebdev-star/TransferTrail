-- Qualify columns that collide with the request function's OUT parameter names.
GRANT CREATE ON SCHEMA public TO balancevault_account_owner;
SET ROLE balancevault_account_owner;
CREATE OR REPLACE FUNCTION public.request_account_opening(p_user_id uuid, p_type public."AccountType")
RETURNS TABLE (id uuid, "requestedType" public."AccountType", status public."AccountOpeningStatus", "createdAt" timestamptz(6))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $request_account_opening$
DECLARE v_role public."UserRole"; v_active boolean; v_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(731904112);
  SELECT u.role, u."isActive" INTO v_role, v_active
    FROM public."User" AS u WHERE u.id = p_user_id;
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
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM balancevault_account_owner;
