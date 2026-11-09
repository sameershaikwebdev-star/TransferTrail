# BalanceVault --- Threat Model

**Document purpose:** Identify realistic security threats to the
BalanceVault hackathon demonstration, record existing safeguards that
have been described, and list validation and mitigation work.

**Scope:** BalanceVault's web frontend, API, authentication and
authorization flows, PostgreSQL database, Redis-backed rate limiting,
and deployment configuration.

**Important scope note:** This is a working threat model based on the
project details currently documented. It is not a penetration-test
report, security certification, or proof that every listed control is
implemented correctly. Verify each control against the current code and
deployed configuration.

------------------------------------------------------------------------

## 1. System overview

  -----------------------------------------------------------------------
  Component               Technology / service    Security relevance
  ----------------------- ----------------------- -----------------------
  Frontend                React, Vite, Vercel     Handles user input and
                                                  sends authenticated API
                                                  requests

  Backend                 Node.js API, Render     Enforces
                                                  authentication,
                                                  authorization,
                                                  validation, and
                                                  business rules

  Database                PostgreSQL on Neon      Stores users,
                                                  account-related data,
                                                  and audit records

  Database access         Dedicated PostgreSQL    Separates runtime,
                          roles and functions     authentication,
                                                  migration, and
                                                  provisioning privileges

  Rate limiting           Redis on Upstash        Helps limit repeated or
                                                  abusive API requests

  Deployment              Vercel and Render       Holds service URLs,
  configuration           environment variables   secrets, and origin
                                                  configuration
  -----------------------------------------------------------------------

The demo is intended for synthetic data. It must not be treated as a
production financial service or used to store real funds or sensitive
financial information.

## 2. Assets to protect

1.  User credentials, password hashes, and authentication tokens.
2.  User identity and account-related records.
3.  Role assignments, especially administrator privileges.
4.  Database integrity and consistency.
5.  Audit-log integrity and availability.
6.  API secrets, database credentials, Redis credentials, and
    actor-assertion keys.
7.  Availability of the frontend, backend, database, and rate-limiting
    service.
8.  The integrity of deployment configuration and source-code changes.

## 3. Trust boundaries

-   **Browser to frontend:** User-controlled input and browser state
    must be considered untrusted.
-   **Frontend to API:** Requests may be forged or modified; frontend
    checks are not authorization controls.
-   **API to PostgreSQL:** Database credentials and SQL operations must
    be restricted to the minimum required privileges.
-   **API to Redis:** Redis credentials and rate-limit state must be
    protected.
-   **Deployment control planes:** Vercel, Render, Neon, and Upstash
    settings can affect the security of the entire application.
-   **Administrative provisioning:** First-admin creation is a
    privileged operation and must not be exposed as ordinary public
    registration.

## 4. Threat register

  ---------------------------------------------------------------------------------------
  ID             Threat             Potential impact Priority       Mitigation /
                                                                    validation
  -------------- ------------------ ---------------- -------------- ---------------------
  T-01           Broken access      A user accesses  Critical       Enforce ownership and
                 control or IDOR    or changes                      role checks in the
                                    another user's                  API for every
                                    records                         protected operation.
                                                                    Test with two
                                                                    separate user
                                                                    accounts.

  T-02           Privilege          A normal user    Critical       Assign roles only
                 escalation         obtains                         through trusted
                                    administrator                   server-side flows.
                                    capabilities                    Reject
                                                                    client-supplied role
                                                                    changes. Test
                                                                    attempts to register
                                                                    or update a user as
                                                                    ADMIN.

  T-03           Account takeover   An attacker      High           Use strong password
                                    gains access                    hashing, rate
                                    through stolen                  limiting, secure
                                    or guessed                      session handling, and
                                    credentials                     safe password-reset
                                                                    design. Test login
                                                                    throttling and
                                                                    credential
                                                                    validation.

  T-04           Token theft or     A stolen bearer  High           Minimize token
                 exposure           token is used to                lifetime, protect
                                    impersonate a                   token storage, use
                                    user                            HTTPS, and implement
                                                                    revocation/rotation
                                                                    where appropriate.
                                                                    Review the current
                                                                    browser token-storage
                                                                    approach.

  T-05           SQL injection      An attacker      Critical       Use parameterized
                                    reads or                        queries and Prisma's
                                    modifies                        safe query APIs.
                                    database records                Review raw SQL and
                                                                    test untrusted input
                                                                    paths.

  T-06           Excessive database Compromise of an Critical       Keep separate
                 privileges         application                     least-privilege roles
                                    credential                      for runtime,
                                    causes wider                    authentication,
                                    database damage                 migrations, and
                                                                    provisioning. Verify
                                                                    grants and function
                                                                    ownership.

  T-07           Abuse of           An unauthorized  Critical       Keep bootstrap out of
                 first-admin        person creates                  public routes.
                 bootstrap          the first                       Require the dedicated
                                    administrator                   bootstrap login and
                                                                    operator role. Make
                                                                    bootstrap single-use
                                                                    and verify its
                                                                    behavior.

  T-08           Forged or missing  Important        High           Generate audit events
                 audit events       administrative                  server-side, restrict
                                    actions cannot                  write permissions,
                                    be reliably                     and test that
                                    investigated                    privileged actions
                                                                    produce the expected
                                                                    records.

  T-09           API abuse and      Repeated         High           Apply Redis-backed
                 denial of service  requests exhaust                rate limits,
                                    service or                      request-size limits,
                                    database                        timeouts, and input
                                    resources                       validation. Test
                                                                    behavior when Redis
                                                                    is unavailable.

  T-10           CORS or browser    Untrusted        Medium         Allow only intended
                 security           origins may                     frontend origins.
                 misconfiguration   interact with                   Verify production
                                    the API or                      CORS, CSP, and HTTPS
                                    browser                         settings. CORS is not
                                    protections may                 a substitute for
                                    fail                            authentication.

  T-11           Secret leakage     Database, Redis, Critical       Keep secrets in
                                    or signing                      provider environment
                                    credentials are                 variables, never
                                    exposed                         commit them, avoid
                                                                    logging them, and
                                                                    rotate any exposed
                                                                    credential.

  T-12           Dependency         A vulnerable     High           Run dependency
                 vulnerability      package is                      audits, update
                                    exploited                       affected packages,
                                                                    review lockfile
                                                                    changes, and retest
                                                                    after upgrades.

  T-13           Insecure           Debug settings,  High           Validate production
                 deployment         incorrect                       environment
                 configuration      origins, or                     variables, disable
                                    exposed                         debug behavior, and
                                    endpoints weaken                review provider
                                    the system                      access controls.

  T-14           Data loss or       Demo records or  High           Define backup
                 corruption         audit history                   expectations, test
                                    become                          restore procedures,
                                    unavailable or                  and use transactions
                                    inconsistent                    for related database
                                                                    changes.

  T-15           Cold starts or     Users cannot     Medium         Document free-tier
                 provider outages   access the demo                 sleep behavior and
                                    temporarily                     service dependencies.
                                                                    Treat health checks
                                                                    as availability
                                                                    signals, not proof of
                                                                    full functionality.
  ---------------------------------------------------------------------------------------

