# Module spec: finance (Invoicing, credit notes and Billit)

Module id `finance`. Owner paths: `packages/db/src/schema/finance.ts`, `packages/db/src/schema/finance.views.ts`, `packages/core/src/finance/`, `apps/web/modules/finance/` (including `config.ts` for the `finance` settings key), `apps/web/app/(admin)/admin/finance/`, `apps/web/app/[locale]/(portal)/account/invoices/`, `packages/integrations/src/billit/` (Wave 0's platform-P3 ships `index.ts`, `types.ts`, `fake.ts` and `client.ts`, the client throwing `NotImplementedError`; finance-P4 takes over `index.ts`, `types.ts`, `fake.ts` and `client.ts`, cross-module D47), `packages/core/src/i18n/messages/*/finance.json`, `packages/db/src/seed/finance.ts`, `packages/email/src/templates/finance/` (finance owns `templates/finance/`, its props schemas and its `finance.email.*` copy: the four code-backed transactional templates, written with email's `defineTemplate()`; email spec rule 15a and decision 1, cross-module D4), `e2e/finance.spec.ts`. Not owned: email's `defineTemplate()`, layout, renderer and generated registry (`email`); `retention_policies` rows are seeded by `ops`.

Blueprint sections: 41 (Finance and accounting), 42 (Peppol), 43 (Financial management dashboard). Also served here: 10 (portal invoices), 13 and 14 (refunds, receipts, payment status), 24 (company VAT number), 37 (resolve-payment follow-up), 38 (failed payments on the action dashboard), 53 (historical commercial data), 56 (refund issued, data exported in the audit trail), 62 and 63 (retain invoices, drop the marketing profile), 72 (integration failures monitored), 76 ("reporting reflects transaction"), 89 (Finance: transactions, Billit, invoices, payment status, reporting).

## 1. Purpose and release mapping

BEAM issues its own legal invoices and credit notes. A paid order (or an order placed on bank transfer) gets an invoice with a gapless number. A refund gets a credit note. Every document is a frozen snapshot, rendered to PDF, visible in the customer portal, emailed where needed, and pushed to Billit. Billit stays the accounting layer and the Peppol access point. BEAM owns the numbers; invoices are legally valid without Billit.

| Release | What ships in finance |
| --- | --- |
| **V1 (weeks 1-6)** | `invoices`, `invoice_sequences` and the supporting tables of section 2. Invoice on every paid order with a non-zero total, from `commerce` inside the `payments.sync` transaction. Open invoice with due date and Belgian structured communication for bank-transfer orders. Credit notes from refunds (full or partial) and from staff corrections. Gapless numbering per year and kind (`BEAM-2026-000123`, `CN-2026-000045`). VAT per line at 0, 6, 12 or 21 % with `vat_breakdown`. Company invoices with VAT number (B2B, at checkout or by staff). B2C company invoice on request (portal request, staff approval, credit note plus reissue). Customer and seller snapshots. Immutability after issue. PDF into `files` with the seller block from platform's `company` setting and finance's `finance.issuer` setting. Portal invoice list, detail and PDF download. Invoice email with PDF for company invoices and on request. Billit REST client and fake: push customer, push invoice, push credit note, push payment status of documents settled in BEAM, send Peppol for company invoices (mandatory for Belgian VAT-registered buyers since 1 January 2026), store `billit_id`, `billit.sync_pending` every 15 minutes (paid status of bank-transfer invoices, re-queue of stuck pushes, High alert after 1 hour of failure), daily `billit.reconcile` report. Overdue follow-up: `invoice.overdue` event plus a `payment` task for the finance team. Finance back office: overview, invoices, invoice detail with Retry, Billit sync page, company invoice requests, accountant CSV exports (invoices, invoice lines, VAT summary, payments) per period, finance settings summary. Finance section of the ops daily digest (`getFinanceDigest`). Privacy registration, erasure with reduced snapshot, retention sweep handlers for the 10-year accounting horizon (3653 days from 1 January after the fiscal year, then `anonymise`). |
| **Release 2 (weeks 9-10)** | No new finance features. R2 features of other modules (ticketing extensions, guest sharing, abandoned-checkout recovery) invoice through the unchanged `issueInvoice` and `issueCreditNote`; ticket lines carry category `ticket`. No finance build package. |
| **Release 3 (weeks 11-12)** | Finance dashboard (blueprint 43): revenue by category and payment method, open invoices, failed payments, recurring payments, refunds, VAT summary, cash inflow, revenue trends with previous-period comparison. Deferred revenue of unused credits, breakage of expired credits and euro voucher redemptions, on screen and as accountant CSV, read from credits' `v_credit_liability`, `v_credit_movements_monthly`, `v_euro_voucher_redemptions` and `getCreditLiabilityAsOf`. |
| **Release 4 (weeks 13-14)** | Finance KPIs exposed to `ops` for custom dashboards, the weekly management summary and natural-language questions (finance views listed for the read-only `ai` schema). |
| **Later (out of scope)** | "Advanced financial automation" (blueprint priority 4): automatic dunning sequences, bank statement (CODA) import and matching, posting journal entries into accounting software, online VIES validation of VAT numbers, multi-currency, stock and inventory valuation, native Peppol access point, importing historical invoices from Lightspeed or Billit (they stay in Billit). |

## 2. Domain model

All tables live in `packages/db/src/schema/finance.ts`, views in `packages/db/src/schema/finance.views.ts`. Conventions of the architecture apply: `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` on mutable tables, money in integer cents (EUR), `vat_rate_pct numeric(4,2)`. Sensitive columns in the health sense (`sensitive()`): none in this module. Columns holding ordinary personal data are marked **PII** and are covered by `privacy.ts`.

### 2.1 Enums

| Enum (`pgEnum`) | Values |
| --- | --- |
| `invoices_kind` | `invoice`, `credit_note` |
| `invoices_status` | `issued`, `paid`, `open`, `cancelled` |
| `invoices_settled_via` | `provider`, `billit`, `manual`, `credit_note` |
| `invoices_pdf_status` | `pending`, `rendered`, `failed` |
| `invoices_billit_status` | `pending`, `synced`, `failed` |
| `invoices_billit_payment_status` | `not_applicable`, `pending`, `synced`, `failed` |
| `invoices_peppol_status` | `not_applicable`, `pending`, `sent`, `failed` |
| `invoice_requests_status` | `requested`, `approved`, `rejected`, `cancelled` |
| `billit_reconcile_runs_status` | `ok`, `issues`, `failed` |
| `finance_exports_kind` | `invoices`, `invoice_lines`, `vat_summary`, `payments`, `deferred_revenue` (R3), `breakage` (R3), `voucher_redemptions` (R3) |
| `finance_exports_status` | `queued`, `running`, `done`, `failed` |

Status meaning. Invoice: `paid` when settled at issue (Mollie, terminal, cash, euro credit) or later; `open` when issued unpaid on bank transfer; `cancelled` when credit notes cover its full total. An invoice never has status `issued` (check `chk_invoices_status_kind`). Credit note: `issued` at creation; `paid` once the linked refund has been executed (money returned). A correction credit note without a refund stays `issued`; it never becomes `open` or `cancelled`.

Transition table (the only transitions `updateInvoiceState()` accepts; anything else throws `InvalidTransitionError`, mapped to `conflict`). Every row has a test in `invoice-state.test.ts` (finance-P2).

| Kind | From | To | Trigger | Rule |
| --- | --- | --- | --- | --- |
| invoice | (new) | `paid` | `issueInvoice` with `status: 'paid'` | 1 |
| invoice | (new) | `open` | `issueInvoice` with `status: 'open'` (bank transfer) | 2 |
| invoice | `open` | `paid` | Billit reports paid, staff mark paid, or commerce's paid transaction for the order | 26, 27, 26a |
| invoice | `open` | `cancelled` | credit notes reach the full total (cancel unpaid transfer, reissue) | 23, 25 |
| invoice | `paid` | `cancelled` | credit notes reach the full total (full refund, reissue) | 20, 23 |
| credit_note | (new) | `issued` | `issueCreditNote` | 21, 25 |
| credit_note | `issued` | `paid` | `markCreditNoteSettled` (refund executed) | 24 |

`paid` and `cancelled` invoices and `paid` credit notes are terminal. A repeated transition to the current status is a no-op, not an error (idempotent jobs).

### 2.2 `invoices` (IMMUTABLE after issue, column level)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| kind | `invoices_kind` | no | | |
| number | text | no | | unique; `BEAM-<yyyy>-<6 digits>` or `CN-<yyyy>-<6 digits>` |
| fiscal_year | smallint | no | | year of `issued_on` in Europe/Brussels |
| sequence_number | integer | no | | check `> 0` |
| reverses_invoice_id | uuid | yes | | FK `invoices.id`; set only on credit notes |
| replaces_invoice_id | uuid | yes | | FK `invoices.id`; set on a reissued invoice (addition) |
| order_id | uuid | no | | FK `orders.id` (commerce) |
| payment_id | uuid | yes | | FK `payments.id`; settling payment (addition) |
| refund_id | uuid | yes | | FK `refunds.id`; credit notes from refunds (addition) |
| person_id | uuid | yes | | FK `persons.id`; nulled on erasure. PII link |
| company_id | uuid | yes | | FK `companies.id` |
| is_company | boolean | no | `false` | B2B document with buyer VAT number (addition) |
| locale | `locale` (shared enum) | no | | document language (addition) |
| currency | char(3) | no | `'EUR'` | check `= 'EUR'` (addition) |
| customer_snapshot | jsonb | no | | **PII**. `CustomerSnapshot`, section 2.8 |
| seller_snapshot | jsonb | no | | `SellerSnapshot` at issue (platform `company` + `finance.issuer`); refreshable only before the first render, section 2.2 (addition) |
| lines | jsonb | no | | `InvoiceLine[]`, section 2.8; at least one line |
| subtotal_cents | integer | no | | sum of line `net_cents` |
| vat_cents | integer | no | | sum of line `vat_cents`; stored for every document, credit notes included, with the document's sign: negative on credit notes (`chk_invoices_kind_amounts`, `chk_invoices_vat_sign`). Readers that want refunded VAT as a positive amount (ops' `v_revenue_daily` through `refunds.credit_note_id`) use `-vat_cents` |
| total_cents | integer | no | | check `total_cents = subtotal_cents + vat_cents` |
| vat_breakdown | jsonb | no | | `VatBreakdownRow[]` |
| issued_on | date | no | | Brussels date of `issued_at` |
| issued_at | timestamptz | no | `now()` | (addition) |
| due_on | date | yes | | only for `open` invoices |
| status | `invoices_status` | no | | |
| paid_at | timestamptz | yes | | (addition) |
| settled_via | `invoices_settled_via` | yes | | (addition) |
| payment_provider | text | yes | | snapshot of `payments.provider` (`mollie`, `stripe`, `viva`, `cash`, `terminal`, `bank_transfer`, `credit_balance`); `mixed` when more than one paid payment settles the order (addition) |
| payment_method | text | yes | | snapshot: `bancontact`, `creditcard`, `terminal`, `cash`, `bank_transfer`, `voucher` (provider `credit_balance`, i.e. euro credit), `mixed` (addition) |
| payment_transaction_ref | text | yes | | snapshot of `payments.provider_payment_id` (`tr_...`) or the bank reference recorded by staff; printed on the PDF as "Transaction reference" (blueprint 13) (addition) |
| payment_reference | text | yes | | Belgian structured communication `+++260/0000/12395+++` for bank transfer (addition) |
| reason | text | yes | | mandatory on credit notes (addition) |
| pdf_file_id | uuid | yes | | FK `files.id` |
| pdf_status | `invoices_pdf_status` | no | `'pending'` | (addition) |
| emailed_at | timestamptz | yes | | last invoice email sent (addition) |
| billit_id | text | yes | | unique; Billit order id |
| billit_status | `invoices_billit_status` | no | `'pending'` | |
| billit_synced_at | timestamptz | yes | | |
| billit_attempts | integer | no | `0` | (addition) |
| billit_last_error | text | yes | | no personal data (addition) |
| billit_failed_since | timestamptz | yes | | first failure of the current streak (addition) |
| billit_payment_status | `invoices_billit_payment_status` | no | `'not_applicable'` | payment registration in Billit for documents settled in BEAM (rule 30a) (addition) |
| peppol_status | `invoices_peppol_status` | no | `'not_applicable'` | (addition) |
| issued_by | jsonb | no | | actor `{kind, id}` (addition) |
| created_at, updated_at | timestamptz | no | `now()` | |

Checks:
- `chk_invoices_kind_amounts`: `(kind = 'invoice' and total_cents >= 0 and subtotal_cents >= 0) or (kind = 'credit_note' and total_cents <= 0 and subtotal_cents <= 0)`. Credit notes store negative amounts and negative line quantities.
- `chk_invoices_vat_sign`: `(kind = 'invoice' and vat_cents >= 0) or (kind = 'credit_note' and vat_cents <= 0)`.
- `chk_invoices_reverses`: `(kind = 'credit_note') = (reverses_invoice_id is not null)`.
- `chk_invoices_reason`: `kind = 'invoice' or length(trim(reason)) >= 3`.
- `chk_invoices_open_due`: `status <> 'open' or (kind = 'invoice' and due_on is not null)`.
- `chk_invoices_paid_at`: `status <> 'paid' or paid_at is not null`.
- `chk_invoices_number_prefix`: `number like case kind when 'invoice' then 'BEAM-%' else 'CN-%' end`.
- `chk_invoices_status_kind`: `(kind = 'invoice' and status in ('paid','open','cancelled')) or (kind = 'credit_note' and status in ('issued','paid'))`.
- `chk_invoices_party`: `person_id is not null or company_id is not null or coalesce((customer_snapshot->>'is_reduced')::boolean, false) or coalesce((customer_snapshot->>'anonymised')::boolean, false) or coalesce(customer_snapshot->>'kind' = 'walk_in', false) or coalesce(customer_snapshot->>'kind' = 'company' and nullif(btrim(customer_snapshot->>'vat_number'), '') is not null, false)` (anonymous POS sale, rule 14a; `anonymised` is the form left by the `finance.invoices` retention sweep, rule 45; a `company` snapshot with a VAT number is a company known only from billing details, a POS company sale invoiced under the Billit party `vat:<number>`, fix-w20-finance-wiring).

Wave 0 stub. Wave 0 already created `invoices` and `invoice_sequences` with the architecture's columns. finance-P1 adds the columns marked "(addition)" and the checks and indexes, and leaves every existing column's type, nullability and default exactly as Wave 0 wrote it (frozen contract columns). Where this table states a stricter nullability for an architecture column (for example `order_id not null`), finance-P1 enforces it with a check constraint instead of altering the column, and notes it in the PR description.

Indexes and constraints:
- unique `number`; unique `(kind, fiscal_year, sequence_number)`; unique `billit_id` (nulls allowed).
- partial unique `uq_invoices_order_live` on `(order_id)` where `kind = 'invoice' and status <> 'cancelled'`: one live invoice per order.
- partial unique on `(refund_id)` where `refund_id is not null`: one credit note per refund.
- partial unique on `(payment_reference)` where `payment_reference is not null`.
- `ix_invoices_issued_on (issued_on, kind)` for period lists, exports and dashboards.
- `ix_invoices_person (person_id, issued_at desc)`; `ix_invoices_reverses (reverses_invoice_id)`; `ix_invoices_order (order_id)`.
- partial `ix_invoices_open (due_on)` where `status = 'open'`.
- partial `ix_invoices_billit_backlog (billit_status, created_at)` where `billit_status <> 'synced'`.
- partial `ix_invoices_pdf_pending (created_at)` where `pdf_status <> 'rendered'`.
- No trigram index. Search is by exact number or `ilike` on `customer_snapshot->>'name'` inside a period filter; at BEAM's volume (under 20,000 documents a year) the period index is enough.

Immutability. After insert only these columns may change: `status` (per the transition table of 2.1), `paid_at`, `settled_via`, `pdf_file_id`, `pdf_status`, `emailed_at`, `billit_*` (including `billit_payment_status`), `peppol_status`, `updated_at`; `payment_id`, `payment_provider`, `payment_method` and `payment_transaction_ref` only from null to a value, when an `open` invoice is settled; `seller_snapshot` only while no PDF was ever rendered and the document is not in Billit (`pdf_status <> 'rendered' and billit_id is null`), which lets a document issued before the company settings were complete pick up the completed seller block when it is re-rendered (edge case 16), before anyone has received it; and, only under `SET LOCAL beam.allow_rewrite = 'on'` (erasure, retention), `person_id` (to null) and `customer_snapshot` (to the reduced form), plus, for the `finance.invoices` retention sweep only (rule 45), `company_id` (to null), `customer_snapshot` (to `{ "anonymised": true }`) and `pdf_file_id` (to null, the PDF file deleted). Deletes are refused except under `beam.allow_rewrite` by the retention hook. Enforced twice: in code by `updateInvoiceState()` (the only writer, which takes a typed `InvoiceMutableFields` object), and in the database by trigger `invoices_guard_immutable()` in the custom migration `finance_invoices_guard.sql`, which the orchestrator adds with `drizzle-kit generate --custom` (packages never write migrations). The trigger compares `OLD` and `NEW` for every other column and raises `invoice_immutable`.

### 2.3 `invoice_sequences`

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| kind | `invoices_kind` | no | | |
| year | smallint | no | | check `year between 2026 and 2100` |
| last_number | integer | no | `0` | check `last_number >= 0` |
| created_at, updated_at | timestamptz | no | `now()` | |

Unique `(year, kind)`. Allocation (inside the issuing transaction): `insert into invoice_sequences (year, kind) values ($1, $2) on conflict (year, kind) do nothing`; `select last_number from invoice_sequences where year = $1 and kind = $2 for update`; `update ... set last_number = last_number + 1, updated_at = now()`. The new number is `last_number + 1`. A rolled-back transaction rolls the counter back, so numbers stay gapless. Rows are never deleted.

### 2.4 `order_billing_details` (addition)

Billing identity chosen at checkout or by staff, read when the invoice is issued.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| order_id | uuid | no | | FK `orders.id`, unique |
| is_company | boolean | no | `false` | |
| legal_name | text | no | | **PII** when it is a person's name; check `length(trim(legal_name)) >= 2` |
| vat_number | text | yes | | normalised `BE0123456789`; required when `is_company` |
| address | jsonb | no | | **PII**. `{ line1, line2?, postal_code, city, country }` (ISO 3166-1 alpha-2) |
| billing_email | text | yes | | **PII**; invoice email recipient |
| purchase_order_ref | text | yes | | buyer's PO number, printed on the PDF |
| peppol_id | text | yes | | e.g. `0208:0123456789`; derived from a BE VAT number when empty |
| created_at, updated_at | timestamptz | no | `now()` | |

Check `chk_obd_company_vat`: `not is_company or vat_number is not null`.

