import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.BALANCEVAULT_TEST_DATABASE_URL;
const runtimeDatabaseUrl = process.env.BALANCEVAULT_TEST_RUNTIME_DATABASE_URL;
const authDatabaseUrl = process.env.BALANCEVAULT_TEST_AUTH_DATABASE_URL;
const integration = Boolean(databaseUrl);
const testName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';

if (integration && (!testName.endsWith('_test') || testName === 'balancevault_dev')) {
  throw new Error('BALANCEVAULT_TEST_DATABASE_URL must target a disposable database ending in _test.');
}
if (integration && !runtimeDatabaseUrl) {
  throw new Error('BALANCEVAULT_TEST_RUNTIME_DATABASE_URL is required to verify the actual runtime role.');
}
if (integration && !authDatabaseUrl) {
  throw new Error('BALANCEVAULT_TEST_AUTH_DATABASE_URL is required to verify password-hash isolation using the authentication login.');
}
if (integration && new URL(authDatabaseUrl).pathname.slice(1) !== testName) {
  throw new Error('BALANCEVAULT_TEST_AUTH_DATABASE_URL must target the same disposable test database.');
}

let admin;
let runtime;
let authRuntime;

async function connect(connectionString, role = null) {
  const client = new Client({ connectionString });
  await client.connect();
  const { rows } = await client.query('SELECT current_database() AS db');
  assert.equal(rows[0].db, testName, 'connected database must match the explicit disposable test database');
  if (role) await client.query(`SET ROLE ${role}`);
  return client;
}

before(async () => {
  if (!integration) return;
  admin = await connect(databaseUrl);
  runtime = await connect(runtimeDatabaseUrl, 'balancevault_runtime');
  authRuntime = await connect(authDatabaseUrl);
});

after(async () => {
  if (runtime) await runtime.end();
  if (authRuntime) await authRuntime.end();
  if (admin) await admin.end();
});

test('account-holder registration function is narrowly owned and granted', {
  skip: !integration,
}, async () => {
  const { rows } = await admin.query(`
    SELECT
      (SELECT pg_get_userbyid(p.proowner)='balancevault_auth_owner' AND p.prosecdef
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
       FROM pg_proc p
       WHERE p.oid='public.create_account_holder_profile(uuid,text,text,text)'::regprocedure) AS function_secure,
      has_function_privilege('balancevault_runtime',
        'public.create_account_holder_profile(uuid,text,text,text)', 'EXECUTE') AS runtime_can_execute,
      NOT EXISTS (
        SELECT 1
        FROM pg_proc p,
          LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) acl
        WHERE p.oid='public.create_account_holder_profile(uuid,text,text,text)'::regprocedure
          AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
      ) AS public_cannot_execute,
      has_table_privilege('balancevault_runtime','public."User"','INSERT') AS runtime_can_insert,
      has_table_privilege('balancevault_runtime','public."User"','UPDATE') AS runtime_can_update,
      has_table_privilege('balancevault_runtime','public."User"','DELETE') AS runtime_can_delete,
      has_table_privilege('balancevault_runtime','public."User"','SELECT') AS runtime_can_select_table,
      has_column_privilege('balancevault_runtime','public."User"','passwordHash','SELECT') AS runtime_can_select_password_hash,
      has_column_privilege('balancevault_runtime','public."User"','email','SELECT') AS runtime_can_select_email,
      has_column_privilege('balancevault_auth_runtime','public."User"','passwordHash','SELECT') AS auth_can_select_password_hash,
      has_column_privilege('balancevault_auth_owner','public."User"','passwordHash','INSERT') AS owner_can_insert_hash,
      has_column_privilege('balancevault_auth_owner','public."User"','passwordHash','SELECT') AS owner_can_select_hash,
      has_column_privilege('balancevault_auth_owner','public."User"','createdAt','SELECT') AS owner_can_return_created_at,
      has_column_privilege('balancevault_auth_owner','public."User"','role','UPDATE') AS owner_can_update_role,
      (SELECT NOT rolcanlogin AND NOT rolinherit FROM pg_roles WHERE rolname='balancevault_auth_owner') AS owner_is_restricted,
      (SELECT NOT rolinherit FROM pg_roles WHERE rolname='balancevault_migration_owner') AS migration_owner_noinherit,
      pg_has_role('balancevault_migration_owner','balancevault_auth_owner','MEMBER') AS migration_owner_can_set_function_owner,
      pg_has_role('balancevault_runtime','balancevault_auth_owner','MEMBER') AS runtime_is_auth_owner_member
  `);
  const privileges = rows[0];
  assert.equal(privileges.function_secure, true);
  assert.equal(privileges.runtime_can_execute, true);
  assert.equal(privileges.public_cannot_execute, true);
  assert.equal(privileges.runtime_can_insert, false);
  assert.equal(privileges.runtime_can_update, false);
  assert.equal(privileges.runtime_can_delete, false);
  assert.equal(privileges.runtime_can_select_table, false);
  assert.equal(privileges.runtime_can_select_password_hash, false);
  assert.equal(privileges.runtime_can_select_email, true);
  assert.equal(privileges.auth_can_select_password_hash, true);
  assert.equal(privileges.owner_can_insert_hash, true);
  assert.equal(privileges.owner_can_select_hash, false);
  assert.equal(privileges.owner_can_return_created_at, true);
  assert.equal(privileges.owner_can_update_role, false);
  assert.equal(privileges.owner_is_restricted, true);
  assert.equal(privileges.migration_owner_noinherit, true);
  assert.equal(privileges.migration_owner_can_set_function_owner, true);
  assert.equal(privileges.runtime_is_auth_owner_member, false);
});