Priority is a qualitative assessment for the hackathon demo, not a
measured risk score.

## 5. Existing safeguards described for the project

The following safeguards have been described during development. Their
presence should still be confirmed against the current deployed code and
configuration.

-   PostgreSQL roles are separated by responsibility, including runtime,
    authentication, migration, and provisioning roles.
-   A dedicated bootstrap login and operator role are used for
    first-admin provisioning.
-   The first-admin database function is intended to be single-use.
-   The API uses an explicit frontend-origin allowlist for CORS.
-   Redis is configured for backend rate limiting.
-   The deployment has backend health and readiness endpoints.
-   Database migrations are applied through a dedicated migration
    workflow.
-   The application is deployed over HTTPS through Vercel and Render.

## 6. Known limitations and items requiring verification

-   The first-admin bootstrap process has encountered PostgreSQL `42501`
    permission errors and is not yet confirmed successful.
-   The deployed admin login and complete admin workflows must be tested
    end to end.
-   Browser token storage and the consequences of token theft require
    further security review.
-   Backup restoration and recovery objectives have not been
    demonstrated.
-   Monitoring, alerting, and reconciliation procedures require further
    validation.
-   A complete independent security review or penetration test has not
    been completed.
-   Free-tier hosting may introduce cold starts and availability
    limitations.

Do not describe these items as resolved until there is test evidence.

## 7. Recommended verification checklist

-   [ ] Confirm unauthenticated users cannot access protected API
    routes.
-   [ ] Confirm one ordinary user cannot read or modify another user's
    records.
-   [ ] Confirm public registration cannot assign ADMIN or other
    privileged roles.
-   [ ] Confirm admin-only endpoints reject ordinary users.
-   [ ] Confirm first-admin bootstrap cannot be repeated after
    successful creation.
-   [ ] Confirm the bootstrap credential cannot be used for ordinary
    application requests.
-   [ ] Confirm database runtime roles cannot perform migrations or
    privileged provisioning.
-   [ ] Confirm SQL inputs are parameterized and validated.
-   [ ] Confirm secrets are absent from source control, browser bundles,
    and application logs.
-   [ ] Confirm CORS permits only the intended production frontend
    origin.
-   [ ] Confirm rate limits work and fail safely when Redis is
    unavailable.
-   [ ] Confirm audit records are created for privileged actions and
    cannot be altered by ordinary users.
-   [ ] Confirm dependency audit results are reviewed and documented.
-   [ ] Confirm backup and restore procedures in a separate test
    environment.
-   [ ] Run end-to-end tests using synthetic accounts and synthetic
    data.

## 8. Incident response basics

If a credential or secret is exposed:

1.  Revoke or rotate the affected credential at its provider.
2.  Update the corresponding environment variable in the relevant
    deployment.
3.  Redeploy and verify the affected service.
4.  Review provider and application logs for suspicious use.
5.  Record the incident, affected component, timeline, and corrective
    action.

If unauthorized access is suspected:

1.  Disable the affected account or privileged access path where
    possible.
2.  Preserve relevant logs and database evidence.
3.  Identify affected records and operations.
4.  Restore from a verified backup if data integrity is compromised.
5.  Re-enable access only after the cause is understood and corrected.

## 9. Security statement

BalanceVault is a hackathon demonstration using synthetic data. The
presence of authentication, role separation, database functions, rate
limiting, and audit functionality does not by itself establish
production-grade security. The project is not represented as a regulated
banking platform, payment processor, or system suitable for real funds.

------------------------------------------------------------------------

**Review status:** Working document --- update this threat model as
implementation and testing evidence changes.
