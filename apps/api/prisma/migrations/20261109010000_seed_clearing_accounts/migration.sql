-- Seed the two internal clearing accounts required for deposits and withdrawals.
-- The balancevault_post_transaction function looks up these rows by systemCode at
-- runtime; if they are absent every deposit and withdrawal is refused with
-- clearing_account_unavailable.  Safe to apply more than once (DO NOTHING).

INSERT INTO public."Account" (
  "id", "accountNumber", "systemCode", "type",
  "status", "balancePaise", "currencyCode", "updatedAt"
)
VALUES
  (
    '00000000-0000-0000-0000-000000000012',
    'BV-CLEAR-DEP',
    'CLEARING_DEPOSIT_INR',
    'SYSTEM_CLEARING',
    'ACTIVE',
    0,
    'INR',
    clock_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000013',
    'BV-CLEAR-WD',
    'CLEARING_WITHDRAWAL_INR',
    'SYSTEM_CLEARING',
    'ACTIVE',
    0,
    'INR',
    clock_timestamp()
  )
ON CONFLICT ("systemCode") DO NOTHING;
