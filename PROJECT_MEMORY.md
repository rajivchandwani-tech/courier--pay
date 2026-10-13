# CourierPay project checkpoint

Updated: 2026-10-07

This is the canonical saved CourierPay checkpoint and supersedes older saved checkpoint versions. Continue from the latest production deployment and current workspace files below. Do not restore or deploy an older version over this one unless the user specifically requests a rollback.

Use this file as the continuity checkpoint when continuing work on the CourierPay website. Never add API key values, passwords, OTPs, or other secrets here.

## Current production version

- Production site: https://courierpay-v5-chatbot.vercel.app
- Latest production deployment: `dpl_CcyxrXmCdE2pr7hGZTRkG7PUbGuX`
- Deployment status: READY; Vercel build completed and the production alias was assigned.
- Latest production alias: https://courierpay-v5-chatbot.vercel.app
- Production smoke checks: homepage returned HTTP 200; `/api/ledger` returned an empty `records` list after initializing its database table; harmless `/api/chat` request returned `{"answer":"OK"}`.
- Neon free database resource `courierpay-ledger` is provisioned and connected to Production. `DATABASE_URL` is configured in Vercel as an encrypted environment variable. Its value was not inspected or copied into the workspace.
- Live browser check: Purchase Index shows an empty register and the shared-ledger connected message. The Add Purchase Bill form opens with Blue Dart, Delhivery, Shree Maruti Couriers, and Ekart options and the expected bill, GST/ITC, payment, and notes fields. The form was closed without saving test data. Monthly P&L showed zero totals for October 2026. No page errors appeared in the browser check.
- Direct CRUD across Rajiv and Shalu accounts has not been exercised by creating a real bill, so verify sharing with an authorized second user when a genuine entry is available.
- Final smoke checks: production homepage returned HTTP 200; a harmless POST to `/api/chat` returned `{"answer":"OK"}`.
- Vercel project: `travel-point/courierpay-v5-chatbot` (team `travel-point`).

## Salary WhatsApp notification

- Added an optional WhatsApp number to each salary entry and allowlisted it in the shared ledger API. The phone number is not included in Finance Assistant requests.
- When a salary entry transitions from not fully paid to fully paid, a successful shared save opens a prefilled WhatsApp Web message in the same browser. The operator must review and press Send; the website does not send automatically.
- A WA action remains on fully paid salary rows for popup-blocker fallback or preparing the message again. Open CourierPay in Opera to use the existing Opera WhatsApp session.
- Deployed to production on 2026-10-06 as `dpl_97TtkBYfFYQ5osNnXm1whFtpoMtj` (READY), with the production alias https://courierpay-v5-chatbot.vercel.app. Homepage returned HTTP 200 and the inline JavaScript syntax check passed.
- The staff phone is stored with shared salary rows for authorized users and is excluded from Finance Assistant request snapshots. A real send was not attempted; the user should enter each staff number and use Opera to keep using its logged-in WhatsApp Web session.

## Shared activity alerts and audit log

- Deployed production update on 2026-10-07: `dpl_CcyxrXmCdE2pr7hGZTRkG7PUbGuX` (READY), alias https://courierpay-v5-chatbot.vercel.app.
- Added append-only `courierpay_activity_events` in Neon. Invoice-state changes and activity rows are inserted atomically in the same SQL statement; finance-entry changes/payments/voids also write an event in the same statement as the ledger upsert.
- Activity includes invoice create/update/delete/payment/paid-marker, company-settings changes, courier purchase/salary/utility entries, finance payments, and voided entries. Sensitive customer phone/email, staff WhatsApp number, bank settings, and free-text notes are excluded from event payloads.
- Activity Log shows the transaction/bill date separately from the server record timestamp (India time), identifies this browser vs another browser/device, retains older pages, and updates with in-app alerts every five seconds while the site is open and visible.
- Pre-feature transaction rows are preserved; reliable historical change timestamps were not captured before this release, so the UI explains that exact older timestamps cannot be reconstructed.
- JavaScript/API syntax checks passed; Vercel deployment is READY; read-only `/api/activity` check returned an empty log. No synthetic transaction data was written. Automatic approval review rejected a proposed POST smoke test against production because of possible risk to live finance state; do not retry that production write test without the user's approval.
- Follow-up production check on 2026-10-07 confirmed the production deployment remains READY and the read-only activity endpoint responds successfully with zero events/cursor zero. This is expected immediately after enabling the log. No invoice, finance, app-state, or activity records were written or changed. Let the first genuine business change verify the write path naturally; do not create test transactions in production.

## Purchase and expense ledger deployed

