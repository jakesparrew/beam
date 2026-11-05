# Business rules

This page lists the rules that matter most in daily work, in plain words. Each rule carries its
number in the module spec, so the full text and its test are easy to find:

- "booking R28" is rule R28 in [booking.md](../plan/modules/booking.md), section 3;
- "credits rule 29" is rule 29 in [credits.md](../plan/modules/credits.md), section 3;
- the same for [commerce.md](../plan/modules/commerce.md), [finance.md](../plan/modules/finance.md),
  [crm.md](../plan/modules/crm.md) (rules "3.n"), [email.md](../plan/modules/email.md),
  [automation.md](../plan/modules/automation.md) ("A-n"), [forms.md](../plan/modules/forms.md)
  ("F1", "U3", ...) and [platform.md](../plan/modules/platform.md) ("PL-n").

**When a rule changes, this page changes in the same pull request** (PL-91).

Many numbers below are **settings**, not code. They are marked "setting" and can be changed by a
user with `settings.write` on `/admin/settings` (booking rules also on `/admin/sessions/rules`).
Every change is audited.

## Bookings and cancellation

| Rule | What it says | Spec |
| --- | --- | --- |
| Who sees a session | Customers see open sessions up to 60 days ahead (setting `booking_horizon_days`). Night sessions close for booking 2 hours before the start (setting) | booking R7 |
| One booking per session | A person holds at most one live booking per session | booking R14 |
| Capacity is strict | Two people trying for the last place: exactly one succeeds. Only staff with `bookings.override` can book past capacity, and it is flagged | booking R10, R12 |
| Members-only sessions | Need a real, active membership (or one in its grace period after a failed payment) | booking R15 |
| How a booking is paid | With credits when the customer has enough of the right kind, otherwise through an order (online payment); reception can also let people pay at the desk | booking R16 to R18, R63 |
| Prices | Always come from commerce. Booking never calculates money | booking R19 |
| Free cancellation | Day sessions until 24 hours before the start, nights until 72 hours before, events never (all settings `free_cancel_hours`). Credits come back; paid lines are refunded with a credit note | booking R28 |
| Late cancellation | After the free window: status `late_cancelled`, the credit stays used and nothing is refunded (unless setting `late_cancel_releases_credit` is on) | booking R29 |
| Guests | Cancelling the owner asks whether to cancel the guests too (default yes) | booking R30 |
| Rescheduling | Cancels the old booking and creates the new one in one step, at most 2 times per booking (setting) | booking R31 |
| Staff override | Staff with `bookings.override` can cancel with credit back or a refund outside the window, with a reason | booking R32 |
| BEAM cancels a session | Every booking is cancelled, credits come back, paid lines are refunded, everyone gets an email | booking R33 |
| Check-in | From 2 hours before the start to 2 hours after the end (settings). It can be undone in the same window | booking R35, R36 |
| No-show | Confirmed bookings not checked in are marked `no_show` 2 hours after the end (setting `no_show`, can be off). The credit stays used | booking R37 |
| What counts as a visit | Only a checked-in booking (`booking.attended`). No-shows and cancellations never count and never trigger a review request | booking R38 |
| Reminders | Day sessions 24 hours before, nights 48 hours before (settings `reminder_hours_before`) | booking R60 |
| Withdrawal right | A booking for a fixed date has no 14-day withdrawal right (Belgian law, art. VI.53 12°); packages, memberships and vouchers bought online do (14 days) | booking R28, commerce rule 54 |
| Closed days | Belgian public holidays and closures stop new sessions on those days; credits can be extended in bulk for a closure | booking R4, R4b; credits rule 32a |

## Waitlist

| Rule | What it says | Spec |
| --- | --- | --- |
| Joining | Only for an open, full session the person may book and is not already in | booking R40 |
| Offers | When a place frees up, the next person gets an email with a single-use claim link. The offer is valid for the session's claim window (default 120 minutes) and ends at the latest 60 minutes before the start (setting) | booking R34, R42 |
| No rushed offers | No offer is made if less than 15 minutes would be left to claim it (setting) | booking R42 |
| Claiming | Opening the link changes nothing (mail scanners open links); the customer must press "claim". Under the session lock, the place is checked again | booking R44 |
| Expiry | An unclaimed offer expires and the next person is offered, every minute | booking R45 |
| Limits | At most 2 offers per person per session (setting); suspicious duplicate entries are flagged for staff | booking R42, R48 |
| Staff | Staff with `waitlist.manage` can offer, move, reorder or remove entries; every change is audited | booking R49 |

