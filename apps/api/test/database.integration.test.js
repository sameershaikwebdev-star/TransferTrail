import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.BALANCEVAULT_TEST_DATABASE_URL;
const runtimeDatabaseUrl = process.env.BALANCEVAULT_TEST_RUNTIME_DATABASE_URL;
const integration = Boolean(databaseUrl);
const testName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';
if (integration && (!testName.endsWith('_test') || testName === 'balancevault_dev')) {
  throw new Error('BALANCEVAULT_TEST_DATABASE_URL must target a disposable database ending in _test.');
}
if (integration && !runtimeDatabaseUrl) {
  throw new Error('BALANCEVAULT_TEST_RUNTIME_DATABASE_URL is required to verify the actual runtime role.');
}

let admin;

async function connect(role = false) {
  const client = new Client({ connectionString: role ? runtimeDatabaseUrl : databaseUrl });
  await client.connect();
  const { rows } = await client.query('SELECT current_database() AS db');
  assert.equal(rows[0].db, testName, 'connected database must match the explicit disposable test database');
  if (role) await client.query('SET ROLE balancevault_runtime');
  return client;
}

function hash(payload) {
  const canonical = JSON.stringify(payload, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  return createHash('sha256').update(canonical).digest('hex');
}

async function fixture({ role = 'ACCOUNT_HOLDER', accountCount = 2 } = {}) {
  const userId = randomUUID();
  const accountIds = Array.from({ length: accountCount }, () => randomUUID());
  await admin.query('BEGIN');
  try {
    await admin.query(
      `INSERT INTO public."User" ("id","email","passwordHash","role","isActive","updatedAt")
       VALUES ($1,$2,'test-hash',$3,true,clock_timestamp())`,
      [userId, `${userId}@example.test`, role],
    );
    for (let i = 0; i < accountIds.length; i += 1) {
      await admin.query(
        `INSERT INTO public."Account" ("id","accountNumber","type","status","balancePaise","currencyCode","updatedAt")
         VALUES ($1,$2,'PERSONAL','ACTIVE',0,'INR',clock_timestamp())`,
        [accountIds[i], `BV-${userId.slice(0, 8)}-${i}`],
      );
      await admin.query(
        `INSERT INTO public."AccountPermission"
          ("id","userId","accountId","canView","canDeposit","canWithdraw","canTransfer","updatedAt")
         VALUES ($1,$2,$3,true,true,true,true,clock_timestamp())`,
        [randomUUID(), userId, accountIds[i]],
      );
    }
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  return { userId, accountIds };
}

async function post(args, client = null) {
  const owned = client ?? await connect(true);
  if (client) await owned.query('SET ROLE balancevault_runtime');
  try {
    const { rows } = await owned.query(
      `SELECT * FROM public.balancevault_post_transaction($1,$2,$3,$4,$5,$6,$7::char(64))`,
      [args.actorId, args.type, args.source ?? null, args.destination ?? null,
        args.amount, args.key, hash(args.payload ?? args)],
    );
    return rows[0];
  } finally {
    if (!client) await owned.end();
  }
}

async function balance(accountId) {
  const { rows } = await admin.query('SELECT "balancePaise" FROM public."Account" WHERE id=$1', [accountId]);
  return BigInt(rows[0].balancePaise);
}

async function customerBalanceTotal(accountIds) {
  const { rows } = await admin.query(
    `SELECT COALESCE(sum("balancePaise"),0)::text AS total
       FROM public."Account"
      WHERE id = ANY($1::uuid[]) AND type <> 'SYSTEM_CLEARING'`,
    [accountIds],
  );
  return BigInt(rows[0].total);
}

async function journalPostings(journalId) {
  const { rows } = await admin.query(`
    SELECT a."accountNumber", a."systemCode", e."amountPaise"
      FROM public."LedgerEntry" e JOIN public."Account" a ON a.id=e."accountId"
     WHERE e."journalTransactionId"=$1 ORDER BY e."postingSequence"`, [journalId]);
  return rows.map((row) => ({ accountNumber: row.accountNumber, systemCode: row.systemCode, amount: BigInt(row.amountPaise) }));
}

before(async () => {
  if (!integration) return;
  admin = await connect();
  const { rows } = await admin.query(`
    SELECT
      (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname='public' AND t.typtype='e') AS enum_count,
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations') AS table_count,
      (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal) AS trigger_count,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='balancevault_private') AS private_function_count,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='balancevault_private' AND pg_get_userbyid(p.proowner)='balancevault_posting_owner') AS private_functions_owned,
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND (
          has_table_privilege('balancevault_runtime',c.oid,'INSERT') OR
          has_table_privilege('balancevault_runtime',c.oid,'UPDATE') OR
          has_table_privilege('balancevault_runtime',c.oid,'DELETE') OR
          has_table_privilege('balancevault_runtime',c.oid,'TRUNCATE'))) AS runtime_table_write_grants,
      has_function_privilege('balancevault_runtime',
        'public.balancevault_post_transaction(uuid,public."JournalTransactionType",uuid,uuid,bigint,text,character)', 'EXECUTE') AS can_post,
      has_function_privilege('balancevault_runtime',
        'balancevault_private.bv_guard_ledger_entry()', 'EXECUTE') AS can_call_guard,
      has_schema_privilege('balancevault_runtime','balancevault_private','CREATE') AS can_create_private,
      has_schema_privilege('balancevault_runtime','balancevault_private','USAGE') AS can_use_private,
      has_schema_privilege('balancevault_runtime','public','CREATE') AS can_create_public,
      has_table_privilege('balancevault_runtime','public."LedgerEntry"','INSERT') AS can_insert_ledger,
      has_table_privilege('balancevault_runtime','public."Account"','UPDATE') AS can_update_account,
      has_table_privilege('balancevault_runtime','public."AuditLog"','TRUNCATE') AS can_truncate_audit,
      (SELECT pg_get_userbyid(proowner)='balancevault_posting_owner' AND prosecdef
         FROM pg_proc WHERE oid='public.balancevault_post_transaction(uuid,public."JournalTransactionType",uuid,uuid,bigint,text,character)'::regprocedure) AS posting_owner_ok,
      (SELECT rolinherit FROM pg_roles WHERE rolname='balancevault_migration_owner') AS migration_owner_inherits,
      pg_has_role('balancevault_migration_owner','balancevault_posting_owner','MEMBER') AS migration_owner_member_of_posting,
      pg_has_role('balancevault_migration_owner','balancevault_runtime','MEMBER') AS migration_owner_member_of_runtime,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
        LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
        WHERE n.nspname IN ('public','balancevault_private','balancevault_auth_private')
          AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend d
             WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid
               AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.deptype='e'
          )) AS public_execute_grants
  `);
  assert.equal(Number(rows[0].enum_count), 7);
  assert.equal(Number(rows[0].table_count), 11);
  assert.equal(Number(rows[0].trigger_count), 19);
  assert.equal(Number(rows[0].private_function_count), 17);
  assert.equal(Number(rows[0].private_functions_owned), 17);
  assert.equal(Number(rows[0].runtime_table_write_grants), 0);
  assert.equal(rows[0].can_post, true);
  assert.equal(rows[0].can_call_guard, false);
  assert.equal(rows[0].can_create_private, false);
  assert.equal(rows[0].can_use_private, false);
  assert.equal(rows[0].can_create_public, false);
  assert.equal(rows[0].can_insert_ledger, false);
  assert.equal(rows[0].can_update_account, false);
  assert.equal(rows[0].can_truncate_audit, false);
  assert.equal(rows[0].posting_owner_ok, true);
  assert.equal(rows[0].migration_owner_inherits, false);
  assert.equal(rows[0].migration_owner_member_of_posting, true);
  assert.equal(rows[0].migration_owner_member_of_runtime, false);
  assert.equal(Number(rows[0].public_execute_grants), 0);
  await admin.query(`
    INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
    VALUES
      ('00000000-0000-0000-0000-000000000012','BV-CLEAR-DEP','CLEARING_DEPOSIT_INR','SYSTEM_CLEARING','ACTIVE',0,'INR',clock_timestamp()),
      ('00000000-0000-0000-0000-000000000013','BV-CLEAR-WD','CLEARING_WITHDRAWAL_INR','SYSTEM_CLEARING','ACTIVE',0,'INR',clock_timestamp())
    ON CONFLICT ("systemCode") DO NOTHING
  `);
});

after(async () => { if (admin) await admin.end(); });

test('PostgreSQL 17 financial integrity integration', { skip: !integration, timeout: 120_000 }, async () => {
  const first = await fixture();
  const [a, b] = first.accountIds;
  const customerTotalBeforeDeposit = await customerBalanceTotal([a, b]);
  const depositClearingBefore = await balance('00000000-0000-0000-0000-000000000012');
  const deposit = await post({ actorId: first.userId, type: 'DEPOSIT', destination: a, amount: 100000n, key: 'deposit-1' });
  assert.equal(deposit.response_status, 201);
  assert.deepEqual((await journalPostings(deposit.response_body.journalTransactionId)).sort((x, y) => x.amount < y.amount ? -1 : 1).map((x) => [x.systemCode, x.amount]), [
    ['CLEARING_DEPOSIT_INR', -100000n], [null, 100000n],
  ]);
  assert.equal(await balance(a), 100000n);
  assert.equal(await customerBalanceTotal([a, b]), customerTotalBeforeDeposit + 100000n);
  assert.equal(await balance('00000000-0000-0000-0000-000000000012'), depositClearingBefore - 100000n);

  const withdrawal = await post({ actorId: first.userId, type: 'WITHDRAWAL', source: a, amount: 20000n, key: 'withdrawal-1' });
  assert.equal(withdrawal.response_status, 201);
  assert.equal(await customerBalanceTotal([a, b]), customerTotalBeforeDeposit + 80000n);
  assert.deepEqual((await journalPostings(withdrawal.response_body.journalTransactionId)).sort((x, y) => x.amount < y.amount ? -1 : 1).map((x) => [x.systemCode, x.amount]), [
    [null, -20000n], ['CLEARING_WITHDRAWAL_INR', 20000n],
  ]);
  const transfer = await post({ actorId: first.userId, type: 'TRANSFER', source: a, destination: b, amount: 30000n, key: 'transfer-1' });
  assert.equal(transfer.response_status, 201);
  assert.deepEqual((await journalPostings(transfer.response_body.journalTransactionId)).sort((x, y) => x.amount < y.amount ? -1 : 1).map((x) => [x.accountNumber, x.amount]), [
    [(await admin.query('SELECT "accountNumber" FROM public."Account" WHERE id=$1', [a])).rows[0].accountNumber, -30000n],
    [(await admin.query('SELECT "accountNumber" FROM public."Account" WHERE id=$1', [b])).rows[0].accountNumber, 30000n],
  ]);
  assert.equal(await balance(a), 50000n);
  assert.equal(await balance(b), 30000n);
  assert.equal(await customerBalanceTotal([a, b]), customerTotalBeforeDeposit + 80000n);

  const insufficient = await post({ actorId: first.userId, type: 'WITHDRAWAL', source: a, amount: 50001n, key: 'insufficient-1' });
  assert.equal(insufficient.response_status, 422);
  assert.equal(insufficient.response_body.status, 'REFUSED');
  assert.equal(await balance(a), 50000n);
  const refusedRecord = await admin.query(`
    SELECT i."resultJournalTransactionId", a.status, count(e.id) AS postings
      FROM public."IdempotencyRecord" i
      JOIN public."TransactionAttempt" a ON a."idempotencyRecordId"=i.id
      LEFT JOIN public."LedgerEntry" e ON e."journalTransactionId"=i."resultJournalTransactionId"
     WHERE i."userId"=$1 AND i."idempotencyKey"='insufficient-1'
     GROUP BY i."resultJournalTransactionId",a.status`, [first.userId]);
  assert.equal(refusedRecord.rows[0].resultJournalTransactionId, null);
  assert.equal(refusedRecord.rows[0].status, 'REFUSED');
  assert.equal(Number(refusedRecord.rows[0].postings), 0);

  const financialCountsBeforeReplay = await admin.query(`SELECT
    (SELECT count(*) FROM public."JournalTransaction") AS journals,
    (SELECT count(*) FROM public."LedgerEntry") AS postings`);
  const replay = await post({ actorId: first.userId, type: 'DEPOSIT', destination: a, amount: 100000n, key: 'deposit-1' });
  assert.deepEqual(replay.response_body, deposit.response_body);
  const conflict = await post({ actorId: first.userId, type: 'DEPOSIT', destination: a, amount: 100001n, key: 'deposit-1' });
  assert.equal(conflict.response_status, 409);
  assert.equal(await balance(a), 50000n);
  const originalIdem = await admin.query(`SELECT id,"responseStatus","responseBody","resultJournalTransactionId"
    FROM public."IdempotencyRecord" WHERE "userId"=$1 AND "idempotencyKey"='deposit-1'`, [first.userId]);
  const replayEvidence = await admin.query(`SELECT count(*) FROM public."AuditLog"
    WHERE "entityType"='IdempotencyRecord' AND "entityId"=$1 AND action='IDEMPOTENCY_REPLAY'`, [originalIdem.rows[0].id]);
  const conflictEvidence = await admin.query(`SELECT count(*) FROM public."AuditLog"
    WHERE "entityType"='IdempotencyRecord' AND "entityId"=$1 AND action='IDEMPOTENCY_CONFLICT'`, [originalIdem.rows[0].id]);
  const originalAfter = await admin.query(`SELECT "responseStatus","responseBody","resultJournalTransactionId"
    FROM public."IdempotencyRecord" WHERE id=$1`, [originalIdem.rows[0].id]);
  assert.equal(Number(replayEvidence.rows[0].count), 1);
  assert.equal(Number(conflictEvidence.rows[0].count), 1);
  const financialCountsAfterReplay = await admin.query(`SELECT
    (SELECT count(*) FROM public."JournalTransaction") AS journals,
    (SELECT count(*) FROM public."LedgerEntry") AS postings`);
  assert.deepEqual(financialCountsAfterReplay.rows[0], financialCountsBeforeReplay.rows[0]);
  assert.deepEqual(originalAfter.rows[0], {
    responseStatus: originalIdem.rows[0].responseStatus,
    responseBody: originalIdem.rows[0].responseBody,
    resultJournalTransactionId: originalIdem.rows[0].resultJournalTransactionId,
  });

  const clearingFailure = await fixture({ accountCount: 1 });
  const clearingAccountId = '00000000-0000-0000-0000-000000000012';
  const clearingCustomer = clearingFailure.accountIds[0];
  const customerBalanceBefore = await balance(clearingCustomer);
  const journalCountBefore = await admin.query('SELECT count(*) FROM public."JournalTransaction"');
  await admin.query('UPDATE public."Account" SET status=\'CLOSED\',"updatedAt"=clock_timestamp() WHERE id=$1', [clearingAccountId]);
  let clearingResponse;
  try {
    clearingResponse = await post({ actorId: clearingFailure.userId, type: 'DEPOSIT', destination: clearingCustomer, amount: 4000n, key: 'clearing-unavailable' });
  } finally {
    await admin.query('UPDATE public."Account" SET status=\'ACTIVE\',"updatedAt"=clock_timestamp() WHERE id=$1', [clearingAccountId]);
  }
  assert.equal(clearingResponse.response_status, 409);
  assert.equal(clearingResponse.response_body.reason, 'clearing_account_unavailable');
  assert.equal(await balance(clearingCustomer), customerBalanceBefore);
  const clearingAttempt = await admin.query(`SELECT a.id,a.status,a."refusalReason",i."resultJournalTransactionId"
    FROM public."TransactionAttempt" a JOIN public."IdempotencyRecord" i ON i.id=a."idempotencyRecordId"
    WHERE i."userId"=$1 AND i."idempotencyKey"='clearing-unavailable'`, [clearingFailure.userId]);
  assert.equal(clearingAttempt.rows[0].status, 'REFUSED');
  assert.equal(clearingAttempt.rows[0].refusalReason, 'clearing_account_unavailable');
  assert.equal(clearingAttempt.rows[0].resultJournalTransactionId, null);
  const clearingAudit = await admin.query(`SELECT count(*) FROM public."AuditLog"
    WHERE action='TRANSACTION_REFUSED' AND "entityType"='TransactionAttempt' AND "entityId"=$1
      AND metadata->>'reason'='clearing_account_unavailable'`, [clearingAttempt.rows[0].id]);
  assert.equal(Number(clearingAudit.rows[0].count), 1);
  const journalCountAfter = await admin.query('SELECT count(*) FROM public."JournalTransaction"');
  assert.equal(Number(journalCountAfter.rows[0].count), Number(journalCountBefore.rows[0].count));

  const outsider = await fixture({ accountCount: 0 });
  const denied = await post({ actorId: outsider.userId, type: 'WITHDRAWAL', source: a, amount: 1n, key: 'unauthorized-1' });
  assert.equal(denied.response_status, 403);
  assert.equal(denied.response_body.reason, 'not_authorized');

  const auditor = await fixture({ role: 'AUDITOR', accountCount: 0 });
  await admin.query(`INSERT INTO public."AccountPermission" ("id","userId","accountId","canView","updatedAt") VALUES ($1,$2,$3,true,clock_timestamp())`, [randomUUID(), auditor.userId, a]);
  const auditorRefusal = await post({ actorId: auditor.userId, type: 'DEPOSIT', destination: a, amount: 1n, key: 'auditor-1' });
  assert.equal(auditorRefusal.response_status, 403);
  assert.equal(auditorRefusal.response_body.reason, 'role_forbidden');

  const duplicate = await fixture({ accountCount: 1 });
  const duplicateArgs = { actorId: duplicate.userId, type: 'DEPOSIT', destination: duplicate.accountIds[0], amount: 777n, key: 'same-key' };
  const duplicated = await Promise.all(Array.from({ length: 8 }, () => post(duplicateArgs)));
  assert.ok(duplicated.every((row) => row.response_status === 201));
  assert.ok(duplicated.every((row) => row.response_body.journalTransactionId === duplicated[0].response_body.journalTransactionId));
  assert.equal(await balance(duplicate.accountIds[0]), 777n);

  const concurrent = await fixture({ accountCount: 1 });
  await post({ actorId: concurrent.userId, type: 'DEPOSIT', destination: concurrent.accountIds[0], amount: 100000n, key: 'fund' });
  const withdrawals = await Promise.all(Array.from({ length: 10 }, (_, i) => post({
    actorId: concurrent.userId, type: 'WITHDRAWAL', source: concurrent.accountIds[0], amount: 20000n, key: `race-${i}`,
  })));
  assert.equal(withdrawals.filter((row) => row.response_status === 201).length, 5);
  assert.equal(withdrawals.filter((row) => row.response_body.status === 'REFUSED').length, 5);
  assert.equal(await balance(concurrent.accountIds[0]), 0n);
  const raceCounts = await admin.query(`
    SELECT count(*) FILTER (WHERE a.status='POSTED') AS posted,
           count(*) FILTER (WHERE a.status='REFUSED') AS refused,
           count(*) AS total,
           count(DISTINCT i."resultJournalTransactionId") FILTER (WHERE a.status='POSTED') AS journals
      FROM public."TransactionAttempt" a
      JOIN public."IdempotencyRecord" i ON i.id=a."idempotencyRecordId"
     WHERE i."userId"=$1 AND i."idempotencyKey" LIKE 'race-%'`, [concurrent.userId]);
  assert.equal(Number(raceCounts.rows[0].posted), 5);
  assert.equal(Number(raceCounts.rows[0].refused), 5);
  assert.equal(Number(raceCounts.rows[0].total), 10);
  assert.equal(Number(raceCounts.rows[0].journals), 5);

  const shared = await fixture({ accountCount: 1 });
  const jointHolder = await fixture({ accountCount: 0 });
  await admin.query(`INSERT INTO public."AccountPermission" ("id","userId","accountId","canView","canWithdraw","updatedAt")
    VALUES ($1,$2,$3,true,true,clock_timestamp())`, [randomUUID(), jointHolder.userId, shared.accountIds[0]]);
  await post({ actorId: shared.userId, type: 'DEPOSIT', destination: shared.accountIds[0], amount: 100000n, key: 'shared-fund' });
  const jointResults = await Promise.all(Array.from({ length: 10 }, (_, i) => post({
    actorId: i % 2 === 0 ? shared.userId : jointHolder.userId,
    type: 'WITHDRAWAL', source: shared.accountIds[0], amount: 20000n, key: `shared-race-${i}`,
  })));
  assert.equal(jointResults.filter((row) => row.response_status === 201).length, 5);
  assert.equal(jointResults.filter((row) => row.response_body.status === 'REFUSED').length, 5);
  assert.equal(await balance(shared.accountIds[0]), 0n);
  const jointCount = await admin.query(`SELECT count(*) FILTER (WHERE a.status='POSTED') AS posted,
      count(*) FILTER (WHERE a.status='REFUSED') AS refused,
      count(DISTINCT i."resultJournalTransactionId") FILTER (WHERE a.status='POSTED') AS journals,
      count(*) AS total
    FROM public."TransactionAttempt" a JOIN public."IdempotencyRecord" i ON i.id=a."idempotencyRecordId"
    WHERE i."idempotencyKey" LIKE 'shared-race-%' AND i."userId" IN ($1,$2)`, [shared.userId, jointHolder.userId]);
  assert.equal(Number(jointCount.rows[0].posted), 5);
  assert.equal(Number(jointCount.rows[0].refused), 5);
  assert.equal(Number(jointCount.rows[0].journals), 5);
  assert.equal(Number(jointCount.rows[0].total), 10);

  const opposing = await fixture({ accountCount: 2 });
  const secondActor = await fixture({ accountCount: 0 });
  for (const accountId of opposing.accountIds) {
    await admin.query(`INSERT INTO public."AccountPermission" ("id","userId","accountId","canView","canTransfer","updatedAt") VALUES ($1,$2,$3,true,true,clock_timestamp())`, [randomUUID(), secondActor.userId, accountId]);
  }
  for (let i = 0; i < 2; i += 1) {
    await post({ actorId: opposing.userId, type: 'DEPOSIT', destination: opposing.accountIds[i], amount: 100000n, key: `fund-${i}` });
  }
  const opposingRows = await Promise.all([
    post({ actorId: opposing.userId, type: 'TRANSFER', source: opposing.accountIds[0], destination: opposing.accountIds[1], amount: 70000n, key: 'outbound' }),
    post({ actorId: secondActor.userId, type: 'TRANSFER', source: opposing.accountIds[1], destination: opposing.accountIds[0], amount: 70000n, key: 'inbound' }),
  ]);
  assert.ok(opposingRows.every((row) => row.response_status === 201));
  assert.equal(await balance(opposing.accountIds[0]), 100000n);
  assert.equal(await balance(opposing.accountIds[1]), 100000n);

  const rollbackFixture = await fixture({ accountCount: 2 });
  const [rollbackSource, rollbackDestination] = rollbackFixture.accountIds;
  await post({ actorId: rollbackFixture.userId, type: 'DEPOSIT', destination: rollbackSource, amount: 5000n, key: 'rollback-fund' });
  const rollbackSourceBefore = await balance(rollbackSource);
  const rollbackDestinationBefore = await balance(rollbackDestination);
  const rollbackCountsBefore = await admin.query(`SELECT
    (SELECT count(*) FROM public."JournalTransaction") AS journals,
    (SELECT count(*) FROM public."LedgerEntry") AS postings,
    (SELECT count(*) FROM public."TransactionAttempt") AS attempts,
    (SELECT count(*) FROM public."IdempotencyRecord") AS idempotency`);
  const rollbackClient = await connect(true);
  await rollbackClient.query('BEGIN');
  await rollbackClient.query(`SELECT * FROM public.balancevault_post_transaction($1,'TRANSFER',$2,$3,1000,'rollback-key',$4::char(64))`, [rollbackFixture.userId, rollbackSource, rollbackDestination, hash({ key: 'rollback-transfer' })]);
  await assert.rejects(rollbackClient.query('SELECT 1/0'), (error) => error.code === '22012');
  await rollbackClient.query('ROLLBACK');
  await rollbackClient.end();
  assert.equal(await balance(rollbackSource), rollbackSourceBefore);
  assert.equal(await balance(rollbackDestination), rollbackDestinationBefore);
  const rollbackCountsAfter = await admin.query(`SELECT
    (SELECT count(*) FROM public."JournalTransaction") AS journals,
    (SELECT count(*) FROM public."LedgerEntry") AS postings,
    (SELECT count(*) FROM public."TransactionAttempt") AS attempts,
    (SELECT count(*) FROM public."IdempotencyRecord") AS idempotency`);
  assert.deepEqual(rollbackCountsAfter.rows[0], rollbackCountsBefore.rows[0]);
  const rollbackIdem = await admin.query('SELECT count(*) FROM public."IdempotencyRecord" WHERE "userId"=$1 AND "idempotencyKey"=\'rollback-key\'', [rollbackFixture.userId]);
  assert.equal(Number(rollbackIdem.rows[0].count), 0);

  const journalCheck = await admin.query(`
    SELECT j.id, count(e.id) AS postings, sum(e."amountPaise") AS total
      FROM public."JournalTransaction" j JOIN public."LedgerEntry" e ON e."journalTransactionId"=j.id
     GROUP BY j.id HAVING count(e.id)<>2 OR sum(e."amountPaise")<>0`);
  assert.equal(journalCheck.rowCount, 0);
  const reconcile = await admin.query(`
    SELECT a.id FROM public."Account" a LEFT JOIN public."LedgerEntry" e ON e."accountId"=a.id
     GROUP BY a.id,a."balancePaise" HAVING a."balancePaise"::numeric<>COALESCE(sum(e."amountPaise"),0)`);
  assert.equal(reconcile.rowCount, 0);

  const ledgerId = (await admin.query('SELECT id FROM public."LedgerEntry" LIMIT 1')).rows[0].id;
  const auditId = (await admin.query('SELECT id FROM public."AuditLog" LIMIT 1')).rows[0].id;
  await assert.rejects(admin.query('UPDATE public."Account" SET "balancePaise"="balancePaise"+1 WHERE id=$1', [a]), /Cached balance can only be changed/);
  await assert.rejects(admin.query(`UPDATE public."Account" SET type='BUSINESS' WHERE id=$1`, [a]), /type and systemCode are immutable/);
  await assert.rejects(admin.query('UPDATE public."LedgerEntry" SET "amountPaise"=1 WHERE id=$1', [ledgerId]), /Ledger is append-only/);
  await assert.rejects(admin.query('DELETE FROM public."LedgerEntry" WHERE id=$1', [ledgerId]), /Ledger is append-only/);
  await assert.rejects(admin.query('TRUNCATE public."LedgerEntry"'), /TRUNCATE is forbidden/);
  await assert.rejects(admin.query('UPDATE public."JournalTransaction" SET description=\'changed\' WHERE id=$1', [deposit.response_body.journalTransactionId]), /Only immutable PENDING/);
  await assert.rejects(admin.query('DELETE FROM public."JournalTransaction" WHERE id=$1', [deposit.response_body.journalTransactionId]), /cannot be deleted/);
  await assert.rejects(admin.query('TRUNCATE public."JournalTransaction"'), /TRUNCATE is forbidden|cannot truncate a table referenced/);
  await assert.rejects(admin.query(`INSERT INTO public."Account" (id,"accountNumber",type,status,"balancePaise","currencyCode","updatedAt") VALUES ($1,$2,'PERSONAL','ACTIVE',-1,'INR',clock_timestamp())`, [randomUUID(), `BV-NEGATIVE-${randomUUID().slice(0,8)}`]), /Account_customer_balance_nonnegative/);
  await assert.rejects(admin.query('UPDATE public."AuditLog" SET action=\'changed\' WHERE id=$1', [auditId]), /append-only/);
  await assert.rejects(admin.query('DELETE FROM public."AuditLog" WHERE id=$1', [auditId]), /append-only/);
  await assert.rejects(admin.query('UPDATE public."AccountPermission" SET "accountId"=$1 WHERE "userId"=$2 AND "accountId"=$3', [b, first.userId, a]), /userId\/accountId are immutable/);

  await admin.query('BEGIN');
  await admin.query('DELETE FROM public."AccountPermission" WHERE "userId"=$1 AND "accountId"=$2', [first.userId, a]);
  await assert.rejects(admin.query('COMMIT'), /requires an active visible ACCOUNT_HOLDER/);
  await admin.query('ROLLBACK');
  await admin.query('BEGIN');
  await admin.query('UPDATE public."User" SET "isActive"=false,"updatedAt"=clock_timestamp() WHERE id=$1', [first.userId]);
  await assert.rejects(admin.query('COMMIT'), /requires an active visible ACCOUNT_HOLDER/);
  await admin.query('ROLLBACK');

  const incompleteUser = randomUUID();
  await admin.query('INSERT INTO public."User" ("id","email","passwordHash","updatedAt") VALUES ($1,$2,\'x\',clock_timestamp())', [incompleteUser, `${incompleteUser}@example.test`]);
  await admin.query('BEGIN');
  await admin.query(`INSERT INTO public."IdempotencyRecord" (id,"userId","idempotencyKey","canonicalRequestHash","expiresAt") VALUES ($1,$2,'unfinished',$3,clock_timestamp()+interval '1 day')`, [randomUUID(), incompleteUser, hash('incomplete')]);
  await assert.rejects(admin.query('COMMIT'), /Incomplete idempotency record/);
  await admin.query('ROLLBACK');

  const noHolderId = randomUUID();
  await admin.query('BEGIN');
  await admin.query(`INSERT INTO public."Account" (id,"accountNumber",type,status,"balancePaise","currencyCode","updatedAt") VALUES ($1,$2,'PERSONAL','ACTIVE',0,'INR',clock_timestamp())`, [noHolderId, `BV-NOHOLDER-${noHolderId.slice(0,8)}`]);
  await assert.rejects(admin.query('COMMIT'), /requires an active visible ACCOUNT_HOLDER/);
  await admin.query('ROLLBACK');

  const pendingActor = await fixture({ accountCount: 0 });
  await admin.query('BEGIN');
  await admin.query(`INSERT INTO public."JournalTransaction" (id,type,status,"actorId") VALUES ($1,'TRANSFER','PENDING',$2)`, [randomUUID(), pendingActor.userId]);
  await assert.rejects(admin.query('COMMIT'), /cannot commit pending/);
  await admin.query('ROLLBACK');

  const runtime = await connect(true);
  await assert.rejects(runtime.query('UPDATE public."Account" SET "balancePaise"=0 WHERE id=$1', [a]), /permission denied/);
  await assert.rejects(runtime.query('INSERT INTO public."LedgerEntry" DEFAULT VALUES'), /permission denied/);
  await assert.rejects(runtime.query('TRUNCATE public."AuditLog"'), /permission denied/);
  await assert.rejects(runtime.query('SELECT balancevault_private.bv_reject_truncate()'), /permission denied/);
  await assert.rejects(runtime.query('CREATE TABLE balancevault_private.runtime_owned (id integer)'), /permission denied/);
  await runtime.end();
});