test('only the dedicated auth database role can read password hashes', { skip: !integration }, async () => {
  const identity = await authRuntime.query(`
    SELECT pg_catalog.pg_has_role(session_user,'balancevault_auth_runtime','USAGE') AS auth_role,
      pg_catalog.pg_has_role(session_user,'balancevault_runtime','MEMBER') AS runtime_role,
      pg_catalog.has_table_privilege(session_user,'public."User"','SELECT') AS broad_select,
      pg_catalog.has_column_privilege(session_user,'public."User"','passwordHash','SELECT') AS hash_select,
      pg_catalog.has_table_privilege(session_user,'public."User"','INSERT')
        OR pg_catalog.has_table_privilege(session_user,'public."User"','UPDATE')
        OR pg_catalog.has_table_privilege(session_user,'public."User"','DELETE') AS can_write
  `);
  assert.equal(identity.rows[0].auth_role, true);
  assert.equal(identity.rows[0].runtime_role, false);
  assert.equal(identity.rows[0].broad_select, false);
  assert.equal(identity.rows[0].hash_select, true);
  assert.equal(identity.rows[0].can_write, false);
  const userId = randomUUID();
  const email = `${userId}@example.test`;
  const passwordHash = await bcrypt.hash('dedicated-auth-role-password', 10);
  await runtime.query('SELECT * FROM public.create_account_holder_profile($1,$2,$3,$4)', [userId, 'Auth Role Test', email, passwordHash]);
  await assert.rejects(
    runtime.query('SELECT "passwordHash" FROM public."User" WHERE id=$1', [userId]),
    (error) => error.code === '42501',
  );
  const result = await authRuntime.query('SELECT "passwordHash" FROM public."User" WHERE id=$1', [userId]);
  assert.equal(result.rows[0].passwordHash, passwordHash);
});

