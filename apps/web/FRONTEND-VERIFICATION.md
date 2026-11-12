# TransferTrail frontend refresh

## Scope

New graphite-and-violet interface with a compact navigation rail, a centered sign-in screen, selected-account balance panel, account switcher, balance visibility control, contextual activity feed, and restyled account, payment, statement, onboarding, permissions and administration screens. Responsive layouts and reduced-motion support are included.

Only frontend files changed. Backend source, database migrations, root deployment configuration, API request clients, authentication provider, and financial submission/idempotency logic were retained. Existing source filenames are preserved; generated build filenames change normally when Vite rebuilds assets.

The dashboard reads the selected account's balance and latest five statement events from the existing APIs. Its statement action opens the same selected account. No example balances or transaction data are included in the application.

## Validation performed — 12 November 2026

- Production Vite build: passed.
- Frontend Node tests: 14 passed, 0 failed. Includes integer paise, retained idempotency keys, pending attempt restoration, duplicate submission guard, role navigation, statement ordering, API response shapes, bearer authorization, cancellation, 401 handling and uncertain network/5xx errors.
- Existing backend HTTP suite (unchanged): 43 tests; 29 passed, 11 failed, 3 skipped. These use test database adapters, not a real PostgreSQL posting environment. Authentication failures began with unavailable Redis (503), followed by missing-user/token assertions. Backend was not altered to suppress failures.
- Live GET https://balancecashvault.onrender.com/api/health: HTTP 200, healthy.
- Live GET https://balancecashvault.onrender.com/api/ready: HTTP 200, ready.
- Live GET /api/accounts without authorization: HTTP 401.
- Live OPTIONS /api/transfers from https://transfertrail.vercel.app: HTTP 204; origin accepted; Authorization, Content-Type and Idempotency-Key headers allowed.
- Redesigned sign-in page rendered and visually inspected in the preview browser.
- Full dashboard/mobile visual verification is incomplete. An isolated fixture preview encountered a test-harness React resolution issue; the subsequent browser reload was blocked by browser URL security policy. No fixture code, fake session or mock data is included in this archive.

## Limits

Successful health/readiness and preflight checks do not prove authenticated financial posting. No live deposits, withdrawals, transfers, user changes or permission changes were performed. End-to-end PostgreSQL ledger invariants, authentication with Redis, and the full mobile/desktop interaction suite must still be verified in a configured test environment. This is not a security certification.

## Run and deploy

Use the existing root README for PostgreSQL, Redis, environment variables and migration setup. The frontend API client remains configured by VITE_API_BASE_URL, with http://localhost:3001 as its local fallback.

From the project root:

```sh
npm ci
npm run dev:web
npm test -w apps/web
```

For the existing hosted backend:

```sh
VITE_API_BASE_URL=https://balancecashvault.onrender.com npm run build -w apps/web
```

The included apps/web/dist build uses that hosted API URL. Keep the existing Vercel environment variable set to the same API address when rebuilding. The existing production CORS allowlist permits https://transfertrail.vercel.app; a different frontend host may require a separate backend deployment configuration change, which is outside this frontend-only update.

The ZIP does not deploy itself. Deploy the updated frontend to make the new design live.
