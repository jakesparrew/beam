# Module spec: finance (Invoicing, credit notes and Billit)

Module id `finance`. Owner paths: `packages/db/src/schema/finance.ts`, `packages/db/src/schema/finance.views.ts`, `packages/core/src/finance/`, `apps/web/modules/finance/`, `apps/web/app/(admin)/admin/finance/`, `apps/web/app/[locale]/(portal)/account/invoices/`, `packages/email/src/templates/finance/`, `packages/integrations/src/billit/`, `packages/core/src/i18n/messages/*/finance.json`, `packages/db/src/seed/finance.ts`, `e2e/finance.spec.ts`.

Blueprint sections: 41 (Finance and accounting), 42 (Peppol), 43 (Financial management dashboard). Also served here: 10 (portal invoices), 13 and 14 (refunds, receipts, payment status), 24 (company VAT number), 37 (resolve-payment follow-up), 38 (failed payments on the action dashboard), 53 (historical commercial data), 56 (refund issued, data exported in the audit trail), 62 and 63 (retain invoices, drop the marketing profile), 72 (integration failures monitored), 76 ("reporting reflects transaction"), 89 (Finance: transactions, Billit, invoices, payment status, reporting).

## 1. Purpose and release mapping

BEAM issues its own legal invoices and credit notes. A paid order (or an order placed on bank transfer) gets an invoice with a gapless number. A refund gets a credit note. Every document is a frozen snapshot, rendered to PDF, visible in the customer portal, emailed where needed, and pushed to Billit. Billit stays the accounting layer and the Peppol access point. BEAM owns the numbers; invoices are legally valid without Billit.

| Release | What ships in finance |
| --- | --- |
| **V1 (weeks 1-6)** | `invoices`, `invoice_sequences` and the supporting tables of section 2. Invoice on every paid order with a non-zero total, from `commerce` inside the `payments.sync` transaction. Open invoice with due date and Belgian structured communication for bank-transfer orders. Credit notes from refunds (full or partial) and from staff corrections. Gapless numbering per year and kind (`BEAM-2026-000123`, `CN-2026-000045`). VAT per line at 0, 6, 12 or 21 % with `vat_breakdown`. Company invoices with VAT number (B2B, at checkout or by staff). B2C company invoice on request (portal request, staff approval, credit note plus reissue). Customer and seller snapshots. Immutability after issue. PDF into `files` with BEAM company details from `settings.company`. Portal invoice list, detail and PDF download. Invoice email with PDF for company invoices and on request. Billit REST client and fake: push customer, push invoice, push credit note, send Peppol for company invoices, store `billit_id`, `billit.sync_pending` every 15 minutes (paid status of bank-transfer invoices, re-queue of stuck pushes, High alert after 1 hour of failure), daily `billit.reconcile` report. Finance back office: overview, invoices, invoice detail with Retry, Billit sync page, company invoice requests, accountant CSV exports (invoices, invoice lines, VAT summary, payments) per period, company and finance settings. Privacy registration, erasure with reduced snapshot, 7-year retention hook. |
| **Release 2 (weeks 9-10)** | No new finance features. R2 features of other modules (ticketing extensions, guest sharing, abandoned-checkout recovery) invoice through the unchanged `issueInvoice` and `issueCreditNote`; ticket lines carry category `ticket`. No finance build package. |
| **Release 3 (weeks 11-12)** | Finance dashboard (blueprint 43): revenue by category and payment method, open invoices, failed payments, recurring payments, refunds, VAT summary, cash inflow, revenue trends with previous-period comparison. Deferred revenue of unused credits and breakage of expired credits, on screen and as accountant CSV. |
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
| `invoices_peppol_status` | `not_applicable`, `pending`, `sent`, `failed` |
| `invoice_requests_status` | `requested`, `approved`, `rejected`, `cancelled` |
| `billit_reconcile_runs_status` | `ok`, `issues`, `failed` |
| `finance_exports_kind` | `invoices`, `invoice_lines`, `vat_summary`, `payments`, `deferred_revenue` (R3), `breakage` (R3) |
| `finance_exports_status` | `queued`, `running`, `done`, `failed` |

Status meaning. Invoice: `paid` when settled at issue (Mollie, terminal, cash, voucher) or later; `open` when issued unpaid on bank transfer; `cancelled` when credit notes cover its full total. Credit note: `issued` at creation; `paid` once the linked refund has been executed (money returned). A correction credit note without a refund stays `issued`.

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
| seller_snapshot | jsonb | no | | copy of `settings.company` at issue (addition) |
| lines | jsonb | no | | `InvoiceLine[]`, section 2.8; at least one line |
| subtotal_cents | integer | no | | sum of line `net_cents` |
| vat_cents | integer | no | | sum of line `vat_cents` |
| total_cents | integer | no | | check `total_cents = subtotal_cents + vat_cents` |
| vat_breakdown | jsonb | no | | `VatBreakdownRow[]` |
| issued_on | date | no | | Brussels date of `issued_at` |
| issued_at | timestamptz | no | `now()` | (addition) |
| due_on | date | yes | | only for `open` invoices |
| status | `invoices_status` | no | | |
| paid_at | timestamptz | yes | | (addition) |
| settled_via | `invoices_settled_via` | yes | | (addition) |
| payment_provider | text | yes | | snapshot of `payments.provider` (addition) |
| payment_method | text | yes | | snapshot: `bancontact`, `creditcard`, `terminal`, `cash`, `bank_transfer`, `voucher`, `mixed` (addition) |
| payment_reference | text | yes | | Belgian structured communication `+++260/0000/12397+++` for bank transfer (addition) |
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
| peppol_status | `invoices_peppol_status` | no | `'not_applicable'` | (addition) |
| issued_by | jsonb | no | | actor `{kind, id}` (addition) |
| created_at, updated_at | timestamptz | no | `now()` | |

Checks:
- `chk_invoices_kind_amounts`: `(kind = 'invoice' and total_cents >= 0 and subtotal_cents >= 0) or (kind = 'credit_note' and total_cents <= 0 and subtotal_cents <= 0)`. Credit notes store negative amounts and negative line quantities.
- `chk_invoices_reverses`: `(kind = 'credit_note') = (reverses_invoice_id is not null)`.
- `chk_invoices_reason`: `kind = 'invoice' or length(trim(reason)) >= 3`.
- `chk_invoices_open_due`: `status <> 'open' or (kind = 'invoice' and due_on is not null)`.
- `chk_invoices_paid_at`: `status <> 'paid' or paid_at is not null`.
- `chk_invoices_number_prefix`: `number like case kind when 'invoice' then 'BEAM-%' else 'CN-%' end`.

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

Immutability. After insert only these columns may change: `status`, `paid_at`, `settled_via`, `pdf_file_id`, `pdf_status`, `emailed_at`, `billit_*`, `peppol_status`, `updated_at`; and, only under `SET LOCAL beam.allow_rewrite = 'on'` (erasure, retention), `person_id` (to null) and `customer_snapshot` (to the reduced form). Deletes are refused except under `beam.allow_rewrite` by the retention hook. Enforced twice: in code by `updateInvoiceState()` (the only writer, which takes a typed `InvoiceMutableFields` object), and in the database by trigger `invoices_guard_immutable()` in the custom migration `finance_invoices_guard.sql`, which the orchestrator adds with `drizzle-kit generate --custom` (packages never write migrations). The trigger compares `OLD` and `NEW` for every other column and raises `invoice_immutable`.

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
| party_key | text | no | | unique; `person:<uuid>`, `company:<uuid>` or `vat:<BE0123456789>` |
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
  kind: 'person' | 'company'; name: string;            // legal name for companies, full name for persons
  email: string | null; phone: string | null;           // removed in the reduced form
  address: Address | null; vat_number: string | null; peppol_id: string | null;
  purchase_order_ref: string | null; person_id: string | null; company_id: string | null;
  is_reduced: boolean;                                  // true after erasure
};
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

`seller_snapshot` is `CompanySettings` (section 8): legal name, trade name, VAT number, enterprise number, register court, address, IBAN, BIC, email, phone, website, footer text in the document locale.

### 2.9 Views (`finance.views.ts`, Drizzle `pgView` with `sql`)

V1:
- `v_invoice_balances`: per invoice of kind `invoice`: `invoice_id, total_cents, credited_cents` (= `-coalesce(sum(cn.total_cents), 0)` over credit notes with `reverses_invoice_id = i.id`), `remaining_cents = total_cents - credited_cents`, `is_fully_credited = remaining_cents = 0`.
- `v_finance_invoice_lines`: one row per document line: `select i.id invoice_id, i.number, i.kind, i.issued_on, i.status, i.payment_method, i.is_company, l.* from invoices i cross join lateral jsonb_to_recordset(i.lines) as l(order_line_id uuid, product_id uuid, sku text, category text, description text, quantity numeric, unit_amount_cents int, discount_cents int, line_total_cents int, vat_rate_pct numeric, vat_cents int, net_cents int, credit_kind text, credit_units int)`.
- `v_finance_vat_summary`: `date_trunc('month', issued_on)::date as month`, `extract(quarter from issued_on) as quarter`, `fiscal_year`, `kind`, `vat_rate_pct`, `sum(net_cents)`, `sum(vat_cents)`, `sum(line_total_cents)`, from `v_finance_invoice_lines`, grouped.
- `v_finance_open_invoices`: invoices with `status = 'open'`: id, number, person_id, customer name, total, due_on, `days_overdue = greatest(0, (now() at time zone 'Europe/Brussels')::date - due_on)`, payment_reference, billit_status.
- `v_finance_billit_backlog`: invoices with `billit_status <> 'synced'`: id, number, kind, billit_status, billit_attempts, billit_last_error, `age_minutes`, `failing_minutes = extract(epoch from now() - billit_failed_since) / 60`.

