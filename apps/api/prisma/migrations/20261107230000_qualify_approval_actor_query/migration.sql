-- Qualify the actor id, which collides with the function's OUT parameter id.
GRANT CREATE ON SCHEMA public TO balancevault_account_owner;
SET ROLE balancevault_account_owner;
CREATE OR REPLACE FUNCTION public.approve_account_opening(p_actor_id uuid, p_request_id uuid, p_account_number text)
RETURNS TABLE (id uuid, "accountNumber" text, type public."AccountType", status public."AccountStatus", "currencyCode" character(3), "createdAt" timestamptz(6))
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $approve_account_opening$
DECLARE v_request public."AccountOpeningRequest"%ROWTYPE; v_account record; v_now timestamptz(6);
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(731904112);
  IF NOT EXISTS (
    SELECT 1 FROM public."User" AS u
     WHERE u.id = p_actor_id AND u.role = 'ADMIN'::public."UserRole" AND u."isActive" = true
  ) THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_request FROM public."AccountOpeningRequest" AS r WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'PENDING'::public."AccountOpeningStatus" THEN
    RAISE EXCEPTION 'Pending account request not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_account FROM public.create_customer_account(
    p_actor_id, p_account_number, v_request."requestedType", v_request."userId"
  );
  v_now := pg_catalog.clock_timestamp();
  UPDATE public."AccountOpeningRequest" AS r
     SET status = 'APPROVED', "reviewedByUserId" = p_actor_id,
         "accountId" = v_account.id, "resolvedAt" = v_now, "updatedAt" = v_now
   WHERE r.id = p_request_id;
  RETURN QUERY SELECT v_account.id, v_account."accountNumber", v_account.type,
                      v_account.status, v_account."currencyCode", v_account."createdAt";
END;
$approve_account_opening$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM balancevault_account_owner;
