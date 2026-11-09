import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
dotenv.config({ path: path.join(root, '.env') });

const connectionString = process.env.MIGRATION_DATABASE_URL;
const keyHex = process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY;
if (!connectionString || !/^(?:[a-f0-9]{2}){32,}$/i.test(keyHex ?? '')) {
  console.error('Configure MIGRATION_DATABASE_URL and a 32-byte-or-longer BALANCEVAULT_ACTOR_ASSERTION_KEY in the protected provisioning environment.');
  process.exit(1);
}

const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  await client.query('SET ROLE balancevault_auth_owner');
  const result = await client.query(
    `INSERT INTO balancevault_auth_private.actor_assertion_key (singleton, secret)
     VALUES (true, $1) ON CONFLICT (singleton) DO NOTHING`,
    [Buffer.from(keyHex, 'hex')],
  );
  if (result.rowCount !== 1) throw new Error('Actor assertion key is already provisioned; use the documented controlled rotation procedure.');
  console.log('Actor assertion verifier installed. The key value was not printed.');
} catch (error) {
  console.error(`Actor assertion key provisioning failed${error?.code ? ` (database error ${error.code})` : ''}.`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