### 2.5 `invoice_requests` (addition): B2C "company invoice on request"

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| invoice_id | uuid | no | | FK `invoices.id` (the B2C invoice to reissue) |
| person_id | uuid | yes | | FK `persons.id`; requester. PII link |
| billing | jsonb | no | | **PII**. `BillingDetails` (same shape as 2.4) |
| status | `invoice_requests_status` | no | `'requested'` | |
| decided_by_user_id | uuid | yes | | FK `users.id` |
| decided_at | timestamptz | yes | | |
| decision_note | text | yes | | shown to the customer on rejection |
| credit_note_id | uuid | yes | | FK `invoices.id` |
| new_invoice_id | uuid | yes | | FK `invoices.id` |
| created_at, updated_at | timestamptz | no | `now()` | |

Partial unique `(invoice_id)` where `status = 'requested'`. Index `(status, created_at)`.

### 2.6 `billit_parties` (addition): our customers as Billit parties

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | `gen_random_uuid()` | PK |
| party_key | text | no | | unique; `person:<uuid>`, `company:<uuid>`, `vat:<BE0123456789>` (billing details with a VAT number but no CRM company) or `walk_in` (the one shared party for anonymous POS sales, rule 14a) |
| person_id | uuid | yes | | FK `persons.id`; nulled on erasure |
| company_id | uuid | yes | | FK `companies.id` |
| billit_party_id | text | yes | | unique; null until first successful push |
| snapshot_hash | text | yes | | sha256 of the last pushed party payload; skips identical pushes |
| synced_at | timestamptz | yes | | |
| last_error | text | yes | | |
| is_anonymised | boolean | no | `false` | |
| created_at, updated_at | timestamptz | no | `now()` | |

### 2.7 `billit_reconcile_runs` (addition) and `finance_exports` (addition)

`billit_reconcile_runs`: id, run_on date not null unique, started_at timestamptz not null, finished_at timestamptz, status `billit_reconcile_runs_status` not null, checked_count integer not null default 0, issues_count integer not null default 0, issues jsonb not null default `'[]'` (`ReconcileIssue[]`: `{ invoice_id?, number?, billit_id?, type: 'missing_in_billit'|'unknown_in_billit'|'amount_mismatch'|'paid_mismatch'|'sequence_gap'|'stale_pending'|'pdf_missing', detail }`, no personal data), created_at, updated_at. A re-run on the same day upserts on `run_on`.

`finance_exports`: id, kind `finance_exports_kind` not null, period_from date not null, period_to date not null (check `period_to >= period_from` and at most 366 days apart), status `finance_exports_status` not null default `'queued'`, file_id uuid FK `files.id`, row_count integer, error text, requested_by_user_id uuid not null FK `users.id`, created_at, updated_at. Index `(created_at desc)`. The CSV holds customer names, so files are `kind = 'export'` with `expires_at = now() + 7 days` and `person_id = null`.

### 2.8 JSON shapes (Zod in `packages/core/src/finance/types.ts`)

```ts
type Address = { line1: string; line2?: string; postal_code: string; city: string; country: string };
type CustomerSnapshot = {
  kind: 'person' | 'company' | 'walk_in'; name: string; // legal name for companies, full name for persons,
                                                        // "Walk-in customer" (finance.pdf.walk_in, document locale) for anonymous POS sales
  email: string | null; phone: string | null;           // removed in the reduced form
  address: Address | null; vat_number: string | null; peppol_id: string | null;
  purchase_order_ref: string | null; person_id: string | null; company_id: string | null;
  is_reduced: boolean;                                  // true after erasure
} | { anonymised: true };                               // after the finance.invoices retention horizon (rule 45, cross-module D34)
type InvoiceLine = {
  order_line_id: string; product_id: string; sku: string;
  category: 'session' | 'night' | 'package' | 'membership' | 'ticket' | 'item' | 'voucher'; // products.kind
  description: string;                                  // in the document locale
  description_i18n: LocalizedText;                      // order_lines.description snapshot
  quantity: number;                                     // negative on credit notes
  unit_amount_cents: number;                            // VAT included
  discount_cents: number; discount_label: string | null;
  line_total_cents: number;                             // gross, VAT included
  vat_rate_pct: 0 | 6 | 12 | 21; vat_cents: number; net_cents: number;
  vat_note: string | null;                              // printed for 0 % lines
  credit_kind: 'day' | 'night' | 'euro' | null; credit_units: number | null;
  session_starts_at: string | null;                     // ISO, for session, night and ticket lines
};
type VatBreakdownRow = { vat_rate_pct: 0 | 6 | 12 | 21; net_cents: number; vat_cents: number; gross_cents: number };
```

`seller_snapshot` is `SellerSnapshot` (section 8): legal name, trade name, VAT number, enterprise number, address (`{ street, postal_code, city, country }`), support email, phone and website from platform's `company` setting, plus register court, IBAN, BIC and the footer text in the document locale from finance's `finance.issuer` setting.

### 2.9 Views (`finance.views.ts`, Drizzle `pgView` with `sql`)

V1:
- `v_invoice_balances`: per invoice of kind `invoice`: `invoice_id, total_cents, credited_cents` (= `-coalesce(sum(cn.total_cents), 0)` over credit notes with `reverses_invoice_id = i.id`), `remaining_cents = total_cents - credited_cents`, `is_fully_credited = remaining_cents = 0`.
- `v_finance_invoice_lines`: one row per document line: `select i.id invoice_id, i.number, i.kind, i.issued_on, i.status, i.payment_method, i.is_company, l.* from invoices i cross join lateral jsonb_to_recordset(i.lines) as l(order_line_id uuid, product_id uuid, sku text, category text, description text, quantity numeric, unit_amount_cents int, discount_cents int, line_total_cents int, vat_rate_pct numeric, vat_cents int, net_cents int, credit_kind text, credit_units int)`.
- `v_finance_vat_summary`: `date_trunc('month', issued_on)::date as month`, `extract(quarter from issued_on) as quarter`, `fiscal_year`, `kind`, `vat_rate_pct`, `sum(net_cents)`, `sum(vat_cents)`, `sum(line_total_cents)`, from `v_finance_invoice_lines`, grouped.
- `v_finance_open_invoices`: invoices with `status = 'open'`: id, number, person_id, customer name, total, `amount_due_cents` (= `remaining_cents` from `v_invoice_balances`, so a partial credit lowers what is owed), due_on, `days_overdue = greatest(0, (now() at time zone 'Europe/Brussels')::date - due_on)`, payment_reference, billit_status.
- `v_finance_billit_backlog`: invoices with `billit_status <> 'synced'`: id, number, kind, billit_status, billit_attempts, billit_last_error, `age_minutes`, `failing_minutes = extract(epoch from now() - billit_failed_since) / 60`.

R3 (added by finance-P8; finance-P9 adds no view):
- `v_finance_revenue_daily`: from `v_finance_invoice_lines`: `issued_on as day, category, payment_method, vat_rate_pct, sum(net_cents), sum(vat_cents), sum(line_total_cents), count(distinct invoice_id)`; credit notes included with their negative amounts, so the sum is net revenue. Category `voucher` is reported separately (a liability, not revenue).
- `v_finance_cash_inflow_daily`: union of `payments` with `status in ('paid','refunded','partially_refunded')` (`paid_at::date` in Brussels, provider, method, `amount_cents` as inflow) and credit notes with `status = 'paid'` (`paid_at`, `payment_method`, `-total_cents` as outflow).
- `v_finance_failed_payments`: `payments` with `status in ('failed','expired')` per Brussels day and method (count, amount), plus `memberships` in `past_due` (count).
- `v_finance_recurring_monthly`: invoices whose order has `channel = 'recurring'`, per month: count and gross; plus a scalar subquery of active memberships.
- No finance view over the credits ledger. Deferred revenue and breakage (R3) read credits' own views and function, which credits provides for exactly this purpose (credits rules 65, 66): `v_credit_liability` (closing liability today, per credit kind, `vat_treatment` and rate), `getCreditLiabilityAsOf(db, at)` (the same liability at a past instant, for month close), `v_credit_movements_monthly` (per Brussels month, kind, `vat_treatment`, rate and entry kind: units and `value_cents` at the unit value sold, VAT included; `consume` minus `release` = recognised, `expire` = breakage, `revoke` = reversed by refunds) and `v_euro_voucher_redemptions` (every euro spend with order id, amount and `is_reversed`). Finance only splits gross into net and VAT (`computeLineVat` with the row's `vat_rate_pct`; rows with `vat_treatment = 'multi_purpose'` count rate 0, because VAT on a euro voucher is charged on the redemption sale) and joins voucher redemptions to the invoice of their order for the accountant.

Tables of other modules this module reads: `orders`, `order_lines`, `payments`, `refunds`, `products` (commerce); `persons`, `companies` (crm); `memberships`, `v_credit_liability`, `v_credit_movements_monthly`, `v_euro_voucher_redemptions` and `getCreditLiabilityAsOf` (credits; finance does not query `credit_grants` or `credit_entries` directly); `settings`, `files`, `jobs`, `integration_calls` (platform); `retention_policies` (ops). It writes other modules' tables only through their `api.ts`: `files` (platform `storeFile`), `activity_events` (`recordEvent`), `audit_log` (`audit`), `jobs` (`enqueue`), `email_messages` (email `sendTransactional`), `tasks` (crm `createTask`), `payments`/`orders` (commerce `recordBankTransferPaid`). It never writes `settings`: the `finance` key is edited through platform's generic settings editor (`updateSetting`), section 8.

## 3. Business rules