- User approved proceeding with the recommended design: one total per provider bill; accrual monthly P&L; centrally shared records for the authorized users.
- Workspace now has a Purchase Index for Blue Dart, Delhivery (listed once), Shree Maruti Couriers, and Ekart; Salary & Utilities register; and a monthly P&L view.
- P&L basis: invoice base amount on invoice date, excluding output GST; provider bills, salary, utilities on bill/accounting date. GST marked recoverable is excluded from cost. GST amount/treatment is shown separately. Results are a management estimate, not filed accounts.
- New finance rows are in a separate `cp_v5_finance_entries` browser key/API. Existing invoices in `cp_v5_invoices` and seeded invoice values were not altered. Finance rows can be edited, voided (retained but excluded from P&L), searched, and exported to CSV. Purchase bill numbers are required and duplicates are blocked.
- Cloud API is implemented in `api/ledger.js` for Neon Postgres via server-side `DATABASE_URL`. If that variable is absent, the UI warns that local entries are not shared and keeps them in the browser.
- User accepted Neon marketplace terms. A free Neon resource was provisioned for Production in Singapore (`sin1`) with built-in auth disabled, then connected to `travel-point/courierpay-v5-chatbot`.
- Ledger code is deployed and the live API successfully created/read its empty table. The API uses `DATABASE_URL` server-side; never expose or log its value.
- Production account protection was left unchanged. Ensure Shalu uses her authorized Vercel account to access the protected deployment.
- Ledger work modifies `index.html`, `server.js`, `.env.example`, `README.md`, `package.json`, `pnpm-lock.yaml`, `vercel.json`, and adds `api/ledger.js`.

## Cross-device shared data

- User requested invoices, customer contact details, payment history, invoice numbering, and shared company settings be synchronized across authorized browsers and devices to prevent inconsistent books.
- Production now uses `api/app-state.js` and Neon table `courierpay_app_state` for versioned central app state. It shares invoice records/settings/counter, while finance entries remain in `courierpay_finance_entries`. `DATABASE_URL` stays server-side.
- Browser sync runs after startup and every 15 seconds while visible; local changes queue to shared storage. Revision checks prevent stale whole-state replacement. Concurrent edits of one invoice are preserved as a duplicate row; the UI warns about duplicate invoice numbers. Delete tombstones prevent stale devices from restoring old copies.
- The in-app production dashboard was reloaded after deployment and showed `Synced`; existing invoice totals remained visible. It identified existing invoice number `FY/25-26/D01435` on two distinct invoice rows. Both rows are preserved; do not remove or alter them without the user's direction.
- Each other browser/device with historic local-only invoice records must open the updated production URL while online once so those records can merge. Existing rows with ambiguous differing values are preserved and flagged for review.
- OneDrive remains an optional CSV backup; it is no longer described in the interface as the live sync method.

## Chatbot integration

- Gemini is the preferred provider. Production Vercel has a `GEMINI_API_KEY` environment variable configured; only its presence was checked, never its value.
- The key is read server-side in `server.js` and sent to Google's Gemini API in a request header. It is not embedded in client-side code.
- Default model: `gemini-3.5-flash-lite`; temporary-capacity fallback models: `gemini-3.8-flash`, then `gemini-2.5-flash`.
- If continuing chatbot work, preserve this server-side secret handling and verify the deployed `/api/chat` endpoint after changes.
- The final live test succeeded with Gemini returning `OK`.

## Finance Assistant ledger and reports

- Updated the Finance Assistant to refresh the shared invoice and finance ledgers before each answer. If either refresh fails, it asks the user to retry rather than answer from stale local data.
- For each request, the browser sends reduced invoice/payment rows, purchase/salary/utility ledger fields, report summaries, and the question to the configured AI provider. Customer phone/email and company bank settings are excluded; the dashboard discloses the shared fields before use.
- The server prepares deterministic monthly P&L and fiscal-year summaries, including the app's FY Reports figures, purchase/salary/utility cost totals, and a separate operating-profit estimate. Calculations follow documented GST, void, invoice status, and partial-payment rules.
- Latest-dated sale, purchase, salary, utility, and recorded payment activity are included so the assistant can answer recent-log questions without inventing individual payment amounts from cumulative paid-to-date figures.
- Deployed these changes to production on 2026-10-06. Deployment `dpl_5LdihXii4h9JyquYa2qbJgLL8WM2` is READY and aliases include https://courierpay-v5-chatbot.vercel.app.
- Verified the public homepage returned HTTP 200. Verified `/api/chat` through Vercel's authenticated CLI using synthetic invoice and ledger rows; Gemini returned the expected latest purchase, FY expense categories, and monthly P&L estimate. No live finance records were used in the smoke check and no real rows were created or changed.

## Project context and prior requested features

- The site is CourierPay v5, a courier invoice and payment tracking dashboard with a finance assistant.
- Existing work includes customer autocomplete, customer phone/email fields, CSV bulk invoice import, a sample CSV download button on the dashboard, and WhatsApp/email reminder-related UI/workflows.
- The user requested Ledger.cloud invoice integration, automated due-date email reminders from `TRAVELEXPRESS012@GMAIL.COM`, and email-OTP access for Rajiv and staff member Shalu. Treat these as project requirements to verify before claiming complete; this checkpoint does not assert that they are implemented or live.
- Vercel deployment protection is enabled for all deployments. An invitation was previously sent to Shalu's Vercel account; confirm current access if relevant. Do not disable protection without the user's explicit direction.
- User prefers ongoing work to build on this production version and avoid losing the current outcome.

## Workspace safety and deployment

- Project directory: `C:\Users\rajiv\.codex\.chatgpt-projects\g-p-68d812e644f48191acf45d162785ab29`.
- `sources/` is read-only synced reference material. Do not edit, rename, move, or delete files under it.
- Vercel CLI is linked to the production project in this workspace. The user explicitly authorized Vercel CLI deployment in the prior project conversation; continue to protect secrets and deployment access.
- Current production source changes include `server.js`, `.env.example`, `package.json`, and `README.md`; this checkpoint is an additional workspace note.