R3 (added by finance-P8 and finance-P9):
- `v_finance_revenue_daily`: from `v_finance_invoice_lines`: `issued_on as day, category, payment_method, vat_rate_pct, sum(net_cents), sum(vat_cents), sum(line_total_cents), count(distinct invoice_id)`; credit notes included with their negative amounts, so the sum is net revenue. Category `voucher` is reported separately (a liability, not revenue).
- `v_finance_cash_inflow_daily`: union of `payments` with `status in ('paid','refunded','partially_refunded')` (`paid_at::date` in Brussels, provider, method, `amount_cents` as inflow) and credit notes with `status = 'paid'` (`paid_at`, `payment_method`, `-total_cents` as outflow).
- `v_finance_failed_payments`: `payments` with `status in ('failed','expired')` per Brussels day and method (count, amount), plus `memberships` in `past_due` (count).
- `v_finance_recurring_monthly`: invoices whose order has `channel = 'recurring'`, per month: count and gross; plus a scalar subquery of active memberships.
- `v_finance_credit_movements`: from `credit_entries` joined to `credit_grants` and `order_lines`: entry id, grant id, Brussels date, kind, `units = -quantity` for `consume|expire|revoke`, `value_gross_cents = units * unit_value_cents`, `vat_rate_pct`, `value_net_cents = value_gross - round_half_up(value_gross * rate / (100 + rate))`. Only grants with `unit_value_cents > 0` (bonus, referral and manual grants carry no value).

Tables of other modules this module reads: `orders`, `order_lines`, `payments`, `refunds`, `products` (commerce); `persons`, `companies` (crm); `credit_grants`, `credit_entries`, `memberships` (credits); `settings`, `files`, `jobs`, `retention_policies` (platform, ops). It writes other modules' tables only through their `api.ts`: `files` (platform `storeFile`), `activity_events` (`recordEvent`), `audit_log` (`audit`), `jobs` (`enqueue`), `settings` (platform `setSetting`), `email_messages` (email `sendTransactional`), `payments`/`orders` (commerce `recordBankTransferPaid`).

## 3. Business rules

Issuing
1. Every order that reaches `paid` with `total_cents > 0` has exactly one live invoice. `commerce` calls `issueInvoice` inside the same transaction that marks the order paid. A second call for the same order returns the existing invoice (`status: 'existing'`) and changes nothing.
2. An order placed with payment provider `bank_transfer` (POS or staff B2B order) gets its invoice at placement with `status = 'open'`, `due_on = issued_on + settings.finance.payment_terms_days` (default 14) and a `payment_reference`.
3. Orders with `total_cents = 0` get no invoice; `issueInvoice` returns `{ status: 'skipped', reason: 'zero_total' }`.
4. Credits consumed at booking are not sales and are never invoiced; VAT was charged when the package was sold (architecture section 6).
5. Invoice lines are copied 1:1 from `order_lines` (description, quantity, unit amount, discount, line total, VAT rate, VAT cents). Finance never re-prices; the invoice total equals `orders.total_cents`, or issuing fails with `conflict` and the paid transaction rolls back.
6. VAT per line: `vat_cents = round_half_up(line_total_cents * rate / (100 + rate))`, `net_cents = line_total_cents - vat_cents`, computed by `computeLineVat()` in `packages/core/src/finance/vat.ts`, identical to `commerce` pricing. `vat_breakdown` groups lines by rate, sorted by rate ascending, sums of line values (never recomputed from totals). Allowed rates are exactly 0, 6, 12, 21.
7. A 0 % line must carry a `vat_note`, taken from `settings.finance.vat_notes[category]` in the document locale (for example multi-purpose voucher: "VAT due on redemption"). Issuing a 0 % line without a configured note fails with `validation`.
8. Gift vouchers (`category = 'voucher'`, credit kind `euro`) are invoiced at 0 % with the voucher note; an order paid with euro credits is invoiced normally with VAT and `payment_method = 'voucher'`.

Numbering
9. Numbers are per kind and per fiscal year: `BEAM-<yyyy>-<NNNNNN>` for invoices, `CN-<yyyy>-<NNNNNN>` for credit notes, six digits zero-padded, starting at 000001 each year. `formatNumber(kind, year, n)` is the only formatter.
10. The fiscal year is the calendar year of `issued_on` in Europe/Brussels. An invoice issued at 2026-12-31T23:30Z is `BEAM-2027-000001`.
11. Numbers are gapless: allocation happens in the issuing transaction with `SELECT ... FOR UPDATE` on `invoice_sequences` (section 2.3). An aborted transaction leaves no gap. Invoices are never deleted inside the retention period.
12. Within one year and kind, a higher number never has an earlier `issued_at`. Backdating is not possible: `issued_on` is always today in Brussels.
13. The daily reconcile asserts for every (year, kind): `count(invoices) = last_number` and the numbers are exactly `1..last_number`; any difference is a `sequence_gap` issue and a High alert.