test('runtime can create only a safe ACCOUNT_HOLDER result', { skip: !integration }, async () => {
  const userId = randomUUID();
  const email = `${userId}@example.test`;
  const passwordHash = await bcrypt.hash('registration-test-password', 10);
  const result = await runtime.query(
    'SELECT * FROM public.create_account_holder_profile($1,$2,$3,$4)',
    [userId, 'Registration Test', email, passwordHash],
  );

  assert.equal(result.rows[0].id, userId);
  assert.equal(result.rows[0].fullName, 'Registration Test');
  assert.equal(result.rows[0].email, email);
  assert.equal(result.rows[0].role, 'ACCOUNT_HOLDER');
  assert.equal(result.rows[0].isActive, true);
  assert.ok(result.rows[0].createdAt instanceof Date);
  assert.equal(Object.hasOwn(result.rows[0], 'passwordHash'), false);

  const stored = await admin.query(
    'SELECT "passwordHash", role, "isActive" FROM public."User" WHERE id=$1',
    [userId],
  );
  assert.equal(stored.rows[0].passwordHash, passwordHash);
  assert.equal(stored.rows[0].role, 'ACCOUNT_HOLDER');
  assert.equal(stored.rows[0].isActive, true);
  const registrationAudit = await admin.query(
    `SELECT action FROM public."AuditLog" WHERE "entityType"='User' AND "entityId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,
    [userId],
  );
  assert.equal(registrationAudit.rows[0]?.action, 'ACCOUNT_HOLDER_REGISTERED');
});

test('duplicate email is rejected by the unique constraint', { skip: !integration }, async () => {
  const userId = randomUUID();
  const email = `${userId}@example.test`;
  const passwordHash = await bcrypt.hash('duplicate-test-password', 10);
  await runtime.query('SELECT * FROM public.create_account_holder_profile($1,$2,$3,$4)', [userId, 'Duplicate Test', email, passwordHash]);
  await assert.rejects(
    runtime.query('SELECT * FROM public.create_account_holder_profile($1,$2,$3,$4)', [randomUUID(), 'Duplicate Test', email, passwordHash]),
    (error) => error.code === '23505',
  );
});

test('invalid email normalization and bcrypt formats are rejected', { skip: !integration }, async () => {
  const hash = await bcrypt.hash('format-test-password', 10);
  await assert.rejects(
    runtime.query('SELECT * FROM public.create_account_holder_profile($1,$2,$3,$4)', [randomUUID(), 'Name', 'Upper@example.test', hash]),
    (error) => error.code === '22023',
  );
  await assert.rejects(
    runtime.query('SELECT * FROM public.create_account_holder_profile($1,$2,$3,$4)', [randomUUID(), 'Name', 'lower@example.test', 'not-a-bcrypt-hash']),
    (error) => error.code === '22023',
  );
  const weakCostHash = await bcrypt.hash('weak-cost-password', 9);
  await assert.rejects(
    runtime.query('SELECT * FROM public.create_account_holder_profile($1,$2,$3,$4)', [randomUUID(), 'Name', 'weak@example.test', weakCostHash]),
    (error) => error.code === '22023',
  );
});

test('callers cannot supply a role or inactive status', { skip: !integration }, async () => {
  const passwordHash = await bcrypt.hash('escalation-test-password', 10);
  await assert.rejects(
    runtime.query(
      'SELECT * FROM public.create_account_holder_profile($1,$2,$3,$4,$5,$6)',
      [randomUUID(), 'Name', `${randomUUID()}@example.test`, passwordHash, 'ADMIN', false],
    ),
    (error) => error.code === '42883',
  );
});

test('runtime cannot write User directly', { skip: !integration }, async () => {
  const id = randomUUID();
  await assert.rejects(
    runtime.query(
      `INSERT INTO public."User" (id,email,"passwordHash","updatedAt") VALUES ($1,$2,'x',clock_timestamp())`,
      [id, `${id}@example.test`],
    ),
    (error) => error.code === '42501',
  );
  await assert.rejects(
    runtime.query('UPDATE public."User" SET role=\'ADMIN\' WHERE id=$1', [id]),
    (error) => error.code === '42501',
  );
  await assert.rejects(
    runtime.query('DELETE FROM public."User" WHERE id=$1', [id]),
    (error) => error.code === '42501',
  );
});
