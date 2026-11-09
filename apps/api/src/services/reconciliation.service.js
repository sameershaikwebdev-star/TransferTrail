const ACCOUNT_RECONCILIATION_SQL = `
  SELECT
    a.id::text AS "accountId",
    a."balancePaise"::text AS "storedBalancePaise",
    COALESCE(sum(e."amountPaise"), 0)::text AS "ledgerBalancePaise",
    (a."balancePaise"::numeric - COALESCE(sum(e."amountPaise"), 0))::text AS "differencePaise"
  FROM public."Account" AS a
  LEFT JOIN public."LedgerEntry" AS e ON e."accountId" = a.id
  GROUP BY a.id, a."balancePaise"
  HAVING a."balancePaise"::numeric <> COALESCE(sum(e."amountPaise"), 0)
  ORDER BY a.id
`;

export async function readLedgerReconciliation(client) {
  const { rows: [{ checkedAccounts }] } = await client.query(
    'SELECT count(*)::text AS "checkedAccounts" FROM public."Account"',
  );
  const { rows: discrepancies } = await client.query(ACCOUNT_RECONCILIATION_SQL);
  return {
    checkedAccounts: Number(checkedAccounts),
    discrepancyCount: discrepancies.length,
    discrepancies,
  };
}
