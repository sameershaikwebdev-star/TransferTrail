import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
dotenv.config({ path: path.join(root, '.env') });

const keyPath = path.join(
  process.env.HOME || '',
  '.config',
  'balancevault',
  'actor-assertion-key.next',
);

const connectionString = process.env.MIGRATION_DATABASE_URL;

if (!connectionString) {
  console.error('MIGRATION_DATABASE_URL is not configured.');
  process.exit(1);
}

let newKey;

try {
  const keyHex = (await readFile(keyPath, 'utf8')).trim();

  if (!/^(?:[a-f0-9]{2}){32,}$/i.test(keyHex)) {
    throw new Error('Invalid key format.');
  }

  newKey = Buffer.from(keyHex, 'hex');
} catch {
  console.error('Could not read or validate the protected candidate key.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 5000,
});

let transactionStarted = false;

try {
  await client.connect();
  await client.query('BEGIN');
  transactionStarted = true;

  await client.query('SET LOCAL ROLE balancevault_auth_owner');

  const current = await client.query(
    `SELECT secret
       FROM balancevault_auth_private.actor_assertion_key
      WHERE singleton IS TRUE
      FOR UPDATE`,
  );

  if (current.rowCount !== 1) {
    throw new Error('Expected exactly one existing verifier row.');
  }

  const oldKey = current.rows[0].secret;

  if (!Buffer.isBuffer(oldKey) || oldKey.length < 32) {
    throw new Error('Existing verifier has an invalid format.');
  }

  if (
    oldKey.length === newKey.length &&
    timingSafeEqual(oldKey, newKey)
  ) {
    throw new Error('Candidate key is identical to the existing key.');
  }

  if (process.argv.includes('--apply')) {
    const result = await client.query(
      `UPDATE balancevault_auth_private.actor_assertion_key
          SET secret = $1
        WHERE singleton IS TRUE`,
      [newKey],
    );

    if (result.rowCount !== 1) {
      throw new Error('Expected exactly one verifier row to be updated.');
    }

    await client.query('COMMIT');
    transactionStarted = false;
    console.log('Actor assertion key rotation committed successfully.');
  } else {
    await client.query('ROLLBACK');
    transactionStarted = false;
    console.log('Preflight successful. No database changes were made.');
    console.log('Use --apply only during the coordinated rotation window.');
  }
} catch (error) {
  if (transactionStarted) {
    await client.query('ROLLBACK').catch(() => {});
  }

  console.error(
    `Actor assertion key rotation failed${error?.code ? ` (database error ${error.code})` : ''}.`,
  );
  process.exitCode = 1;
} finally {
  newKey?.fill(0);
  await client.end().catch(() => {});
}
