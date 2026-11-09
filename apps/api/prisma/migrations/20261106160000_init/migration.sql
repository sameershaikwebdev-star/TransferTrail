-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('PERSONAL', 'BUSINESS', 'SYSTEM_CLEARING');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalTransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER');

-- CreateEnum
CREATE TYPE "JournalTransactionStatus" AS ENUM ('PENDING', 'POSTED');

-- CreateEnum
CREATE TYPE "TransactionAttemptStatus" AS ENUM ('RECEIVED', 'POSTED', 'REFUSED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ACCOUNT_HOLDER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "systemCode" TEXT,
    "type" "AccountType" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "balancePaise" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" CHAR(3) NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountPermission" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "canView" BOOLEAN NOT NULL DEFAULT false,
    "canDeposit" BOOLEAN NOT NULL DEFAULT false,
    "canWithdraw" BOOLEAN NOT NULL DEFAULT false,
    "canTransfer" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AccountPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalTransaction" (
    "id" UUID NOT NULL,
    "type" "JournalTransactionType" NOT NULL,
    "status" "JournalTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "actorId" UUID NOT NULL,
    "reference" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "journalTransactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "postingSequence" INTEGER NOT NULL,
    "accountPostingSequence" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "canonicalRequestHash" CHAR(64) NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "resultJournalTransactionId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionAttempt" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "sourceAccountId" UUID,
    "destinationAccountId" UUID,
    "type" "JournalTransactionType" NOT NULL,
    "requestedAmountPaise" BIGINT NOT NULL,
    "status" "TransactionAttemptStatus" NOT NULL DEFAULT 'RECEIVED',
    "refusalReason" TEXT,
    "idempotencyRecordId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Account_accountNumber_key" ON "Account"("accountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Account_systemCode_key" ON "Account"("systemCode");

-- CreateIndex
CREATE INDEX "Account_type_status_idx" ON "Account"("type", "status");

-- CreateIndex
CREATE INDEX "Account_status_createdAt_idx" ON "Account"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AccountPermission_accountId_idx" ON "AccountPermission"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountPermission_userId_accountId_key" ON "AccountPermission"("userId", "accountId");

-- CreateIndex
CREATE INDEX "JournalTransaction_actorId_createdAt_idx" ON "JournalTransaction"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "JournalTransaction_type_status_createdAt_idx" ON "JournalTransaction"("type", "status", "createdAt");

-- CreateIndex
CREATE INDEX "JournalTransaction_reference_idx" ON "JournalTransaction"("reference");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_id_idx" ON "LedgerEntry"("accountId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LedgerEntry_journalTransactionId_idx" ON "LedgerEntry"("journalTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_journalTransactionId_postingSequence_key" ON "LedgerEntry"("journalTransactionId", "postingSequence");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_accountId_accountPostingSequence_key" ON "LedgerEntry"("accountId", "accountPostingSequence");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_resultJournalTransactionId_key" ON "IdempotencyRecord"("resultJournalTransactionId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_userId_idempotencyKey_key" ON "IdempotencyRecord"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TransactionAttempt_actorId_createdAt_idx" ON "TransactionAttempt"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionAttempt_sourceAccountId_createdAt_idx" ON "TransactionAttempt"("sourceAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionAttempt_destinationAccountId_createdAt_idx" ON "TransactionAttempt"("destinationAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionAttempt_idempotencyRecordId_idx" ON "TransactionAttempt"("idempotencyRecordId");

-- CreateIndex
CREATE INDEX "TransactionAttempt_status_createdAt_idx" ON "TransactionAttempt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "AccountPermission" ADD CONSTRAINT "AccountPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountPermission" ADD CONSTRAINT "AccountPermission_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "JournalTransaction" ADD CONSTRAINT "JournalTransaction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_journalTransactionId_fkey" FOREIGN KEY ("journalTransactionId") REFERENCES "JournalTransaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_resultJournalTransactionId_fkey" FOREIGN KEY ("resultJournalTransactionId") REFERENCES "JournalTransaction"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransactionAttempt" ADD CONSTRAINT "TransactionAttempt_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransactionAttempt" ADD CONSTRAINT "TransactionAttempt_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransactionAttempt" ADD CONSTRAINT "TransactionAttempt_destinationAccountId_fkey" FOREIGN KEY ("destinationAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransactionAttempt" ADD CONSTRAINT "TransactionAttempt_idempotencyRecordId_fkey" FOREIGN KEY ("idempotencyRecordId") REFERENCES "IdempotencyRecord"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Financial row constraints. Cross-row invariants are enforced by triggers below.
ALTER TABLE public."Account"
  ADD CONSTRAINT "Account_customer_balance_nonnegative"
    CHECK ("type" = 'SYSTEM_CLEARING' OR "balancePaise" >= 0),
  ADD CONSTRAINT "Account_system_code_matches_type"
    CHECK (("type" = 'SYSTEM_CLEARING' AND "systemCode" IS NOT NULL)
        OR ("type" <> 'SYSTEM_CLEARING' AND "systemCode" IS NULL)),
  ADD CONSTRAINT "Account_currency_inr"
    CHECK ("currencyCode" = 'INR');

ALTER TABLE public."TransactionAttempt"
  ADD CONSTRAINT "TransactionAttempt_amount_positive"
    CHECK ("requestedAmountPaise" > 0),
  ADD CONSTRAINT "TransactionAttempt_refusal_reason_shape"
    CHECK (("status" = 'REFUSED' AND "refusalReason" IS NOT NULL)
        OR ("status" <> 'REFUSED' AND "refusalReason" IS NULL));

ALTER TABLE public."LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_amount_nonzero" CHECK ("amountPaise" <> 0),
  ADD CONSTRAINT "LedgerEntry_posting_sequence_positive" CHECK ("postingSequence" > 0),
  ADD CONSTRAINT "LedgerEntry_account_sequence_positive" CHECK ("accountPostingSequence" > 0);

ALTER TABLE public."IdempotencyRecord"
  ADD CONSTRAINT "IdempotencyRecord_response_shape"
  CHECK (COALESCE(
    ("responseStatus" IS NULL AND "responseBody" IS NULL
      AND "resultJournalTransactionId" IS NULL)
    OR
    ("responseStatus" IS NOT NULL AND "responseStatus" BETWEEN 200 AND 299
      AND "responseBody" IS NOT NULL
      AND "resultJournalTransactionId" IS NOT NULL)
    OR
    ("responseStatus" IS NOT NULL AND "responseStatus" BETWEEN 400 AND 499
      AND "responseBody" IS NOT NULL
      AND "resultJournalTransactionId" IS NULL), false));

CREATE SCHEMA IF NOT EXISTS balancevault_private AUTHORIZATION balancevault_posting_owner;

-- PostgreSQL migration connections use balancevault_migration_owner with
-- NOINHERIT. Switch explicitly into the designated owner while creating and
-- securing its private trigger functions; membership alone does not confer
-- owner privileges. The migration role is restored before public objects and
-- grants are managed.
GRANT USAGE ON SCHEMA public TO balancevault_posting_owner;
GRANT USAGE ON TYPE public."AccountType", public."AccountStatus",
  public."UserRole", public."JournalTransactionType",
  public."JournalTransactionStatus", public."TransactionAttemptStatus"
  TO balancevault_posting_owner;
GRANT TRIGGER ON ALL TABLES IN SCHEMA public TO balancevault_posting_owner;
SET ROLE balancevault_posting_owner;
REVOKE ALL ON SCHEMA balancevault_private FROM PUBLIC;

-- Helpers are SECURITY DEFINER and only callable by owned trigger functions or
-- the posting owner. Every table reference is schema-qualified.
CREATE OR REPLACE FUNCTION balancevault_private.bv_assert_account_holder(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE v_type public."AccountType";
BEGIN
  SELECT a."type" INTO v_type FROM public."Account" a WHERE a."id" = p_account_id;
  IF NOT FOUND OR v_type = 'SYSTEM_CLEARING' THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."AccountPermission" p
    JOIN public."User" u ON u."id" = p."userId"
    WHERE p."accountId" = p_account_id AND p."canView"
      AND u."role" = 'ACCOUNT_HOLDER' AND u."isActive"
  ) THEN
    RAISE EXCEPTION 'Customer account % requires an active visible ACCOUNT_HOLDER', p_account_id
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_check_holder_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE v_ids uuid[] := ARRAY[]::uuid[]; v_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'Account' THEN
    IF TG_OP = 'DELETE' THEN v_ids := ARRAY[OLD."id"];
    ELSE v_ids := ARRAY[NEW."id"]; END IF;
  ELSIF TG_TABLE_NAME = 'AccountPermission' THEN
    IF TG_OP = 'INSERT' THEN v_ids := ARRAY[NEW."accountId"];
    ELSIF TG_OP = 'DELETE' THEN v_ids := ARRAY[OLD."accountId"];
    ELSE v_ids := ARRAY[OLD."accountId", NEW."accountId"]; END IF;
  ELSE
    SELECT COALESCE(array_agg(DISTINCT p."accountId" ORDER BY p."accountId"), ARRAY[]::uuid[])
      INTO v_ids FROM public."AccountPermission" p WHERE p."userId" = NEW."id";
  END IF;
  FOR v_id IN SELECT x FROM unnest(v_ids) AS ids(x)
              WHERE x IS NOT NULL GROUP BY x ORDER BY x LOOP
    PERFORM balancevault_private.bv_assert_account_holder(v_id);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_guard_account_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE
  v_users uuid[] := ARRAY[]::uuid[]; v_accounts uuid[] := ARRAY[]::uuid[];
  v_id uuid; v_type public."AccountType";
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_users := ARRAY[NEW."userId"]; v_accounts := ARRAY[NEW."accountId"];
  ELSIF TG_OP = 'DELETE' THEN
    v_users := ARRAY[OLD."userId"]; v_accounts := ARRAY[OLD."accountId"];
  ELSE
    IF NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."accountId" IS DISTINCT FROM OLD."accountId" THEN
      RAISE EXCEPTION 'Permission userId/accountId are immutable; delete and insert instead'
        USING ERRCODE = '55000';
    END IF;
    v_users := ARRAY[OLD."userId", NEW."userId"];
    v_accounts := ARRAY[OLD."accountId", NEW."accountId"];
  END IF;
  -- Global order: users sorted by UUID, then accounts sorted by UUID.
  FOR v_id IN SELECT x FROM unnest(v_users) AS ids(x)
              WHERE x IS NOT NULL GROUP BY x ORDER BY x LOOP
    PERFORM 1 FROM public."User" u WHERE u."id" = v_id FOR UPDATE;
  END LOOP;
  FOR v_id IN SELECT x FROM unnest(v_accounts) AS ids(x)
              WHERE x IS NOT NULL GROUP BY x ORDER BY x LOOP
    PERFORM 1 FROM public."Account" a WHERE a."id" = v_id FOR UPDATE;
  END LOOP;
  IF TG_OP <> 'DELETE' THEN
    SELECT a."type" INTO v_type FROM public."Account" a WHERE a."id" = NEW."accountId";
    IF v_type = 'SYSTEM_CLEARING' THEN
      RAISE EXCEPTION 'System clearing accounts cannot receive permissions' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_lock_user_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE v_ids uuid[]; v_id uuid;
BEGIN
  IF OLD."role" IS NOT DISTINCT FROM NEW."role"
     AND OLD."isActive" IS NOT DISTINCT FROM NEW."isActive" THEN RETURN NEW; END IF;
  SELECT COALESCE(array_agg(DISTINCT p."accountId" ORDER BY p."accountId"), ARRAY[]::uuid[])
    INTO v_ids FROM public."AccountPermission" p WHERE p."userId" = OLD."id";
  FOR v_id IN SELECT x FROM unnest(v_ids) AS ids(x) ORDER BY x LOOP
    PERFORM 1 FROM public."Account" a WHERE a."id" = v_id FOR UPDATE;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_guard_account_classification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
BEGIN
  IF NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."systemCode" IS DISTINCT FROM OLD."systemCode" THEN
    RAISE EXCEPTION 'Account type and systemCode are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_reject_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_reject_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE is forbidden on %', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_assert_account_balance(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE v_balance bigint; v_total numeric;
BEGIN
  SELECT a."balancePaise" INTO v_balance FROM public."Account" a WHERE a."id" = p_account_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(sum(e."amountPaise"), 0) INTO v_total
    FROM public."LedgerEntry" e WHERE e."accountId" = p_account_id;
  IF v_balance::numeric <> v_total THEN
    RAISE EXCEPTION 'Account % cache % differs from ledger total %', p_account_id, v_balance, v_total
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_check_balance_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE v_ids uuid[] := ARRAY[]::uuid[]; v_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'Account' THEN
    IF TG_OP = 'DELETE' THEN v_ids := ARRAY[OLD."id"];
    ELSE v_ids := ARRAY[NEW."id"]; END IF;
  ELSIF TG_OP = 'INSERT' THEN v_ids := ARRAY[NEW."accountId"];
  ELSIF TG_OP = 'DELETE' THEN v_ids := ARRAY[OLD."accountId"];
  ELSE v_ids := ARRAY[OLD."accountId", NEW."accountId"]; END IF;
  FOR v_id IN SELECT x FROM unnest(v_ids) AS ids(x)
              WHERE x IS NOT NULL GROUP BY x ORDER BY x LOOP
    PERFORM balancevault_private.bv_assert_account_balance(v_id);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_assert_journal(p_journal_id uuid, p_require_posted boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE
  v_type public."JournalTransactionType"; v_status public."JournalTransactionStatus";
  v_n bigint; v_distinct bigint; v_sum numeric; v_invalid bigint;
  v_dp bigint; v_dc bigint; v_wd bigint; v_wc bigint; v_td bigint; v_tc bigint;
  v_valid boolean := false;
BEGIN
  SELECT j."type", j."status", count(e."id"), count(DISTINCT e."accountId"),
         COALESCE(sum(e."amountPaise"), 0),
         count(e."id") FILTER (WHERE a."id" IS NULL OR a."currencyCode" <> 'INR' OR a."status" <> 'ACTIVE'),
         count(e."id") FILTER (WHERE a."type" IN ('PERSONAL','BUSINESS') AND e."amountPaise" > 0),
         count(e."id") FILTER (WHERE a."type" = 'SYSTEM_CLEARING' AND a."systemCode" = 'CLEARING_DEPOSIT_INR' AND a."currencyCode" = 'INR' AND a."status" = 'ACTIVE' AND e."amountPaise" < 0),
         count(e."id") FILTER (WHERE a."type" IN ('PERSONAL','BUSINESS') AND e."amountPaise" < 0),
         count(e."id") FILTER (WHERE a."type" = 'SYSTEM_CLEARING' AND a."systemCode" = 'CLEARING_WITHDRAWAL_INR' AND a."currencyCode" = 'INR' AND a."status" = 'ACTIVE' AND e."amountPaise" > 0),
         count(e."id") FILTER (WHERE a."type" IN ('PERSONAL','BUSINESS') AND e."amountPaise" < 0),
         count(e."id") FILTER (WHERE a."type" IN ('PERSONAL','BUSINESS') AND e."amountPaise" > 0)
    INTO v_type, v_status, v_n, v_distinct, v_sum, v_invalid, v_dp, v_dc, v_wd, v_wc, v_td, v_tc
    FROM public."JournalTransaction" j
    LEFT JOIN public."LedgerEntry" e ON e."journalTransactionId" = j."id"
    LEFT JOIN public."Account" a ON a."id" = e."accountId"
   WHERE j."id" = p_journal_id
   GROUP BY j."id", j."type", j."status";
  IF NOT FOUND THEN RETURN; END IF;
  IF p_require_posted AND v_status <> 'POSTED' THEN
    RAISE EXCEPTION 'Journal % cannot commit pending', p_journal_id USING ERRCODE = '23514';
  END IF;
  IF v_n <> 2 OR v_distinct <> 2 OR v_sum <> 0 OR v_invalid <> 0 THEN
    RAISE EXCEPTION 'Journal % must have two distinct active INR postings summing to zero', p_journal_id USING ERRCODE = '23514';
  END IF;
  CASE v_type
    WHEN 'DEPOSIT' THEN v_valid := v_dp = 1 AND v_dc = 1;
    WHEN 'WITHDRAWAL' THEN v_valid := v_wd = 1 AND v_wc = 1;
    WHEN 'TRANSFER' THEN v_valid := v_td = 1 AND v_tc = 1;
  END CASE;
  IF v_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Journal % has invalid postings for %', p_journal_id, v_type USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_check_journal_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'JournalTransaction' THEN
    IF TG_OP = 'DELETE' THEN v_id := OLD."id"; ELSE v_id := NEW."id"; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN v_id := OLD."journalTransactionId"; ELSE v_id := NEW."journalTransactionId"; END IF;
  END IF;
  PERFORM balancevault_private.bv_assert_journal(v_id, true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_guard_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Journal transactions cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN RAISE EXCEPTION 'Journals must start PENDING' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'PENDING' OR NEW."status" <> 'POSTED'
     OR ROW(NEW."type", NEW."actorId", NEW."reference", NEW."description", NEW."createdAt")
        IS DISTINCT FROM ROW(OLD."type", OLD."actorId", OLD."reference", OLD."description", OLD."createdAt") THEN
    RAISE EXCEPTION 'Only immutable PENDING -> POSTED journal transition allowed' USING ERRCODE = '55000';
  END IF;
  PERFORM balancevault_private.bv_assert_journal(NEW."id", false);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_guard_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE v_status public."JournalTransactionStatus"; v_currency char(3); v_account_status public."AccountStatus"; v_next numeric;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN RAISE EXCEPTION 'Ledger is append-only' USING ERRCODE = '55000'; END IF;
  PERFORM 1 FROM public."Account" a WHERE a."id" = NEW."accountId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ledger account missing' USING ERRCODE = '23503'; END IF;
  SELECT a."currencyCode", a."status" INTO v_currency, v_account_status FROM public."Account" a WHERE a."id" = NEW."accountId";
  SELECT j."status" INTO v_status FROM public."JournalTransaction" j WHERE j."id" = NEW."journalTransactionId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ledger journal missing' USING ERRCODE = '23503'; END IF;
  IF v_status <> 'PENDING' THEN RAISE EXCEPTION 'Cannot append to posted journal' USING ERRCODE = '23514'; END IF;
  IF v_currency <> 'INR' OR v_account_status <> 'ACTIVE' OR NEW."amountPaise" = 0 THEN
    RAISE EXCEPTION 'Posting requires nonzero paise and active INR account' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(max(e."accountPostingSequence"), 0) + 1 INTO v_next
    FROM public."LedgerEntry" e WHERE e."accountId" = NEW."accountId";
  IF NEW."accountPostingSequence"::numeric <> v_next THEN
    RAISE EXCEPTION 'Expected next account posting sequence %', v_next USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_guard_idempotency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE v_incomplete boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Idempotency records cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF ROW(NEW."userId", NEW."idempotencyKey", NEW."canonicalRequestHash", NEW."createdAt", NEW."expiresAt")
     IS DISTINCT FROM ROW(OLD."userId", OLD."idempotencyKey", OLD."canonicalRequestHash", OLD."createdAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'Idempotency identity is immutable' USING ERRCODE = '55000';
  END IF;
  v_incomplete := OLD."responseStatus" IS NULL AND OLD."responseBody" IS NULL AND OLD."resultJournalTransactionId" IS NULL;
  IF NOT v_incomplete AND ROW(NEW."responseStatus", NEW."responseBody", NEW."resultJournalTransactionId")
     IS DISTINCT FROM ROW(OLD."responseStatus", OLD."responseBody", OLD."resultJournalTransactionId") THEN
    RAISE EXCEPTION 'Completed idempotency response cannot be overwritten' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_assert_idempotency(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
DECLARE v_user uuid; v_status int; v_body jsonb; v_journal uuid; v_jstatus public."JournalTransactionStatus"; v_actor uuid;
BEGIN
  SELECT r."userId", r."responseStatus", r."responseBody", r."resultJournalTransactionId"
    INTO v_user, v_status, v_body, v_journal FROM public."IdempotencyRecord" r WHERE r."id" = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_status IS NULL OR v_body IS NULL THEN RAISE EXCEPTION 'Incomplete idempotency record %', p_id USING ERRCODE = '23514'; END IF;
  IF v_status BETWEEN 200 AND 299 THEN
    SELECT j."status", j."actorId" INTO v_jstatus, v_actor FROM public."JournalTransaction" j WHERE j."id" = v_journal;
    IF NOT FOUND OR v_journal IS NULL OR v_jstatus <> 'POSTED' OR v_actor <> v_user THEN
      RAISE EXCEPTION 'Successful idempotency record must reference its actor posted journal' USING ERRCODE = '23514';
    END IF;
  ELSIF v_status BETWEEN 400 AND 499 THEN
    IF v_journal IS NOT NULL THEN RAISE EXCEPTION 'Refusal cannot reference a journal' USING ERRCODE = '23514'; END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported stored response status %', v_status USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_check_idempotency_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, balancevault_private, pg_temp
AS $$
BEGIN
  PERFORM balancevault_private.bv_assert_idempotency(NEW."id");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION balancevault_private.bv_guard_account_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF current_user NOT IN ('balancevault_posting_owner', 'balancevault_migration_owner') THEN
    RAISE EXCEPTION 'Cached balance can only be changed by the posting function' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger installation. Deferred events observe final transaction state at COMMIT.
CREATE TRIGGER "AccountPermission_guard"
BEFORE INSERT OR UPDATE OR DELETE ON public."AccountPermission"
FOR EACH ROW EXECUTE FUNCTION balancevault_private.bv_guard_account_permission();
CREATE TRIGGER "User_lock_accounts_before_access_change"
BEFORE UPDATE ON public."User"
FOR EACH ROW EXECUTE FUNCTION balancevault_private.bv_lock_user_accounts();
CREATE TRIGGER "Account_classification_immutable"
BEFORE UPDATE ON public."Account"
FOR EACH ROW EXECUTE FUNCTION balancevault_private.bv_guard_account_classification();
CREATE TRIGGER "Account_balance_owner_only"
BEFORE UPDATE OF "balancePaise" ON public."Account"
FOR EACH ROW EXECUTE FUNCTION balancevault_private.bv_guard_account_balance();
CREATE CONSTRAINT TRIGGER "Account_holder_after_account_change"
AFTER INSERT OR UPDATE OR DELETE ON public."Account"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION balancevault_private.bv_check_holder_event();
CREATE CONSTRAINT TRIGGER "Account_holder_after_permission_change"
AFTER INSERT OR UPDATE OR DELETE ON public."AccountPermission"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION balancevault_private.bv_check_holder_event();
CREATE CONSTRAINT TRIGGER "Account_holder_after_user_change"
AFTER UPDATE ON public."User"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION balancevault_private.bv_check_holder_event();
CREATE TRIGGER "JournalTransaction_guard"
BEFORE INSERT OR UPDATE OR DELETE ON public."JournalTransaction"
FOR EACH ROW EXECUTE FUNCTION balancevault_private.bv_guard_journal();
CREATE TRIGGER "LedgerEntry_guard"
BEFORE INSERT OR UPDATE OR DELETE ON public."LedgerEntry"
FOR EACH ROW EXECUTE FUNCTION balancevault_private.bv_guard_ledger_entry();
CREATE CONSTRAINT TRIGGER "JournalTransaction_validate_at_commit"
AFTER INSERT OR UPDATE ON public."JournalTransaction"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION balancevault_private.bv_check_journal_event();
CREATE CONSTRAINT TRIGGER "LedgerEntry_validate_at_commit"
AFTER INSERT OR UPDATE OR DELETE ON public."LedgerEntry"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION balancevault_private.bv_check_journal_event();
CREATE CONSTRAINT TRIGGER "Account_balance_validate_at_commit"
AFTER INSERT OR UPDATE OR DELETE ON public."Account"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION balancevault_private.bv_check_balance_event();
CREATE CONSTRAINT TRIGGER "LedgerEntry_balance_validate_at_commit"
AFTER INSERT OR UPDATE OR DELETE ON public."LedgerEntry"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION balancevault_private.bv_check_balance_event();
CREATE TRIGGER "IdempotencyRecord_guard"
BEFORE UPDATE OR DELETE ON public."IdempotencyRecord"
FOR EACH ROW EXECUTE FUNCTION balancevault_private.bv_guard_idempotency();
CREATE CONSTRAINT TRIGGER "IdempotencyRecord_complete_at_commit"
AFTER INSERT OR UPDATE ON public."IdempotencyRecord"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION balancevault_private.bv_check_idempotency_event();
CREATE TRIGGER "LedgerEntry_no_truncate"
BEFORE TRUNCATE ON public."LedgerEntry"
FOR EACH STATEMENT EXECUTE FUNCTION balancevault_private.bv_reject_truncate();
CREATE TRIGGER "JournalTransaction_no_truncate"
BEFORE TRUNCATE ON public."JournalTransaction"
FOR EACH STATEMENT EXECUTE FUNCTION balancevault_private.bv_reject_truncate();
CREATE TRIGGER "AuditLog_no_mutation"
BEFORE UPDATE OR DELETE ON public."AuditLog"
FOR EACH ROW EXECUTE FUNCTION balancevault_private.bv_reject_row_mutation();
CREATE TRIGGER "AuditLog_no_truncate"
BEFORE TRUNCATE ON public."AuditLog"
FOR EACH STATEMENT EXECUTE FUNCTION balancevault_private.bv_reject_truncate();

-- Remove PUBLIC execution, assign protected function ownership, and expose only
-- approved entry points in the subsequent privilege migration section.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA balancevault_private FROM PUBLIC;
RESET ROLE;
-- Trigger creation needed temporary privileges because the posting owner is
-- not the owner of the Prisma tables. Revoke them as the table owner.
REVOKE TRIGGER ON ALL TABLES IN SCHEMA public FROM balancevault_posting_owner;

-- Controlled posting API. The API supplies actor_id from its verified session,
-- never from the request body. The runtime role has EXECUTE only on this entry point.
CREATE OR REPLACE FUNCTION public.balancevault_post_transaction(
  p_actor_id uuid,
  p_type public."JournalTransactionType",
  p_source_account_id uuid,
  p_destination_account_id uuid,
  p_amount_paise bigint,
  p_idempotency_key text,
  p_request_hash char(64)
) RETURNS TABLE(response_status integer, response_body jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, balancevault_private, pg_temp
AS $post$
DECLARE
  v_idem public."IdempotencyRecord"%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_attempt uuid := gen_random_uuid();
  v_journal uuid := gen_random_uuid();
  v_user public."User"%ROWTYPE;
  v_source public."Account"%ROWTYPE;
  v_destination public."Account"%ROWTYPE;
  v_clear public."Account"%ROWTYPE;
  v_reason text;
  v_body jsonb;
  v_status integer;
  v_existing integer;
  v_next bigint;
  v_account_id uuid;
  v_posting integer := 0;
  v_audit_action text := 'TRANSACTION_POSTED';
  v_audit_entity text := 'JournalTransaction';
BEGIN
  IF p_actor_id IS NULL OR p_type IS NULL OR p_amount_paise IS NULL
     OR p_amount_paise <= 0 OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 255
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Invalid financial request arguments' USING ERRCODE = '22023';
  END IF;

  -- Lock actor first so concurrent requests cannot deadlock while upgrading
  -- FK key-share locks to FOR UPDATE. Permission changes follow user->account.
  SELECT * INTO v_user FROM public."User" u WHERE u."id"=p_actor_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown transaction actor' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public."IdempotencyRecord" ("id","userId","idempotencyKey","canonicalRequestHash","expiresAt")
  VALUES (v_id,p_actor_id,p_idempotency_key,lower(p_request_hash),clock_timestamp() + interval '24 hours')
  ON CONFLICT ("userId","idempotencyKey") DO NOTHING;
  GET DIAGNOSTICS v_existing = ROW_COUNT;
  v_existing := CASE WHEN v_existing = 0 THEN 1 ELSE 0 END;
  SELECT * INTO v_idem FROM public."IdempotencyRecord" r
   WHERE r."userId" = p_actor_id AND r."idempotencyKey" = p_idempotency_key FOR UPDATE;
  IF v_existing = 1 THEN
    IF v_idem."canonicalRequestHash" <> lower(p_request_hash) THEN
      INSERT INTO public."AuditLog" ("id","actorId","action","entityType","entityId","metadata")
      VALUES (gen_random_uuid(),p_actor_id,'IDEMPOTENCY_CONFLICT','IdempotencyRecord',v_idem."id",
              jsonb_build_object('requestHash',lower(p_request_hash),'storedRequestHash',v_idem."canonicalRequestHash"));
      RETURN QUERY SELECT 409, jsonb_build_object('error','idempotency_key_conflict'); RETURN;
    END IF;
    IF v_idem."responseStatus" IS NULL OR v_idem."responseBody" IS NULL THEN
      RAISE EXCEPTION 'Concurrent idempotency owner committed incomplete record' USING ERRCODE = '23514';
    END IF;
    -- Expiry never authorizes a second execution: a matching retry replays the
    -- original response forever. Retention/cleanup is intentionally disabled.
    INSERT INTO public."AuditLog" ("id","actorId","action","entityType","entityId","metadata")
    VALUES (gen_random_uuid(),p_actor_id,'IDEMPOTENCY_REPLAY','IdempotencyRecord',v_idem."id",
            jsonb_build_object('requestHash',v_idem."canonicalRequestHash",'originalResponseStatus',v_idem."responseStatus"));
    RETURN QUERY SELECT v_idem."responseStatus", v_idem."responseBody"; RETURN;
  END IF;

  -- Global order: actor, idempotency row, accounts by UUID, permissions.
  -- Permission mutations also acquire user before account locks.
  IF NOT FOUND OR NOT v_user."isActive" THEN v_reason := 'actor_inactive';
  ELSIF v_user."role"='AUDITOR' THEN v_reason := 'role_forbidden';
  END IF;

  IF p_type='DEPOSIT' THEN
    IF p_source_account_id IS NOT NULL OR p_destination_account_id IS NULL THEN v_reason := COALESCE(v_reason,'invalid_accounts'); END IF;
    v_account_id := p_destination_account_id;
  ELSIF p_type='WITHDRAWAL' THEN
    IF p_source_account_id IS NULL OR p_destination_account_id IS NOT NULL THEN v_reason := COALESCE(v_reason,'invalid_accounts'); END IF;
    v_account_id := p_source_account_id;
  ELSE
    IF p_source_account_id IS NULL OR p_destination_account_id IS NULL OR p_source_account_id=p_destination_account_id THEN v_reason := COALESCE(v_reason,'invalid_accounts'); END IF;
  END IF;

  FOR v_account_id IN
    SELECT x FROM unnest(ARRAY[p_source_account_id,p_destination_account_id]) AS ids(x)
     WHERE x IS NOT NULL GROUP BY x ORDER BY x
  LOOP
    PERFORM 1 FROM public."Account" a WHERE a."id"=v_account_id FOR UPDATE;
  END LOOP;
  IF p_source_account_id IS NOT NULL THEN SELECT * INTO v_source FROM public."Account" WHERE "id"=p_source_account_id; END IF;
  IF p_destination_account_id IS NOT NULL THEN SELECT * INTO v_destination FROM public."Account" WHERE "id"=p_destination_account_id; END IF;

  IF v_reason IS NULL AND p_type='TRANSFER' THEN
    IF v_source."type"='SYSTEM_CLEARING' OR v_destination."type"='SYSTEM_CLEARING'
       OR v_source."currencyCode" <> 'INR' OR v_destination."currencyCode" <> 'INR'
       OR v_source."status"<>'ACTIVE' OR v_destination."status"<>'ACTIVE' THEN v_reason := 'account_unavailable';
    ELSIF NOT EXISTS (SELECT 1 FROM public."AccountPermission" p WHERE p."userId"=p_actor_id AND p."accountId"=p_source_account_id AND p."canTransfer") THEN v_reason := 'not_authorized';
    ELSIF v_source."balancePaise" < p_amount_paise THEN v_reason := 'insufficient_funds';
    END IF;
  ELSIF v_reason IS NULL THEN
    IF (p_type='DEPOSIT' AND (v_destination."type"='SYSTEM_CLEARING' OR v_destination."status"<>'ACTIVE'))
       OR (p_type='WITHDRAWAL' AND (v_source."type"='SYSTEM_CLEARING' OR v_source."status"<>'ACTIVE')) THEN v_reason := 'account_unavailable';
    ELSIF (p_type='DEPOSIT' AND NOT EXISTS (SELECT 1 FROM public."AccountPermission" p WHERE p."userId"=p_actor_id AND p."accountId"=p_destination_account_id AND p."canDeposit"))
       OR (p_type='WITHDRAWAL' AND NOT EXISTS (SELECT 1 FROM public."AccountPermission" p WHERE p."userId"=p_actor_id AND p."accountId"=p_source_account_id AND p."canWithdraw")) THEN v_reason := 'not_authorized';
    ELSIF p_type='WITHDRAWAL' AND v_source."balancePaise" < p_amount_paise THEN v_reason := 'insufficient_funds';
    END IF;
  END IF;
  IF v_reason IS NULL AND (v_user."role" NOT IN ('ADMIN','ACCOUNT_HOLDER')) THEN v_reason := 'role_forbidden'; END IF;

  IF v_reason IS NOT NULL THEN
    v_status := 403;
    IF v_reason='insufficient_funds' THEN v_status := 422; END IF;
    IF v_reason='account_unavailable' THEN v_status := 409; END IF;
    v_body := jsonb_build_object('status','REFUSED','reason',v_reason);
    INSERT INTO public."TransactionAttempt" ("id","actorId","sourceAccountId","destinationAccountId","type","requestedAmountPaise","status","refusalReason","idempotencyRecordId")
    VALUES (v_attempt,p_actor_id,p_source_account_id,p_destination_account_id,p_type,p_amount_paise,'REFUSED',v_reason,v_id);
    INSERT INTO public."AuditLog" ("id","actorId","action","entityType","entityId","metadata")
    VALUES (gen_random_uuid(),p_actor_id,'TRANSACTION_REFUSED','TransactionAttempt',v_attempt,jsonb_build_object('reason',v_reason,'type',p_type));
    UPDATE public."IdempotencyRecord" SET "responseStatus"=v_status,"responseBody"=v_body WHERE "id"=v_id;
    RETURN QUERY SELECT v_status,v_body; RETURN;
  END IF;

  IF p_type='DEPOSIT' THEN
    SELECT * INTO v_clear FROM public."Account" WHERE "systemCode"='CLEARING_DEPOSIT_INR' AND "type"='SYSTEM_CLEARING' AND "currencyCode"='INR' AND "status"='ACTIVE' FOR UPDATE;
  ELSIF p_type='WITHDRAWAL' THEN
    SELECT * INTO v_clear FROM public."Account" WHERE "systemCode"='CLEARING_WITHDRAWAL_INR' AND "type"='SYSTEM_CLEARING' AND "currencyCode"='INR' AND "status"='ACTIVE' FOR UPDATE;
  END IF;
  IF p_type<>'TRANSFER' AND NOT FOUND THEN
    v_reason := 'clearing_account_unavailable'; v_status:=409;
    v_body:=jsonb_build_object('status','REFUSED','reason',v_reason);
    INSERT INTO public."TransactionAttempt" ("id","actorId","sourceAccountId","destinationAccountId","type","requestedAmountPaise","status","refusalReason","idempotencyRecordId") VALUES (v_attempt,p_actor_id,p_source_account_id,p_destination_account_id,p_type,p_amount_paise,'REFUSED',v_reason,v_id);
    INSERT INTO public."AuditLog" ("id","actorId","action","entityType","entityId","metadata")
    VALUES (gen_random_uuid(),p_actor_id,'TRANSACTION_REFUSED','TransactionAttempt',v_attempt,
            jsonb_build_object('reason',v_reason,'type',p_type));
    UPDATE public."IdempotencyRecord" SET "responseStatus"=v_status,"responseBody"=v_body WHERE "id"=v_id;
    RETURN QUERY SELECT v_status,v_body; RETURN;
  END IF;

  INSERT INTO public."JournalTransaction" ("id","type","status","actorId") VALUES (v_journal,p_type,'PENDING',p_actor_id);
  -- Posting rows are in deterministic account UUID order; each account is
  -- already locked and its next sequence is allocated inside this transaction.
  FOR v_account_id IN
    SELECT x FROM unnest(ARRAY[p_source_account_id,p_destination_account_id,CASE WHEN p_type='TRANSFER' THEN NULL ELSE v_clear."id" END]) ids(x)
     WHERE x IS NOT NULL GROUP BY x ORDER BY x
  LOOP
    v_posting := v_posting + 1;
    SELECT COALESCE(max("accountPostingSequence"),0)+1 INTO v_next FROM public."LedgerEntry" WHERE "accountId"=v_account_id;
    IF v_account_id= p_source_account_id THEN
      INSERT INTO public."LedgerEntry" ("id","journalTransactionId","accountId","amountPaise","postingSequence","accountPostingSequence")
      VALUES (gen_random_uuid(),v_journal,v_account_id,CASE WHEN p_type='TRANSFER' OR p_type='WITHDRAWAL' THEN -p_amount_paise ELSE p_amount_paise END,v_posting,v_next);
      UPDATE public."Account" SET "balancePaise"="balancePaise"+CASE WHEN p_type='TRANSFER' OR p_type='WITHDRAWAL' THEN -p_amount_paise ELSE p_amount_paise END,"updatedAt"=clock_timestamp() WHERE "id"=v_account_id;
    ELSIF v_account_id=p_destination_account_id THEN
      INSERT INTO public."LedgerEntry" ("id","journalTransactionId","accountId","amountPaise","postingSequence","accountPostingSequence") VALUES (gen_random_uuid(),v_journal,v_account_id,p_amount_paise,v_posting,v_next);
      UPDATE public."Account" SET "balancePaise"="balancePaise"+p_amount_paise,"updatedAt"=clock_timestamp() WHERE "id"=v_account_id;
    ELSE
      INSERT INTO public."LedgerEntry" ("id","journalTransactionId","accountId","amountPaise","postingSequence","accountPostingSequence") VALUES (gen_random_uuid(),v_journal,v_account_id,CASE WHEN p_type='DEPOSIT' THEN -p_amount_paise ELSE p_amount_paise END,v_posting,v_next);
      UPDATE public."Account" SET "balancePaise"="balancePaise"+CASE WHEN p_type='DEPOSIT' THEN -p_amount_paise ELSE p_amount_paise END,"updatedAt"=clock_timestamp() WHERE "id"=v_account_id;
    END IF;
  END LOOP;
  UPDATE public."JournalTransaction" SET "status"='POSTED' WHERE "id"=v_journal;
  INSERT INTO public."TransactionAttempt" ("id","actorId","sourceAccountId","destinationAccountId","type","requestedAmountPaise","status","idempotencyRecordId") VALUES (v_attempt,p_actor_id,p_source_account_id,p_destination_account_id,p_type,p_amount_paise,'POSTED',v_id);
  v_status:=201; v_body:=jsonb_build_object('status','POSTED','journalTransactionId',v_journal,'amountPaise',p_amount_paise);
  UPDATE public."IdempotencyRecord" SET "responseStatus"=v_status,"responseBody"=v_body,"resultJournalTransactionId"=v_journal WHERE "id"=v_id;
  INSERT INTO public."AuditLog" ("id","actorId","action","entityType","entityId","metadata")
  VALUES (gen_random_uuid(), p_actor_id, v_audit_action, v_audit_entity, v_journal, v_body);
  RETURN QUERY SELECT v_status,v_body;
END;
$post$;

-- Secure ownership and privileges. Provision these NOLOGIN roles before applying
-- the migration. The migration principal needs schema/table ownership or ALTER,
-- CREATE on the schemas, REFERENCES/TRIGGER privileges, and role membership to
-- assign ownership to balancevault_posting_owner.
GRANT CREATE ON SCHEMA public TO balancevault_posting_owner;
ALTER FUNCTION public.balancevault_post_transaction(uuid, public."JournalTransactionType", uuid, uuid, bigint, text, char(64)) OWNER TO balancevault_posting_owner;
REVOKE CREATE ON SCHEMA public FROM balancevault_posting_owner;
SET ROLE balancevault_posting_owner;
REVOKE ALL ON FUNCTION public.balancevault_post_transaction(uuid, public."JournalTransactionType", uuid, uuid, bigint, text, char(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.balancevault_post_transaction(uuid, public."JournalTransactionType", uuid, uuid, bigint, text, char(64)) TO balancevault_runtime;
RESET ROLE;
GRANT USAGE ON SCHEMA public TO balancevault_runtime;
GRANT SELECT ON public."User", public."Account", public."AccountPermission", public."JournalTransaction", public."LedgerEntry", public."IdempotencyRecord", public."TransactionAttempt", public."AuditLog" TO balancevault_runtime;
GRANT SELECT ON public."Account", public."AccountPermission", public."User", public."JournalTransaction", public."LedgerEntry", public."IdempotencyRecord" TO balancevault_posting_owner;
GRANT INSERT ON public."IdempotencyRecord", public."JournalTransaction", public."LedgerEntry", public."TransactionAttempt", public."AuditLog" TO balancevault_posting_owner;
GRANT UPDATE ("role","isActive") ON public."User" TO balancevault_posting_owner;
GRANT UPDATE ("balancePaise","updatedAt") ON public."Account" TO balancevault_posting_owner;
GRANT UPDATE ("status") ON public."JournalTransaction" TO balancevault_posting_owner;
GRANT UPDATE ("responseStatus","responseBody","resultJournalTransactionId") ON public."IdempotencyRecord" TO balancevault_posting_owner;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public."LedgerEntry", public."AuditLog" FROM balancevault_runtime;
REVOKE UPDATE ("balancePaise") ON public."Account" FROM balancevault_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
