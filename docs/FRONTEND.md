# Frontend authentication and dashboard

The web app uses `VITE_API_BASE_URL` to call the existing API. It provides `/login`, `/register`, `/dashboard`, `/accounts`, `/accounts/:id`, `/statements`, and an `/audit` view for ADMIN and AUDITOR roles. The account list loads permitted accounts and fetches each balance from its account balance endpoint. Account detail loads the account and balance endpoints. Display formatting converts paise with `BigInt` quotient/remainder arithmetic, avoiding floating-point conversion. Dashboard activity and statements use real account statement events; the interface displays the backend's event order and running balances without recalculating or reordering them. The statements page supports account selection and backend cursor pagination. Refused attempts are shown as not posted with the unchanged running balance supplied by the API.

The backend statement event does not expose the journal transaction ID. For that reason, transfer detail links are not inferred from statement references. After a successful transfer, the transaction receipt can open `/transfers/:id` using the returned journal transaction ID; the detail view calls `GET /api/transfers/:id` and shows only the fields and account entries returned by that endpoint. The `/audit` page calls `GET /api/audit?page=…&perPage=…`; the backend restricts it to ADMIN and redacts sensitive metadata before returning it. Frontend role checks only hide or show navigation and are not an authorization boundary.

Administrators see an account creation form that submits to the existing `POST /api/accounts` function. The database and API enforce administrator authorization and validate the holder. A selected account is held in frontend authentication context for future transaction forms; this value is only a UI convenience and does not authorize API access. Account creation refreshes the account list. Future successful money movement actions should call the shared `refreshAccounts()` context action to refresh account views.

## Financial transaction requests

Deposit, withdrawal, and transfer actions call the existing `POST /api/deposits`, `/api/withdrawals`, and `/api/transfers` endpoints. INR input is converted to paise with `BigInt` string arithmetic and sent as a decimal string. The backend remains authoritative for account permissions, balances, and overdraft checks.

Before submission, the user reviews the source, destination, and amount. The client generates one UUID idempotency key for that logical request and stores its key and exact payload in `localStorage` under a key scoped to the current user and transaction type. This pending request data is not an access credential, but it contains account identifiers and amounts and is readable by page JavaScript. It is removed after a confirmed posted or refused response. If the network or server response is uncertain, the UI retains the exact payload/key and permits retrying only that request; it does not silently create a replacement key. A new key is created only after an explicit new transaction or a changed reviewed payload.

`localStorage` is not protected from cross-site scripting. The idempotency key does not authorize an operation; requests still require the bearer token and backend authorization. If the user clears browser storage while a request is uncertain, the client may lose its retry key. The safest response is to check the server-side statement or transaction history before initiating another request.

## Session storage

For this hackathon SPA, the access token, safe user response, and calculated expiry are stored in `sessionStorage`. This keeps a login across reloads in the same tab and clears it when that tab's session ends. The interface clears the session when the stored expiry is reached on initialization or when an API request returns `401`.

`sessionStorage` is readable by JavaScript running on the page. A cross-site scripting flaw could steal the access token. It is not equivalent to an `HttpOnly`, `Secure`, `SameSite` cookie and has no automatic CSRF protection tradeoff. Do not store financial credentials or long-lived refresh tokens there. A production session should move to a server-managed `HttpOnly`, `Secure`, `SameSite` cookie design with appropriate CSRF controls.

The stored role is used only to show or hide navigation. A browser user can change their local storage values, so the backend must remain responsible for every authentication and authorization decision. API requests send the bearer token, and the backend reloads the current active user and role from PostgreSQL.

## Local setup

Set `VITE_API_BASE_URL` to the API origin (for example `http://localhost:3001`) in the root `.env`. Vite exposes only variables with the `VITE_` prefix. Start both apps with `npm run dev`, or start them separately with `npm run dev:api` and `npm run dev:web`.

Registration stores the submitted full name in the account profile. Profile and settings pages allow updating the name, while role, email, and active state remain read-only. Password changes require the current password and return the user to login because all existing JWTs are invalidated.

Account holders may submit a personal or business account-opening request. Administrators review and approve or reject requests. Approval uses a restricted database function that invokes the existing atomic account creator; a browser cannot directly create an account. The administrator user page can activate or deactivate users but cannot change roles. Auditors receive read-only account and audit navigation; all authorization remains enforced by the API.
