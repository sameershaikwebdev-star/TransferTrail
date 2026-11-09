import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { canonicalRequestHash } from '../src/services/financial-transaction.service.js';

const { Client } = pg;
const adminUrl = process.env.BALANCEVAULT_TEST_OVERFLOW_DATABASE_URL;
const runtimeUrl = process.env.BALANCEVAULT_TEST_OVERFLOW_RUNTIME_DATABASE_URL;
const dbName = adminUrl ? new URL(adminUrl).pathname.slice(1) : '';
const integration = Boolean(adminUrl && runtimeUrl);
if ((adminUrl || runtimeUrl) && (!dbName.endsWith('_test') || dbName === 'balancevault_dev'
  || new URL(runtimeUrl ?? adminUrl).pathname.slice(1) !== dbName)) {
  throw new Error('Overflow integration URLs must target the same disposable database ending in _test.');
}

let admin;
let runtime;
let actorId;
let accountId;

before(async () => {
  if (!integration) return;
  admin = new Client({ connectionString: adminUrl });
  runtime = new Client({ connectionString: runtimeUrl });
  await Promise.all([admin.connect(), runtime.connect()]);
  const { rows: [{ current_database: currentDatabase }] } = await admin.query('SELECT current_database()');
  assert.equal(currentDatabase, dbName);
  await admin.query(`
    INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
    VALUES
      ('00000000-0000-0000-0000-000000000012','BV-CLEAR-DEP','CLEARING_DEPOSIT_INR','SYSTEM_CLEARING','ACTIVE',0,'INR',clock_timestamp()),
      ('00000000-0000-0000-0000-000000000013','BV-CLEAR-WD','CLEARING_WITHDRAWAL_INR','SYSTEM_CLEARING','ACTIVE',0,'INR',clock_timestamp())
    ON CONFLICT ("systemCode") DO NOTHING
  `);
  actorId = randomUUID();
  accountId = randomUUID();
  await admin.query('BEGIN');
  try {
    await admin.query(`INSERT INTO public."User" (id,email,"passwordHash",role,"isActive","updatedAt")
      VALUES ($1,$2,'test-hash','ACCOUNT_HOLDER',true,clock_timestamp())`, [actorId, `${actorId}@example.test`]);
    await admin.query(`INSERT INTO public."Account" (id,"accountNumber",type,status,"balancePaise","currencyCode","updatedAt")
      VALUES ($1,$2,'PERSONAL','ACTIVE',0,'INR',clock_timestamp())`, [accountId, `BV-OVERFLOW-${actorId.slice(0, 8)}`]);
    await admin.query(`INSERT INTO public."AccountPermission"
      (id,"userId","accountId","canView","canDeposit","canWithdraw","canTransfer","updatedAt")
      VALUES ($1,$2,$3,true,true,true,true,clock_timestamp())`, [randomUUID(), actorId, accountId]);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  await runtime.query('SET ROLE balancevault_runtime');
});

after(async () => {
  await Promise.all([runtime?.end(), admin?.end()]);
});

async function post(amountPaise, idempotencyKey) {
  const hash = canonicalRequestHash({ type: 'DEPOSIT', sourceAccountId: null, destinationAccountId: accountId, amountPaise });
  const { rows: [result] } = await runtime.query(
    `SELECT * FROM public.balancevault_post_transaction($1::uuid,'DEPOSIT',NULL,$2::uuid,$3::bigint,$4,$5::char(64))`,
    [actorId, accountId, amountPaise.toString(), idempotencyKey, hash],
  );
  return result;
}

test('BIGINT maximum posts once and the next paise fails atomically', { skip: !integration, timeout: 30_000 }, async () => {
  const maximum = 9223372036854775807n;
  const winning = await post(maximum, 'overflow-max-deposit');
  assert.equal(winning.response_status, 201);
  await assert.rejects(post(1n, 'overflow-one-more-paise'), (error) => error.code === '22003');

  const { rows: [state] } = await admin.query(`
    SELECT a."balancePaise"::text AS customer_balance,
           c."balancePaise"::text AS clearing_balance,
           (SELECT count(*)::int FROM public."LedgerEntry" WHERE "accountId" IN ($1,$2)) AS posting_count,
           (SELECT count(*)::int FROM public."IdempotencyRecord" WHERE "userId"=$3 AND "idempotencyKey"='overflow-one-more-paise') AS overflow_idempotency_count,
           (SELECT count(*)::int FROM public."AuditLog" WHERE "actorId"=$3 AND "action"='TRANSACTION_POSTED') AS posted_audit_count
      FROM public."Account" a CROSS JOIN public."Account" c
     WHERE a.id=$1 AND c."systemCode"='CLEARING_DEPOSIT_INR'`, [accountId, '00000000-0000-0000-0000-000000000012', actorId]);
  assert.equal(BigInt(state.customer_balance), maximum);
  assert.equal(BigInt(state.clearing_balance), -maximum);
  assert.equal(state.posting_count, 2);
  assert.equal(state.overflow_idempotency_count, 0);
  assert.equal(state.posted_audit_count, 1);
});
