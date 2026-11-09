import { Client } from 'pg';
import { readLedgerReconciliation } from '../src/services/reconciliation.service.js';
import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });

const connectionString = process.env.RECONCILIATION_DATABASE_URL;
if (!connectionString) {
  console.error('Set RECONCILIATION_DATABASE_URL to a least-privilege read-only database login.');
  process.exit(1);
}

let targetDatabase;
try {
  targetDatabase = decodeURIComponent(new URL(connectionString).pathname.slice(1));
} catch {
  console.error('RECONCILIATION_DATABASE_URL must be a valid PostgreSQL URL.');
  process.exit(1);
}
// Local development allows balancevault_dev; production should use a separate read-only DB.

const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const { rows: [identity] } = await client.query(`
    SELECT current_database() AS database_name,
           role.rolsuper AS is_superuser,
           role.rolcreatedb AS can_create_database,
           role.rolcreaterole AS can_create_roles,
           pg_catalog.pg_has_role(session_user, 'balancevault_runtime', 'MEMBER') AS has_runtime_role,
           pg_catalog.pg_has_role(session_user, 'balancevault_auth_runtime', 'MEMBER') AS has_auth_runtime_role,
           pg_catalog.pg_has_role(session_user, 'balancevault_migration_owner', 'MEMBER') AS has_migration_role,
           pg_catalog.pg_has_role(session_user, 'balancevault_posting_owner', 'MEMBER') AS has_posting_owner_role,
           pg_catalog.pg_has_role(session_user, 'balancevault_auth_owner', 'MEMBER') AS has_auth_owner_role,
           pg_catalog.pg_has_role(session_user, 'balancevault_account_owner', 'MEMBER') AS has_account_owner_role,
           pg_catalog.pg_has_role(session_user, 'balancevault_provisioning_owner', 'MEMBER') AS has_provisioning_owner_role,
           pg_catalog.pg_has_role(session_user, 'balancevault_bootstrap_operator', 'MEMBER') AS has_bootstrap_operator_role
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = session_user
  `);
  if (identity?.database_name !== targetDatabase || identity.is_superuser || identity.can_create_database
      || identity.can_create_roles || !identity.has_runtime_role || identity.has_auth_runtime_role
      || identity.has_migration_role || identity.has_posting_owner_role || identity.has_auth_owner_role
      || identity.has_account_owner_role || identity.has_provisioning_owner_role || identity.has_bootstrap_operator_role) {
    throw new Error('Database login is not an approved non-privileged runtime identity.');
  }

  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const report = await readLedgerReconciliation(client);
  await client.query('COMMIT');
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2));
  if (report.discrepancyCount > 0) process.exitCode = 2;
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Ledger reconciliation failed${error?.code ? ` (database code ${error.code})` : ''}.`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
