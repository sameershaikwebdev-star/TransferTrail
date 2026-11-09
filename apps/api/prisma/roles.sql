-- Run once as a PostgreSQL administrator, outside Prisma migrations.
-- Supply credentials using your deployment's secret manager; no passwords belong here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='balancevault_migration_owner') THEN
    CREATE ROLE balancevault_migration_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='balancevault_posting_owner') THEN
    CREATE ROLE balancevault_posting_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='balancevault_runtime') THEN
    CREATE ROLE balancevault_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='balancevault_auth_owner') THEN
    CREATE ROLE balancevault_auth_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='balancevault_account_owner') THEN
    CREATE ROLE balancevault_account_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='balancevault_provisioning_owner') THEN
    CREATE ROLE balancevault_provisioning_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='balancevault_bootstrap_operator') THEN
    CREATE ROLE balancevault_bootstrap_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='balancevault_auth_runtime') THEN
    CREATE ROLE balancevault_auth_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END $$;

-- Neon does not expose true SUPERUSER roles, so it rejects ALTER ROLE ... NOSUPERUSER.
-- Keep NOSUPERUSER explicit in CREATE ROLE above; normalize the other restricted
-- attributes here using the Neon project owner's delegated role-management rights.
ALTER ROLE balancevault_migration_owner LOGIN NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE balancevault_posting_owner NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE balancevault_runtime NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE balancevault_auth_owner NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE balancevault_account_owner NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE balancevault_provisioning_owner NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE balancevault_bootstrap_operator NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE balancevault_auth_runtime NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

-- The migration principal must own the target database and public schema (or be
-- granted equivalent CREATE/ALTER/REFERENCES/TRIGGER privileges). Membership in
-- the NOLOGIN posting owner role is needed only to transfer routine ownership.
GRANT balancevault_posting_owner TO balancevault_migration_owner;
GRANT balancevault_auth_owner TO balancevault_migration_owner;
GRANT balancevault_account_owner TO balancevault_migration_owner;
GRANT balancevault_provisioning_owner TO balancevault_migration_owner;
DO $$
DECLARE v_grant record;
BEGIN
  FOR v_grant IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
      JOIN pg_catalog.pg_roles member ON member.oid = m.member
     WHERE (granted.rolname IN ('balancevault_runtime','balancevault_bootstrap_operator','balancevault_auth_runtime')
            AND member.rolname IN ('balancevault_migration_owner','balancevault_posting_owner',
                                   'balancevault_auth_owner','balancevault_account_owner',
                                   'balancevault_provisioning_owner','balancevault_bootstrap_operator'))
        OR (member.rolname IN ('balancevault_runtime','balancevault_bootstrap_operator','balancevault_auth_runtime')
            AND granted.rolname IN ('balancevault_migration_owner','balancevault_posting_owner',
                                    'balancevault_auth_owner','balancevault_account_owner',
                                    'balancevault_provisioning_owner','balancevault_bootstrap_operator'))
  LOOP
    EXECUTE format('REVOKE %I FROM %I', v_grant.granted_role, v_grant.member_role);
  END LOOP;
END $$;

-- The service's login is provisioned separately and receives this group role:
-- GRANT balancevault_runtime TO balancevault_api_login;
-- A one-time operator login may be granted this non-login group role by the DBA.
-- Keep its credentials separate from DATABASE_URL and MIGRATION_DATABASE_URL.
-- GRANT balancevault_bootstrap_operator TO balancevault_bootstrap_login;
-- A separate, read-only login may inherit only password-verification columns:
-- GRANT balancevault_auth_runtime TO balancevault_auth_login;