Issuing
1. Every order that reaches `paid` with `total_cents > 0` has exactly one live invoice. `commerce` calls `issueInvoice` inside the same transaction that marks the order paid. `issueInvoice` first locks the order's invoices (`select ... from invoices where order_id = $1 and kind = 'invoice' for update`). When any invoice of kind `invoice` already exists for the order (live or `cancelled`), it returns the newest one (`status: 'existing'`) and issues nothing: a new invoice for an order whose invoice was cancelled comes only from the reissue path (rule 20, `replaces_invoice_id`). This makes a late or repeated `payments.sync` after a full refund harmless.
2. An order placed with payment provider `bank_transfer` (POS or staff B2B order) gets its invoice at placement with `status = 'open'`, `due_on = input.dueOn` (commerce passes the bank-transfer payment's `expires_at` date, from `settings.commerce.bank_transfer_due_days`, default 14) or, when absent, `issued_on + settings.finance.payment_terms_days` (default 14), and a `payment_reference`. Commerce and finance therefore show the same due date.
2a. When commerce's paid transaction calls `issueInvoice` with `status: 'paid'` for an order whose invoice is `open` (the transfer was reported by Billit or by staff on the invoice, both of which reach commerce only through `commerce.recordBankTransferPaid`, rules 26 and 27), finance settles that invoice instead of issuing a second one: `status = 'paid'`, `paid_at = input.paidAt ?? ctx.now`, `settled_via = input.settledVia ?? 'manual'`, payment snapshot columns filled from `input.paymentId`; it returns `existing`. Settling an invoice that is already `paid` is a no-op.
3. Orders with `total_cents = 0` get no invoice; `issueInvoice` returns `{ status: 'skipped', reason: 'zero_total' }`. A free supply has no consideration, so Belgian VAT law requires no invoice, and free lead-magnet tickets would otherwise flood Billit with zero documents. Commerce's edge case 10 ("invoice with total 0 still issued") is superseded by this rule; the order, its credits and its bookings work as usual.
4. Credits consumed at booking are not sales and are never invoiced; VAT was charged when the package was sold (architecture section 6).
5. Invoice lines are copied 1:1 from `order_lines` (description, quantity, unit amount, discount, line total, VAT rate, VAT cents). Finance never re-prices; the invoice total equals `orders.total_cents`, or issuing fails with `conflict` and the paid transaction rolls back.
6. VAT per line: `vat_cents = round_half_up(line_total_cents * rate / (100 + rate))`, `net_cents = line_total_cents - vat_cents`, computed by `computeLineVat()` in `packages/core/src/finance/vat.ts`, identical to `commerce` pricing. `vat_breakdown` groups lines by rate, sorted by rate ascending, sums of line values (never recomputed from totals). Allowed rates are exactly 0, 6, 12, 21.
7. A 0 % line must carry a `vat_note`, taken from `settings.finance.vat_notes[category]` in the document locale (for example multi-purpose voucher: "VAT due on redemption"). Issuing a 0 % line without a configured note fails with `validation`.
8. Gift vouchers (`category = 'voucher'`, credit kind `euro`, commerce check `vat_rate_pct = 0`) are multi-purpose vouchers: the sale is invoiced at 0 % with the voucher note; an order paid with euro credits (payment provider `credit_balance`) is invoiced normally with VAT per line and `payment_method = 'voucher'`, because VAT on a multi-purpose voucher is due at redemption (credits rule 65, commerce rule 24). An order paid partly with euro credits and partly by Mollie (or terminal, cash) gets `payment_method = 'mixed'` and `payment_provider = 'mixed'`. Euro credit is a means of payment, never a discount: the invoice lines, `vat_breakdown` and `total_cents` are exactly those of the order, and the credit amount appears only in the payment block of the PDF ("Paid with euro credit" plus the other method, amounts from the order's paid `payments` rows).
8a. Billit mapping of euro-credit orders (`toBillitOrder`, section 6): the order lines go to Billit with their own VAT rates and amounts (no negative line, no discount for the credit, so Billit's VAT base equals ours); the document is created with `Paid = true`, `PaidDate` and `PaymentMethod` mapped from `payment_method` through `BILLIT_PAYMENT_METHOD` (section 6: `voucher` -> Billit's voucher code, `mixed` -> the method of the largest non-`credit_balance` payment), and `Comments` lists the split per provider ("Euro credit 30.00 EUR; Bancontact 70.00 EUR"). A credit note whose refund went back to euro credit (commerce rule 38) is registered as paid in Billit with the voucher method when the refund is settled (rule 30a). The voucher sale itself stays a 0 % line with the multi-purpose note (rule 7).

Numbering
9. Numbers are per kind and per fiscal year: `BEAM-<yyyy>-<NNNNNN>` for invoices, `CN-<yyyy>-<NNNNNN>` for credit notes, six digits zero-padded, starting at 000001 each year. `formatNumber(kind, year, n)` is the only formatter.
10. The fiscal year is the calendar year of `issued_on` in Europe/Brussels. An invoice issued at 2026-12-31T23:30Z is `BEAM-2027-000001`.
11. Numbers are gapless: allocation happens in the issuing transaction with `SELECT ... FOR UPDATE` on `invoice_sequences` (section 2.3). An aborted transaction leaves no gap. Invoices are never deleted inside the retention period.
12. Within one year and kind, a higher number never has an earlier `issued_at`. Backdating is not possible: `issued_on` is always today in Brussels.
13. The daily reconcile asserts for every (year, kind) of the current and the previous fiscal year (older years are closed and may later be swept): `count(invoices) = last_number` and the numbers are exactly `1..last_number`; any difference is a `sequence_gap` issue and a High alert.

Snapshots and immutability
14. At issue the invoice stores `customer_snapshot` (from `order_billing_details` when present, else the CRM company when `orders.company_id` is set, else the person) and `seller_snapshot` (platform `company` plus `finance.issuer`). Later edits to the person, company or settings never change an issued invoice or its PDF.
14a. An anonymous POS sale (commerce allows it for items and vouchers only, `orders.person_id` and `company_id` null) gets `customer_snapshot = { kind: 'walk_in', name: <"Walk-in customer" in the document locale>, address: null, ... }` and `locale = nl-BE`. Its invoice records no activity event (there is no subject) and gets no personal Billit party: it is pushed under one shared Billit party with `party_key = 'walk_in'` created on first use.
15. After issue only the columns listed in section 2.2 change. Corrections are always a credit note, optionally followed by a reissued invoice.
16. The document locale is `persons.locale` (or `orders.locale` when there is no person) when every line has a description in that locale; otherwise `nl-BE` for the whole document. A document is never mixed-language. This is the one deliberate exception to the architecture's "no fallback language" rule (section 5), which governs emails and screens: an invoice is a legal document that must exist the moment money is taken, and its frozen line snapshot cannot be repaired later. Products cannot be activated without all three locales (commerce rule 1), so the case only arises for imported or legacy lines; each occurrence is logged (`logger.warn({ invoiceId, missingLocale })`) and counted in the finance digest line "Invoices rendered in nl-BE fallback".

Company invoices (B2B) and invoices on request (B2C)
17. A company invoice requires legal name, address and a VAT number. Belgian numbers are normalised to `BE` + 10 digits and must pass the mod-97 check (`97 - (first 8 digits mod 97) = last 2 digits`); other EU numbers must match their country format (regex table in `vat-number.ts`). No VIES call in V1.
18. Company invoices show unit prices and line amounts excluding VAT plus the breakdown; consumer invoices show amounts including VAT plus the breakdown. Both print the seller VAT number, enterprise number, register court, address and IBAN.
19. Belgian VAT applies to every line; there is no reverse charge (BEAM's services are supplied at its premises in Belgium).
19a. Belgian structured e-invoicing (Peppol) is mandatory for B2B invoices and credit notes between Belgian VAT-registered businesses since 1 January 2026. Every company document whose buyer VAT number starts with `BE` is therefore sent over Peppol through Billit (rule 33); a PDF email to such a buyer is a courtesy copy, not the legal invoice. Company documents for buyers outside Belgium go over Peppol when Billit finds the receiver, else by email with PDF.
20. A customer may ask for a company invoice for one of their own B2C invoices within `settings.finance.company_request_window_days` (default 30) of `issued_on`, once per invoice while a request is pending. Staff with `invoices.issue` approve or reject. Approval issues, in one transaction, a full credit note (reason "Reissued to company") and a new invoice with the company snapshot, `replaces_invoice_id` set, the same lines, payment and settlement; the original becomes `cancelled`. Staff can reissue at any time with the same action.

Credit notes and refunds
21. A refund in `commerce` creates exactly one credit note through `issueCreditNote` in the same transaction (one per `refund_id`). Full refund: all lines negated. Partial refund: the listed lines with quantity or amount; VAT is recomputed per credited line with the line's rate. Line arithmetic (`creditLines()` in `packages/core/src/finance/lines.ts`):
   - By quantity `q` of a line with quantity `Q` and gross `G`: credited gross = `round_half_up(G * q / Q)`, except that the credit which brings the line's credited quantity to `Q` takes exactly the remainder, so a line credited in parts sums to `G` to the cent. The credit line has `quantity = -q` and the original `unit_amount_cents`; any discount is prorated by the same formula.
   - By amount `a`: a line with `quantity = -1`, `unit_amount_cents = a`, `discount_cents = 0`, description prefixed with the `finance.pdf.partial_credit` label, same rate.
22. The sum of credit notes of an invoice can never exceed the invoice total, per line and in total (checked under `SELECT ... FOR UPDATE` on the invoice row). Exceeding fails with `conflict`.
23. When credit notes cover the full total, the invoice becomes `cancelled`; an `open` invoice fully credited stops being collected. A partial credit on an `open` invoice lowers `amount_due_cents` (view `v_finance_open_invoices`); Billit receives the credit note, and the settlement check of rule 26 compares Billit's paid amount with the remaining amount.
24. A credit note becomes `paid` (with `paid_at`) when `commerce` reports the refund executed via `markCreditNoteSettled`. A correction credit note without money returned stays `issued`.
25. Staff may issue a manual credit note without a refund only with `invoices.issue`, a reason of at least 3 characters, and either on an `open` invoice (partial correction of an unpaid bank transfer) or with the explicit flag `noRefund: true` (correction or reissue). Cancelling an unpaid bank-transfer order entirely always goes through commerce's `cancelOrder` (commerce rule 22b, edge 26), which calls `issueCreditNote({ orderId, reason, noRefund: true })` in its transaction, so the order, its bookings, its euro credit and its invoice are cancelled together. Both entry points reach it: the commerce order screen, and finance's own manual credit note dialog. When `issueManualCreditNote` would fully credit an `open` invoice (no `lines`, or lines covering `amount_due_cents`), the action does not issue the credit note itself: it calls `commerce.cancelOrder(tx, ctx, { orderId: invoice.order_id, reason })` in its transaction and returns the credit note that commerce's call created (found by `reverses_invoice_id`). When commerce returns `{ cancelled: false }` (the order is not cancellable, for example a provider payment in progress; `cancelOrder` never throws for that, cross-module D31), the action fails with `finance.errors.order_not_cancellable` and nothing is written. A partial manual credit on an `open` invoice stays a finance-only credit note (the order stays `pending_payment` for the remaining amount).

Settlement of bank-transfer invoices
26. `billit.sync_pending` reads Billit's paid status for every `open` invoice with a `billit_id`. When Billit reports it paid for at least `amount_due_cents`, the invoice becomes `paid` (`settled_via = 'billit'`, `paid_at` = Billit's paid date at 12:00 Brussels) and, in the same transaction, `commerce.recordBankTransferPaid(tx, ctx, { orderId, paidOn, reference: <invoice number> })` runs commerce's paid transaction (credits, membership, bookings follow in commerce; its `issueInvoice` call then returns `existing` per rule 2a).
27. Staff can mark an `open` invoice paid manually (`settled_via = 'manual'`, mandatory date and note, audited); the action calls `commerce.recordBankTransferPaid` the same way. Commerce has no "Record bank transfer" button; its order screen links to the finance invoice (cross-module D32). Whichever path comes first wins; a later Billit "paid" or a second staff action for the same invoice is a no-op.
28. A partial payment reported by Billit leaves the invoice `open` and appears in the reconcile report as `paid_mismatch`.
29. `finance.scan_overdue` emits `invoice.overdue` once per invoice (dedupe `invoice:<id>:overdue`) when `days_overdue >= 7`, and creates one `payment` task through `crm.createTask` (title "Follow up overdue invoice <number>", priority `high`, `dueAt` = next business day (Monday to Friday) 10:00 Brussels, `ownerRole: 'finance'` (crm resolves the first active user of that role, else the owner), `source: 'system'`, `ref: { type: 'invoice', id }`, `personId` or `companyId` of the invoice, `dedupeKey = invoice:<id>:overdue_task`) (blueprint 37). The ops action dashboard lists overdue invoices from `v_finance_open_invoices`. A staff payment reminder can be sent at most once per 7 days per invoice. Completing the task changes nothing in finance; paying the invoice does not close the task automatically.

Billit
30. Every issued document is pushed to Billit with our number as Billit's order number and external reference. Billit is never the source of numbers.
30a. Payment status flows both ways (blueprint 41 "synchronise payment status"). A document that is already `paid` when pushed is created in Billit with `Paid = true` and `PaidDate`, so `billit_payment_status = 'synced'` at push. A document that becomes `paid` in BEAM after its push (staff mark paid, which also calls `commerce.recordBankTransferPaid`; a refund executed for a credit note) gets `billit_payment_status = 'pending'` and the job `billit.push_payment` (key `billit:payment:<invoice_id>`) registers the payment in Billit. Documents settled by Billit itself (`settled_via = 'billit'`) are `not_applicable`. Open documents stay `not_applicable` until paid.
31. Before any create call the push job re-reads `billit_id`; when it is null it calls `findOrderByReference(number)` first, so a lost response never creates a duplicate. `billit_id` is committed before any follow-up call (Peppol send).
32. A credit note is pushed only after its original invoice is `synced`; otherwise the job retries and enqueues the original's push.
33. Company invoices and credit notes with a VAT number are sent over Peppol by Billit after a successful push (`peppol_status` `pending` then `sent`). Consumer documents are `not_applicable`. Peppol stays entirely in Billit. When Peppol delivery fails for a `BE` buyer (receiver not found or rejected), `peppol_status = 'failed'`, one High Slack alert "Peppol delivery failed for <number>" is raised, a `follow_up` task "Fix Peppol delivery <number>" is created as in rule 29 (`ownerRole: 'finance'`, `dedupeKey = invoice:<id>:peppol_task`), and the courtesy PDF email is still sent. Staff correct the buyer's Peppol id in Billit and resend there, or reissue (credit note plus new invoice) with corrected billing details. For non-`BE` buyers a failed Peppol lookup is not an error: the email with PDF is the delivery, the detail page says "Sent by email, receiver not on Peppol".
34. While `settings.finance.billit_enabled = false` (local and preview without sandbox keys), push jobs succeed without calling Billit and leave `billit_status = 'pending'`; nothing is lost when it is switched on, because `billit.sync_pending` re-queues pending documents. `settings.finance.peppol_enabled = false` skips `billit.send_peppol` outside production only: in `APP_ENV = production` the Zod schema of the `finance` key refuses `false`, because rule 19a makes Peppol a legal obligation.
35. A document failing to sync for 60 minutes (`settings.finance.alert_after_minutes`) raises one High Slack alert per invoice per hour; the finance screen shows the backlog with Retry. Invoices remain legally valid while unsynced.

PDF and delivery
36. Each document gets one PDF rendered from its snapshots only (`files.kind = 'invoice_pdf'`, `files.person_id = null`, name `<number>.pdf`). An existing rendered PDF is never replaced; rendering again is allowed only when `pdf_status = 'failed'` or the file is missing, and never for a document anonymised by the `finance.invoices` retention sweep (rule 45), whose PDF was deleted on purpose.
37. The PDF never prints email or phone; it shows the seller block, buyer name and address (plus VAT number and PO reference for companies), number, issue date, due date and structured communication when open, lines, breakdown, totals, payment status, and for credit notes "Credit note for invoice <number>" and the reason.
38. Invoice email (template key `finance.invoice`, PDF attached): sent automatically for company invoices, for open bank-transfer invoices and for reissued invoices; a credit note email (`finance.credit_note`, PDF attached) for every credit note that has an email recipient. Payment reminders use `finance.invoice_reminder` and decisions on company invoice requests use `finance.company_request_decided`. All four are finance's own code-backed templates (section 8). Consumer receipts for paid orders are sent by `commerce` and link to the portal invoice; no second email.
39. The recipient is `order_billing_details.billing_email`, else the person's email. A missing recipient skips the email and leaves `emailed_at` null; staff can resend to any address with `invoices.issue` (audited).

Portal
40. A customer sees only invoices and credit notes where `person_id = ctx.actor.personId`, newest first, with number, date, total, status and PDF download. Other people's invoices return `not_found`. Invoices of a company the customer is a contact of are not shown in V1 (company accounts with employee usage are the proposal's open question 5 and not in scope); the company receives them by Peppol or email.

Reporting, exports and accounting (V1 and R3)
41. Revenue is invoice-based and excludes VAT: `sum(net_cents)` of invoices plus credit notes by `issued_on`; `voucher` lines are reported as voucher liability, not revenue.
42. Accountant CSVs (V1): `invoices`, `invoice_lines`, `vat_summary`, `payments` for a period of at most 366 days; `;` separator, UTF-8 with BOM, amounts in euros with a dot and two decimals, ISO dates; one header row; files expire after 7 days; every export is audited (`finance.export_requested`).
43. Deferred revenue (R3) at date D is credits' liability: `v_credit_liability` for today and `credits.getCreditLiabilityAsOf(db, D 23:59:59 Brussels)` for a past date (remaining units times the unit value sold, VAT included), split by finance into net and VAT with the row's rate (`multi_purpose` at 0 %). Recognised revenue, breakage and revocations per month come from `v_credit_movements_monthly` (`consume` net of `release` = recognised, `expire` = breakage, `revoke` = reversed by a refund and excluded from breakage because the credit note already reverses it). Euro voucher redemptions per period come from `v_euro_voucher_redemptions`, listed with the invoice of the order they paid, so the accountant sees where VAT on a multi-purpose voucher was charged. Finance never recomputes balances from `credit_entries` (architecture principle 2: derived numbers come from the owner's views).
44. Dashboard comparisons (R3) compare the selected period with the previous period of equal length and the same period last year.

Retention and privacy
45. Invoices, credit notes, their PDFs and `invoice_sequences` are accounting records. They are kept on erasure with the reduced snapshot and `person_id = null`, and are never affected by marketing anonymisation. The `retention_policies` row `finance.invoices` (seeded by ops: 3653 days, action `anonymise`; ops row 90; cross-module D34 and D37) is counted from 1 January after the fiscal year of the document: 10 years, as the Belgian law of 20 November 2022 requires for invoices and accounting documents, so the 10-year floor is the policy itself. Finance's sweep handler `sweep['finance.invoices']` applies the row's action to documents past the horizon: `anonymise` sets `person_id` and `company_id` to null, reduces `customer_snapshot` to `{ "anonymised": true }` and deletes the PDF file (`pdf_file_id = null`), while totals, lines and numbers stay for the sequence; `delete` removes documents and their PDFs. No sweep touches a document younger than 3653 days from 1 January after its fiscal year (`LEGAL_MIN_RETENTION_YEARS = 10`, i.e. 3653 days, in `packages/core/src/finance/retention.ts`): a policy edited below that horizon is not applied below it, and the sweep logs `skipped_legal_floor` with the count. Before the horizon, erasure reduces documents as section 9 says (`retained_legal`).

## 4. Server surface

All files under `apps/web/modules/finance/`. Domain logic called from them lives in `apps/web/modules/finance/service/*.ts` (database) and `packages/core/src/finance/*.ts` (pure).

### 4.1 Cross-module `api.ts` (exact signatures)

```ts
import type { Tx, DbOrTx } from '@beam/db';
import type { Ctx } from '@/lib/ctx';
import type { BillingDetails, InvoiceSummary, FinanceKpis } from '@beam/core/finance';
import type { DigestSection } from '@/modules/platform/api';

export type IssueInvoiceInput = {
  orderId: string;
  status?: 'paid' | 'open';                      // default 'paid'; 'open' only for bank_transfer orders (rule 2)
  dueOn?: string;                                // YYYY-MM-DD; commerce passes the transfer payment's expires_at date
  paymentId?: string;                            // settling payment (provider snapshot, transaction ref)
  paidAt?: Date; settledVia?: 'provider' | 'billit' | 'manual'; // used when an open invoice is settled (rule 2a)
};
export type IssueInvoiceResult =
  | { status: 'issued' | 'existing'; invoiceId: string; number: string }
  | { status: 'skipped'; reason: 'zero_total' };
/** Called by commerce in the payments.sync paid transaction and at bank-transfer order placement. */
export function issueInvoice(tx: Tx, ctx: Ctx, input: IssueInvoiceInput): Promise<IssueInvoiceResult>;

export type CreditNoteLineInput = { orderLineId: string; quantity?: number; amountCents?: number };
export type IssueCreditNoteInput = {
  invoiceId?: string; orderId?: string;           // one of the two; orderId resolves the live invoice
  refundId?: string; reason: string;
  lines?: CreditNoteLineInput[];                  // omitted = full remaining amount
  noRefund?: boolean;
};
/** Called by commerce's refund action in its transaction; also used by finance's own staff actions. */
export function issueCreditNote(tx: Tx, ctx: Ctx, input: IssueCreditNoteInput): Promise<{ creditNoteId: string; number: string; totalCents: number }>;

/** Called by commerce when a refund reaches `refunded`. Idempotent. */
export function markCreditNoteSettled(tx: Tx, ctx: Ctx, input: { refundId: string; settledAt: Date }): Promise<void>;

/** Called by commerce checkout (company invoice box) and staff order screens before payment. Upsert per order. */
export function setOrderBillingDetails(tx: Tx, ctx: Ctx, input: { orderId: string; details: BillingDetails }): Promise<void>;

/** Latest invoice of kind 'invoice' for the order (live or cancelled), for commerce's order screen and return page. */
export function getInvoiceForOrder(db: DbOrTx, orderId: string): Promise<InvoiceSummary | null>;
/** For the crm person page and the ops privacy export. */
export function listInvoicesForPerson(db: DbOrTx, personId: string): Promise<InvoiceSummary[]>;
/** For ops privacy.erase_external (runs before the module erase handlers): the person's Billit party id, if any. */
export function getBillitCustomerRef(db: DbOrTx, personId: string): Promise<string | null>;
/** For ops rectification and crm person edits: enqueue billit.push_customer for the person's party (no-op without a party). */
export function resyncCustomer(tx: Tx, ctx: Ctx, personId: string): Promise<void>;
/** For ops.daily_digest: Billit failed and failing over the alert time, PDF failures, overdue open invoices, last reconcile, nl-BE fallbacks. Ids and counts only. */
export function getFinanceDigest(db: DbOrTx, day: string /* YYYY-MM-DD Brussels */): Promise<DigestSection>;
/** R4: KPIs for ops custom dashboards, weekly summary and NL questions. */
export function getFinanceKpis(db: DbOrTx, input: { from: string; to: string }): Promise<FinanceKpis>;

export type InvoiceSummary = { id: string; kind: 'invoice' | 'credit_note'; number: string; issuedOn: string;
  status: 'issued' | 'paid' | 'open' | 'cancelled'; totalCents: number; isCompany: boolean; pdfReady: boolean };
```

Retention is not an api function: finance's `privacy.ts` exports `sweep` handlers keyed by policy key (`finance.invoices`, `finance.invoice_requests`, `finance.billit_reconcile_runs`, `finance.finance_exports`; the `PrivacyRegistration` shape from Wave 0), which ops' `privacy.retention_sweep` calls (section 9). Commerce's calls map as follows: `issueInvoice(tx, ctx, { orderId, status, dueOn, paymentId })` from the paid transaction and bank-transfer placement; `issueCreditNote(tx, ctx, { invoiceId, lines, reason, refundId })` from the refund action (commerce's `refunds.lines` `{order_line_id, quantity, amount_cents}` mapped to `CreditNoteLineInput`) and `issueCreditNote(tx, ctx, { orderId, reason, noRefund: true })` from `cancelOrder` on an unpaid bank-transfer order.

`BillingDetails` (Zod `BillingDetailsInput` in `packages/core/src/finance/billing.ts`, reused by commerce's checkout form): `{ isCompany: boolean, legalName: string(2..200), vatNumber?: string, address: Address, billingEmail?: email, purchaseOrderRef?: string(..50), peppolId?: string }`, refined by rule 17.

### 4.2 Server actions (`actions.ts`, all through `action()`)

| Action (name) | Audience, permission | Input (Zod summary) | Output | Writes |
| --- | --- | --- | --- | --- |
| `issueManualCreditNote` (`finance.credit_note.issue`) | staff, `invoices.issue` | `{ invoiceId: uuid, reason: string(3..500), lines?: CreditNoteLineInput[], noRefund: boolean }` | `{ creditNoteId, number }` | event `credit_note.issued`; audit `invoice.credit_note_issued`; a full credit of an `open` invoice runs `commerce.cancelOrder` instead (rule 25), which also writes `order.cancelled` |
| `reissueInvoice` (`finance.invoice.reissue`) | staff, `invoices.issue` | `{ invoiceId, billing: BillingDetailsInput, reason }` | `{ creditNoteId, invoiceId, number }` | events `credit_note.issued`, `invoice.issued`; audit `invoice.reissued` |
| `markInvoicePaid` (`finance.invoice.mark_paid`) | staff, `invoices.issue` | `{ invoiceId, paidOn: date (not in the future, not before issued_on), bankReference?: string(..100), note: string(3..500) }` | `{ ok }` | invoice `paid`, `commerce.recordBankTransferPaid`, `billit.push_payment`; event `invoice.paid`; audit `invoice.marked_paid` (old and new status) |
| `retryBillitSync` (`finance.billit.retry`) | staff, `invoices.issue` | `{ invoiceId }` | `{ jobId }` | audit `billit.retry` |
| `retryAllBillitFailed` (`finance.billit.retry_all`) | staff, `invoices.issue` | `{}` | `{ count }` | audit `billit.retry_all` |
| `runBillitReconcileNow` (`finance.billit.reconcile`) | staff, `invoices.issue` | `{}` | `{ jobId }` | audit `billit.reconcile_requested` |
| `rerenderInvoicePdf` (`finance.pdf.rerender`) | staff, `invoices.issue` | `{ invoiceId }` or `{ allBlocked: true }` (only documents with `pdf_status = 'failed'` or a missing file; refreshes `seller_snapshot` first when allowed by 2.2) | `{ jobIds }` | audit `invoice.pdf_rerendered` |
| `resendInvoiceEmail` (`finance.invoice.resend`) | staff, `invoices.issue` | `{ invoiceId, to?: email }` (passed to email as `to`) | `{ emailMessageId }` | event `invoice.emailed`; audit `invoice.email_resent` |
| `sendPaymentReminder` (`finance.invoice.remind`) | staff, `invoices.issue` | `{ invoiceId }` (open, overdue, none in last 7 days) | `{ emailMessageId }` | event `invoice.reminder_sent`; audit `invoice.reminder_sent` |
| `decideCompanyInvoiceRequest` (`finance.request.decide`) | staff, `invoices.issue` | `{ requestId, decision: 'approve' \| 'reject', note?: string(..500) }` | `{ status, newInvoiceId? }` | events `invoice.company_request_decided` (+ reissue events); audit `invoice_request.approved` or `.rejected` |
| `requestFinanceExport` (`finance.export.request`) | staff, `reports.finance` | `{ kind: finance_exports_kind, from: date, to: date }` | `{ exportId }` | audit `finance.export_requested` |
| `requestCompanyInvoice` (`finance.request.create`) | customer | `{ invoiceId, billing: BillingDetailsInput }` (own invoice, rule 20) | `{ requestId }` | event `invoice.company_requested` |
| `cancelCompanyInvoiceRequest` (`finance.request.cancel`) | customer | `{ requestId }` (own, `requested`) | `{ ok }` | event `invoice.company_request_cancelled` |

Every staff action writes `audit_log` through the `action()` wrapper (`audit` option set) with `entity_type = 'invoice'` (or `invoice_request`, `finance_export`) and `person_id` of the invoice. The two customer actions declare `audience: 'customer'` and no permission; their handlers load the invoice with `person_id = ctx.actor.personId` and return `not_found` otherwise. Error mapping: rule violations raise `conflict` with a message key (`finance.errors.credit_exceeds_invoice`, `finance.errors.not_open`, `finance.errors.order_not_cancellable`, `finance.errors.invalid_transition`, `finance.errors.request_window_closed`, `finance.errors.reminder_too_soon`). Finance settings have no finance action: the `finance` key is declared with its Zod schema in `apps/web/modules/finance/config.ts` and edited through platform's `updateSetting` at `/admin/settings/finance` (`settings.write`, audited as `settings.update` by platform).

### 4.3 Queries (`queries.ts`)

| Query | Permission or audience | Input | Returns |
| --- | --- | --- | --- |
| `listInvoices` | `invoices.read` | `{ from?, to?, kind?, status?, billitStatus?, isCompany?, q?, cursor?, limit: 50 }` | page of `InvoiceRow` (number, kind, date, customer name, total, status, billit, pdf) |
| `getInvoice` | `invoices.read` | `{ id }` | full invoice, balance, credit notes, replacing/replaced documents, order, payments, refunds, related jobs, request history |
| `getFinanceOverview` | `invoices.read` | `{}` | issued today and this month (count, net), open and overdue totals, Billit backlog counts, PDF failures, pending requests, last reconcile |
| `listBillitBacklog` | `invoices.read` | `{ status?: 'pending' \| 'failed' }` | rows of `v_finance_billit_backlog` |
| `listReconcileRuns` / `getReconcileRun` | `invoices.read` | `{ limit: 30 }` / `{ id }` | runs and issues |
| `listCompanyInvoiceRequests` | `invoices.read` | `{ status? }` | requests with invoice number and customer |
| `listFinanceExports` | `reports.finance` | `{}` | last 50 exports |
| `getInvoicingIdentity` | `invoices.read` | `{}` | the merged `SellerSnapshot` that the next document would carry, plus `missing: string[]` (empty required fields) for the overview banner and the settings summary |
| `listMyInvoices` | customer | `{}` | `InvoiceSummary[]` for `ctx.actor.personId` |
| `getMyInvoice` | customer | `{ id }` | snapshot view, lines, breakdown, payment state, open request |
| `getFinanceDashboard` (R3) | `reports.finance` | `{ period: 'day' \| 'week' \| 'month' \| 'ytd' \| 'custom', from?, to? }` | KPI tiles, series and comparisons (section 5) |
| `getDeferredRevenue` (R3) | `reports.finance` | `{ asOf: date }` | totals by credit kind and by VAT treatment and rate, gross, net and VAT |
| `getBreakage` (R3) | `reports.finance` | `{ from, to }` | per month, credit kind and rate: recognised, breakage (expired) and revoked value, gross, net, VAT |
| `getVoucherRedemptions` (R3) | `reports.finance` | `{ from, to }` | euro credit spends with order, invoice number, amount, reversed flag |

### 4.4 Route handlers

| Route | Who | Behaviour |
| --- | --- | --- |
| `GET app/(admin)/admin/finance/invoices/[id]/pdf/route.ts` | staff with `invoices.read` | streams the PDF (`application/pdf`, `Content-Disposition: inline; filename="<number>.pdf"`, `Cache-Control: private, no-store`); 404 when not rendered |
| `GET app/[locale]/(portal)/account/invoices/[id]/pdf/route.ts` | customer owning the invoice | same; 404 for anyone else (never 403, so ids cannot be probed) |
| `GET app/(admin)/admin/finance/exports/[id]/route.ts` | staff with `reports.finance` | streams the CSV (`text/csv; charset=utf-8`), audit `finance.export_downloaded` |

No webhooks: Billit is polled (architecture section 8).

### 4.5 Jobs (`jobs.ts`, `defineJob`)

| Kind | Lane, priority | Idempotency key | Does | Retry |
| --- | --- | --- | --- | --- |
| `finance.render_pdf` | fast, 5 | `invoice_pdf:<invoice_id>` (retry action: `invoice_pdf:<id>:r<n>`) | builds `InvoiceDocumentModel` from snapshots, renders with `@react-pdf/renderer`, stores the file, sets `pdf_file_id`, `pdf_status = 'rendered'`; then enqueues the Billit push (`billit:invoice:<id>` or `billit:credit_note:<id>`) and, when rule 38 applies, `finance.send_invoice_email` | default backoff; `MissingCompanySettingsError` (production, empty seller VAT number, enterprise number or IBAN) and template errors are `PermanentError` -> `pdf_status = 'failed'` |
| `finance.send_invoice_email` | fast, 1 | `invoice_email:<invoice_id>:<reason>` (`issued`, `resend:<n>`, `reminder:<yyyy-mm-dd>`, `peppol_fallback`) | calls `email.sendTransactional(ctx, { template, personId, to, locale, data, key: <job key>, attachments: [{ fileId: pdf_file_id, filename: '<number>.pdf' }] })` with `finance.invoice`, `finance.credit_note` or `finance.invoice_reminder` (`personId` omitted when the invoice has none; `to` = rule 39 recipient), which returns `{ emailMessageId, jobId }`; sets `emailed_at`; event `invoice.emailed` | default; no recipient = success with result `skipped_no_recipient`; suppression and translation are decided later by `email.send` (the call returns no status, cross-module D5), so finance never sees a `suppressed` result |
| `billit.push_customer` | fast, 5 | `billit:customer:<party_key>:<snapshot_hash8>` | upserts the Billit party; stores `billit_party_id`, `snapshot_hash` | 5xx, 429, network: retryable; 4xx: permanent with `last_error` |
| `billit.push_invoice` | fast, 5 | `billit:invoice:<invoice_id>` (retry: `billit:invoice:<id>:r<attempt>`) | ensures the party inline, `findOrderByReference`, `createOrder` with PDF attachment (and `Paid`/`PaidDate` when already paid, rule 30a), commits `billit_id`, `billit_status = 'synced'`; enqueues `billit.send_peppol` for company invoices and `billit.push_payment` when the invoice was settled between issue and push | retryable as above; each failure updates `billit_attempts`, `billit_last_error`, `billit_failed_since`, `billit_status = 'failed'` in a separate autocommit statement before rethrow; 409 duplicate = re-fetch by reference |
| `billit.push_credit_note` | fast, 5 | `billit:credit_note:<invoice_id>` (retry: `...:r<attempt>`) | as push_invoice with order type credit note and the original's Billit reference | `RetryableError('original_not_synced')` while the original is not synced |
| `billit.send_peppol` | fast, 5 | `billit:peppol:<invoice_id>` | `sendOrder(billitId, 'Peppol')`; `peppol_status = 'sent'` | 4xx (receiver not on Peppol) is permanent: `peppol_status = 'failed'`, rule 33 (High alert and task for `BE` buyers), invoice email with key reason `peppol_fallback` |
| `billit.push_payment` | fast, 5 | `billit:payment:<invoice_id>` (retry: `...:r<attempt>`) | `registerPayment(billitId, { paidOn, amountCents, method, reference })`; `billit_payment_status = 'synced'` | `RetryableError('not_synced')` while `billit_status <> 'synced'`; failures set `billit_payment_status = 'failed'` (autocommit, as push_invoice) |
| `billit.sync_pending` | bulk, 5 | `schedule:billit.sync_pending:<minute>` | (a) up to 100 `open` invoices with `billit_id`: `getOrder`, apply rule 26/28; (b) re-enqueue pushes for `pending`/`failed` documents older than 15 minutes with no live job; (c) High alert per rule 35 through `notifySlack` with fingerprint `billit-failing:<invoice_id>` (one per invoice per hour); self-continues with `offset` when more than 100 open | default |
| `billit.reconcile` | bulk, 9 | `schedule:billit.reconcile:<minute>` (manual: `billit:reconcile:<yyyy-mm-dd>:manual:<n>`) | checks documents issued in the last `settings.finance.reconcile_lookback_days` (35) against Billit, sequence gaps, stale pending, missing PDFs; upserts `billit_reconcile_runs`; Slack summary when issues | default; Billit unreachable -> run `failed` |
| `finance.scan_overdue` | bulk, 9 | `schedule:finance.scan_overdue:<minute>` | emits `invoice.overdue` and creates the `payment` task (rule 29) | default |
| `finance.build_export` | bulk, 9 | `finance_export:<export_id>` | streams rows in pages of 1,000 into a CSV, stores the file, sets `done`, `row_count` | default; after max attempts `status = 'failed'` |

All handlers are idempotent: running twice with the same payload leaves the same state (`jobs.test.ts`, using platform's `runJobTwice`). The Billit client comes from `getIntegrations().billit` (`apps/web/lib/integrations.ts`, Wave 0: real client in `staging` and `production` or when `BILLIT_API_KEY` is set, the fake when `INTEGRATIONS=fake`), and its `onCall` is wired to `ctx.integrationLog`, so every call lands in `integration_calls`. Slack alerts go through platform's `notifySlack({ fingerprint, severity, text })`, which enqueues `notify.slack` with key `slack:<fingerprint>:<YYYY-MM-DDTHH>`; finance fingerprints are `billit-failing:<invoice_id>`, `billit-auth`, `peppol-failed:<invoice_id>`, `billit-reconcile:<run_on>` and `sequence-gap:<year>:<kind>`. Billit party anonymisation on erasure is done by ops' `privacy.erase_external` with `BillitApi.anonymiseCustomer`, not by a finance job (section 9).

### 4.6 Schedules (`schedules.ts`, Europe/Brussels)

| Kind | Cron | Note |
| --- | --- | --- |
| `billit.sync_pending` | `*/15 * * * *` | architecture schedule |
| `billit.reconcile` | `15 5 * * *` | daily 05:15, after `ledger.reconcile` (04:30) |
| `finance.scan_overdue` | `40 7 * * *` | daily 07:40, before `ops.daily_digest` (08:00) |

### 4.7 Activity events (`events.ts`, `defineEvent`)

| Kind | Person | Data | Dedupe key |
| --- | --- | --- | --- |
| `invoice.issued` | invoice person | `{ invoice_id, number, total_cents, is_company, status }` | `invoice:<id>:issued` |
| `invoice.paid` | invoice person | `{ invoice_id, number, settled_via }` | `invoice:<id>:paid` |
| `credit_note.issued` | invoice person | `{ credit_note_id, number, invoice_number, total_cents, refund_id }` | `credit_note:<id>:issued` |
| `credit_note.settled` | invoice person | `{ credit_note_id, number, refund_id }` | `credit_note:<id>:settled` |
| `invoice.emailed` | invoice person | `{ invoice_id, number, reason }` | `invoice_email:<id>:<reason>` |
| `invoice.reminder_sent` | invoice person | `{ invoice_id, number }` | `invoice:<id>:reminder:<date>` |
| `invoice.overdue` | invoice person | `{ invoice_id, number, days_overdue, total_cents }` | `invoice:<id>:overdue` |
| `invoice.company_requested` / `invoice.company_request_decided` / `invoice.company_request_cancelled` | requester | `{ request_id, invoice_number, decision? }` | `invoice_request:<id>:<state>` |

Events carry no address, email or VAT number. Every event is declared with `defineEvent({ kind, data, subject: 'either' })`. When the invoice has no `person_id` but a `company_id`, events attach to the company. When it has neither (anonymous POS sale, or a document of an erased person), no event is recorded, because `activity_events` requires one of the two; the invoice row and `issued_by` remain the record.

## 5. Screens

All admin screens use `DataTable`, money and dates through `Intl` in `users.locale` and Europe/Brussels. Loading states are route-level `loading.tsx` skeletons; errors are route-level `error.tsx` with the request id and a Retry link. Navigation (`nav.ts`): group "Finance" with Overview, Invoices, Billit sync, Requests, Exports, Dashboard (R3), Deferred revenue (R3), Settings; entries hidden without the permission. Accessibility: admin and portal finance screens meet WCAG 2.1 AA (status badges carry text, not colour alone; tables have header cells and captions; dialogs trap focus; amounts are read with their currency). PDFs set document title, author (`seller.legal_name`) and language (`lang` = document locale) metadata, use real text (no images of text) at a minimum 9 pt, and keep reading order equal to visual order; full PDF/UA tagging is not provided by the renderer and is not promised.

| Route | Who | Shows | Actions | Empty state |
| --- | --- | --- | --- | --- |
| `/admin/finance` | `invoices.read` | V1 overview tiles from `getFinanceOverview`: issued today and this month, open and overdue amount, Billit backlog (pending, failed, failing over 1 h in red), PDF failures, pending company requests, last reconcile status with issue count | links into filtered lists; "Retry all failed" (`invoices.issue`) | "No invoices yet. The first paid order creates BEAM-<year>-000001." |
| `/admin/finance/invoices` | `invoices.read` | list: number, kind badge, issue date, customer, company badge, total, status, Billit status, PDF icon; filters (period, kind, status, Billit status, B2B), search by number or customer name | open detail; CSV of the current filter via `requestFinanceExport` (`reports.finance`) | "No documents in this period." |
| `/admin/finance/invoices/[id]` | `invoices.read` | header (number, kind, status, dates, due date, structured communication), buyer and seller snapshot, lines with VAT, breakdown, totals, balance (credited, remaining), PDF preview (iframe of the PDF route), Billit block (status, id, attempts, last error, Peppol status), linked order, payments, refunds, credit notes, replaced/replacing document, company request history, timeline of related jobs | (`invoices.issue`) Issue credit note (dialog: full or lines, reason, "no refund" flag), Reissue to other customer details, Mark paid (open only), Retry Billit, Re-render PDF (failed only), Resend email, Send payment reminder (open and overdue); "Refund" links to the commerce order refund (`commerce.refund`) | not applicable; unknown id shows the 404 page |
| `/admin/finance/sync` | `invoices.read` | Billit backlog table, reconcile runs (last 30) with issues expandable per type, integration status (last successful call from `integration_calls`) | Retry one, Retry all failed, Run reconcile now (`invoices.issue`) | "Everything is in sync with Billit." |
| `/admin/finance/requests` | `invoices.read` | company invoice requests: customer, invoice, requested company details, VAT check result, age | Approve, Reject with note (`invoices.issue`) | "No open requests." |
| `/admin/finance/exports` | `reports.finance` | form (kind, period with presets: last month, last quarter, last year) and the last 50 exports with status, rows, expiry | Request export, Download | "No exports yet." |
| `/admin/finance/settings` | `invoices.read` | read-only summary from `getInvoicingIdentity`: the seller block exactly as the next PDF will print it, the list of missing required fields, and the current finance settings (payment terms, request window, Billit on or off, Peppol on or off, alert minutes, VAT notes per category with completeness badge) | "Edit company details" links to `/admin/settings/company` and "Edit finance settings" to `/admin/settings/finance` (platform's generic editor, `settings.write`) | prefilled from seed; missing fields listed in red |
| `/admin/finance/dashboard` (R3) | `reports.finance` | period selector (day, week, month, YTD, custom) with previous-period and last-year comparison; tiles: net revenue, VAT collected, cash inflow, refunds, open invoices (count, amount, overdue), failed payments, recurring revenue and active memberships; charts: revenue trend (daily or monthly bars with comparison line), revenue by category, revenue by payment method, VAT by rate and quarter, cash inflow vs outflow; tables: top open invoices, last failed payments | drill-down links to filtered invoice lists; CSV of each table | tiles show 0 and "No data in this period" |
| `/admin/finance/deferred` (R3) | `reports.finance` | deferred revenue as of a date by credit kind and by VAT rate (units, gross, net, VAT); recognised, breakage and revoked value per month and credit kind; euro voucher redemptions in the period with invoice numbers | export `deferred_revenue`, `breakage` and `voucher_redemptions` CSV | "No unused paid credits." |
| `/[locale]/account/invoices` | customer (own) | list of own invoices and credit notes: number, date, total, status (Paid, Open with due date, Cancelled, Credit note), PDF link | open detail, download PDF | "You have no invoices yet." |
| `/[locale]/account/invoices/[id]` | customer (own) | document summary with lines and VAT, payment status; for open invoices IBAN and structured communication; credit notes linked to the invoice | Download PDF; "Need an invoice in your company's name?" form (rule 20, shown within the window); cancel own pending request | not applicable |

Portal loading and error states use the portal shell skeleton and the localised "Something went wrong, try again" panel. PDF links show "Being prepared" while `pdf_status = 'pending'` and refresh after 5 seconds once. No public (`/[locale]/...` site) screens are owned by finance; the checkout's "company invoice" fields are commerce's form using finance's `BillingDetailsInput` and labels from the `finance.billing.*` keys. Reception flow: at the POS counter (`/admin/pos`, commerce) the "Invoice to a company" toggle opens the same fields and calls `finance.setOrderBillingDetails` before payment, so a walk-in business customer leaves with a company invoice that Billit sends over Peppol; afterwards the receptionist cannot reissue (no `invoices.issue`) and hands the request to finance.

## 6. Integrations

**Billit** (`packages/integrations/src/billit/`): `client.ts` (REST), `fake.ts` (in-memory, used by every test), `types.ts` (Zod response schemas). Constructor `new BillitClient({ baseUrl, apiKey, partyId, onCall })`; `baseUrl` from `BILLIT_BASE_URL` (`https://api.billit.be` in production, `https://api.sandbox.billit.be` elsewhere), `apiKey` from `BILLIT_API_KEY`, BEAM's own Billit party id from `BILLIT_PARTY_ID` (added secrets). `onCall` writes `integration_calls` (operation, request digest, status code, duration; never bodies).

```ts
export interface BillitApi {
  upsertParty(input: BillitPartyInput): Promise<{ partyId: string }>;          // POST/PATCH /v1/parties
  createOrder(input: BillitOrderInput): Promise<{ orderId: string }>;          // POST /v1/orders (OrderType Invoice | CreditNote, OrderDirection Income)
  findOrderByReference(reference: string): Promise<{ orderId: string } | null>; // GET /v1/orders?$filter=OrderNumber eq '<number>'
  getOrder(orderId: string): Promise<BillitOrder>;                            // GET /v1/orders/{id}: Paid, PaidDate, TotalIncl, Status
  listOrdersSince(since: Date, page: number): Promise<{ items: BillitOrder[]; hasMore: boolean }>;
  sendOrder(orderId: string, transport: 'Peppol'): Promise<void>;             // POST /v1/orders/commands/send
  registerPayment(orderId: string, p: { paidOn: string; amountCents: number; method: string; reference: string | null }): Promise<void>; // PATCH /v1/orders/{id}: Paid, PaidDate, PaymentMethod
  anonymiseCustomer(partyId: string): Promise<void>;                          // PATCH /v1/parties/{id}: clears Email, Phone, Mobile, Contacts; keeps Name, Addresses, VATNumber
}
export function createBillitClient(opts: { baseUrl: string; apiKey: string; partyId: string; onCall: OnCall }): BillitApi;
```

`createBillitClient` is exported from `packages/integrations/src/billit/index.ts` with this exact signature; Wave 0's `apps/web/lib/integrations.ts` imports it (Wave 0's platform-P3 ships `index.ts`, `types.ts`, `fake.ts` and `client.ts`, the client a stub that throws `NotImplementedError`; finance-P4 takes over all four files, cross-module D47). `anonymiseCustomer` is the method ops' `privacy.erase_external` calls (ops spec section 6).

`BillitOrderInput` maps from the invoice: `OrderNumber = number`, `Reference = number`, `OrderDate = issued_on`, `ExpiryDate = due_on`, `Customer = { PartyID }`, `OrderLines` (description, quantity, unit price excl. VAT with 4 decimals, VAT percentage), `AboutInvoiceNumber` for credit notes, `PaymentReference` (structured communication), `Attachments = [{ FileName: '<number>.pdf', MimeType: 'application/pdf', FileContent: base64 }]`, and for documents already paid `Paid = true`, `PaidDate`, `PaymentMethod` and `Comments` per rule 8a. `PaymentMethod` comes from one table `BILLIT_PAYMENT_METHOD: Record<payment_method, string>` in `billit-mapping.ts` (`bancontact`, `creditcard`, `terminal` -> card; `cash` -> cash; `bank_transfer` -> transfer; `voucher` -> voucher; `mixed` -> the largest non-euro-credit payment's method), whose right-hand values are Billit's payment-method codes as recorded from the sandbox in `types.ts`; `registerPayment` uses the same table. Euro credit (`credit_balance`) never becomes a discount or negative line. Mapping lives in `packages/core/src/finance/billit-mapping.ts` (pure, unit-tested) so Billit's totals equal ours: after create the job compares Billit's `TotalIncl` with `total_cents`; a difference of more than 1 cent is an `amount_mismatch` on the next reconcile and a Normal alert.

Failure handling: `IntegrationError { provider: 'billit', retryable }`; 5xx, 408, 429 and network errors are retryable with the standard backoff (60 s to 6 h); 400 and 422 are permanent (the dead job shows Billit's validation message on the finance screen); 401 and 403 are permanent and raise one High alert ("Billit credentials rejected"). Idempotency: our number is the Billit reference, `findOrderByReference` before create, `billit_id` committed right after create, job keys per document. `fake.ts` supports `failNext(operation, { status })`, `loseResponseNext('createOrder')` (creates, then throws a timeout), `markPaid(reference, paidOn, amountCents?)`, `setPeppolReachable(vat, boolean)` and `snapshot()` for assertions; it keeps the Wave 0 fake's exported name and constructor so tests of other modules written against the stub keep compiling.

Monitoring tied to the SLA (proposal section 7: "Billit sync failing" is High, first response within 4 business hours): the High alert fires after 60 minutes of failure (rule 35), credentials rejected (401/403) alert at once, a `sequence_gap` or `amount_mismatch` from the reconcile is a High alert, a Peppol failure for a `BE` buyer is High, everything else surfaces in the daily digest through `getFinanceDigest` and on `/admin/finance/sync`. Platform's System page shows the Billit row of `v_integration_health` (last success, error rate).

**Resend**: indirectly through `email.sendTransactional` (email module). **Mollie**: none directly; payment facts come from `commerce` tables. **Peppol**: through Billit only.

## 7. Permissions and audit

`modules/finance/permissions.ts` declares `invoices.read`, `invoices.issue` and `reports.finance` (the names fixed by architecture section 4). It also uses `settings.write` (platform, for the `finance` key in the generic editor) and relies on `commerce.refund` (commerce) for refunds.

| Role (seeded) | invoices.read | invoices.issue | reports.finance | settings.write (finance settings) |
| --- | --- | --- | --- | --- |
| owner, technical_admin | yes | yes | yes | yes |
| management | yes | yes | yes | yes |
| finance | yes | yes | yes | no |
| customer_service, sales, marketing, reception | no | no | no | no |
| external_partner | no | no | no | no |
| customer (portal) | own documents only | own company requests only | no | no |

The owner may grant `invoices.read` to `customer_service` at `/admin/settings/roles`. A refund (and its credit note) needs `commerce.refund`, which finance and management have.

Audited (`audit_log`, staff actor, `entity_type`, `entity_id`, `person_id`, old and new value where relevant): `invoice.credit_note_issued`, `invoice.reissued`, `invoice.marked_paid`, `invoice.email_resent`, `invoice.reminder_sent`, `invoice.pdf_rerendered`, `billit.retry`, `billit.retry_all`, `billit.reconcile_requested`, `invoice_request.approved`, `invoice_request.rejected`, `finance.export_requested`, `finance.export_downloaded`; edits of the `company` and `finance` settings keys are audited by platform as `settings.update` with old and new value. System issuance (from `payments.sync` and Billit sync) is recorded as activity events and in `invoices.issued_by`, not in `audit_log`. Credit notes from refunds are audited by commerce as `refund.issued` (blueprint 56 "Refund issued"); finance adds the credit note id to that row's `new_value` through the returned value. Viewing an invoice is not audited; downloading an export is.

## 8. Multi-language and content

Catalogue namespace `finance` in `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/finance.json`; `en` is the source; `pnpm i18n:check` enforces parity. Key groups:
- `finance.admin.*` (overview, invoices, invoice detail, sync, requests, exports, settings, dashboard, deferred): column headers, filters, badges, dialogs, empty states.
- `finance.portal.*`: list, detail, status labels, request form, "Being prepared".
- `finance.pdf.*`: `invoice_title`, `credit_note_title`, `number`, `issue_date`, `due_date`, `customer`, `vat_number`, `po_reference`, `description`, `quantity`, `unit_price_incl`, `unit_price_excl`, `vat_rate`, `vat_amount`, `net_amount`, `amount`, `subtotal_excl`, `vat_total`, `total_incl`, `paid_on`, `open_pay_by`, `structured_communication`, `credit_note_for`, `reason`, `page_x_of_y`, `session_date`.
- `finance.billing.*`: labels and errors of the company invoice fields (used by commerce's checkout and POS).
- `finance.errors.*`: action error messages.
- `finance.digest.*`: labels of the finance section of the daily digest.
- `finance.email.<name>.<slot>`: copy of the four finance email templates (`invoice`, `credit_note`, `invoice_reminder`, `company_request_decided`).

Email templates: finance owns `templates/finance/`, its props schemas and its `finance.email.*` copy (cross-module D4); email owns `defineTemplate()`, the layout, renderer, generated registry and the seeding of system rows. The four code-backed transactional templates live in `packages/email/src/templates/finance/{invoice.tsx,credit-note.tsx,invoice-reminder.tsx,company-request-decided.tsx,index.ts}`, declared with email's `defineTemplate({ name, component, props, slots, attachments })` (email rule 15a and decision 1); `pnpm gen:indexes` puts them in email's `TEMPLATE_REGISTRY` and email's seed creates one editable system row per key. Keys (`<m>.<name>`, `<name>` = file basename with `-` replaced by `_`, one file one key; cross-module Convention 1 and D2; the slash form is retired): `finance.invoice`, `finance.credit_note`, `finance.invoice_reminder` (these three declare a PDF attachment) and `finance.company_request_decided`. Copy lives in finance's own catalogue under `finance.email.<name>.<slot>` (for example `finance.email.invoice_reminder.subject`), never in `email.json`. Props schemas (Zod, in each template file): `{ number: string; totalFormatted: string; dueOn?: string; paymentReference?: string; iban?: string; portalUrl: string; reason?: string; decision?: 'approved' | 'rejected'; note?: string; isCourtesyCopy?: boolean }`, passed as `data`; `isCourtesyCopy` adds the line "The legal invoice was sent to you over Peppol" (rule 19a). Sent in `persons.locale` (or `orders.locale` when there is no person). A missing translation makes `email.send` mark the message `blocked_translation` (no fallback language); the PDF and the portal still work.

LocalizedText fields: `settings.finance.issuer.invoice_footer` (also carries the reference to BEAM's general terms and conditions) and `settings.finance.vat_notes.<category>`. The Zod schema of the `finance` key refines both with `assertComplete(text, ['nl-BE','fr-BE','en'])`, so platform's `updateSetting` refuses a save with the missing locales. Invoice line descriptions are snapshots of `order_lines.description` (already complete at product activation); rule 16 handles the remaining case.

Settings (declared in `apps/web/modules/finance/config.ts`, schemas in `packages/core/src/finance/settings.ts`):
- Platform's key `company` (owned by platform, platform section 2): `{ legal_name: 'Vibrant Lifestyle Collective BV', trade_name: 'BEAM Vitality Center', vat_number (BE + 10 digits), enterprise_number, address: { street, postal_code, city, country: 'BE' }, support_email, phone, website }`. Finance reads it with `getSetting(tx, 'company')`; it never writes it. The seller block takes legal name, trade name, VAT number, enterprise number, address, support email (printed as the seller's contact address, never the buyer's), phone and website from here.
- Finance's key `finance` (new): `{ issuer: { register_court, iban, bic, invoice_footer: LocalizedText }, payment_terms_days: 14, company_request_window_days: 30, billit_enabled: true, peppol_enabled: true, alert_after_minutes: 60, reconcile_lookback_days: 35, vat_notes: Partial<Record<'voucher' | 'item' | 'session' | 'night' | 'package' | 'membership' | 'ticket', LocalizedText>> }`. `iban` is validated with the ISO 13616 mod-97 check (`company.enterprise_number` is validated by platform's schema); only categories sold at 0 % need a note and the seed provides `voucher`. The seed leaves `issuer.register_court`, `iban` and `bic` empty. Issuer details that only invoices need (IBAN, BIC, register court, footer) stay in finance's key; identity fields shared with the site and email footers (VAT and enterprise number, address, website) live only in `company`, so no value is held twice.
- Writing settings: finance writes no settings key. Both `company` and `finance` are edited only through platform's generic editor at `/admin/settings/[key]` (`updateSetting` with `expectedVersion`, platform rule PL-41); finance has no settings form and makes no `setSetting` call. The finance settings summary links to both editors.
- `SellerSnapshot = company + finance.issuer` (merged by `buildSellerSnapshot()`; `company.address.street` becomes the seller's `line1`). Issuing works with empty issuer fields (numbers must not stop sales), but in `APP_ENV = production` PDF rendering refuses a snapshot with an empty `company.vat_number`, `company.enterprise_number` or `finance.issuer.iban` (`MissingCompanySettingsError`, permanent).

## 9. Privacy

`modules/finance/privacy.ts` registers:

```ts
export const financePrivacy = {
  tables: ['invoices', 'order_billing_details', 'invoice_requests', 'billit_parties'],
  export: async (tx, personId) => ({ /* rows + PDF file references */ }),
  erase: async (tx, personId) => ([ /* per-table { table, rows, action } */ ]),
  sweep: {                                   // keyed by retention policy key (cross-module D37), called by ops
                                             // privacy.retention_sweep: (tx, cutoff: Date) => Promise<number> rows affected
    'finance.invoices': sweepInvoices,
    'finance.invoice_requests': sweepInvoiceRequests,
    'finance.billit_reconcile_runs': sweepBillitReconcileRuns,
    'finance.finance_exports': sweepFinanceExports,
  },
} satisfies PrivacyRegistration;            // { tables, export, erase, sweep?, retention? } from packages/core/src/privacy/registry-types.ts (Wave 0, cross-module D69); finance passes no `retention` (ops seeds the rows)
```

| Table | Person data | Export | Erase action | Why |
| --- | --- | --- | --- | --- |
| `invoices` | `person_id`, `customer_snapshot` | every document of the person as JSON (snapshot, lines, totals, status) plus each PDF file (`{ fileId, name }`) | `retained_legal`: `person_id = null`; `customer_snapshot` reduced to `{ kind, name, address, vat_number (companies only), peppol_id, purchase_order_ref, is_reduced: true }`, email, phone and ids removed. PDFs kept (they print no email or phone) | Belgian accounting and VAT law; blueprint 62, 63, scenario 7 |
| `order_billing_details` | legal name, address, billing email | rows for the person's orders | `deleted` for all of the person's orders (an issued invoice's snapshot already holds what the law needs; an unpaid order is expired by commerce) | data minimisation |
| `invoice_requests` | `person_id`, `billing` | rows | pending requests set `cancelled`, then all rows of the person `deleted` | no legal need after the decision |
| `billit_parties` | `person_id` link | Billit party id | `anonymised`: `person_id = null`, `is_anonymised = true`, `snapshot_hash` set to the hash of the reduced party, so a later push (refund credit note) sends only name and address. The Billit-side call (`anonymiseCustomer`) was already made by ops' `privacy.erase_external`, which runs before the module handlers and reads the id through `finance.getBillitCustomerRef` | Billit keeps the invoices; its party loses email and phone |

The erase handler runs inside `privacy.erase` under `SET LOCAL beam.allow_rewrite = 'on'` (needed for the guarded invoice columns), in ops' `ERASE_ORDER` after `commerce` and before `site`, `ops` and `crm` (ops rule 62). Its report lists counts and actions only. An open bank-transfer invoice is no reason to refuse erasure (ops shows the `open_invoices` warning; edge case 20). `finance_exports` and `billit_reconcile_runs` hold no person reference (`NO_PII_TABLES`); exported CSV files expire after 7 days. Marketing anonymisation after 3 years of inactivity (ops retention) does not touch finance tables. Scenario 7 is asserted end to end by ops' `e2e/scenario-7-deletion.spec.ts` (the invoice remains with `person_id` null and a reduced snapshot; the Billit fake received `anonymiseCustomer`); finance's `privacy.test.ts` asserts the same at module level.

Retention: the rows live in ops' `retention_policies` and are seeded by `packages/db/src/seed/ops.ts` (finance seeds none); ops' `privacy.retention_sweep` calls the `sweep` handlers above with `cutoff = now() - days`:
- `finance.invoices` (ops row 90: 3653 days, `anonymise`, counted from 1 January after the fiscal year; cross-module D34): documents of fiscal years with `make_date(fiscal_year + 1, 1, 1) <= cutoff`, never younger (rule 45). `anonymise` sets `person_id` and `company_id` to null, reduces `customer_snapshot` to `{ "anonymised": true }` and deletes the PDF file (`pdf_file_id = null`), keeping totals, lines and numbers for the sequence; `delete` deletes documents and their PDF files, only when no newer document references them (edge case 27). `order_billing_details` of the affected orders are deleted in the same pass. `invoice_sequences` rows always stay so numbering can never restart.
- `finance.invoice_requests` (requested row: 730 days, `delete`): decided or cancelled requests whose `decided_at` (or `updated_at`) is older than the cutoff.
- `finance.billit_reconcile_runs` (requested row: 400 days, `delete`).
- `finance.finance_exports` (requested row: 90 days, `delete`); their files already expired after 7 days through `files.purge_expired`.

## 10. Dependencies

Needs from other modules:

| Module | What | How |
| --- | --- | --- |
| platform | `action()`, `defineJob`, `defineEvent`, `defineSchedule`, `enqueue`, `runJobs`, `recordEvent`, `audit`, `requirePermission`, `PermanentError`/`RetryableError`, `notifySlack`, `getIntegrations()`, `ctx.integrationLog`, `runJobTwice` (tests) | `apps/web/lib/*` and `modules/platform/api.ts` (Wave 0) |
| platform | settings `company` (read) and the generic editor for finance's `finance` key | `getSetting(tx, 'company')`, `getSetting(tx, 'finance')`; `/admin/settings/[key]` with `updateSetting` (`expectedVersion`, PL-41). Finance never calls `setSetting(ctx, key, value, expectedVersion)`: it has no settings form of its own |
| platform | PDF and CSV storage | `storeFile(ctx, { kind, name, mime, bytes, expiresAt? }): Promise<{ fileId, sha256 }>` (no `personId`, so accounting files survive person erasure), `readFile(tx, fileId)` (api.ts); table `files` |
| platform | digest section type | `DigestSection` from `modules/platform/api.ts` |
| crm | buyer identity at issue (name, email, phone, address, locale; company name, VAT, address) | read-only on tables `persons`, `companies`; `crm.getPersonStatus` not needed |
| crm | overdue and Peppol follow-up tasks | `crm.createTask(tx, ctx, { title, kind: 'payment' \| 'follow_up', priority: 'high', dueAt, ownerRole: 'finance', source: 'system', ref: { type: 'invoice', id }, personId?, companyId?, dedupeKey })` (crm api as declared) |
| commerce | order, lines, payment, refund facts | read-only on `orders`, `order_lines`, `payments`, `refunds`, `products` |
| commerce | cancel an unpaid bank-transfer order from finance's full manual credit note (rule 25) | `commerce.cancelOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason: string }): Promise<{ cancelled: boolean }>` (commerce api as declared) |
| commerce | settle a bank-transfer order when Billit or staff reports payment | `commerce.recordBankTransferPaid(tx: Tx, ctx: Ctx, input: { orderId: string; paidOn: string; reference: string }): Promise<void>` (commerce api, exactly as the commerce spec declares it; idempotent on the order) |
| commerce | calls into finance | `finance.issueInvoice` in the paid transaction and at bank-transfer placement; `finance.issueCreditNote` in the refund action and in `cancelOrder` for unpaid bank-transfer orders; `finance.markCreditNoteSettled` when the refund is `refunded`; `finance.setOrderBillingDetails` at checkout and POS; `finance.getInvoiceForOrder` on order screens |
| credits | R3 deferred revenue, breakage and voucher redemptions; active memberships | views `v_credit_liability`, `v_credit_movements_monthly`, `v_euro_voucher_redemptions` and `getCreditLiabilityAsOf(db: DbOrTx, at: Date)` (credits api); read-only on `memberships` (dashboard counts) |
| email | invoice emails with attachment; template framework | `email.sendTransactional(ctx, { template: 'finance.invoice' \| 'finance.credit_note' \| 'finance.invoice_reminder' \| 'finance.company_request_decided', personId?: string, to?: string, locale: Locale, data, key, attachments?: { fileId, filename, inline? }[], context?, sendAt?, replyTo?, headers? }): Promise<{ emailMessageId: string; jobId: string }>` (email's exact signature, email decision 6, cross-module D5; finance passes `data`, `key`, `to` and `attachments`, never `props`, `idempotencyKey`, `toEmail` or `purpose`, and gets no status back); `defineTemplate()` from `@beam/email/templates/define` for finance's four templates in `packages/email/src/templates/finance/`, which email's registry and seed pick up (email rule 15a) |
| ops | privacy orchestration, retention sweep, action dashboard, daily digest, R4 dashboards and AI views | ops calls `financePrivacy` (including `sweep`) through `GDPR_REGISTRY`, calls `getBillitCustomerRef` and `BillitApi.anonymiseCustomer` in `privacy.erase_external`, `resyncCustomer` after rectification, `getFinanceDigest` in `ops.daily_digest`, reads `v_finance_open_invoices` and `v_finance_billit_backlog`; R4 calls `finance.getFinanceKpis`; ops seeds the four finance retention rows (`finance.invoices`, `finance.invoice_requests`, `finance.billit_reconcile_runs`, `finance.finance_exports`, cross-module D37) and calls `sweep[key]` by those keys |

Provides to other modules: `issueInvoice`, `issueCreditNote`, `markCreditNoteSettled`, `setOrderBillingDetails`, `getInvoiceForOrder` (commerce order screen and return page), `listInvoicesForPerson` (crm person page "Invoices" tab), `getBillitCustomerRef`, `resyncCustomer`, `getFinanceDigest` and `getFinanceKpis` (ops), `createBillitClient` and `BillitApi` (platform's `lib/integrations.ts`, ops), the `sweep` handlers in `privacy.ts` (ops), the `BillingDetailsInput` schema and `finance.billing.*` labels (commerce checkout), activity events `invoice.*` and `credit_note.*` (crm timeline, automation triggers), views `v_finance_*` and `v_invoice_balances` (ops dashboards).

## 11. Edge cases and failure modes

1. **Two orders paid in the same millisecond.** Both transactions lock the `invoice_sequences` row; the second waits and gets the next number. No duplicate, no gap. A Neon-only concurrency test proves it (section 12, finance-P2).
2. **Paid transaction rolls back after allocating a number** (for example credits grant fails). The counter update rolls back too; the next invoice reuses the number. Nothing was rendered or pushed because jobs are enqueued in the same transaction.
3. **Mollie webhook arrives twice or `payments.sync` runs twice.** `issueInvoice` finds the live invoice for the order (partial unique `uq_invoices_order_live`) and returns `existing`; job keys prevent second PDFs and pushes.
4. **New Year's Eve.** The first invoice after 00:00 Brussels gets `BEAM-<new year>-000001`, even though UTC is still the old year; the old year's sequence stays closed.
5. **Invoice total differs from the order total** (a bug in pricing or lines). `issueInvoice` throws `conflict`; the paid transaction rolls back, `payments.sync` retries and goes dead after 6 attempts with an alert; the payment stays recorded by Mollie and is resolved by Sidestream. Money is never accepted without a matching invoice silently.
6. **Refund larger than what remains to credit**, or a second partial refund overlapping the first. `issueCreditNote` locks the invoice row, sums existing credit notes per line and refuses with `finance.errors.credit_exceeds_invoice`; commerce's refund action rolls back, no Mollie refund is sent.
7. **Billit is down for hours.** Push jobs back off (60 s to 6 h); `billit_status = 'failed'` with the error; High alert after 60 minutes; `billit.sync_pending` re-queues stuck documents; invoices, PDFs, portal and emails keep working.
8. **Billit created the order but the response was lost.** The next attempt calls `findOrderByReference(number)`, stores the found id and does not create a second order.
9. **Billit rejects the document (422).** Permanent failure: the job is dead, the invoice shows Billit's message and Retry; staff fix the cause (usually party data or a VAT number) by reissuing, or Sidestream fixes the mapping; Retry uses a new key.
10. **Credit note pushed before its invoice is in Billit.** `billit.push_credit_note` raises `RetryableError('original_not_synced')` and enqueues the original push; it succeeds once the original is synced.
11. **Bank-transfer customer pays twice or overpays.** Billit reports paid; the invoice is settled once (`invoice.paid` dedupe); the overpayment appears as `paid_mismatch` in the reconcile report; staff refund it through commerce (credit note only when goods are returned; a pure overpayment refund is outside invoicing and handled in Billit).
12. **Staff mark an invoice paid, then Billit also reports it paid.** The second transition is a no-op (`status` already `paid`); `commerce.recordBankTransferPaid` is idempotent on the order.
13. **Open invoice never paid.** Day 7 overdue: `invoice.overdue` event, action dashboard line, staff reminder; the order stays `pending_payment` with no credits granted. A `payment` task goes to the finance role. Staff cancel the order on the commerce order screen (`cancelOrder`) or issue a full manual credit note on the finance invoice screen, which calls the same `commerce.cancelOrder`; either way commerce issues the full credit note through `issueCreditNote({ orderId, noRefund: true })` in the same transaction, releases the order's bookings and euro credit, and the invoice becomes `cancelled` (rule 25).
14. **Customer changes address or name after purchase.** Issued invoices keep their snapshot. A correction is a reissue (credit note plus new invoice), never an edit.
15. **Company settings changed (new IBAN) after issue.** Old documents keep `seller_snapshot` and render identically; only new documents show the new IBAN.
16. **Company settings incomplete at go-live.** Issuance continues (numbers must not stop sales); production PDF rendering fails permanently with `MissingCompanySettingsError`, the overview shows "PDF blocked: complete company settings", and the Billit push waits for the PDF. After the settings are saved, "Re-render all blocked PDFs" (`rerenderInvoicePdf` per document) refreshes `seller_snapshot` from the current settings (allowed only because no PDF exists and Billit has nothing, section 2.2) and renders. The go-live checklist (ops) contains "invoice issuer settings complete" so this stays an exception.
17. **A product description lacks the customer's locale.** The whole document is rendered in `nl-BE` (rule 16); nothing is blocked, the line text is never mixed.
18. **Invalid or foreign VAT number at checkout.** `BillingDetailsInput` rejects a failed mod-97 or format check with a localised message; the customer can still pay as a consumer and request a company invoice later.
19. **B2C customer requests a company invoice on day 31.** The portal hides the form and the action refuses with `request_window_closed`; staff can still reissue manually.
20. **Erasure of a person with an open bank-transfer invoice.** The invoice is retained with the reduced snapshot and stays `open` (it is a legal claim); Billit's party is anonymised by ops' external step; reminders stop because there is no recipient any more, and `invoice.overdue` is not recorded (no subject) but the overdue task is still created with `ref` only. Collection continues in Billit; a later Billit "paid" still settles it through rule 26.
21. **Refund for an erased person.** `issueCreditNote` copies the reduced snapshot from the original invoice; no email is sent (no recipient); the credit note is pushed to Billit normally.
22. **Zero-total order (100 % promotion).** No invoice (rule 3); the order and its credits work as usual; reporting shows no revenue for it.
23. **PDF rendering throws on one document** (font or layout bug). `pdf_status = 'failed'`, the Billit push waits for the PDF; the overview shows the failure; Re-render after a fix. The invoice number and data are unaffected.
24. **Peppol receiver unknown** (company not registered on Peppol). `billit.send_peppol` fails permanently; `peppol_status = 'failed'`. For a `BE` buyer this breaks the 2026 e-invoicing obligation: High alert, `follow_up` task for finance, courtesy PDF email; the detail page shows "Peppol delivery failed: fix the receiver in Billit". For a foreign buyer the email with PDF is the delivery and the page shows "Sent by email, receiver not on Peppol".
25. **Reconcile finds a Billit invoice that BEAM does not know** (someone created it by hand in Billit). Listed as `unknown_in_billit`; nothing is imported; finance decides in Billit.
26. **Export for a very large period.** Limited to 366 days per export; rows stream in pages of 1,000; a CSV above 10 MB (the `files` limit) fails with "Choose a shorter period".
27. **Retention deletes old years while a credit note in a newer year points at an old invoice.** The `finance.invoices` sweep handler (action `delete`) deletes per fiscal year only when no newer document references it (`reverses_invoice_id`/`replaces_invoice_id`); such chains are kept until the newest member expires. With the seeded action `anonymise` no document row is deleted (only the PDF files of anonymised documents), so the chain and the numbers stay.
28. **`payments.sync` runs again after a full refund.** The order's invoice is `cancelled`; `issueInvoice` finds it (rule 1 looks at any invoice of the order, not only live ones) and returns `existing`. No second invoice, no gap.
29. **Staff mark an invoice paid before its Billit push finished.** `billit_payment_status = 'pending'` but `billit.push_payment` raises `RetryableError('not_synced')`; `billit.push_invoice` then sees the invoice is paid and creates the Billit order with `Paid = true`, after which the payment job succeeds as a no-op (Billit already shows it paid).
30. **Anonymous POS sale of a voucher, refunded the same day.** The invoice and credit note carry the `walk_in` snapshot, no activity events, the shared `walk_in` Billit party; the 0 % voucher line is credited at 0 %.
31. **Customer erased, then an old order is refunded.** The credit note copies the reduced snapshot; the Billit party already has `is_anonymised = true` and its stored hash matches the reduced payload, so `billit.push_customer` sends nothing new and no email or phone reaches Billit again.

## 12. Build packages

Ordering rule: the ten finance packages are **strictly sequential** (P1 -> P2 -> ... -> P10). Several of them edit the same module files (`api.ts`, `actions.ts`, `queries.ts`, `jobs.ts`, `nav.ts`, `finance.views.ts`, the three `finance.json` catalogues); each such file is listed under every package that edits it, and the next package starts only after the previous one is merged. No package edits `package.json`, the lockfile, migrations, `registry/*.generated.ts`, `packages/db/src/schema/index.ts` or frozen Wave 0 files. A needed dependency goes to `docs/build/dependency-requests.md`; the custom trigger migration and new env names go to the PR description for the orchestrator. Every package's done-definition includes: `pnpm typecheck`, `pnpm lint`, its Vitest suites green using `createTestDb()` and the Billit `fake.ts`, `pnpm i18n:check` when it touches catalogues.

Waves. P1 and P2 run in Wave 1 (one agent, P2 after P1 in the same worktree sequence), so `issueInvoice` and `issueCreditNote` are real when Wave 2 wires the seam "order to invoice to Billit". P3 to P7 follow in later V1 waves in order, each after the previous merge; until P4 lands, Billit documents simply stay `pending` (rule 34), which is harmless. P8 and P9 ship in Release 3, P10 in Release 4. Dependencies are acyclic at build time: finance needs only Wave 0, `commerce:recordBankTransferPaid`, `commerce:cancelOrder`, `crm:createTask` and email's `defineTemplate()` and `sendTransactional`, all mocked in tests until their owners land them; nothing in commerce, crm or email waits on a later finance package except finance's own templates (P3) and digest wiring. The runtime call pair `finance.issueManualCreditNote -> commerce.cancelOrder -> finance.issueCreditNote` runs in one transaction and is not a build dependency.

Proposal coverage in tests:
- V1 acceptance "customer can pay" and "reports reflect the transaction" (finance half): finance-P6 `e2e/finance.spec.ts` and finance-P7 `exports.test.ts`; the revenue report half is ops'.
- V1 acceptance "data can be exported": finance-P7 accountant exports (ops owns the entity export and the full export).
- V1 acceptance "deletion propagates" and scenario 7: finance-P6 `privacy.test.ts`; ops' `e2e/scenario-7-deletion.spec.ts` asserts the retained, unlinked invoice and the Billit fake call.
- Proposal "Billit integration" (V1) and "invoices, receipts, credit notes, VAT per line, company invoices, sync with Billit for accounting and Peppol" (section 5): finance-P2, P3, P4.
- SLA High severity "Billit sync failing": finance-P4 alert tests (60-minute alert, credentials alert, Peppol alert) and finance-P5 `digest.test.ts`.
- Release 3 "management and finance dashboards": finance-P8 and P9. Release 4 KPIs for custom dashboards, weekly summary and NL questions: finance-P10.
Scenarios 1 to 6 do not touch finance.

### finance-P1 (V1): schema and pure finance core

- Goal: every finance table, enum and V1 view; pure logic for VAT, numbering, snapshots, billing validation, structured communication and settings.
- Files: `packages/db/src/schema/finance.ts` (all tables of 2.2-2.7, including R3 export kinds), `packages/db/src/schema/finance.views.ts` (V1 views of 2.9), `packages/db/src/seed/finance.ts` (the `finance` settings row with empty issuer fields and the voucher VAT note in three locales; no `company` row, which platform seeds, and no retention rows, which ops seeds), `packages/core/src/finance/{index.ts,types.ts,vat.ts,numbering.ts,ogm.ts,vat-number.ts,billing.ts,snapshot.ts,seller.ts,lines.ts,immutability.ts,transitions.ts,retention.ts,settings.ts}` and tests beside them.
- Interfaces: `computeLineVat(lineTotalCents: number, ratePct: 0|6|12|21): { vatCents: number; netCents: number }`; `buildVatBreakdown(lines: InvoiceLine[]): VatBreakdownRow[]`; `formatNumber(kind: InvoiceKind, year: number, n: number): string`; `fiscalYearOf(at: Date): number` (Brussels); `structuredCommunication(year: number, n: number): string`; `normaliseVatNumber(input: string): { ok: true; value: string } | { ok: false; reason: 'format' | 'checksum' }`; `BillingDetailsInput`, `FinanceSettingSchema` (Zod, used by `config.ts`), `CompanySetting` (type of platform's key); `buildCustomerSnapshot(src: { person?: PersonForBilling; company?: CompanyForBilling; billing?: BillingDetails }): CustomerSnapshot`; `reduceSnapshot(s: CustomerSnapshot): CustomerSnapshot`; `linesFromOrderLines(rows: OrderLineForInvoice[], locale: Locale, vatNotes): { lines: InvoiceLine[]; locale: Locale }`; `creditLines(invoice: InvoiceLine[], already: InvoiceLine[][], request: CreditNoteLineInput[] | 'full'): InvoiceLine[]`; `assertMutableUpdate(patch: Record<string, unknown>, current: InvoiceRecord, mode: 'normal' | 'rewrite'): void`; `nextInvoiceStatus(kind: InvoiceKind, from: InvoiceStatus | null, to: InvoiceStatus): InvoiceStatus` (throws `InvalidTransitionError`; the table of 2.1); `buildSellerSnapshot(company: CompanySetting, finance: FinanceSetting, locale: Locale): SellerSnapshot`; `missingIssuerFields(s: SellerSnapshot): string[]`; `retentionCutoffYear(today: string, days: number, action: 'anonymise' | 'delete'): number` (counts `days` from 1 January after the fiscal year and never returns a year younger than `LEGAL_MIN_RETENTION_YEARS = 10`, i.e. 3653 days, for either action; cross-module D34); SQL text `INVOICES_GUARD_TRIGGER_SQL` exported for the orchestrator's custom migration.
- Depends on: Wave 0 (`_shared.ts`, contract tables `orders`, `order_lines`, `payments`, `refunds`, `persons`, `companies`, `files`, `users`), `commerce:refunds` table existing as a contract stub.
- Tests: `vat.test.ts` (each rate, half-up at .5, zero, negative credit lines, breakdown sorted and summed, total equals order total for 200 random baskets), `numbering.test.ts` (format, padding, year from Brussels at 23:30Z on 31 Dec), `ogm.test.ts` (mod 97, remainder 0 -> 97, format), `vat-number.test.ts` (valid BE, bad checksum, spaces and dots, NL/FR/DE formats), `snapshot.test.ts` (person, company, billing override, reduce removes email, phone and ids), `lines.test.ts` (locale fallback to nl-BE whole document, 0 % without note throws, credit beyond remaining throws, partial by amount), `immutability.test.ts` (allowed and refused columns per mode; payment columns only from null; `seller_snapshot` only before the first render; under rewrite `company_id`, `pdf_file_id` and the `{ "anonymised": true }` snapshot only for the retention sweep), `transitions.test.ts` (every row of the 2.1 table accepted, every other pair refused, repeated transition is a no-op), `seller.test.ts` (merge of platform `company` and `finance.issuer`, missing fields listed), `retention.test.ts` (3653 days of the seeded policy counted from 1 January after the fiscal year; neither `anonymise` nor `delete` reaches a fiscal year whose horizon has not passed, also with a policy edited below 3653 days), `ogm` example `+++260/0000/12395+++`, `schema.test.ts` with `createTestDb()` (tables and views exist; partial unique one live invoice per order; check constraints reject a credit note with positive total or positive `vat_cents`, an open invoice without due date, an invoice with status `issued` and a document without person, company, reduced, anonymised or walk-in snapshot; the Wave 0 columns of `invoices` and `invoice_sequences` are unchanged).
- Done: the common definition; `packages/core/src/finance` coverage at least 90 %.
- **Build order note (03-build-order.md, forward-call stubs):** this package also owns `apps/web/modules/finance/api.ts` and declares in it every finance function that another module calls (section 4 and section 10), with its final signature, as a typed stub that throws `NotImplementedError` (`issueInvoice` keeps the Wave 0 signature). Later finance packages replace the stub bodies; no signature changes without a cross-module decision.

### finance-P2 (V1): issuing service and cross-module API

- Goal: transactional issuing of invoices and credit notes with gapless numbering, settlement, billing details, events.
- Files: `apps/web/modules/finance/service/{sequences.ts,issue-invoice.ts,issue-credit-note.ts,settle.ts,billing-details.ts,invoice-state.ts}`, `apps/web/modules/finance/api.ts` (replaces the Wave 0 stub; `issueInvoice`, `issueCreditNote`, `markCreditNoteSettled`, `setOrderBillingDetails`, `getInvoiceForOrder`, `listInvoicesForPerson`, `getBillitCustomerRef`, `resyncCustomer` (enqueues `billit.push_customer` by kind; the handler lands in finance-P4); `getFinanceDigest` and `getFinanceKpis` keep throwing `NotImplementedError` until finance-P5 and finance-P10), `apps/web/modules/finance/config.ts` (the `finance` settings key: Zod schema with the `assertComplete` refinements and the production `peppol_enabled` guard, default value), `apps/web/modules/finance/events.ts`, `apps/web/modules/finance/permissions.ts`, tests in `apps/web/modules/finance/service/__tests__/`.
- Interfaces: section 4.1 signatures; `allocateNumber(tx: Tx, kind: InvoiceKind, year: number): Promise<number>`; `updateInvoiceState(tx: Tx, id: string, patch: InvoiceMutableFields): Promise<void>` (the only invoice updater); `markInvoicePaidInternal(tx, ctx, { invoiceId, paidAt, settledVia, paymentId?, bankReference? })` (sets `billit_payment_status = 'pending'` and enqueues `billit.push_payment` when the document is already in Billit and `settledVia <> 'billit'`). `issueInvoice` enqueues `finance.render_pdf` (key `invoice_pdf:<id>`) and records `invoice.issued`.
- Depends on: finance-P1; `platform:recordEvent`, `platform:enqueue`, `platform:getSetting`; `commerce:orders/order_lines/payments/refunds` tables; `crm:persons/companies` tables; `commerce:recordBankTransferPaid` (mocked in tests until commerce lands it); `crm:createTask` is not needed before finance-P4.
- Tests: `issue-invoice.test.ts` (paid order -> `BEAM-2026-000001` paid with payment method; second call `existing`; zero total skipped; open bank transfer with due date and structured communication; total mismatch throws and the transaction leaves no row and no counter change; company snapshot from billing details; numbers 1..50 consecutive across 50 orders; new year restarts at 1; after a full refund a repeated call returns the cancelled invoice as `existing`; an `open` invoice is settled by a `status: 'paid'` call (rule 2a) with payment snapshot filled; `dueOn` from commerce wins over `payment_terms_days`; anonymous POS order gets the `walk_in` snapshot and no event; `credit_balance` payment gives `payment_method = 'voucher'`, two payments give `mixed`), `invoice-state.test.ts` (each transition of the 2.1 table through `updateInvoiceState`, the database trigger refusing a guarded column, every illegal transition refused), `issue-credit-note.test.ts` (full refund, two partial refunds, over-credit refused, cancelled when fully credited, one per refund id, credit note number series independent, erased person copies reduced snapshot, a line credited in three quantity parts sums to its gross exactly, credit by amount, `issueCreditNote({ orderId, noRefund: true })` fully credits an `open` invoice and cancels it), `settle.test.ts` (open -> paid once, `invoice.paid` once, settled credit note), `numbering.concurrency.test.ts` (runs only when `BEAM_NEON_TESTS=1` with `neon-ws` on a `dev-*` branch: 20 parallel issues give 20 distinct consecutive numbers), `permissions.test.ts` (api functions refuse a customer actor for another person's data).
- Done: the common definition.

### finance-P3 (V1): PDF rendering and invoice emails

- Goal: deterministic PDFs from snapshots and the transactional invoice emails.
- Files: `packages/core/src/finance/document-model.ts` (+ test), `apps/web/modules/finance/pdf/{invoice-document.tsx,styles.ts,render.ts}`, `apps/web/modules/finance/jobs.ts` (`finance.render_pdf`, `finance.send_invoice_email`), `packages/email/src/templates/finance/{index.ts,invoice.tsx,credit-note.tsx,invoice-reminder.tsx,company-request-decided.tsx}` (with `defineTemplate()`; no other file under `packages/email/`), `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/finance.json` (keys `finance.pdf.*` including `walk_in`, `partial_credit` and `transaction_reference`, `finance.billing.*`, `finance.errors.*`, `finance.email.*`).
- Interfaces: `buildInvoiceDocumentModel(invoice: InvoiceRecord, original?: { number: string }): InvoiceDocumentModel` (pure: labels resolved with `t(locale, key)`, amounts formatted with `Intl`, B2B excl. VAT columns, B2C incl. VAT); `renderInvoicePdf(model: InvoiceDocumentModel): Promise<Uint8Array>`.
- Depends on: finance-P2; `platform:storeFile/readFile`; `email:sendTransactional` with attachments (mocked in tests until email lands it) and `email:defineTemplate` from `@beam/email/templates/define` (Wave 0 or email-P1); PDF library `@react-pdf/renderer` (requested in `docs/build/dependency-requests.md` if Wave 0 installed another renderer; the package then adapts `render.ts` only).
- Tests: `document-model.test.ts` (B2C and B2B columns, credit note heading and reference, open invoice shows IBAN and structured communication, no email or phone in the model, three locales), `render.test.ts` (PDF bytes start with `%PDF`, page count 1 for 10 lines and 2 for 40, same input gives the same text content), `jobs.test.ts` (render twice -> one file; placeholder settings in production mode -> `failed`; render enqueues the Billit push; email sent for company invoice, not for paid B2C; no recipient -> skipped; double run sends once; incomplete issuer in production refreshes `seller_snapshot` on re-render once settings are complete; PDF metadata carries title, author and language), `packages/email/src/templates/finance/templates.test.ts` (each template's props schema accepts the `data` that `finance.send_invoice_email` and the request decision build; the three document templates declare the PDF attachment; each renders in `nl-BE`, `fr-BE` and `en` with copy from `finance.email.*`; `isCourtesyCopy` adds the Peppol line), `send-invoice-email.test.ts` (the mocked `sendTransactional` receives `{ template, personId, to, locale, data, key, attachments }` with `key` = the job key and no `personId` for a walk-in or erased document).
- Done: the common definition plus `pnpm i18n:check`.

### finance-P4 (V1): Billit client, fake and sync jobs

- Goal: the Billit adapter and every Billit job and schedule.
- Files: `packages/integrations/src/billit/{client.ts,fake.ts,types.ts,index.ts}` (takes over `index.ts`, `types.ts`, `fake.ts` and `client.ts` from Wave 0's platform-P3, cross-module D47; finance owns the folder from here), `packages/core/src/finance/billit-mapping.ts` (+ test), `apps/web/modules/finance/jobs.ts` (adds `billit.push_customer`, `billit.push_invoice`, `billit.push_credit_note`, `billit.send_peppol`, `billit.push_payment`, `billit.sync_pending`, `billit.reconcile`, `finance.scan_overdue`), `apps/web/modules/finance/schedules.ts`, `apps/web/modules/finance/service/{billit-sync.ts,reconcile.ts,billit-failure.ts}`.
- Interfaces: `BillitApi` (section 6); `createBillitClient({ baseUrl, apiKey, partyId, onCall }): BillitApi` (selection between real client and fake stays in Wave 0's `lib/integrations.ts`); `toBillitOrder(invoice: InvoiceRecord, partyId: string, pdf?: Uint8Array): BillitOrderInput`; `toBillitParty(snapshot: CustomerSnapshot): BillitPartyInput`; `recordBillitFailure(db: Db, invoiceId: string, err: IntegrationError): Promise<void>`; `reconcile(tx, api, { from, to }): Promise<ReconcileIssue[]>`.
- Depends on: finance-P3; `platform:notifySlack`, `platform:getIntegrations` (`ctx.integrationLog`); `commerce:recordBankTransferPaid`; `crm:createTask`.
- Tests: `client.test.ts` (request shapes and Zod parsing against recorded JSON fixtures; 5xx/429 retryable, 4xx permanent, 401 alert flag), `billit-mapping.test.ts` (totals equal to the cent for mixed rates; credit note references original; unit price excl. VAT 4 decimals; an order paid fully with euro credit maps to normal VAT lines, `Paid = true` and the voucher method; an order paid 30 % euro credit and 70 % Bancontact keeps lines and totals of the order, no negative or discount line, method of the Bancontact payment, `Comments` with the split; a credit note refunded to euro credit registers the voucher method), `billit-jobs.test.ts` (push stores `billit_id`; lost response -> no duplicate in the fake; failure columns set and `billit_failed_since` kept across attempts; credit note waits for original; Peppol only for company; Peppol failure for a `BE` buyer raises the High alert, creates the task and sends the courtesy email, for a `NL` buyer only the email; paid document created with `Paid = true`; mark-paid after push registers the payment once, before push waits and then no-ops; `anonymiseCustomer` clears email and phone in the fake; disabled Billit leaves pending; every handler run twice -> same state), `sync-pending.test.ts` (fake `markPaid` -> invoice paid, commerce settle called once; partial payment stays open; stuck pending re-queued; alert key once per hour), `reconcile.test.ts` (missing, unknown, amount mismatch, paid mismatch, sequence gap, missing PDF; upsert per day), `scan-overdue.test.ts` (event and `payment` task once at day 7, task due next business day 10:00 when day 7 is a Saturday, no event but a task for an erased person's invoice).
- Done: the common definition.

### finance-P5 (V1): finance back office

- Goal: staff screens and actions of section 5 for V1.
- Files: `apps/web/modules/finance/{actions.ts,queries.ts,nav.ts}`, `apps/web/modules/finance/service/{reissue.ts,digest.ts}`, `apps/web/modules/finance/api.ts` (implements `getFinanceDigest`), `apps/web/modules/finance/ui/*` (invoice table, detail panels, credit note dialog, reissue dialog, mark-paid dialog, Billit block, settings summary), `apps/web/app/(admin)/admin/finance/{page.tsx,loading.tsx,error.tsx}`, `.../finance/invoices/{page.tsx,[id]/page.tsx,[id]/pdf/route.ts}`, `.../finance/sync/page.tsx`, `.../finance/requests/page.tsx`, `.../finance/settings/page.tsx`, catalogues `finance.json` (keys `finance.admin.*`).
- Interfaces: the staff actions of 4.2 except `requestFinanceExport`, `requestCompanyInvoice`, `cancelCompanyInvoiceRequest`; queries `listInvoices`, `getInvoice`, `getFinanceOverview`, `listBillitBacklog`, `listReconcileRuns`, `getReconcileRun`, `listCompanyInvoiceRequests`, `getInvoicingIdentity`; `getFinanceDigest` (4.1); `reissueToCompany(tx: Tx, ctx: Ctx, input: { invoiceId: string; billing: BillingDetails; reason: string }): Promise<{ creditNoteId: string; invoiceId: string; number: string }>` used by `reissueInvoice` and `decideCompanyInvoiceRequest`.
- Depends on: finance-P4; `platform:getSetting`, platform's `/admin/settings/[key]` editor (links only); `platform:DigestSection` type; `commerce:cancelOrder` (rule 25; mocked in tests until commerce lands it); `commerce` order detail route for links.
- Tests: `actions.test.ts` (manual credit note with and without refund flag; full manual credit of an `open` invoice calls the mocked `commerce.cancelOrder` once with the invoice's order and returns the credit note it created, `{ cancelled: false }` gives `order_not_cancellable` and writes nothing, a partial one does not call commerce; reissue creates CN plus new invoice and cancels the original, mark paid calls commerce once, retry uses a new key, reminder limited to one per 7 days, mark paid refuses a future date and a date before `issued_on`, mark paid after push enqueues `billit.push_payment`), `config.test.ts` (the `finance` key schema refuses an incomplete footer or VAT note and `peppol_enabled = false` in production), `digest.test.ts` (counts of failed and failing Billit documents, PDF failures, overdue invoices, last reconcile, nl-BE fallbacks; no names or emails in the section), `permissions.test.ts` (every action refuses without its permission; reception and marketing get `forbidden`), `queries.test.ts` (filters, search by number and name, overview counts), audit rows written for every action.
- Done: the common definition; manual check in `pnpm dev` that the pages render with seed data.

### finance-P6 (V1): customer portal, company invoice requests, privacy and retention

- Goal: portal invoice screens and PDF download, the B2C company-invoice request flow end to end, the privacy registration and the retention hook.
- Files: `apps/web/app/[locale]/(portal)/account/invoices/{page.tsx,loading.tsx,error.tsx,[id]/page.tsx,[id]/pdf/route.ts}`, `apps/web/modules/finance/ui/portal/*`, `apps/web/modules/finance/actions.ts` (adds `requestCompanyInvoice`, `cancelCompanyInvoiceRequest`), `apps/web/modules/finance/service/retention.ts`, `apps/web/modules/finance/queries.ts` (adds `listMyInvoices`, `getMyInvoice`), `apps/web/modules/finance/privacy.ts` (registration with `export`, `erase` and the four `sweep` handlers), `apps/web/modules/finance/seed.ts` (demo: three paid invoices, one open bank-transfer invoice, one credit note for the seed customer), catalogues `finance.json` (keys `finance.portal.*`), `e2e/finance.spec.ts`.
- Interfaces: `financePrivacy` (section 9) satisfying Wave 0's `PrivacyRegistration`; `sweep['finance.invoices'](tx, cutoff)`, `sweep['finance.invoice_requests'](tx, cutoff)`, `sweep['finance.billit_reconcile_runs'](tx, cutoff)`, `sweep['finance.finance_exports'](tx, cutoff)` (keys per cross-module D37), each returning the number of rows affected. The approval path reuses `reissueToCompany` from finance-P5.
- Depends on: finance-P5; `platform:PrivacyRegistration` type (`{ tables, export, erase, sweep?, retention? }`, cross-module D69) from `packages/core/src/privacy/registry-types.ts` (Wave 0); `finance.company_request_decided` template from finance-P3; `ops:retention_policies` rows seeded by ops (tests insert their own rows).
- Tests: `portal.test.ts` (own invoices only; other person's id -> not_found from query and PDF route; request inside and outside the window; one pending request per invoice; approval yields CN plus company invoice, rejection notifies), `privacy.test.ts` (export lists invoices, PDFs, billing details, requests; erase nulls `person_id`, reduces snapshots, deletes billing details and requests, nulls `billit_parties.person_id` and sets `is_anonymised`; `getBillitCustomerRef` returns the party id before erasure and null after; no finance row references the person afterwards; report has no personal data), `retention.test.ts` (`sweep['finance.invoices']` with `anonymise` on a fiscal year past 3653 days nulls `person_id` and `company_id`, sets `customer_snapshot` to `{ "anonymised": true }`, deletes the PDF file and keeps the rows, totals, lines and numbers; a fiscal year inside the horizon is untouched and logged `skipped_legal_floor` when the policy was edited below 3653 days; `delete` removes a fiscal year past the horizon with its PDFs and billing details, keeps sequences and a chain with a newer credit note; `sweep['finance.invoice_requests']`: decided requests older than 730 days deleted, pending ones kept), `e2e/finance.spec.ts` (fake Mollie purchase of a package -> portal shows `BEAM-<year>-000001` as Paid, PDF downloads; staff refund half -> credit note `CN-<year>-000001` appears in portal and admin with Billit `synced` against the fake; the paid order appears on `/admin/finance` "issued today" and in an `invoices` CSV export for today, which is the finance half of the V1 acceptance test "reporting reflects the transaction").
- Done: the common definition plus `e2e/finance.spec.ts` green against `beam_dev` at the wave checkpoint; `gdpr-coverage.test.ts` passes with the four finance tables registered.

### finance-P7 (V1): accountant CSV exports

- Goal: per-period CSV exports for the accountant.
- Files: `packages/core/src/finance/csv.ts` (+ test), `apps/web/modules/finance/service/exports.ts`, `apps/web/modules/finance/jobs.ts` (adds `finance.build_export`), `apps/web/modules/finance/actions.ts` (adds `requestFinanceExport`), `apps/web/modules/finance/queries.ts` (adds `listFinanceExports`), `apps/web/app/(admin)/admin/finance/exports/{page.tsx,[id]/route.ts}`, `apps/web/modules/finance/nav.ts` (adds Exports), catalogues `finance.json` (keys `finance.admin.exports.*`).
- Interfaces: `toCsv(header: string[], rows: Iterable<(string | number | null)[]>): string` (`;`, BOM, RFC 4180 quoting); `EXPORT_COLUMNS: Record<FinanceExportKind, string[]>`: invoices (`number, kind, issued_on, due_on, status, customer_name, customer_vat, is_company, net, vat, total, payment_method, payment_reference, reverses_number, billit_id`), invoice_lines (`number, line_no, sku, category, description, quantity, unit_incl, discount, vat_rate, net, vat, gross`), vat_summary (`month, vat_rate, kind, net, vat, gross`), payments (`paid_on, provider, method, provider_payment_id, order_id, invoice_number, amount`), deferred_revenue (`as_of, credit_kind, vat_treatment, vat_rate, units, gross, net, vat`), breakage (`month, credit_kind, vat_rate, recognised_gross, breakage_gross, breakage_net, breakage_vat, revoked_gross`) and voucher_redemptions (`redeemed_on, order_id, invoice_number, amount, is_reversed`), filled by P9.
- Depends on: finance-P6; `platform:storeFile` with `expiresAt`.
- Tests: `csv.test.ts` (quoting of `;`, quotes and newlines, BOM, decimals), `exports.test.ts` (each kind for a seeded month: row counts, sums equal `v_finance_vat_summary`; credit notes negative; period over 366 days refused; double run yields one file; audit rows for request and download; download refused without `reports.finance`).
- Done: the common definition.

### finance-P8 (R3): finance dashboard

- Goal: blueprint 43 dashboard.
- Files: `packages/db/src/schema/finance.views.ts` (adds `v_finance_revenue_daily`, `v_finance_cash_inflow_daily`, `v_finance_failed_payments`, `v_finance_recurring_monthly`), `packages/core/src/finance/periods.ts` (+ test), `apps/web/modules/finance/queries.ts` (adds `getFinanceDashboard`), `apps/web/modules/finance/ui/dashboard/*`, `apps/web/app/(admin)/admin/finance/dashboard/{page.tsx,loading.tsx}`, `apps/web/modules/finance/nav.ts`, catalogues `finance.json` (keys `finance.admin.dashboard.*`).
- Interfaces: `resolvePeriod(input: { period: 'day'|'week'|'month'|'ytd'|'custom'; from?: string; to?: string }, now: Date): { from: string; to: string; previous: { from: string; to: string }; lastYear: { from: string; to: string } }` (Brussels, ISO weeks starting Monday); `getFinanceDashboard` returns `{ tiles, revenueTrend, byCategory, byMethod, vatByRate, cashFlow, openInvoices, failedPayments, recurring }`.
- Depends on: finance-P7; `commerce:payments/orders` and `credits:memberships` tables; chart components from `packages/ui` (shadcn chart on Recharts; `recharts` requested in `docs/build/dependency-requests.md` if absent).
- Tests: `periods.test.ts` (week across a year boundary, YTD, leap year, DST change), `dashboard.test.ts` (seeded orders, refunds, failed payments and a recurring renewal: every tile equals a hand-computed value; vouchers excluded from revenue; credit notes reduce revenue on their own date), `permissions.test.ts` addition (dashboard refused without `reports.finance`).
- Done: the common definition.

### finance-P9 (R3): deferred revenue and breakage

- Goal: accounting view of unused and expired paid credits.
- Files: `apps/web/modules/finance/service/deferred.ts`, `apps/web/modules/finance/queries.ts` (adds `getDeferredRevenue`, `getBreakage`, `getVoucherRedemptions`), `apps/web/modules/finance/service/exports.ts` (adds the kinds `deferred_revenue`, `breakage`, `voucher_redemptions`), `apps/web/modules/finance/api.ts` (no change; `getFinanceKpis` lands in P10), `apps/web/app/(admin)/admin/finance/deferred/page.tsx`, `apps/web/modules/finance/nav.ts`, catalogues `finance.json` (keys `finance.admin.deferred.*`).
- Interfaces: `getDeferredRevenue(tx: Tx, input: { asOf: string }): Promise<{ total: Money3; byKind: Record<'day'|'night'|'euro', Money3>; byRate: Array<{ creditKind: 'day'|'night'|'euro'; vatTreatment: string; vatRatePct: number | null; units: number } & Money3> }>` with `Money3 = { grossCents: number; netCents: number; vatCents: number }` (today from `v_credit_liability`, a past date from `credits.getCreditLiabilityAsOf(db, endOfDayBrussels(asOf))`); `getBreakage(tx: Tx, input: { from: string; to: string }): Promise<Array<{ month: string; creditKind: 'day'|'night'|'euro'; vatRatePct: number | null; recognised: Money3; breakage: Money3; revoked: Money3 }>>` (from `v_credit_movements_monthly`: recognised = `-(consume + release)`, breakage = `-expire`, revoked = `-revoke`); `getVoucherRedemptions(tx: Tx, input: { from: string; to: string }): Promise<Array<{ redeemedOn: string; orderId: string; invoiceNumber: string | null; amountCents: number; isReversed: boolean }>>` (from `v_euro_voucher_redemptions` left-joined to the order's invoice; no person column is returned).
- Depends on: finance-P8; credits' `v_credit_liability`, `v_credit_movements_monthly`, `v_euro_voucher_redemptions` and `getCreditLiabilityAsOf(db, at)` (credits rules 65, 66; mocked with fixture rows until credits lands them).
- Tests: `deferred.test.ts` (grants and entries written through credits' real functions: 10 day credits at 2,000 cents each, after 4 consumes the deferred balance is 6 x 2,000 gross with the 21 % split; an as-of date before a consume, through `getCreditLiabilityAsOf`, counts it as unused; expiry shows as breakage in the expiry month; revoked units appear as `revoked`, not breakage; bonus grants with zero value contribute nothing; `multi_purpose` euro credit is split at 0 %; the as-of-today total equals `sum(v_credit_liability.remaining_value_cents)`; a voucher redemption lists the paying order's invoice number), export rows of `deferred_revenue`, `breakage` and `voucher_redemptions` equal the query totals.
- Done: the common definition.

### finance-P10 (R4): finance KPIs for custom dashboards, weekly summary and NL questions

- Goal: let `ops` R4 features use finance numbers without reading finance internals.
- Files: `packages/core/src/finance/kpis.ts` (+ test), `apps/web/modules/finance/service/kpis.ts`, `apps/web/modules/finance/api.ts` (implements `getFinanceKpis`), `apps/web/modules/finance/ai-views.ts` (exports `FINANCE_AI_VIEWS = ['v_finance_revenue_daily','v_finance_vat_summary','v_finance_failed_payments','v_finance_recurring_monthly']` for ops to expose in the `ai` schema; these are aggregates without any person column. `v_finance_open_invoices` is excluded because it carries customer names).
- Interfaces: `FinanceKpis = { netRevenueCents, vatCents, cashInCents, refundsCents, openInvoicesCount, openInvoicesCents, overdueCents, failedPaymentsCount, activeMemberships, recurringRevenueCents, deferredRevenueCents, breakageCents, previous: Omit<FinanceKpis, 'previous'> }`; `FINANCE_KPI_DEFINITIONS: Array<{ key: keyof FinanceKpis; label: LocalizedText; unit: 'cents' | 'count'; permission: 'reports.finance' }>`.
- Depends on: finance-P9; `ops:custom dashboards` and `ops:ai schema` consume these (ops R4 packages).
- Tests: `kpis.test.ts` (each KPI equals the dashboard query for the same period; previous period filled), `ai-views.test.ts` (no listed view has a column named `email`, `phone`, `address`, `customer_snapshot` or any `SENSITIVE_COLUMNS` member).
- Done: the common definition.

## 13. Decisions made

Additions to the architecture (tables, columns, keys, functions):
1. New tables `order_billing_details`, `invoice_requests`, `billit_parties`, `billit_reconcile_runs`, `finance_exports` (section 2), each needed by a stated requirement: company invoices at checkout, B2C invoices on request, Billit customer sync, the daily reconcile report, accountant exports.
2. New `invoices` columns: `fiscal_year`, `sequence_number`, `replaces_invoice_id`, `payment_id`, `refund_id`, `is_company`, `locale`, `currency`, `seller_snapshot`, `issued_at`, `paid_at`, `settled_via`, `payment_provider`, `payment_method`, `payment_reference`, `reason`, `pdf_status`, `emailed_at`, `billit_attempts`, `billit_last_error`, `billit_failed_since`, `peppol_status`, `issued_by`. The architecture's columns are kept unchanged.
3. New settings key `finance` (declared in `apps/web/modules/finance/config.ts`, edited with platform's generic editor) holding the invoice-only issuer fields (register court, IBAN, BIC, footer) and the finance switches. Platform's `company` key (platform's, with `vat_number`, `enterprise_number`, `address { street, postal_code, city, country }`, `support_email`, `phone`, `website`) supplies the rest of the seller block; the PDF seller block merges both. Enterprise number and website moved from `finance.issuer` to `company` at platform's review request, so each value is stored once.
4. New env names `BILLIT_PARTY_ID` and `BILLIT_BASE_URL` (orchestrator adds them to `.env.example`).
5. Cross-module functions used exactly as their owners declare them: commerce's `recordBankTransferPaid(tx, ctx, { orderId, paidOn, reference })`, email's `sendTransactional(ctx, { ..., attachments })`, crm's `createTask(tx, ctx, { ..., ownerRole, dedupeKey })`, platform's `storeFile(ctx, ...)`, `getSetting`, `notifySlack`, `getIntegrations()`. `issueInvoice` accepts commerce's call shape `{ orderId, status?, dueOn?, paymentId? }`.
6. New jobs `finance.render_pdf` (named in the architecture), `finance.send_invoice_email`, `finance.scan_overdue`, `finance.build_export`, `billit.send_peppol`, `billit.push_payment`; schedules `billit.reconcile` at 05:15 and `finance.scan_overdue` at 07:40. No Billit anonymisation job: ops' `privacy.erase_external` calls `BillitApi.anonymiseCustomer` directly.
7. Retention keys `finance.invoices` (ops row 90, 3653 days from 1 January after the fiscal year, `anonymise`), and new keys `finance.invoice_requests` (730 days), `finance.billit_reconcile_runs` (400 days) and `finance.finance_exports` (90 days), all `delete` (key format per cross-module Convention 4 and D37, horizon per D34); ops seeds the rows, finance supplies `sweep` handlers in `privacy.ts` (no `applyRetention` api function).
8. Custom migration `finance_invoices_guard.sql` with trigger `invoices_guard_immutable()`, delivered as SQL text from finance-P1 for the orchestrator.

Choices the inputs left open:
9. Every paid order with a non-zero total gets an invoice; the B2C invoice doubles as the receipt. "Invoices on request for B2C" means a company invoice in the customer's company name, by portal request within 30 days or by staff at any time, done as credit note plus reissue.
10. Bank-transfer orders are invoiced at placement as `open` with 14-day terms and a Belgian structured communication derived from year and sequence number.
11. Zero-total orders get no invoice.
12. Credit notes store negative amounts and quantities, `vat_cents` included; PDFs and Billit show them as positive amounts under a "Credit note" heading.
13. Invoice status semantics: `paid`, `open` and `cancelled` for invoices; `issued` and `paid` (refund executed) for credit notes.
14. Lines stay a jsonb snapshot (architecture); reporting flattens them in `v_finance_invoice_lines` instead of a second line table.
15. Number format has six digits per year and kind, starting at 000001; the first V1 invoice is `BEAM-2026-000001` (the architecture's tonight milestone).
16. Billit is polled, not webhooked: paid status every 15 minutes, a reconcile over 35 days daily.
17. Billit receives every B2C customer as a party (Billit is the accounting layer and needs the buyer); anonymous POS sales share one `walk_in` party; erasure reduces the party to name and address through ops' external step.
18. Billit order creation includes our PDF, so the push waits for rendering; PDF first, then push.
19. Company invoices and credit notes are sent over Peppol by Billit after the push. For Belgian VAT-registered buyers Peppol is a legal obligation since 1 January 2026: a failure is a High alert plus a finance task, and the email is only a courtesy copy. For foreign buyers email is an accepted fallback.
20. No reverse charge and no VIES call in V1: BEAM supplies in Belgium; VAT numbers are checked by format and Belgian mod-97 only.
21. Gift vouchers are multi-purpose vouchers at 0 % with a VAT note; VAT is invoiced when the voucher pays for a sale.
22. Document language is the customer's locale, or `nl-BE` for the whole document when a line lacks that locale, so legal documents never block and never mix languages.
23. PDFs never print email or phone, and their `files` rows carry `person_id = null`, so erasure keeps them intact and platform's file erasure cannot delete accounting records.
24. PDF library `@react-pdf/renderer`; CSV with `;`, UTF-8 BOM, dot decimals.
25. Consumer receipts stay with commerce; finance emails only company, open, reissued and credit-note documents, which avoids two emails per purchase.
26. Billit failure state is written by an autocommit statement before the job rethrows, so the failure survives the job transaction rollback.
27. Retry from the finance screen enqueues with a fresh key suffix (`:r<n>`), because a dead job's key would block a plain re-enqueue.
28. Overdue handling in V1 is an event, an action-dashboard line and a manual reminder (at most one per 7 days); automatic dunning is "Later".
29. Retention: the `finance.invoices` policy is 10 years (3653 days, counted from 1 January after the fiscal year, ops' seed) with action `anonymise` (person and company links nulled, snapshot reduced to `{ "anonymised": true }`, PDF deleted, totals, lines and numbers kept), matching the Belgian law of 20 November 2022 for invoices and accounting documents; the 10-year floor is the policy itself, and no sweep touches a document younger than 3653 days, so no policy edit can make the platform anonymise or delete an invoice early (cross-module D34).
30. Revenue on the dashboard is invoice-based and excludes VAT; vouchers are a liability; cash inflow uses payments and settled credit notes; comparisons use the previous equal period and the same period last year.
31. Deferred revenue and breakage are reports for the accountant (R3); the platform posts no journal entries.
32. Finance declares the permissions `invoices.read`, `invoices.issue` and `reports.finance`; editing the `company` and `finance` settings keys needs `settings.write` (platform's editor), which the finance role does not have by default; owner and management do, and the finance screen shows the current values read-only to `invoices.read`.
33. No finance work in Release 2; R4 work is limited to KPIs and AI-safe views for ops.
34. Historical invoices from Lightspeed or Billit are not imported; they stay in Billit.
35. The ten build packages are strictly sequential because they share module files; the numbering concurrency test runs only against a Neon `dev-*` branch (`BEAM_NEON_TESTS=1`), since PGlite has a single connection.
36. `issueInvoice` is idempotent per order across cancellation: it returns any existing invoice of the order, and only the reissue path creates a second invoice for the same order.
37. An `open` invoice is settled by whichever comes first: Billit's paid status (`billit.sync_pending`) or finance's "Mark paid" (`markInvoicePaid`); both call `commerce.recordBankTransferPaid`, whose paid transaction reaches finance through `issueInvoice` with `status: 'paid'` and returns `existing`. Commerce has no "Record bank transfer" button (cross-module D32). Both end in the same state and the later one is a no-op.
38. Zero-total orders get no invoice; commerce's edge case 10 is superseded (requested from commerce).
39. Payment status is pushed to Billit for documents settled in BEAM (`billit.push_payment`, or `Paid = true` at creation), so Billit's receivables match BEAM's.
40. Overdue invoices create a `payment` task for role `finance` through `crm.createTask` with a dedupe key, besides the event; automatic dunning stays "Later".
41. The invoice document locale may fall back to `nl-BE` for the whole document when a frozen line lacks the customer's locale; this is the only exception to the architecture's no-fallback rule and is logged and counted in the digest.
42. Finance owns its four email templates in `packages/email/src/templates/finance/` with copy in `finance.json` under `finance.email.*`, as email's final spec decides (email rule 15a, decision 1: each module owns its template folder; email owns `defineTemplate()`, layout, renderer, registry and seed). Keys stay dotted: `finance.invoice`, `finance.credit_note`, `finance.invoice_reminder`, `finance.company_request_decided`. Calls use email's exact `sendTransactional(ctx, { template, personId?, to?, locale, data, key, attachments? })`; the earlier `toEmail`, `props`, `idempotencyKey` names are gone.
43. Anonymous POS sales get a `walk_in` customer snapshot, no activity events and the shared Billit party; `chk_invoices_party` allows exactly this case, reduced and anonymised snapshots, and a `company` snapshot with a VAT number (a POS company sale without a CRM company, fix-w20-finance-wiring).
44. `seller_snapshot` may be refreshed only before a document's first PDF render and Billit push, so documents issued while the issuer settings were incomplete become correct without breaking immutability for anything a customer or Billit has seen.
45. Wave 0 contract columns of `invoices` and `invoice_sequences` are never altered by finance; stricter rules are added as check constraints.

Cross-module review (requests from other modules' reviews, applied or declined):
46. Platform: finance uses `ctx.integrationLog` (the Billit client's `onCall` is wired to it; the name `integrationCallLogger` is not used anywhere in this spec). Applied.
47. Platform: the seller block reads `company.vat_number`, `enterprise_number`, `address { street, postal_code, city, country }`, `support_email`, `phone` and `website` from platform's `company` key; `finance.issuer` keeps only register court, IBAN, BIC and the footer (enterprise number and website removed from it). Applied.
48. Platform: `setSetting(ctx, key, value, expectedVersion)` is the signature; finance makes no `setSetting` call at all, because it has no settings form: `company` and `finance` are edited in platform's generic editor through `updateSetting` (PL-41). Platform section 2's sentence "finance's company form writes it through `setSetting()`" is therefore wrong and is listed as a conflict for platform to correct; a second form for the same keys would duplicate the generic editor that every other module uses.
49. Commerce: orders paid partly or fully with euro credit (`credit_balance`) are invoiced and mapped to Billit with the order's own VAT lines (VAT at redemption), never a discount or negative line; `PaymentMethod` comes from `BILLIT_PAYMENT_METHOD`, `mixed` uses the largest non-credit payment and `Comments` lists the split (rules 8, 8a). Applied.
50. Commerce: a full manual credit note on an `open` (overdue) bank-transfer invoice calls `commerce.cancelOrder(tx, ctx, { orderId, reason })` in the action's transaction, so bookings and euro credit are released with the invoice; the error `finance.errors.cancel_via_order` is replaced by `finance.errors.order_not_cancellable` (rule 25, edge case 13). Applied. The runtime round trip finance -> commerce -> finance stays in one transaction and is not a build-time cycle.
51. Credits: R3 deferred revenue, breakage and voucher redemptions read credits' `v_credit_liability`, `getCreditLiabilityAsOf`, `v_credit_movements_monthly` and `v_euro_voucher_redemptions`; finance's own `v_finance_credit_movements` is dropped, the per-product split is replaced by a split per credit kind, VAT treatment and rate (what the credits views carry), and the export kind `voucher_redemptions` (R3) is added. Applied.
52. Email: calls use `(ctx, { template, personId?, to?, locale, data, key, attachments? })`. Applied. The slash keys `finance/invoice-issued` and `finance/credit-note-issued` are void (cross-module D68): transactional keys are `<m>.<name>` (cross-module Convention 1, D1), and the registry lists exactly `finance.invoice`, `finance.credit_note`, `finance.invoice_reminder` and `finance.company_request_decided` (D2). Email's same decision moves template ownership to the calling module, so finance now owns `packages/email/src/templates/finance/` and the `finance.email.*` copy (finance-P3). Applied.
53. Ops: the `finance.invoices` retention row is 3653 days with action `anonymise`, counted from the fiscal-year end (1 January after the fiscal year); the 10-year floor is the policy itself, and finance's `sweep['finance.invoices']` (`retentionCutoffYear`, `LEGAL_MIN_RETENTION_YEARS = 10`) never touches a younger document (cross-module D34). No `applyRetention` function is added: the registry's `sweep` handlers are the retention contract (no extra api function).
54. Ops: credit notes store `vat_cents` (and every amount) negative. Confirmed and enforced with `chk_invoices_vat_sign`. Ops' `v_revenue_daily` negates the stored credit-note amounts (`refunds_vat_cents = -coalesce(sum(cn.vat_cents), 0)`; cross-module D33). Negative storage is kept because the credit sums of rules 22 and 23, `v_finance_vat_summary`, `v_finance_revenue_daily` and the accountant CSVs all add documents of both kinds directly.

Cross-module decisions (`_cross-module-decisions.md`, binding):
55. Cross-module decision 2 applied: section 8, rule 38, section 10 and decision 52 use only `finance.invoice`, `finance.credit_note`, `finance.invoice_reminder` and `finance.company_request_decided`; no `finance/invoice-issued` or `finance/credit-note-issued` remains. Convention 1 applied with it: keys are `<m>.<name>` with `<name>` the file basename with `-` replaced by `_`, copy slots `finance.email.<name>.<slot>`.
56. Cross-module decision 4 applied: finance owns `templates/finance/`, its props schemas (with `isCourtesyCopy`, `decision`, `note`) and its `finance.email.*` copy; the owner paths list `packages/email/src/templates/finance/` (section 8, owner paths).
57. Cross-module decision 5 applied: every `sendTransactional` call uses `data`, `key`, `to` and `attachments` and receives `{ emailMessageId, jobId }` with no status; `resendInvoiceEmail` takes `to` (not `toEmail`); `finance.send_invoice_email` no longer expects a `suppressed` result (section 4.5, section 10 email row).
58. Cross-module decision 31 applied: `commerce.cancelOrder` returns `{ cancelled: false }` for a non-cancellable order and never throws for it; finance then fails with `finance.errors.order_not_cancellable` (rule 25).
59. Cross-module decision 32 applied: rule 27 no longer mentions a commerce "Record bank transfer" button; `commerce.recordBankTransferPaid` is called only by `markInvoicePaid` and `billit.sync_pending` (rules 2a, 27, 30a, decision 37).
60. Cross-module decision 33 applied: decision 54 records that ops negates the stored negative credit-note amounts.
61. Cross-module decision 34 applied: `finance.invoices` is 3653 days `anonymise` from 1 January after the fiscal year, the 10-year floor is the policy itself, no sweep touches a younger document, and `anonymise` nulls `person_id` and `company_id`, reduces `customer_snapshot` to `{ "anonymised": true }` and deletes the PDF (rule 45, sections 2.2, 2.8, 9, decisions 29 and 53, finance-P1 and P6 tests).
62. Cross-module decision 37 applied (Convention 4): retention keys `finance.invoices`, `finance.invoice_requests`, `finance.billit_reconcile_runs`, `finance.finance_exports` in section 9, the `sweep` map keys, finance-P6 and decision 7.
63. Cross-module decision 47 applied: Wave 0 (platform-P3) ships `packages/integrations/src/billit/{index.ts,types.ts,fake.ts,client.ts}`; finance-P4 takes over `index.ts`, `types.ts`, `fake.ts` and `client.ts` (owner paths, section 6, finance-P4 files).
64. Cross-module decision 68 applied: the slash-key review item is void (decision 52).
65. Cross-module decision 69 applied: `PrivacyRegistration = { tables, export, erase, sweep?, retention? }` (section 9, finance-P6); the erase step sets only `beam.allow_rewrite`.
66. Cross-module Convention 5 applied: idempotency and dedupe keys use snake_case nouns: `invoice_pdf:<id>`, `invoice_email:<id>:<reason>`, `billit:credit_note:<id>`, `finance_export:<id>`, `invoice_request:<id>:<state>` (sections 4.5, 4.7, finance-P2).
67. Cross-module decisions 17 and 29 need no change here: `finance.issuer` holds only `register_court`, `iban`, `bic`, `invoice_footer` and both keys are edited through platform's generic editor (decisions 47, 48); finance reads only credits' contract views and `getCreditLiabilityAsOf` (section 2.9).