Snapshots and immutability
14. At issue the invoice stores `customer_snapshot` (from `order_billing_details` when present, else the CRM company when `orders.company_id` is set, else the person) and `seller_snapshot` (from `settings.company`). Later edits to the person, company or settings never change an issued invoice or its PDF.
15. After issue only the columns listed in section 2.2 change. Corrections are always a credit note, optionally followed by a reissued invoice.
16. The document locale is `persons.locale` (or the billing contact's order locale) when every line has a description in that locale; otherwise `nl-BE` for the whole document. A document is never mixed-language.

Company invoices (B2B) and invoices on request (B2C)
17. A company invoice requires legal name, address and a VAT number. Belgian numbers are normalised to `BE` + 10 digits and must pass the mod-97 check (`97 - (first 8 digits mod 97) = last 2 digits`); other EU numbers must match their country format (regex table in `vat-number.ts`). No VIES call in V1.
18. Company invoices show unit prices and line amounts excluding VAT plus the breakdown; consumer invoices show amounts including VAT plus the breakdown. Both print the seller VAT number, enterprise number, register court, address and IBAN.
19. Belgian VAT applies to every line; there is no reverse charge (BEAM's services are supplied at its premises in Belgium).
20. A customer may ask for a company invoice for one of their own B2C invoices within `settings.finance.company_request_window_days` (default 30) of `issued_on`, once per invoice while a request is pending. Staff with `invoices.issue` approve or reject. Approval issues, in one transaction, a full credit note (reason "Reissued to company") and a new invoice with the company snapshot, `replaces_invoice_id` set, the same lines, payment and settlement; the original becomes `cancelled`. Staff can reissue at any time with the same action.

Credit notes and refunds
21. A refund in `commerce` creates exactly one credit note through `issueCreditNote` in the same transaction (one per `refund_id`). Full refund: all lines negated. Partial refund: the listed lines with quantity or amount; VAT is recomputed per credited line with the line's rate.
22. The sum of credit notes of an invoice can never exceed the invoice total, per line and in total (checked under `SELECT ... FOR UPDATE` on the invoice row). Exceeding fails with `conflict`.
23. When credit notes cover the full total, the invoice becomes `cancelled`; an `open` invoice fully credited stops being collected.
24. A credit note becomes `paid` (with `paid_at`) when `commerce` reports the refund executed via `markCreditNoteSettled`. A correction credit note without money returned stays `issued`.
25. Staff may issue a manual credit note without a refund only with `invoices.issue`, a reason of at least 3 characters, and either on an `open` invoice (cancel unpaid bank transfer) or with the explicit flag `noRefund: true` (correction or reissue).

Settlement of bank-transfer invoices
26. `billit.sync_pending` reads Billit's paid status for every `open` invoice with a `billit_id`. When Billit reports it paid in full, the invoice becomes `paid` (`settled_via = 'billit'`, `paid_at` = Billit's paid date at 12:00 Brussels) and `commerce.recordBankTransferPaid` settles the payment and order (credits, membership, bookings follow in commerce).
27. Staff can mark an `open` invoice paid manually (`settled_via = 'manual'`, mandatory date and note, audited). A later Billit "paid" for the same invoice is a no-op.
28. A partial payment reported by Billit leaves the invoice `open` and appears in the reconcile report as `paid_mismatch`.
29. `finance.scan_overdue` emits `invoice.overdue` once per invoice (dedupe `invoice:<id>:overdue`) when `days_overdue >= 7`; the ops action dashboard lists overdue invoices from `v_finance_open_invoices`. A staff payment reminder can be sent at most once per 7 days per invoice.

Billit
30. Every issued document is pushed to Billit with our number as Billit's order number and external reference. Billit is never the source of numbers.
31. Before any create call the push job re-reads `billit_id`; when it is null it calls `findOrderByReference(number)` first, so a lost response never creates a duplicate. `billit_id` is committed before any follow-up call (Peppol send).
32. A credit note is pushed only after its original invoice is `synced`; otherwise the job retries and enqueues the original's push.
33. Company invoices with a VAT number are sent over Peppol by Billit after a successful push (`peppol_status` `pending` then `sent`). Consumer invoices are `not_applicable`. Peppol stays entirely in Billit.
34. While `settings.finance.billit_enabled = false` (local and preview without sandbox keys), push jobs succeed without calling Billit and leave `billit_status = 'pending'`; nothing is lost when it is switched on, because `billit.sync_pending` re-queues pending documents.
35. A document failing to sync for 60 minutes (`settings.finance.alert_after_minutes`) raises one High Slack alert per invoice per hour; the finance screen shows the backlog with Retry. Invoices remain legally valid while unsynced.

PDF and delivery
36. Each document gets one PDF rendered from its snapshots only (`files.kind = 'invoice_pdf'`, `files.person_id = null`, name `<number>.pdf`). An existing rendered PDF is never replaced; rendering again is allowed only when `pdf_status = 'failed'` or the file is missing.
37. The PDF never prints email or phone; it shows the seller block, buyer name and address (plus VAT number and PO reference for companies), number, issue date, due date and structured communication when open, lines, breakdown, totals, payment status, and for credit notes "Credit note for invoice <number>" and the reason.
38. Invoice email (`finance/invoice-issued`, PDF attached): sent automatically for company invoices, for open bank-transfer invoices and for reissued invoices; a credit note email (`finance/credit-note-issued`) for every credit note that has an email recipient. Consumer receipts for paid orders are sent by `commerce` and link to the portal invoice; no second email.
39. The recipient is `order_billing_details.billing_email`, else the person's email. A missing recipient skips the email and leaves `emailed_at` null; staff can resend to any address with `invoices.issue` (audited).

Portal
40. A customer sees only invoices and credit notes where `person_id = ctx.actor.personId`, newest first, with number, date, total, status and PDF download. Other people's invoices return `not_found`.

Reporting, exports and accounting (V1 and R3)
41. Revenue is invoice-based and excludes VAT: `sum(net_cents)` of invoices plus credit notes by `issued_on`; `voucher` lines are reported as voucher liability, not revenue.
42. Accountant CSVs (V1): `invoices`, `invoice_lines`, `vat_summary`, `payments` for a period of at most 366 days; `;` separator, UTF-8 with BOM, amounts in euros with a dot and two decimals, ISO dates; one header row; files expire after 7 days; every export is audited (`finance.export_requested`).
43. Deferred revenue (R3) at date D = for each grant with `unit_value_cents > 0`: remaining units at D (sum of its ledger entries with `created_at <= D`) times `unit_value_cents`, split into net and VAT with the grant's order-line rate. Breakage for a period = value of `expire` entries in the period. Revoked units (refunds) are excluded because the credit note already reverses them.
44. Dashboard comparisons (R3) compare the selected period with the previous period of equal length and the same period last year.

Retention and privacy
45. Invoices, credit notes, their PDFs and `invoice_sequences` are accounting records retained for the `retention_policies` row `invoices` (seeded 2557 days = 7 years, counted from the end of the fiscal year). They are kept on erasure with the reduced snapshot and `person_id = null`, and are never affected by marketing anonymisation.

## 4. Server surface

All files under `apps/web/modules/finance/`. Domain logic called from them lives in `apps/web/modules/finance/service/*.ts` (database) and `packages/core/src/finance/*.ts` (pure).

### 4.1 Cross-module `api.ts` (exact signatures)

```ts
import type { Tx } from '@beam/db';
import type { Ctx } from '@/lib/ctx';
import type { BillingDetails, InvoiceSummary, FinanceKpis } from '@beam/core/finance';

export type IssueInvoiceInput = { orderId: string; paymentId?: string; settlement: 'paid' | 'open' };
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

export function getInvoiceForOrder(tx: Tx, orderId: string): Promise<InvoiceSummary | null>;
/** For the crm person page and the ops privacy export. */
export function listInvoicesForPerson(tx: Tx, personId: string): Promise<InvoiceSummary[]>;
/** Called by ops privacy.retention_sweep for policy keys 'invoices', 'billit_reconcile_runs' and 'finance_exports'. */
export function applyRetention(tx: Tx, ctx: Ctx, policy: { key: 'invoices' | 'billit_reconcile_runs' | 'finance_exports'; days: number }): Promise<{ rows: number }>;
/** R4: KPIs for ops custom dashboards, weekly summary and NL questions. */
export function getFinanceKpis(tx: Tx, input: { from: string; to: string }): Promise<FinanceKpis>;

export type InvoiceSummary = { id: string; kind: 'invoice' | 'credit_note'; number: string; issuedOn: string;
  status: 'issued' | 'paid' | 'open' | 'cancelled'; totalCents: number; isCompany: boolean; pdfReady: boolean };
```

`BillingDetails` (Zod `BillingDetailsInput` in `packages/core/src/finance/billing.ts`, reused by commerce's checkout form): `{ isCompany: boolean, legalName: string(2..200), vatNumber?: string, address: Address, billingEmail?: email, purchaseOrderRef?: string(..50), peppolId?: string }`, refined by rule 17.

### 4.2 Server actions (`actions.ts`, all through `action()`)

| Action (name) | Audience, permission | Input (Zod summary) | Output | Writes |
| --- | --- | --- | --- | --- |
| `issueManualCreditNote` (`finance.credit_note.issue`) | staff, `invoices.issue` | `{ invoiceId: uuid, reason: string(3..500), lines?: CreditNoteLineInput[], noRefund: boolean }` | `{ creditNoteId, number }` | event `credit_note.issued`; audit `invoice.credit_note_issued` |
| `reissueInvoice` (`finance.invoice.reissue`) | staff, `invoices.issue` | `{ invoiceId, billing: BillingDetailsInput, reason }` | `{ creditNoteId, invoiceId, number }` | events `credit_note.issued`, `invoice.issued`; audit `invoice.reissued` |
| `markInvoicePaid` (`finance.invoice.mark_paid`) | staff, `invoices.issue` | `{ invoiceId, paidOn: date, note: string(3..500) }` | `{ ok }` | event `invoice.paid`; audit `invoice.marked_paid` (old and new status) |
| `retryBillitSync` (`finance.billit.retry`) | staff, `invoices.issue` | `{ invoiceId }` | `{ jobId }` | audit `billit.retry` |
| `retryAllBillitFailed` (`finance.billit.retry_all`) | staff, `invoices.issue` | `{}` | `{ count }` | audit `billit.retry_all` |
| `runBillitReconcileNow` (`finance.billit.reconcile`) | staff, `invoices.issue` | `{}` | `{ jobId }` | audit `billit.reconcile_requested` |
| `rerenderInvoicePdf` (`finance.pdf.rerender`) | staff, `invoices.issue` | `{ invoiceId }` (only when `pdf_status = 'failed'` or file missing) | `{ jobId }` | audit `invoice.pdf_rerendered` |
| `resendInvoiceEmail` (`finance.invoice.resend`) | staff, `invoices.issue` | `{ invoiceId, toEmail?: email }` | `{ messageId }` | event `invoice.emailed`; audit `invoice.email_resent` |
| `sendPaymentReminder` (`finance.invoice.remind`) | staff, `invoices.issue` | `{ invoiceId }` (open, overdue, none in last 7 days) | `{ messageId }` | event `invoice.reminder_sent`; audit `invoice.reminder_sent` |
| `decideCompanyInvoiceRequest` (`finance.request.decide`) | staff, `invoices.issue` | `{ requestId, decision: 'approve' \| 'reject', note?: string(..500) }` | `{ status, newInvoiceId? }` | events `invoice.company_request_decided` (+ reissue events); audit `invoice_request.approved` or `.rejected` |
| `requestFinanceExport` (`finance.export.request`) | staff, `reports.finance` | `{ kind: finance_exports_kind, from: date, to: date }` | `{ exportId }` | audit `finance.export_requested` |
| `updateCompanySettings` (`finance.settings.company`) | staff, `settings.write` | `CompanySettingsInput` (section 8) | `{ version }` | audit `settings.company_updated` (old and new value) |
| `updateFinanceSettings` (`finance.settings.finance`) | staff, `settings.write` | `FinanceSettingsInput` (section 8) | `{ version }` | audit `settings.finance_updated` |
| `requestCompanyInvoice` (`finance.request.create`) | customer | `{ invoiceId, billing: BillingDetailsInput }` (own invoice, rule 20) | `{ requestId }` | event `invoice.company_requested` |
| `cancelCompanyInvoiceRequest` (`finance.request.cancel`) | customer | `{ requestId }` (own, `requested`) | `{ ok }` | event `invoice.company_request_cancelled` |

Every staff action writes `audit_log` through the `action()` wrapper with `entity_type = 'invoice'` (or `invoice_request`, `finance_export`, `settings`) and `person_id` of the invoice. Error mapping: rule violations raise `conflict` with a message key (`finance.errors.credit_exceeds_invoice`, `finance.errors.not_open`, `finance.errors.request_window_closed`, `finance.errors.reminder_too_soon`).

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
| `getCompanySettings` / `getFinanceSettings` | `settings.write` | `{}` | current values and version |
| `listMyInvoices` | customer | `{}` | `InvoiceSummary[]` for `ctx.actor.personId` |
| `getMyInvoice` | customer | `{ id }` | snapshot view, lines, breakdown, payment state, open request |
| `getFinanceDashboard` (R3) | `reports.finance` | `{ period: 'day' \| 'week' \| 'month' \| 'ytd' \| 'custom', from?, to? }` | KPI tiles, series and comparisons (section 5) |
| `getDeferredRevenue` (R3) | `reports.finance` | `{ asOf: date }` | totals by credit kind and product, net and VAT |
| `getBreakage` (R3) | `reports.finance` | `{ from, to }` | expired value by month and product |

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
| `finance.render_pdf` | fast, 5 | `invoice-pdf:<invoice_id>` (retry action: `invoice-pdf:<id>:r<n>`) | builds `InvoiceDocumentModel` from snapshots, renders with `@react-pdf/renderer`, stores the file, sets `pdf_file_id`, `pdf_status = 'rendered'`; then enqueues the Billit push (`billit:invoice:<id>` or `billit:credit-note:<id>`) and, when rule 38 applies, `finance.send_invoice_email` | default backoff; `MissingCompanySettingsError` and template errors are `PermanentError` -> `pdf_status = 'failed'` |
| `finance.send_invoice_email` | fast, 1 | `invoice-email:<invoice_id>:<reason>` (`issued`, `resend:<n>`, `reminder:<yyyy-mm-dd>`) | calls `email.sendTransactional` with template and the PDF as attachment; sets `emailed_at`; event `invoice.emailed` | default; no recipient = success with result `skipped_no_recipient` |
| `billit.push_customer` | fast, 5 | `billit:customer:<party_key>:<snapshot_hash8>` | upserts the Billit party; stores `billit_party_id`, `snapshot_hash` | 5xx, 429, network: retryable; 4xx: permanent with `last_error` |
| `billit.push_invoice` | fast, 5 | `billit:invoice:<invoice_id>` (retry: `billit:invoice:<id>:r<attempt>`) | ensures the party inline, `findOrderByReference`, `createOrder` with PDF attachment, commits `billit_id`, `billit_status = 'synced'`; enqueues `billit.send_peppol` for company invoices | retryable as above; each failure updates `billit_attempts`, `billit_last_error`, `billit_failed_since`, `billit_status = 'failed'` in a separate autocommit statement before rethrow; 409 duplicate = re-fetch by reference |
| `billit.push_credit_note` | fast, 5 | `billit:credit-note:<invoice_id>` (retry: `...:r<attempt>`) | as push_invoice with order type credit note and the original's Billit reference | `RetryableError('original_not_synced')` while the original is not synced |
| `billit.send_peppol` | fast, 5 | `billit:peppol:<invoice_id>` | `sendOrder(billitId, 'Peppol')`; `peppol_status = 'sent'` | 4xx (receiver not on Peppol) is permanent: `peppol_status = 'failed'` and the invoice email is sent instead |
| `billit.sync_pending` | bulk, 5 | `schedule:billit.sync_pending:<minute>` | (a) up to 100 `open` invoices with `billit_id`: `getOrder`, apply rule 26/28; (b) re-enqueue pushes for `pending`/`failed` documents older than 15 minutes with no live job; (c) High alert per rule 35 through `notify.slack` key `billit-failing:<invoice_id>:<yyyy-mm-ddThh>`; self-continues with `offset` when more than 100 open | default |
| `billit.reconcile` | bulk, 9 | `schedule:billit.reconcile:<minute>` (manual: `billit:reconcile:<yyyy-mm-dd>:manual:<n>`) | checks documents issued in the last `settings.finance.reconcile_lookback_days` (35) against Billit, sequence gaps, stale pending, missing PDFs; upserts `billit_reconcile_runs`; Slack summary when issues | default; Billit unreachable -> run `failed` |
| `billit.anonymise_party` | fast, 5 | `billit:anonymise:<party_key>` | updates the Billit party to the reduced snapshot (name and address; email and phone cleared); `is_anonymised = true` | default |
| `finance.scan_overdue` | bulk, 9 | `schedule:finance.scan_overdue:<minute>` | emits `invoice.overdue` (rule 29) | default |
| `finance.build_export` | bulk, 9 | `finance-export:<export_id>` | streams rows in pages of 1,000 into a CSV, stores the file, sets `done`, `row_count` | default; after max attempts `status = 'failed'` |

All handlers are idempotent: running twice with the same payload leaves the same state (`jobs.test.ts`).

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
| `credit_note.issued` | invoice person | `{ credit_note_id, number, invoice_number, total_cents, refund_id }` | `invoice:<id>:issued` |
| `invoice.emailed` | invoice person | `{ invoice_id, number, reason }` | `invoice-email:<id>:<reason>` |
| `invoice.reminder_sent` | invoice person | `{ invoice_id, number }` | `invoice:<id>:reminder:<date>` |
| `invoice.overdue` | invoice person | `{ invoice_id, number, days_overdue, total_cents }` | `invoice:<id>:overdue` |
| `invoice.company_requested` / `invoice.company_request_decided` / `invoice.company_request_cancelled` | requester | `{ request_id, invoice_number, decision? }` | `invoice-request:<id>:<state>` |

Events carry no address, email or VAT number. When the invoice has no `person_id` but a `company_id`, events attach to the company.

## 5. Screens

All admin screens use `DataTable`, money and dates through `Intl` in `users.locale` and Europe/Brussels. Loading states are route-level `loading.tsx` skeletons; errors are route-level `error.tsx` with the request id and a Retry link. Navigation (`nav.ts`): group "Finance" with Overview, Invoices, Billit sync, Requests, Exports, Dashboard (R3), Deferred revenue (R3), Settings; entries hidden without the permission.

| Route | Who | Shows | Actions | Empty state |
| --- | --- | --- | --- | --- |
| `/admin/finance` | `invoices.read` | V1 overview tiles from `getFinanceOverview`: issued today and this month, open and overdue amount, Billit backlog (pending, failed, failing over 1 h in red), PDF failures, pending company requests, last reconcile status with issue count | links into filtered lists; "Retry all failed" (`invoices.issue`) | "No invoices yet. The first paid order creates BEAM-<year>-000001." |
| `/admin/finance/invoices` | `invoices.read` | list: number, kind badge, issue date, customer, company badge, total, status, Billit status, PDF icon; filters (period, kind, status, Billit status, B2B), search by number or customer name | open detail; CSV of the current filter via `requestFinanceExport` (`reports.finance`) | "No documents in this period." |
| `/admin/finance/invoices/[id]` | `invoices.read` | header (number, kind, status, dates, due date, structured communication), buyer and seller snapshot, lines with VAT, breakdown, totals, balance (credited, remaining), PDF preview (iframe of the PDF route), Billit block (status, id, attempts, last error, Peppol status), linked order, payments, refunds, credit notes, replaced/replacing document, company request history, timeline of related jobs | (`invoices.issue`) Issue credit note (dialog: full or lines, reason, "no refund" flag), Reissue to other customer details, Mark paid (open only), Retry Billit, Re-render PDF (failed only), Resend email, Send payment reminder (open and overdue); "Refund" links to the commerce order refund (`commerce.refund`) | not applicable; unknown id shows the 404 page |
| `/admin/finance/sync` | `invoices.read` | Billit backlog table, reconcile runs (last 30) with issues expandable per type, integration status (last successful call from `integration_calls`) | Retry one, Retry all failed, Run reconcile now (`invoices.issue`) | "Everything is in sync with Billit." |
| `/admin/finance/requests` | `invoices.read` | company invoice requests: customer, invoice, requested company details, VAT check result, age | Approve, Reject with note (`invoices.issue`) | "No open requests." |
| `/admin/finance/exports` | `reports.finance` | form (kind, period with presets: last month, last quarter, last year) and the last 50 exports with status, rows, expiry | Request export, Download | "No exports yet." |
| `/admin/finance/settings` | `settings.write` | company details (legal name, trade name, VAT, enterprise number, register court, address, IBAN, BIC, contact, invoice footer in three locales with completeness badge) and finance settings (payment terms, request window, Billit on or off, Peppol on or off, alert minutes, VAT notes per category in three locales) | Save (each form separately, versioned) | prefilled from seed |
| `/admin/finance/dashboard` (R3) | `reports.finance` | period selector (day, week, month, YTD, custom) with previous-period and last-year comparison; tiles: net revenue, VAT collected, cash inflow, refunds, open invoices (count, amount, overdue), failed payments, recurring revenue and active memberships; charts: revenue trend (daily or monthly bars with comparison line), revenue by category, revenue by payment method, VAT by rate and quarter, cash inflow vs outflow; tables: top open invoices, last failed payments | drill-down links to filtered invoice lists; CSV of each table | tiles show 0 and "No data in this period" |
| `/admin/finance/deferred` (R3) | `reports.finance` | deferred revenue as of a date by credit kind and product (units, gross, net, VAT); breakage per month with product split | export `deferred_revenue` and `breakage` CSV | "No unused paid credits." |
| `/[locale]/account/invoices` | customer (own) | list of own invoices and credit notes: number, date, total, status (Paid, Open with due date, Cancelled, Credit note), PDF link | open detail, download PDF | "You have no invoices yet." |
| `/[locale]/account/invoices/[id]` | customer (own) | document summary with lines and VAT, payment status; for open invoices IBAN and structured communication; credit notes linked to the invoice | Download PDF; "Need an invoice in your company's name?" form (rule 20, shown within the window); cancel own pending request | not applicable |

Portal loading and error states use the portal shell skeleton and the localised "Something went wrong, try again" panel. PDF links show "Being prepared" while `pdf_status = 'pending'` and refresh after 5 seconds once. No public (`/[locale]/...` site) screens are owned by finance; the checkout's "company invoice" fields are commerce's form using finance's `BillingDetailsInput` and labels from the `finance.billing.*` keys.

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
  anonymiseParty(partyId: string, reduced: BillitPartyInput): Promise<void>;  // PATCH /v1/parties/{id}
}
```

`BillitOrderInput` maps from the invoice: `OrderNumber = number`, `Reference = number`, `OrderDate = issued_on`, `ExpiryDate = due_on`, `Customer = { PartyID }`, `OrderLines` (description, quantity, unit price excl. VAT with 4 decimals, VAT percentage), `AboutInvoiceNumber` for credit notes, `PaymentReference` (structured communication), `Attachments = [{ FileName: '<number>.pdf', MimeType: 'application/pdf', FileContent: base64 }]`. Mapping lives in `packages/core/src/finance/billit-mapping.ts` (pure, unit-tested) so Billit's totals equal ours: after create the job compares Billit's `TotalIncl` with `total_cents`; a difference of more than 1 cent is an `amount_mismatch` on the next reconcile and a Normal alert.

Failure handling: `IntegrationError { provider: 'billit', retryable }`; 5xx, 408, 429 and network errors are retryable with the standard backoff (60 s to 6 h); 400 and 422 are permanent (the dead job shows Billit's validation message on the finance screen); 401 and 403 are permanent and raise one High alert ("Billit credentials rejected"). Idempotency: our number is the Billit reference, `findOrderByReference` before create, `billit_id` committed right after create, job keys per document. `fake.ts` supports `failNext(operation, { status })`, `loseResponseNext('createOrder')` (creates, then throws a timeout), `markPaid(reference, paidOn, amountCents?)`, `setPeppolReachable(vat, boolean)` and `snapshot()` for assertions.

**Resend**: indirectly through `email.sendTransactional` (email module). **Mollie**: none directly; payment facts come from `commerce` tables. **Peppol**: through Billit only.

## 7. Permissions and audit

`modules/finance/permissions.ts` declares `invoices.read`, `invoices.issue` and `reports.finance`. It also uses `settings.write` (platform) and relies on `commerce.refund` (commerce) for refunds.

| Role (seeded) | invoices.read | invoices.issue | reports.finance | settings.write (finance settings) |
| --- | --- | --- | --- | --- |
| owner, technical_admin | yes | yes | yes | yes |
| management | yes | yes | yes | yes |
| finance | yes | yes | yes | no |
| customer_service, sales, marketing, reception | no | no | no | no |
| external_partner | no | no | no | no |
| customer (portal) | own documents only | own company requests only | no | no |

The owner may grant `invoices.read` to `customer_service` at `/admin/settings/roles`. A refund (and its credit note) needs `commerce.refund`, which finance and management have.

Audited (`audit_log`, staff actor, `entity_type`, `entity_id`, `person_id`, old and new value where relevant): `invoice.credit_note_issued`, `invoice.reissued`, `invoice.marked_paid`, `invoice.email_resent`, `invoice.reminder_sent`, `invoice.pdf_rerendered`, `billit.retry`, `billit.retry_all`, `billit.reconcile_requested`, `invoice_request.approved`, `invoice_request.rejected`, `finance.export_requested`, `finance.export_downloaded`, `settings.company_updated`, `settings.finance_updated`. System issuance (from `payments.sync` and Billit sync) is recorded as activity events and in `invoices.issued_by`, not in `audit_log`. Credit notes from refunds are audited by commerce as `refund.issued` (blueprint 56 "Refund issued"); finance adds the credit note id to that row's `new_value` through the returned value. Viewing an invoice is not audited; downloading an export is.

## 8. Multi-language and content

Catalogue namespace `finance` in `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/finance.json`; `en` is the source; `pnpm i18n:check` enforces parity. Key groups:
- `finance.admin.*` (overview, invoices, invoice detail, sync, requests, exports, settings, dashboard, deferred): column headers, filters, badges, dialogs, empty states.
- `finance.portal.*`: list, detail, status labels, request form, "Being prepared".
- `finance.pdf.*`: `invoice_title`, `credit_note_title`, `number`, `issue_date`, `due_date`, `customer`, `vat_number`, `po_reference`, `description`, `quantity`, `unit_price_incl`, `unit_price_excl`, `vat_rate`, `vat_amount`, `net_amount`, `amount`, `subtotal_excl`, `vat_total`, `total_incl`, `paid_on`, `open_pay_by`, `structured_communication`, `credit_note_for`, `reason`, `page_x_of_y`, `session_date`.
- `finance.email.*`: subjects and bodies of `invoice-issued`, `credit-note-issued`, `invoice-reminder`, `company-request-decided`.
- `finance.billing.*`: labels and errors of the company invoice fields (used by commerce's checkout).
- `finance.errors.*`: action error messages.

Email templates (react-email, transactional, `packages/email/src/templates/finance/`): `invoice-issued.tsx`, `credit-note-issued.tsx`, `invoice-reminder.tsx`, `company-request-decided.tsx`. Each takes `{ locale, number, totalFormatted, dueOn?, paymentReference?, iban?, portalUrl, reason? }`. Sent in `persons.locale` (or the order locale when there is no person). A missing key raises `MissingTranslationError` (no fallback language).

LocalizedText fields: `settings.company.invoice_footer` and `settings.finance.vat_notes.<category>`. Saving either settings form calls `assertComplete(text, ['nl-BE','fr-BE','en'])` and refuses with the missing locales. Invoice line descriptions are snapshots of `order_lines.description` (already complete at product publish); rule 16 handles the remaining case.

Settings schemas (`packages/core/src/finance/settings.ts`):
- `CompanySettings` (key `company`, exists in the architecture): `{ legal_name: 'Vibrant Lifestyle Collective BV', trade_name: 'BEAM Vitality Center', vat_number, enterprise_number, register_court, address: Address, iban, bic, email, phone, website, invoice_footer: LocalizedText }`; `vat_number` and `iban` validated (mod-97). Seed values are placeholders marked `is_placeholder: true`; issuing works with placeholders but PDF rendering in production refuses them (`MissingCompanySettingsError`).
- `FinanceSettings` (new key `finance`): `{ payment_terms_days: 14, company_request_window_days: 30, billit_enabled: true, peppol_enabled: true, alert_after_minutes: 60, reconcile_lookback_days: 35, vat_notes: Record<'voucher' | 'item' | 'session' | 'night' | 'package' | 'membership' | 'ticket', LocalizedText> }` (only categories sold at 0 % need a note; the seed provides `voucher`).

## 9. Privacy

`modules/finance/privacy.ts` registers:

```ts
export const financePrivacy = {
  tables: ['invoices', 'order_billing_details', 'invoice_requests', 'billit_parties'],
  export: async (tx, personId) => ({ /* rows + PDF file references */ }),
  erase: async (tx, personId) => ([ /* per-table { table, rows, action } */ ]),
};
```

| Table | Person data | Export | Erase action | Why |
| --- | --- | --- | --- | --- |
| `invoices` | `person_id`, `customer_snapshot` | every document of the person as JSON (snapshot, lines, totals, status) plus each PDF file (`{ fileId, name }`) | `retained_legal`: `person_id = null`; `customer_snapshot` reduced to `{ kind, name, address, vat_number (companies only), peppol_id, purchase_order_ref, is_reduced: true }`, email, phone and ids removed. PDFs kept (they print no email or phone) | Belgian accounting and VAT law; blueprint 62, 63, scenario 7 |
| `order_billing_details` | legal name, address, billing email | rows for the person's orders | `deleted` for all of the person's orders (an issued invoice's snapshot already holds what the law needs; an unpaid order is expired by commerce) | data minimisation |
| `invoice_requests` | `person_id`, `billing` | rows | pending requests set `cancelled`, then all rows of the person `deleted` | no legal need after the decision |
| `billit_parties` | `person_id` link | Billit party id | `anonymised`: `person_id = null`, enqueue `billit.anonymise_party` (key `billit:anonymise:<party_key>`) | Billit keeps the invoices; its party loses email and phone |

The erase handler runs inside `privacy.erase` under `SET LOCAL beam.allow_rewrite = 'on'` (needed for the guarded invoice columns), after `commerce` and before `crm` anonymises `persons`. Its report lists counts and actions only. `finance_exports` and `billit_reconcile_runs` hold no person reference (`NO_PII_TABLES`); exported CSV files expire after 7 days. Marketing anonymisation after 3 years of inactivity (ops retention) does not touch finance tables.

Retention (`retention_policies`, enforced by ops `privacy.retention_sweep` through `finance.applyRetention`):
- `invoices`: 2557 days after the end of the fiscal year, action `delete`: deletes invoices, credit notes and their PDF files of fiscal years where `make_date(fiscal_year, 12, 31) + days < today`; `invoice_sequences` rows stay so numbering can never restart.
- `billit_reconcile_runs`: 400 days, action `delete`.
- `finance_exports` rows: 90 days (their files expire after 7 days through `files.purge_expired`).

## 10. Dependencies

Needs from other modules:

| Module | What | How |
| --- | --- | --- |
| platform | `action()`, `defineJob`, `defineEvent`, `defineSchedule`, `enqueue`, `runJobs`, `recordEvent`, `audit`, `requirePermission`, `PermanentError`/`RetryableError`, `notify.slack` job | `apps/web/lib/*` (Wave 0) |
| platform | settings `company` and `finance` | `platform.getSetting(tx, key)`, `platform.setSetting(tx, ctx, key, value)` (api.ts) |
| platform | PDF and CSV storage | `platform.storeFile(tx, { kind, name, mime, bytes, personId: null, expiresAt? }): Promise<{ fileId }>`, `platform.readFile(tx, fileId)` (api.ts); table `files` |
| platform | `integration_calls` writer callback | `platform.integrationCallLogger('billit')` |
| crm | buyer identity at issue (name, email, phone, address, locale; company name, VAT, address) | read-only on tables `persons`, `companies`; `crm.getPersonStatus` not needed |
| commerce | order, lines, payment, refund facts | read-only on `orders`, `order_lines`, `payments`, `refunds`, `products` |
| commerce | settle a bank-transfer order when Billit or staff reports payment | `commerce.recordBankTransferPaid(tx: Tx, ctx: Ctx, input: { orderId: string; paidAt: Date; amountCents: number; source: 'billit' \| 'manual' }): Promise<void>` (new commerce api function; requested in the commerce spec) |
| commerce | calls into finance | `finance.issueInvoice` in `payments.sync` (paid) and at bank-transfer placement; `finance.issueCreditNote` in the refund action; `finance.markCreditNoteSettled` when the refund is `refunded`; `finance.setOrderBillingDetails` at checkout |
| credits | R3 deferred revenue and breakage | read-only on `credit_grants`, `credit_entries`, `memberships` |
| email | invoice emails with attachment | `email.sendTransactional(tx, ctx, { template: 'finance/invoice-issued', personId?, toEmail, locale, data, attachments: [{ fileId, filename }], idempotencyKey })` (attachments support requested from the email module) |
| ops | privacy orchestration, retention sweep, action dashboard, R4 dashboards and AI views | ops calls `financePrivacy` through `GDPR_REGISTRY`, `finance.applyRetention`, reads `v_finance_open_invoices` and `v_finance_billit_backlog`, R4 calls `finance.getFinanceKpis` |

Provides to other modules: `issueInvoice`, `issueCreditNote`, `markCreditNoteSettled`, `setOrderBillingDetails`, `getInvoiceForOrder` (commerce order screen and return page), `listInvoicesForPerson` (crm person page "Invoices" tab), `applyRetention` and `getFinanceKpis` (ops), the `BillingDetailsInput` schema and `finance.billing.*` labels (commerce checkout), activity events `invoice.*` and `credit_note.*` (crm timeline, automation triggers), views `v_finance_*` and `v_invoice_balances` (ops dashboards).

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
13. **Open invoice never paid.** Day 7 overdue: `invoice.overdue` event, action dashboard line, staff reminder; the order stays `pending_payment` with no credits granted. Staff cancel with a manual credit note (rule 25), which marks the invoice `cancelled`, and commerce cancels the order.
14. **Customer changes address or name after purchase.** Issued invoices keep their snapshot. A correction is a reissue (credit note plus new invoice), never an edit.
15. **Company settings changed (new IBAN) after issue.** Old documents keep `seller_snapshot` and render identically; only new documents show the new IBAN.
16. **Company settings still placeholders at go-live.** Issuance continues (numbers must not stop sales); production PDF rendering fails permanently with `MissingCompanySettingsError`, the overview shows "PDF blocked: complete company settings", and Re-render works after the settings are saved.
17. **A product description lacks the customer's locale.** The whole document is rendered in `nl-BE` (rule 16); nothing is blocked, the line text is never mixed.
18. **Invalid or foreign VAT number at checkout.** `BillingDetailsInput` rejects a failed mod-97 or format check with a localised message; the customer can still pay as a consumer and request a company invoice later.
19. **B2C customer requests a company invoice on day 31.** The portal hides the form and the action refuses with `request_window_closed`; staff can still reissue manually.
20. **Erasure of a person with an open bank-transfer invoice.** The invoice is retained with the reduced snapshot and stays `open` (it is a legal claim); Billit's party is anonymised; reminders stop because there is no recipient any more. Collection continues in Billit.
21. **Refund for an erased person.** `issueCreditNote` copies the reduced snapshot from the original invoice; no email is sent (no recipient); the credit note is pushed to Billit normally.
22. **Zero-total order (100 % promotion).** No invoice (rule 3); the order and its credits work as usual; reporting shows no revenue for it.
23. **PDF rendering throws on one document** (font or layout bug). `pdf_status = 'failed'`, the Billit push waits for the PDF; the overview shows the failure; Re-render after a fix. The invoice number and data are unaffected.
24. **Peppol receiver unknown** (company not registered on Peppol). `billit.send_peppol` fails permanently; `peppol_status = 'failed'`; the invoice email with PDF is sent instead and the detail page shows "Sent by email, not on Peppol".
25. **Reconcile finds a Billit invoice that BEAM does not know** (someone created it by hand in Billit). Listed as `unknown_in_billit`; nothing is imported; finance decides in Billit.
26. **Export for a very large period.** Limited to 366 days per export; rows stream in pages of 1,000; a CSV above 10 MB (the `files` limit) fails with "Choose a shorter period".
27. **Retention deletes old years while a credit note in a newer year points at an old invoice.** The retention hook deletes per fiscal year only when no newer document references it (`reverses_invoice_id`/`replaces_invoice_id`); such chains are kept until the newest member expires.

## 12. Build packages

Ordering rule: the ten finance packages are **strictly sequential** (P1 -> P2 -> ... -> P10). Several of them edit the same module files (`api.ts`, `actions.ts`, `queries.ts`, `jobs.ts`, `nav.ts`, `finance.views.ts`, the three `finance.json` catalogues); each such file is listed under every package that edits it, and the next package starts only after the previous one is merged. No package edits `package.json`, the lockfile, migrations, `registry/*.generated.ts`, `packages/db/src/schema/index.ts` or frozen Wave 0 files. A needed dependency goes to `docs/build/dependency-requests.md`; the custom trigger migration and new env names go to the PR description for the orchestrator. Every package's done-definition includes: `pnpm typecheck`, `pnpm lint`, its Vitest suites green using `createTestDb()` and the Billit `fake.ts`, `pnpm i18n:check` when it touches catalogues.

### finance-P1 (V1): schema and pure finance core

- Goal: every finance table, enum and V1 view; pure logic for VAT, numbering, snapshots, billing validation, structured communication and settings.
- Files: `packages/db/src/schema/finance.ts` (all tables of 2.2-2.7, including R3 export kinds), `packages/db/src/schema/finance.views.ts` (V1 views of 2.9), `packages/db/src/seed/finance.ts` (settings `company` placeholders, `finance` defaults with the voucher VAT note, retention rows `invoices` 2557, `billit_reconcile_runs` 400, `finance_exports` 90 when absent), `packages/core/src/finance/{index.ts,types.ts,vat.ts,numbering.ts,ogm.ts,vat-number.ts,billing.ts,snapshot.ts,lines.ts,immutability.ts,settings.ts}` and tests beside them.
- Interfaces: `computeLineVat(lineTotalCents: number, ratePct: 0|6|12|21): { vatCents: number; netCents: number }`; `buildVatBreakdown(lines: InvoiceLine[]): VatBreakdownRow[]`; `formatNumber(kind: InvoiceKind, year: number, n: number): string`; `fiscalYearOf(at: Date): number` (Brussels); `structuredCommunication(year: number, n: number): string`; `normaliseVatNumber(input: string): { ok: true; value: string } | { ok: false; reason: 'format' | 'checksum' }`; `BillingDetailsInput`, `CompanySettingsInput`, `FinanceSettingsInput` (Zod); `buildCustomerSnapshot(src: { person?: PersonForBilling; company?: CompanyForBilling; billing?: BillingDetails }): CustomerSnapshot`; `reduceSnapshot(s: CustomerSnapshot): CustomerSnapshot`; `linesFromOrderLines(rows: OrderLineForInvoice[], locale: Locale, vatNotes): { lines: InvoiceLine[]; locale: Locale }`; `creditLines(invoice: InvoiceLine[], already: InvoiceLine[][], request: CreditNoteLineInput[] | 'full'): InvoiceLine[]`; `assertMutableUpdate(patch: Record<string, unknown>, mode: 'normal' | 'rewrite'): void`; SQL text `INVOICES_GUARD_TRIGGER_SQL` exported for the orchestrator's custom migration.
- Depends on: Wave 0 (`_shared.ts`, contract tables `orders`, `order_lines`, `payments`, `refunds`, `persons`, `companies`, `files`, `users`), `commerce:refunds` table existing as a contract stub.
- Tests: `vat.test.ts` (each rate, half-up at .5, zero, negative credit lines, breakdown sorted and summed, total equals order total for 200 random baskets), `numbering.test.ts` (format, padding, year from Brussels at 23:30Z on 31 Dec), `ogm.test.ts` (mod 97, remainder 0 -> 97, format), `vat-number.test.ts` (valid BE, bad checksum, spaces and dots, NL/FR/DE formats), `snapshot.test.ts` (person, company, billing override, reduce removes email, phone and ids), `lines.test.ts` (locale fallback to nl-BE whole document, 0 % without note throws, credit beyond remaining throws, partial by amount), `immutability.test.ts` (allowed and refused columns per mode), `schema.test.ts` with `createTestDb()` (tables and views exist; partial unique one live invoice per order; check constraints reject a credit note with positive total and an open invoice without due date).
- Done: the common definition; `packages/core/src/finance` coverage at least 90 %.

### finance-P2 (V1): issuing service and cross-module API

- Goal: transactional issuing of invoices and credit notes with gapless numbering, settlement, billing details, events.
- Files: `apps/web/modules/finance/service/{sequences.ts,issue-invoice.ts,issue-credit-note.ts,settle.ts,billing-details.ts,invoice-state.ts}`, `apps/web/modules/finance/api.ts` (replaces the Wave 0 stub; `issueInvoice`, `issueCreditNote`, `markCreditNoteSettled`, `setOrderBillingDetails`, `getInvoiceForOrder`, `listInvoicesForPerson`; `applyRetention` and `getFinanceKpis` keep throwing `NotImplementedError`), `apps/web/modules/finance/events.ts`, `apps/web/modules/finance/permissions.ts`, tests in `apps/web/modules/finance/service/__tests__/`.
- Interfaces: section 4.1 signatures; `allocateNumber(tx: Tx, kind: InvoiceKind, year: number): Promise<number>`; `updateInvoiceState(tx: Tx, id: string, patch: InvoiceMutableFields): Promise<void>` (the only invoice updater); `markInvoicePaidInternal(tx, ctx, { invoiceId, paidAt, settledVia })`. `issueInvoice` enqueues `finance.render_pdf` (key `invoice-pdf:<id>`) and records `invoice.issued`.
- Depends on: finance-P1; `platform:recordEvent`, `platform:enqueue`, `platform:getSetting`; `commerce:orders/order_lines/payments/refunds` tables; `crm:persons/companies` tables; `commerce:recordBankTransferPaid` (mocked in tests until commerce lands it).
- Tests: `issue-invoice.test.ts` (paid order -> `BEAM-2026-000001` paid with payment method; second call `existing`; zero total skipped; open bank transfer with due date and structured communication; total mismatch throws and the transaction leaves no row and no counter change; company snapshot from billing details; numbers 1..50 consecutive across 50 orders; new year restarts at 1), `issue-credit-note.test.ts` (full refund, two partial refunds, over-credit refused, cancelled when fully credited, one per refund id, credit note number series independent, erased person copies reduced snapshot), `settle.test.ts` (open -> paid once, `invoice.paid` once, settled credit note), `numbering.concurrency.test.ts` (runs only when `BEAM_NEON_TESTS=1` with `neon-ws` on a `dev-*` branch: 20 parallel issues give 20 distinct consecutive numbers), `permissions.test.ts` (api functions refuse a customer actor for another person's data).
- Done: the common definition.

### finance-P3 (V1): PDF rendering and invoice emails

- Goal: deterministic PDFs from snapshots and the transactional invoice emails.
- Files: `packages/core/src/finance/document-model.ts` (+ test), `apps/web/modules/finance/pdf/{invoice-document.tsx,styles.ts,render.ts}`, `apps/web/modules/finance/jobs.ts` (`finance.render_pdf`, `finance.send_invoice_email`), `packages/email/src/templates/finance/{invoice-issued.tsx,credit-note-issued.tsx,invoice-reminder.tsx,company-request-decided.tsx}`, `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/finance.json` (keys `finance.pdf.*`, `finance.email.*`, `finance.billing.*`, `finance.errors.*`).
- Interfaces: `buildInvoiceDocumentModel(invoice: InvoiceRecord, original?: { number: string }): InvoiceDocumentModel` (pure: labels resolved with `t(locale, key)`, amounts formatted with `Intl`, B2B excl. VAT columns, B2C incl. VAT); `renderInvoicePdf(model: InvoiceDocumentModel): Promise<Uint8Array>`.
- Depends on: finance-P2; `platform:storeFile/readFile`; `email:sendTransactional` with attachments; PDF library `@react-pdf/renderer` (requested in `docs/build/dependency-requests.md` if Wave 0 installed another renderer; the package then adapts `render.ts` only).
- Tests: `document-model.test.ts` (B2C and B2B columns, credit note heading and reference, open invoice shows IBAN and structured communication, no email or phone in the model, three locales), `render.test.ts` (PDF bytes start with `%PDF`, page count 1 for 10 lines and 2 for 40, same input gives the same text content), `jobs.test.ts` (render twice -> one file; placeholder settings in production mode -> `failed`; render enqueues the Billit push; email sent for company invoice, not for paid B2C; no recipient -> skipped; double run sends once), template snapshot tests in `packages/email`.
- Done: the common definition plus `pnpm i18n:check`.

### finance-P4 (V1): Billit client, fake and sync jobs

- Goal: the Billit adapter and every Billit job and schedule.
- Files: `packages/integrations/src/billit/{client.ts,fake.ts,types.ts,index.ts}` (Wave 0 created the fake stub; finance owns the folder from here), `packages/core/src/finance/billit-mapping.ts` (+ test), `apps/web/modules/finance/jobs.ts` (adds `billit.push_customer`, `billit.push_invoice`, `billit.push_credit_note`, `billit.send_peppol`, `billit.sync_pending`, `billit.reconcile`, `billit.anonymise_party`, `finance.scan_overdue`), `apps/web/modules/finance/schedules.ts`, `apps/web/modules/finance/service/{billit-sync.ts,reconcile.ts,billit-failure.ts}`.
- Interfaces: `BillitApi` (section 6); `createBillitClient(env, onCall): BillitApi` choosing the fake when `BILLIT_API_KEY` is unset or `fake`; `toBillitOrder(invoice: InvoiceRecord, partyId: string, pdf?: Uint8Array): BillitOrderInput`; `toBillitParty(snapshot: CustomerSnapshot): BillitPartyInput`; `recordBillitFailure(db: Db, invoiceId: string, err: IntegrationError): Promise<void>`; `reconcile(tx, api, { from, to }): Promise<ReconcileIssue[]>`.
- Depends on: finance-P3; `platform:notify.slack` job, `platform:integrationCallLogger`; `commerce:recordBankTransferPaid`.
- Tests: `client.test.ts` (request shapes and Zod parsing against recorded JSON fixtures; 5xx/429 retryable, 4xx permanent, 401 alert flag), `billit-mapping.test.ts` (totals equal to the cent for mixed rates; credit note references original; unit price excl. VAT 4 decimals), `billit-jobs.test.ts` (push stores `billit_id`; lost response -> no duplicate in the fake; failure columns set and `billit_failed_since` kept across attempts; credit note waits for original; Peppol only for company; disabled Billit leaves pending; every handler run twice -> same state), `sync-pending.test.ts` (fake `markPaid` -> invoice paid, commerce settle called once; partial payment stays open; stuck pending re-queued; alert key once per hour), `reconcile.test.ts` (missing, unknown, amount mismatch, paid mismatch, sequence gap, missing PDF; upsert per day), `scan-overdue.test.ts` (event once at day 7).
- Done: the common definition.

### finance-P5 (V1): finance back office

- Goal: staff screens and actions of section 5 for V1.
- Files: `apps/web/modules/finance/{actions.ts,queries.ts,nav.ts}`, `apps/web/modules/finance/service/reissue.ts`, `apps/web/modules/finance/ui/*` (invoice table, detail panels, credit note dialog, reissue dialog, mark-paid dialog, Billit block, settings forms), `apps/web/app/(admin)/admin/finance/{page.tsx,loading.tsx,error.tsx}`, `.../finance/invoices/{page.tsx,[id]/page.tsx,[id]/pdf/route.ts}`, `.../finance/sync/page.tsx`, `.../finance/requests/page.tsx`, `.../finance/settings/page.tsx`, catalogues `finance.json` (keys `finance.admin.*`).
- Interfaces: the staff actions of 4.2 except `requestFinanceExport`, `requestCompanyInvoice`, `cancelCompanyInvoiceRequest`; queries `listInvoices`, `getInvoice`, `getFinanceOverview`, `listBillitBacklog`, `listReconcileRuns`, `getReconcileRun`, `listCompanyInvoiceRequests`, `getCompanySettings`, `getFinanceSettings`; `reissueToCompany(tx: Tx, ctx: Ctx, input: { invoiceId: string; billing: BillingDetails; reason: string }): Promise<{ creditNoteId: string; invoiceId: string; number: string }>` used by `reissueInvoice` and `decideCompanyInvoiceRequest`.
- Depends on: finance-P4; `platform:setSetting`; `commerce` order detail route for links.
- Tests: `actions.test.ts` (manual credit note with and without refund flag, reissue creates CN plus new invoice and cancels the original, mark paid calls commerce once, retry uses a new key, reminder limited to one per 7 days, settings save refuses an incomplete footer), `permissions.test.ts` (every action refuses without its permission; reception and marketing get `forbidden`), `queries.test.ts` (filters, search by number and name, overview counts), audit rows written for every action.
- Done: the common definition; manual check in `pnpm dev` that the pages render with seed data.

### finance-P6 (V1): customer portal, company invoice requests, privacy and retention

- Goal: portal invoice screens and PDF download, the B2C company-invoice request flow end to end, the privacy registration and the retention hook.
- Files: `apps/web/app/[locale]/(portal)/account/invoices/{page.tsx,loading.tsx,error.tsx,[id]/page.tsx,[id]/pdf/route.ts}`, `apps/web/modules/finance/ui/portal/*`, `apps/web/modules/finance/actions.ts` (adds `requestCompanyInvoice`, `cancelCompanyInvoiceRequest`), `apps/web/modules/finance/service/retention.ts`, `apps/web/modules/finance/queries.ts` (adds `listMyInvoices`, `getMyInvoice`), `apps/web/modules/finance/api.ts` (implements `applyRetention`), `apps/web/modules/finance/privacy.ts`, `apps/web/modules/finance/seed.ts` (demo: three paid invoices, one open bank-transfer invoice, one credit note for the seed customer), catalogues `finance.json` (keys `finance.portal.*`), `e2e/finance.spec.ts`.
- Interfaces: `financePrivacy` (section 9); `applyRetention` (4.1). The approval path reuses `reissueToCompany` from finance-P5.
- Depends on: finance-P5; `ops:GDPR_REGISTRY` shape (`{ tables, export, erase }`) from `packages/core/src/privacy/registry.ts`.
- Tests: `portal.test.ts` (own invoices only; other person's id -> not_found from query and PDF route; request inside and outside the window; one pending request per invoice; approval yields CN plus company invoice, rejection notifies), `privacy.test.ts` (export lists invoices, PDFs, billing details, requests; erase nulls `person_id`, reduces snapshots, deletes billing details and requests, nulls `billit_parties.person_id` and enqueues `billit.anonymise_party`; no finance row references the person afterwards; report has no personal data), `retention.test.ts` (old fiscal year deleted with its PDFs, sequences kept, chain with a newer credit note kept), `e2e/finance.spec.ts` (fake Mollie purchase of a package -> portal shows `BEAM-<year>-000001` as Paid, PDF downloads; staff refund half -> credit note `CN-<year>-000001` appears in portal and admin with Billit `synced` against the fake).
- Done: the common definition plus `e2e/finance.spec.ts` green against `beam_dev` at the wave checkpoint; `gdpr-coverage.test.ts` passes with the four finance tables registered.

### finance-P7 (V1): accountant CSV exports

- Goal: per-period CSV exports for the accountant.
- Files: `packages/core/src/finance/csv.ts` (+ test), `apps/web/modules/finance/service/exports.ts`, `apps/web/modules/finance/jobs.ts` (adds `finance.build_export`), `apps/web/modules/finance/actions.ts` (adds `requestFinanceExport`), `apps/web/modules/finance/queries.ts` (adds `listFinanceExports`), `apps/web/app/(admin)/admin/finance/exports/{page.tsx,[id]/route.ts}`, `apps/web/modules/finance/nav.ts` (adds Exports), catalogues `finance.json` (keys `finance.admin.exports.*`).
- Interfaces: `toCsv(header: string[], rows: Iterable<(string | number | null)[]>): string` (`;`, BOM, RFC 4180 quoting); `EXPORT_COLUMNS: Record<FinanceExportKind, string[]>`: invoices (`number, kind, issued_on, due_on, status, customer_name, customer_vat, is_company, net, vat, total, payment_method, payment_reference, reverses_number, billit_id`), invoice_lines (`number, line_no, sku, category, description, quantity, unit_incl, discount, vat_rate, net, vat, gross`), vat_summary (`month, vat_rate, kind, net, vat, gross`), payments (`paid_on, provider, method, order_id, invoice_number, amount`), deferred_revenue and breakage (filled by P9).
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
- Files: `packages/db/src/schema/finance.views.ts` (adds `v_finance_credit_movements`), `apps/web/modules/finance/service/deferred.ts`, `apps/web/modules/finance/queries.ts` (adds `getDeferredRevenue`, `getBreakage`), `apps/web/modules/finance/service/exports.ts` (adds the two kinds), `apps/web/app/(admin)/admin/finance/deferred/page.tsx`, `apps/web/modules/finance/nav.ts`, catalogues `finance.json` (keys `finance.admin.deferred.*`).
- Interfaces: `getDeferredRevenue(tx: Tx, input: { asOf: string }): Promise<{ total: Money3; byKind: Record<'day'|'night'|'euro', Money3>; byProduct: Array<{ productId: string; sku: string; units: number } & Money3> }>` with `Money3 = { grossCents: number; netCents: number; vatCents: number }`; `getBreakage(tx: Tx, input: { from: string; to: string }): Promise<Array<{ month: string; productId: string; units: number } & Money3>>`.
- Depends on: finance-P8; `credits:credit_grants/credit_entries` tables (with `unit_value_cents`).
- Tests: `deferred.test.ts` (grant of 10 day credits at 2,000 cents each: after 4 consumes the balance is 6 x 2,000 gross with 21 % split; as-of date before a consume counts it as unused; expiry moves the remainder to breakage in the expiry month; revoked units excluded; bonus grants with zero value ignored; euro voucher credits at 0 %), export rows equal the query totals.
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
3. New settings key `finance` (`FinanceSettings`); the existing key `company` gets the `CompanySettings` schema owned by finance.
4. New env names `BILLIT_PARTY_ID` and `BILLIT_BASE_URL` (orchestrator adds them to `.env.example`).
5. New commerce api function `recordBankTransferPaid` and an `attachments` option on `email.sendTransactional`; both requested from their owners.
6. New jobs `finance.render_pdf` (named in the architecture), `finance.send_invoice_email`, `finance.scan_overdue`, `finance.build_export`, `billit.send_peppol`, `billit.anonymise_party`; schedules `billit.reconcile` at 05:15 and `finance.scan_overdue` at 07:40.
7. New retention keys `billit_reconcile_runs` (400 days) and `finance_exports` (90 days); `finance.applyRetention` is the hook ops' sweep calls for finance keys.
8. Custom migration `finance_invoices_guard.sql` with trigger `invoices_guard_immutable()`, delivered as SQL text from finance-P1 for the orchestrator.

Choices the inputs left open:
9. Every paid order with a non-zero total gets an invoice; the B2C invoice doubles as the receipt. "Invoices on request for B2C" means a company invoice in the customer's company name, by portal request within 30 days or by staff at any time, done as credit note plus reissue.
10. Bank-transfer orders are invoiced at placement as `open` with 14-day terms and a Belgian structured communication derived from year and sequence number.
11. Zero-total orders get no invoice.
12. Credit notes store negative amounts and quantities; PDFs and Billit show them as positive amounts under a "Credit note" heading.
13. Invoice status semantics: `paid`, `open` and `cancelled` for invoices; `issued` and `paid` (refund executed) for credit notes.
14. Lines stay a jsonb snapshot (architecture); reporting flattens them in `v_finance_invoice_lines` instead of a second line table.
15. Number format has six digits per year and kind, starting at 000001; the first V1 invoice is `BEAM-2026-000001` (the architecture's tonight milestone).
16. Billit is polled, not webhooked: paid status every 15 minutes, a reconcile over 35 days daily.
17. Billit receives every B2C customer as a party (Billit is the accounting layer and needs the buyer); erasure updates the party to name and address only.
18. Billit order creation includes our PDF, so the push waits for rendering; PDF first, then push.
19. Company invoices are sent over Peppol by Billit after the push; failure falls back to email.
20. No reverse charge and no VIES call in V1: BEAM supplies in Belgium; VAT numbers are checked by format and Belgian mod-97 only.
21. Gift vouchers are multi-purpose vouchers at 0 % with a VAT note; VAT is invoiced when the voucher pays for a sale.
22. Document language is the customer's locale, or `nl-BE` for the whole document when a line lacks that locale, so legal documents never block and never mix languages.
23. PDFs never print email or phone, and their `files` rows carry `person_id = null`, so erasure keeps them intact and platform's file erasure cannot delete accounting records.
24. PDF library `@react-pdf/renderer`; CSV with `;`, UTF-8 BOM, dot decimals.
25. Consumer receipts stay with commerce; finance emails only company, open, reissued and credit-note documents, which avoids two emails per purchase.
26. Billit failure state is written by an autocommit statement before the job rethrows, so the failure survives the job transaction rollback.
27. Retry from the finance screen enqueues with a fresh key suffix (`:r<n>`), because a dead job's key would block a plain re-enqueue.
28. Overdue handling in V1 is an event, an action-dashboard line and a manual reminder (at most one per 7 days); automatic dunning is "Later".
29. Retention: the seeded `invoices` policy is the architecture's 7 years (2557 days), counted from the end of the fiscal year. The Belgian law of 20 November 2022 raised the retention of accounting documents and VAT invoices to 10 years for documents from 2023 onwards, so the kick-off checklist sets the editable policy to 3653 days once BEAM's accountant confirms; that change is configuration only, no code.
30. Revenue on the dashboard is invoice-based and excludes VAT; vouchers are a liability; cash inflow uses payments and settled credit notes; comparisons use the previous equal period and the same period last year.
31. Deferred revenue and breakage are reports for the accountant (R3); the platform posts no journal entries.
32. Finance declares the permissions `invoices.read`, `invoices.issue` and `reports.finance`; finance settings need `settings.write`, which the finance role does not have by default.
33. No finance work in Release 2; R4 work is limited to KPIs and AI-safe views for ops.
34. Historical invoices from Lightspeed or Billit are not imported; they stay in Billit.
35. The ten build packages are strictly sequential because they share module files; the numbering concurrency test runs only against a Neon `dev-*` branch (`BEAM_NEON_TESTS=1`), since PGlite has a single connection.
