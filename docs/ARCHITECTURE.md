# BalanceVault architecture

## Monorepo

- `apps/web` is the React + Vite client. It displays state and calls REST endpoints; it never performs money movement.
- `apps/api` is the Express API. It authenticates requests, validates inputs, applies route authorization, and calls database functions for protected operations.
- PostgreSQL is the source of truth. Prisma 7 and its PostgreSQL adapter provide ordinary queries and parameterized function calls.
- Redis backs shared authentication rate limits.

Both apps use JavaScript ES modules. Feature routes and services are grouped under `apps/api/src/routes` and `apps/api/src/services`; shared authentication, configuration, Redis, and database clients live under `apps/api/src`.

## Financial integrity

Financial operations call `balancevault_post_transaction` in PostgreSQL. It serializes overlapping account work, checks authorization and account status, rejects overdrafts, and commits a balanced journal and cached balances atomically. Idempotency records replay an equivalent request and reject a changed payload. Ledger rows are protected against update and deletion; refused attempts are recorded separately.

Amounts use integer paise. Request identity comes from a verified JWT and is rechecked against current user state. The browser cannot set authoritative user identity or role, and it cannot directly edit balances. Auditors have read-only, account-scoped views.

## Database identities

- The migration login owns the database schema and is `NOINHERIT`; it can explicitly assume function-owner roles during reviewed migrations.
- `balancevault_runtime` executes approved functions and reads only the non-secret columns required for normal API operations.
- `balancevault_auth_runtime` has narrow read access for credential verification, including `User.passwordHash`; it cannot write.
- Separate `balancevault_*_owner` roles own narrowly scoped `SECURITY DEFINER` functions and are not login roles.
- `balancevault_bootstrap_operator` can run only the single-use first-administrator function.

Privileged invitations and password changes use short-lived HMAC assertions bound to the authenticated actor, action, nonce, and operation arguments. PostgreSQL verifies and consumes each nonce atomically. The assertion key is stored outside public schemas and must be provisioned out of band.

## Local configuration and operations

Copy `.env.example` to `.env` and provide local values for the API and separate database identities. No credentials or token secrets belong in the repository. `/api/health` is a liveness endpoint; `/api/ready` performs a bounded database readiness check. See `docs/DEPLOYMENT.md` for production setup, migration order, and recovery guidance.

Ledger reconciliation is an operations-only read path. The CLI uses a dedicated runtime login, verifies that the login is not a superuser or migration/function owner, and runs a repeatable-read, read-only snapshot comparing `Account.balancePaise` with the signed sum of that account's `LedgerEntry.amountPaise`. It reports differences without attempting repairs. Operational scheduling and alerting must be supplied by the deployment environment.

The current browser session still uses a short-lived JWT bearer token in `sessionStorage`. The API reloads active status, role, and token version for every protected request, but JavaScript can read the browser token. A production server-managed cookie session with CSRF defenses has not been implemented; this remains an explicit launch blocker, not a claimed mitigation.
