# CourierPay v5 with Finance Assistant

This project preserves the uploaded CourierPay v5 application and adds a Finance Assistant tab backed by the Gemini API, with OpenAI and Groq available as alternatives. Provider keys are read by the local Node server and are never placed in browser JavaScript.

## Start

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` in this folder and replace the placeholder with your Gemini API key. Alternatively, set `OPENAI_API_KEY` or `GROQ_API_KEY` instead.
3. From this folder, run `npm start` (or `node server.js`).
4. Open `http://127.0.0.1:3000` in your browser.

No npm packages need to be installed. Do not open `index.html` directly as a file: the chatbot calls the same-origin `/api/chat` endpoint provided by the server.

## Data sent to the assistant

Before answering, the browser refreshes the shared invoice and finance ledgers. For each question it sends the prompt, optional context, reduced invoice/payment details, finance-entry details (including payee, dates, amounts, GST treatment and notes), and deterministic report summaries to the configured AI provider. Customer phone/email and company settings such as bank details are excluded. Do not put passwords, API keys, OTPs, or unrelated personal information in assistant prompts.

The Finance Assistant can answer latest sale/purchase/payment questions, filter ledger entries by date/provider/payee, and explain FY report and monthly P&L totals. The backend calculates report summaries from the supplied records, and the assistant follows the app's stated treatment of GST, voids, paid markers, and partial payments. It refuses a request when shared records cannot be refreshed, rather than answering a latest-activity question from a potentially stale snapshot.

## Purchases, expenses, and monthly P&L

The Purchase Index records one courier-provider bill per entry for Blue Dart, Delhivery, Shree Maruti Couriers, and Ekart. The Salary & Utilities register records actual monthly entries. Each entry keeps the bill date, reference, taxable value, GST treatment/amount, input tax credit flag, due date, amount paid, and notes. Entries are stored separately from invoice records and support edit, void, and CSV export.

Salary entries can optionally store a staff WhatsApp number. When a salary is first marked fully paid and the shared save succeeds, CourierPay opens a prefilled message in WhatsApp Web in the same browser; the user reviews and sends it. Paid salary rows also have a WhatsApp action to prepare the message again. This does not send automatically, and staff should agree to receive these notifications.

Monthly P&L uses an accrual basis: invoice amount excluding output GST is sales on invoice date; courier bills, salaries, and utilities are costs on their bill/accounting dates. Recoverable GST is excluded from expense; GST not claimed as input credit remains in cost. This is a management estimate limited to the records entered here, not a tax return or filed financial statement.

The finance ledger and shared app-state API store data in Neon Postgres through the server-side `DATABASE_URL`. Invoice, customer/contact, payment, and shared company-setting records sync automatically across authorized browsers and devices. Changes sync when online and browsers poll for updates every 15 seconds while visible. A revision check prevents one device from replacing a newer shared snapshot; conflicting edits to the same invoice are retained as two rows and surfaced as a repeated invoice number for review.

## Activity alerts and audit history

Committed invoice creation, edits, deletion, payment entries, purchases, salary/utility entries, expense payments, voids, and settings changes are recorded in the shared append-only activity table with a server timestamp. The Activity Log shows the transaction date separately from the recorded timestamp in India Standard Time, and other open browsers poll for new activity every five seconds and show an in-app alert. The log retains activity history in Neon and supports loading older pages. Changes made before this feature was enabled do not have reliable historic change timestamps; original invoice and bill dates remain available in their registers.

When each browser first opens the updated app, its existing local invoices are merged into the shared database. Open CourierPay on every browser/device that has older local-only records so those records can be included. Distinct records are merged; ambiguous same-ID edits are preserved for review. Deleted invoice IDs are retained as sync tombstones so stale devices do not re-add them. OneDrive CSV export is an additional backup, not the live sync mechanism. If the shared database is unavailable, the app indicates that edits are only on that device until it reconnects.

## Configuration

Set `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `GROQ_API_KEY` in `.env`. Gemini is used when its key is set; otherwise OpenAI is preferred over Groq. Gemini uses `gemini-3.5-flash-lite` by default and tries `gemini-3.8-flash` and `gemini-2.5-flash` if Google reports temporary capacity pressure. Optionally set `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`, `OPENAI_MODEL` (defaults to `gpt-4o-mini`), `GROQ_MODEL`, `DATABASE_URL`, and `PORT`. Keep `.env` private; it is excluded by `.gitignore`.

## Deploy to Vercel

Import this project into Vercel with the project root set to this directory, and add `GEMINI_API_KEY` under Project Settings → Environment Variables for Production (and Preview if desired). Deploy after saving the variable. Vercel serves `index.html` and runs `api/chat.js` as the server-side `/api/chat` function. The key is read only from the server environment.
