# BalanceVault --- AI Prompts

This file documents representative prompts used while developing and
reviewing BalanceVault with ChatGPT and OpenAI Codex in VS Code.

> **Note:** These are cleaned-up representative prompts, not a claim
> that every prompt is a verbatim transcript of the development
> conversation. AI-generated changes were reviewed and tested before
> being treated as project changes.

## 1. Understand the project architecture

``` text
Inspect the existing BalanceVault repository and explain its architecture.
Identify the frontend, backend, database, authentication, authorization,
and infrastructure components. Trace the main user flows and point to
the relevant files. Do not modify files.
```

## 2. Implement features within the existing architecture

``` text
Inspect the existing implementation before making changes. Implement the
requested feature using the project's current conventions and architecture.
Avoid unrelated refactoring. Identify affected files, explain the proposed
changes, add or update focused tests, and report any assumptions or
unfinished work.
```

## 3. Review authentication and authorization

``` text
Review the authentication and role-based authorization implementation.
Trace how users authenticate, how roles are checked, and how protected
routes are enforced. Look for privilege escalation, insecure defaults,
missing authorization checks, and unsafe handling of credentials.
Do not make changes until you have explained the findings.
```

## 4. Review database migrations and role provisioning

``` text
Inspect the Prisma schema, database migrations, and PostgreSQL role
provisioning scripts. Explain the purpose and privileges of each role.
Check ownership, grants, function permissions, and least-privilege
assumptions. Do not modify applied migrations or execute database
commands. Recommend the smallest safe correction for any issue found.
```

## 5. Debug deployment configuration

``` text
Inspect the deployment configuration for the Vercel frontend and Render
backend. Verify the expected environment-variable names, API base URL,
CORS origin, health-check path, and database/Redis URL requirements.
Do not print secret values. Do not claim deployment is successful unless
the provider confirms it.
```

## 6. Diagnose a database error safely

``` text
Trace the failing operation through the application code and database
functions. Identify the exact statement and permission involved before
recommending a change. Report only the operation/stage and safe error
metadata. Never log connection strings, passwords, password hashes, or
query parameters. Do not grant broad privileges or weaken database
security.
```

## 7. Add focused diagnostic logging

``` text
Make the smallest local-only diagnostic change needed to identify the
failing stage. Log only an allowlisted stage name and safe error code.
Do not log complete error objects, credentials, SQL parameters, or
password hashes. Do not change application behavior, migrations, or
database permissions. Show the diff before running anything.
```

## 8. Review tests and report limitations

``` text
Review the relevant backend and frontend tests. Run only the focused
tests needed for the change, report the exact commands and results, and
identify untested paths. Do not describe a feature as working unless
there is evidence from tests or an end-to-end check.
```

## 9. Prepare a hackathon demo checklist

``` text
Prepare a short judge-facing demo checklist for BalanceVault. Separate
verified functionality from incomplete or unverified functionality.
Include the public repository, live application, key user flows, and
known limitations. Do not invent capabilities or claim production
financial readiness.
```

## AI tools used

-   **ChatGPT:** architecture discussions, technical explanations,
    debugging guidance, deployment troubleshooting, and documentation.
-   **OpenAI Codex in VS Code:** repository inspection, code
    implementation, code review, and focused diagnostics.

## Human review and responsibility

AI suggestions were treated as assistance, not as proof of correctness.
Repository changes, database permissions, deployment settings, and test
results were reviewed separately. Known incomplete functionality is
disclosed in the project submission rather than presented as verified.