## Credits and packages

A package gives a number of **credits** (units) of one kind: `day` (sessions), `night` (overnight
stays) or `euro` (gift vouchers and store credit, counted in cents). Customers see "4 sessions
remaining", never the word "credits".

| Rule | What it says | Spec |
| --- | --- | --- |
| No balance column | The balance is the sum of the ledger entries (`credit_entries`). Entries are never changed; corrections are new entries | credits rules 7, 11 |
| Never negative | A use that would make a balance negative is refused | credits rule 9 |
| Which package is used first | The customer's own packages first, then packages shared with them; within those, the one that expires first | credits rules 13, 14 |
| Not enough credits | Nothing is used, and the customer is offered to pay instead | credits rule 16 |
| Guests | A guest can use the owner's package only if the package allows sharing, at most 2 guest uses per month by default | credits rule 17 |
| Thresholds | At 50 %, 75 %, 80 % and 90 % used, and at the last unit, an event is written; the package journeys use them | credits rules 21, 22 |
| Cancellation | A cancellation inside the window gives the credit back; a late cancellation or no-show does not | credits rules 24, 25 |
| Expiry | Packages expire at their end date, at 00:05 Brussels time. Warnings go out 30 and 7 days before (settings) | credits rules 29, 30 |
| Extension | Staff with `credits.adjust` can extend a package, also one that expired less than a year ago (the units come back) | credits rules 31, 32 |
| Adjustments | Always with a reason of at least 3 characters and an audit row; a minus can not exceed the balance | credits rule 33 |
| Refund of a package | The unused units are revoked; the refund is pro rata to unused units by default | credits rule 27, commerce rule 36 |
| Nightly check | `ledger.reconcile` compares bookings paid with credits to the ledger every night and alerts on any difference | architecture section 6 |

## Memberships

| Rule | What it says | Spec |
| --- | --- | --- |
| One at a time | A person has at most one active membership and at most one waiting to start | credits rule 47 |
| Included credits | Each period grants its included credits, valid only for that period (no rollover) | credits rule 46 |
| Renewal | With a direct-debit mandate the renewal is charged 3 days before the period ends; without one, a payment link order is made 7 days before | credits rules 48, 52 |
| Failed payment | First failure: `past_due` (member benefits stay during the grace period); retries on day 3 and day 7; on day 10 the membership expires | credits rules 50, 51; architecture section 6 |
| Cancelling | At the end of the period (customer or staff), or right away by staff with a reason | credits rules 53, 54 |
| Changing plan | Cancel at period end and buy the new plan, which starts when the old one ends | credits rule 57 |

## Prices, promotions and discounts

| Rule | What it says | Spec |
| --- | --- | --- |
| Prices include VAT | Prices are stored in cents, VAT included | commerce rule 11 |
| Price versions | A price change adds a new version; old orders keep the price they were sold at, forever | commerce rules 4, 15 |
| Audiences | A price can differ for the public, members and companies (B2B) | commerce rules 5, 7 |
| Best single discount | The customer gets the best one of: personal price, member price, member discount, automatic promotion, promotion code. Discounts never stack | commerce rules 8, 9 |
| No member discount on vouchers or memberships | Promotions reach them only when listed explicitly | commerce rule 12 |
| Promotion codes | An unknown, expired or used-up code gives a clear warning, never an error. Once used, a promotion's value cannot change | commerce rules 13, 18 |
| Price trace | Every order line stores exactly how its price was found | commerce rule 14 |
| Price changed during checkout | The customer sees "The price changed" with the new total before paying | commerce rule 16 |
| Double click | A second submit of the same checkout returns the same order; nothing is created twice | commerce rule 20 |
| Open orders | An unpaid online order expires after 30 minutes (setting `order_expiry_minutes`) and its reserved places are released | commerce rule 22 |

## VAT and invoices

