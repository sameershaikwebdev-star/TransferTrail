import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from 'pg';
import { readLedgerReconciliation } from '../src/services/reconciliation.service.js';

const databaseUrl = process.env.BALANCEVAULT_TEST_DATABASE_URL;
const databaseName = databaseUrl ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) : '';
const enabled = Boolean(databaseUrl);
if (enabled && (!databaseName.endsWith('_test') || databaseName === 'balancevault_dev')) {
  throw new Error('Ledger reconciliation integration tests require a disposable *_test database.');
}

let client;

before(async () => {
  if (!enabled) return;
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const { rows: [{ current_database: actualDatabase }] } = await client.query('SELECT current_database()');
  assert.equal(actualDatabase, databaseName);
});

after(async () => {
  if (client) await client.end();
});

test('ledger reconciliation reports balanced account snapshots without write access', {
  skip: !enabled,
  timeout: 15_000,
}, async () => {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const report = await readLedgerReconciliation(client);
    assert.ok(report.checkedAccounts >= 0);
    assert.equal(report.discrepancyCount, 0, JSON.stringify(report.discrepancies));
    assert.deepEqual(report.discrepancies, []);

    await client.query('SAVEPOINT verify_read_only');
    await assert.rejects(
      client.query('UPDATE public."Account" SET "updatedAt"=clock_timestamp() WHERE false'),
      (error) => error.code === '25006',
      'the reconciliation snapshot must reject writes',
    );
    await client.query('ROLLBACK TO SAVEPOINT verify_read_only');
    await client.query('RELEASE SAVEPOINT verify_read_only');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
});
