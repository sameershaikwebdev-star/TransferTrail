import { z } from 'zod';

const databaseUrlSchema = z.string().url().refine((value) => {
  try {
    return ['postgres:', 'postgresql:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, 'DATABASE_URL must be a PostgreSQL connection URL');
const authDatabaseUrlSchema = databaseUrlSchema;

const redisUrlSchema = z.string().url().refine((value) => {
  try {
    return ['redis:', 'rediss:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, 'REDIS_URL must be a Redis-compatible connection URL');

function parseOrigins(value, production) {
  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length) throw new Error('WEB_ORIGIN must contain at least one allowed origin');
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('WEB_ORIGIN must contain valid origins');
    }
    if (parsed.origin !== origin || (production && parsed.protocol !== 'https:')) {
      throw new Error('WEB_ORIGIN must contain exact HTTPS origins in production');
    }
  }
  return origins;
}

export function validateRuntimeConfig(env = process.env) {
  const databaseUrl = databaseUrlSchema.safeParse(env.DATABASE_URL);
  if (!databaseUrl.success) throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  const authDatabaseUrl = authDatabaseUrlSchema.safeParse(env.AUTH_DATABASE_URL);
  if (env.AUTH_DATABASE_URL && !authDatabaseUrl.success) throw new Error('AUTH_DATABASE_URL must be a valid PostgreSQL connection URL');
  if (env.NODE_ENV === 'production' && !authDatabaseUrl.success) throw new Error('AUTH_DATABASE_URL must be configured');

  const production = env.NODE_ENV === 'production';
  const redisUrl = redisUrlSchema.safeParse(env.REDIS_URL ?? (production ? undefined : 'redis://127.0.0.1:6379/0'));
  if (!redisUrl.success) throw new Error('REDIS_URL must be a valid Redis-compatible connection URL');
  const origins = parseOrigins(env.WEB_ORIGIN ?? (production ? '' : 'http://localhost:5173'), production);
  const rawPort = env.PORT ?? env.API_PORT ?? '3001';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT or API_PORT must be a valid TCP port');
  }

  const poolMax = Number(env.DATABASE_POOL_MAX ?? '10');
  const connectionTimeoutMillis = Number(env.DATABASE_CONNECTION_TIMEOUT_MS ?? '5000');
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 100) {
    throw new Error('DATABASE_POOL_MAX must be an integer from 1 through 100');
  }
  if (!Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 100 || connectionTimeoutMillis > 60000) {
    throw new Error('DATABASE_CONNECTION_TIMEOUT_MS must be an integer from 100 through 60000');
  }
  const databaseReadyTimeoutMillis = Number(env.DATABASE_READY_TIMEOUT_MS ?? '1500');
  if (!Number.isInteger(databaseReadyTimeoutMillis) || databaseReadyTimeoutMillis < 100 || databaseReadyTimeoutMillis > 10000) {
    throw new Error('DATABASE_READY_TIMEOUT_MS must be an integer from 100 through 10000');
  }

  if (production) {
    const url = new URL(databaseUrl.data);
    if (!['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode'))) {
      throw new Error('DATABASE_URL must use sslmode=require, verify-ca, or verify-full in production');
    }
    const authUrl = new URL(authDatabaseUrl.data);
    if (!['require', 'verify-ca', 'verify-full'].includes(authUrl.searchParams.get('sslmode'))) {
      throw new Error('AUTH_DATABASE_URL must use sslmode=require, verify-ca, or verify-full in production');
    }
  }

  return {
    databaseUrl: databaseUrl.data,
    authDatabaseUrl: authDatabaseUrl.success ? authDatabaseUrl.data : null,
    redisUrl: redisUrl.data,
    origins,
    port,
    pool: { max: poolMax, connectionTimeoutMillis },
    databaseReadyTimeoutMillis,
    production,
  };
}

export async function verifyRuntimeDatabaseIdentity(prismaClient) {
  const [identity] = await prismaClient.$queryRaw`
    SELECT
      pg_catalog.pg_has_role(session_user, 'balancevault_runtime', 'USAGE') AS has_runtime_privileges,
      COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user), true) AS is_superuser,
      pg_catalog.pg_has_role(session_user, 'balancevault_migration_owner', 'MEMBER') AS is_migration_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_posting_owner', 'MEMBER') AS is_posting_owner_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_auth_owner', 'MEMBER') AS is_auth_owner_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_account_owner', 'MEMBER') AS is_account_owner_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_auth_runtime', 'MEMBER') AS is_auth_runtime_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_provisioning_owner', 'MEMBER') AS is_provisioning_owner_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_bootstrap_operator', 'MEMBER') AS is_bootstrap_operator_member,
      COALESCE((SELECT r.rolcreatedb OR r.rolcreaterole FROM pg_catalog.pg_roles r WHERE r.rolname = session_user), true) AS has_role_admin_options,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND (pg_catalog.has_table_privilege(session_user, c.oid, 'INSERT')
            OR pg_catalog.has_table_privilege(session_user, c.oid, 'UPDATE')
            OR pg_catalog.has_table_privilege(session_user, c.oid, 'DELETE')
            OR pg_catalog.has_table_privilege(session_user, c.oid, 'TRUNCATE'))
      ) AS has_direct_table_write,
      pg_catalog.has_schema_privilege(session_user, 'public', 'CREATE') AS can_create_public,
      pg_catalog.has_schema_privilege(session_user, 'balancevault_private', 'CREATE') AS can_create_private,
      pg_catalog.has_schema_privilege(session_user, 'balancevault_auth_private', 'USAGE') AS can_use_auth_private
  `;

  if (!identity?.has_runtime_privileges || identity.is_superuser || identity.is_migration_member
      || identity.is_posting_owner_member || identity.is_auth_owner_member || identity.is_account_owner_member
      || identity.is_auth_runtime_member || identity.is_provisioning_owner_member || identity.is_bootstrap_operator_member) {
    throw new Error('DATABASE_URL must use a non-privileged login that inherits only balancevault_runtime');
  }
  if (identity.has_role_admin_options || identity.has_direct_table_write
      || identity.can_create_public || identity.can_create_private || identity.can_use_auth_private) {
    throw new Error('DATABASE_URL login has direct database privileges outside the approved runtime functions');
  }
}

export async function verifyAuthDatabaseIdentity(prismaClient) {
  const [identity] = await prismaClient.$queryRaw`
    SELECT
      pg_catalog.pg_has_role(session_user, 'balancevault_auth_runtime', 'USAGE') AS has_auth_privileges,
      COALESCE((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user), true) AS is_superuser,
      pg_catalog.pg_has_role(session_user, 'balancevault_runtime', 'MEMBER') AS is_runtime_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_migration_owner', 'MEMBER') AS is_migration_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_posting_owner', 'MEMBER') AS is_posting_owner_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_auth_owner', 'MEMBER') AS is_auth_owner_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_account_owner', 'MEMBER') AS is_account_owner_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_provisioning_owner', 'MEMBER') AS is_provisioning_owner_member,
      pg_catalog.pg_has_role(session_user, 'balancevault_bootstrap_operator', 'MEMBER') AS is_bootstrap_operator_member,
      COALESCE((SELECT r.rolcreatedb OR r.rolcreaterole FROM pg_catalog.pg_roles r WHERE r.rolname = session_user), true) AS has_role_admin_options,
      pg_catalog.has_table_privilege(session_user, 'public."User"', 'SELECT') AS has_table_select,
      pg_catalog.has_column_privilege(session_user, 'public."User"', 'passwordHash', 'SELECT') AS can_verify_password,
      pg_catalog.has_column_privilege(session_user, 'public."User"', 'role', 'SELECT') AS can_read_role,
      pg_catalog.has_table_privilege(session_user, 'public."User"', 'INSERT')
        OR pg_catalog.has_table_privilege(session_user, 'public."User"', 'UPDATE')
        OR pg_catalog.has_table_privilege(session_user, 'public."User"', 'DELETE')
        OR pg_catalog.has_table_privilege(session_user, 'public."User"', 'TRUNCATE') AS can_write_user,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p')
          AND (pg_catalog.has_table_privilege(session_user,c.oid,'INSERT')
            OR pg_catalog.has_table_privilege(session_user,c.oid,'UPDATE')
            OR pg_catalog.has_table_privilege(session_user,c.oid,'DELETE')
            OR pg_catalog.has_table_privilege(session_user,c.oid,'TRUNCATE'))
      ) AS has_direct_table_write,
      pg_catalog.has_schema_privilege(session_user,'public','CREATE') AS can_create_public,
      pg_catalog.has_schema_privilege(session_user,'balancevault_auth_private','USAGE') AS can_use_auth_private
  `;
  if (!identity?.has_auth_privileges || identity.is_superuser || identity.is_runtime_member
      || identity.is_migration_member || identity.is_posting_owner_member || identity.is_auth_owner_member
      || identity.is_account_owner_member || identity.is_provisioning_owner_member || identity.is_bootstrap_operator_member
      || identity.has_role_admin_options || identity.has_direct_table_write || identity.can_create_public
      || identity.can_use_auth_private || identity.has_table_select
      || !identity.can_verify_password || !identity.can_read_role || identity.can_write_user) {
    throw new Error('AUTH_DATABASE_URL must use a read-only login inheriting only balancevault_auth_runtime');
  }
}