| Rule | What it says | Spec |
| --- | --- | --- |
| VAT per line | `vat = round_half_up(line total × rate / (100 + rate))`, per line, then summed | commerce rule 11, finance rule 6 |
| Default rates | Day sessions and day packages 21 %, night sessions and night packages 6 %, memberships 21 %. A package has exactly one credit kind and one VAT rate | commerce rule 2 |
| VAT at sale | VAT on a package is charged when it is sold. Using credits later is not a sale and is never invoiced | finance rule 4, architecture section 6 |
| Gift vouchers | Sold at 0 % VAT (multi-purpose voucher, with a note on the invoice); VAT is charged on what is bought with them. Valid at least 2 years | commerce rule 46, finance rule 8 |
| One invoice per paid order | Every paid order above €0 gets exactly one invoice, in the same step as the payment. €0 orders get none | finance rules 1, 3 |
| Numbering | `BEAM-<year>-000001` for invoices, `CN-<year>-000001` for credit notes, gapless, per calendar year in Brussels time, never backdated | finance rules 9 to 12 |
| Never edited | Corrections are always a credit note (and a new invoice if needed) | finance rule 15 |
| Language | The invoice uses the customer's language if every line has a text in it, otherwise Dutch; never mixed | finance rule 16 |
| Company invoices | Need legal name, address and a valid VAT number; they show amounts excluding VAT. Belgian B2B invoices go over Peppol through Billit | finance rules 17 to 19a |
| Company invoice afterwards | A customer can ask within 30 days (setting) to turn their invoice into a company invoice | finance rule 20 |
| Refunds | Every refund creates exactly one credit note. A refund above €500, or on an order older than 365 days, also needs `invoices.issue` | commerce rules 39, 40; finance rule 21 |
| Billit | Billit is the accounting and Peppol layer; BEAM keeps the numbers. Invoices stay valid when Billit is down | architecture section 8 |

## Consent and unsubscribing

| Rule | What it says | Spec |
| --- | --- | --- |
| Per purpose | Consent is recorded per purpose: `newsletter`, `events`, `member_comms`, `b2b`, plus `sensitive_processing` and `ai_processing` for forms. Each record keeps date, source and the exact wording version | crm rules 3.13, 3.14 |
| Never overwritten | Consent records are only added. The current state is the latest record per purpose | crm rule 3.13 |
| No hidden consent | A result page or a purchase never creates newsletter consent; only a ticked box does | crm rule 3.15 |
| Unsubscribe | Withdrawing a purpose adds a suppression at once; "unsubscribe from everything" suppresses all marketing. Running marketing journeys stop within seconds | crm rules 3.16, 3.17; automation A-23 |
| Bounces and complaints | A hard bounce or a spam complaint suppresses all email to that address | crm rule 3.18 |
| Suppressions are permanent | A suppression is never deleted. An import can never undo an unsubscribe | crm rules 3.19, 3.20 |
| Coming back | A person who unsubscribed and ticks the box on a form again must confirm by email first | crm rule 3.21 |
| Children | Marketing consent is not recorded for someone younger than 13 | crm rule 3.53 |
| Every marketing email | Has a one-click unsubscribe link and header, and the legal footer of Vibrant Lifestyle Collective BV | email rules 2, 4 |

## Languages

| Rule | What it says | Spec |
| --- | --- | --- |
| Three languages | Dutch (`nl-BE`, default), French (`fr-BE`) and English (`en`) on every screen, email, form and page | PL-62 |
| No fallback | A missing translation blocks the send (`blocked_translation`) or the publish; the wrong language is never shown | PL-63, PL-64; architecture section 5 |
| Person's language | Each person has one language, set at first contact, which drives every email and portal page | crm rule 3.5 |

## Privacy and retention

| Data | Kept | Then | Key |
| --- | --- | --- | --- |
| Marketing profile without activity | 3 years | anonymised | `ops.marketing_profile` |
| Leads | 2 years | anonymised | `ops.marketing_contact` |
| Invoices, orders and accounting records | 10 years (from 1 January after the fiscal year) | anonymised, numbers and totals kept | `finance.invoices`, `commerce.orders` |
| Audit log | 5 years | deleted | `platform.audit_log` |
| AI request log | 30 days | deleted | `platform.ai_requests` |
| Webhook and integration logs | 90 days | deleted | `platform.webhook_events`, `platform.integration_calls` |
| Form submissions and their sensitive answers | 3 years | deleted (sensitive answers first) | `forms.form_submissions`, `forms.form_sensitive_answers` |
| Email events, watch time | 2 years | deleted | `email.email_events`, `webinar.watch_segments` |
| Export files | 7 days | deleted | `platform.files_export` |
| Suppressions and consent records | kept | never deleted | `crm.suppressions`, `crm.consent_records` |

The retention rules are rows in `retention_policies` and run nightly (`privacy.retention_sweep`,
01:00); `/admin/privacy/retention` shows them. A customer's request for a copy of their data or
for deletion is handled on `/admin/privacy` (`privacy.run`); see
[core-workflows.md](core-workflows.md#5-deleting-a-customer-gdpr-erasure) for what deletion does.
