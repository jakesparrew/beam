# Module spec: booking (Booking, capacity, events and waitlists)

Owner paths: `packages/db/src/schema/booking.ts`, `packages/db/src/schema/booking.views.ts`, `packages/core/src/booking/`, `apps/web/modules/booking/`, `apps/web/app/(admin)/admin/{sessions,bookings,waitlist}/`, `apps/web/app/[locale]/(portal)/account/{book,bookings,waitlist}/`, `apps/web/app/[locale]/(site)/claim/`, `apps/web/app/api/public/claim/`, `packages/email/src/templates/booking/` (architecture section 11 gives each module package its template folder; see decision 37), `packages/core/src/i18n/messages/*/booking.json`, `packages/db/src/seed/booking.ts`, `e2e/booking.spec.ts`, `e2e/scenario-3-lead-access.spec.ts`, `e2e/scenario-4-seat-claim.spec.ts`.

Blueprint sections: 7, 8, 9, 10, 15, 19, 48, 49, plus booking requirements in 5 (timeline), 12 (member-only and waitlist rules), 21 and 31 (reminders, review requests, inactivity guard), 22 (retention inputs), 53 (booking history import), 56 (audit of booking and waitlist changes), 62 and 63 (deletion and retention of bookings and waitlists), 14 (POS walk-ins and desk payment), 72 and the proposal SLA (booking health monitoring), 76 and 87 (acceptance tests and scenarios 1 for reminders, 3, 4, and 7 for waitlist deletion), proposal questions 3 (rooms), 4 (gift vouchers) and 6 (Lead Magnet timing).

## 1. Purpose and release mapping

The booking module replaces SimplyBook. It owns the schedule (templates, exceptions, materialised sessions), capacity (seats, beds, holds), bookings for day sessions, nights and events, attendance and check-in, the waitlist with expiring claim links, and the Lead Magnet access engine. It emits the booking facts that the timeline, automations, retention and reports use. It never stores identity (that is `crm.persons`), money (that is `commerce`) or balances (that is `credits`).

| Release | Weeks | What ships in this module |
| --- | --- | --- |
| **V1** | 1-6 | Session templates with weekdays, start times, durations, capacities and validity; sessions materialised 90 days ahead and regenerated on template change without touching booked sessions; exceptions (closed days, holidays, special hours); one-off sessions; capacity holds (staff, partner, host, speaker, blocked); day sessions counting seats and nights counting beds; guests (individual or shared bed); bookings from the portal and by staff (manual, override, over capacity); payment by credits, order, guest use of a shared package, or free; rescheduling and cancellation under `settings.booking_rules`; confirmation and reminder emails (day and night; event reminders come from automation's `event-registration` sequence); check-in by QR code and name search, with pay-at-desk bookings settled at the counter; printable day list for reception; no-show marking; basic events (session of kind `event` with an `event_category`, one price through `sessions.product_id`, capacity, holds, registration, attendance); terms and house-rules acceptance on the first booking (through `site`); Belgian public holidays offered as one-click exceptions; `settings.business_hours`; waitlist with the full seat-offer state machine, real expiring single-use claim links, duplicate protection and protected confirmed seats (single `public` queue); `v_session_availability`, `v_person_bookings`, `v_session_utilisation` (capacity utilisation data for basic reporting); future-booking import (`importBooking`) for the SimplyBook cut-over; booking health signals for monitoring; portal pages (WCAG 2.1 AA) and admin screens. If BEAM confirms at the week-1 kick-off that a Lead Magnet event is planned before week 9 (proposal question 6), booking-P7 moves into Wave 2 unchanged behind its flag. |
| **Release 2** | 9-10 | Lead Magnet activation: lead-reserved seats, lead window in Europe/Brussels, release rule, `lead`/`customer`/`public` queues, "Opens for you on ..." messaging, optional visible waitlist position, waiting lead who buys moves to the customer queue (scenario 3 and the R2 acceptance tests). Events and ticketing extensions: multiple `ticket_types` per event with product-based prices, member-only types, capacity per type and sales windows; guest information per ticket; post-event follow-up event `booking.event_ended`; `booking.lead_window_open` claim email. Webinar sessions written through `upsertWebinarSession` / `cancelWebinarSession`. No-show and cancellation reporting: the screens are ops' R2 report over ops' V1 view `v_no_show_report`, which reads this module's tables; this module guarantees the columns it needs (`cancel_reason_code`, `cancelled_at`, `paid_with`, `order_line_id`). Guest and package-sharing controls: remaining guest uses shown at booking time (from `credits.checkCredits`); the abuse review list is credits' `v_sharing_review`. (Guest bookings and the guest confirmation email are V1.) |
| **Release 3** | 11-12 | Partner management: `external_partner` users see and fill their own partner holds (`partner.own`) at `/admin/sessions/holds`; partner-attributed bookings feed the referral and partner reports owned by `ops`. |
| **Release 4** | 13-14 | No new booking behaviour or code. Ops' `ai` schema exposes `ai.bookings` (ops-owned SQL over `bookings` and `sessions`, ids and non-personal columns only) and may add `v_session_utilisation`; booking-frequency inputs come from the V1 `getPersonBookingSummary` for churn and repurchase indicators built by `ops`. |
| **Later** (out of scope) | - | Native mobile app (blueprint 81), gamification (52), voice AI booking, predictive no-show models, room, staff or equipment assignment per session (proposal question 3 answered as "seats and beds only"), SMS reminders, door access integration. |

## 2. Domain model

All tables live in `packages/db/src/schema/booking.ts`; views in `packages/db/src/schema/booking.views.ts`. Conventions from the architecture apply: `id uuid pk default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` on mutable tables, enums named `<table>_<column>`, `LocalizedText` jsonb via `localized()`. None of this module's tables is APPEND or IMMUTABLE: the append-only history of booking facts is `activity_events` (crm), money is in `order_lines` (commerce) and credit use is in `credit_entries` (credits). This module has **no sensitive columns**; staff are told in the UI that `notes` and `cancel_reason` must not contain health information (health notes go to `crm.person_sensitive_fields`).

### Enums

| Enum | Values |
| --- | --- |
| `session_templates_kind`, `sessions_kind` | `day`, `night`, `event` |
| `session_templates_credit_kind`, `sessions_credit_kind` | `day`, `night` |
| `sessions_status` | `open`, `closed`, `cancelled` |
| `sessions_event_category` (addition) | `lecture`, `concert`, `member_event`, `experience`, `webinar`, `special_activity`, `partner_event` (blueprint 15) |
| `sessions_lead_release_rule` (addition) | `customers_then_public`, `public`, `keep_for_leads` |
| `session_exceptions_kind` (addition) | `closed`, `holiday`, `special_hours` |
| `capacity_holds_kind` | `staff`, `partner`, `host`, `speaker`, `blocked` |
| `bookings_status` | `reserved`, `confirmed`, `cancelled`, `late_cancelled`, `no_show`, `attended` |
| `bookings_paid_with` | `credit`, `order`, `guest`, `free` |
| `bookings_source` | `portal`, `admin`, `waitlist`, `import`, `pos`, `site` |
| `bookings_cancel_reason_code` (addition) | `customer`, `staff`, `session_cancelled`, `payment_expired`, `order_cancelled`, `refunded`, `rescheduled`, `erased`, `duplicate` (commerce has no "payment failed" end state for an order: a failed payment may be retried until the order expires, so `payment_expired` covers it) |
| `waitlist_entries_queue` | `lead`, `customer`, `public` |
| `waitlist_entries_state` | `waiting`, `offered`, `confirmed`, `released`, `expired`, `withdrawn` |

### `session_templates` (mutable)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() | pk |
| kind | session_templates_kind | no | | |
| name | jsonb LocalizedText | no | | complete in 3 locales before `is_active = true` |
| description | jsonb LocalizedText | yes | | addition; shown on the booking page |
| weekdays | smallint[] | no | | ISO weekday 1 = Monday ... 7 = Sunday; check `weekdays <@ '{1,2,3,4,5,6,7}' and cardinality(weekdays) >= 1` |
| start_time | time | no | | local Europe/Brussels wall-clock time |
| duration_minutes | integer | no | | check `between 15 and 1440` |
| capacity_seats | integer | yes | | check `>= 0`; required unless kind = night |
| capacity_beds | integer | yes | | check `>= 0`; required when kind = night |
| credit_kind | session_templates_credit_kind | yes | | null only for kind = event |
| credit_cost | smallint | no | 1 | check `between 0 and 10` |
| product_id | uuid -> products.id | yes | | walk-in / single-ticket price |
| is_member_only | boolean | no | false | |
| location | text | yes | | addition; free text room name |
| active_from_on | date | no | | |
| active_to_on | date | yes | | check `active_to_on is null or active_to_on >= active_from_on` |
| is_active | boolean | no | true | |
| version | integer | no | 1 | addition; incremented on every edit, drives regeneration |
| created_by_user_id | uuid -> users.id | yes | | addition |
| created_at, updated_at | timestamptz | no | now() | |

Checks: `(kind = 'night') = (capacity_beds is not null)`; `kind = 'night' or capacity_seats is not null`; `kind = 'event' or credit_kind is not null`. Index `(is_active, kind)`. A day schedule with four blocks is four templates; the admin "Add schedule" form creates several in one action.

### `session_exceptions` (addition, mutable)

Closed days, holidays and exceptional opening hours (blueprint 9).

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() | pk |
| on_date | date | no | | Europe/Brussels calendar date |
| kind | session_exceptions_kind | no | | |
| template_ids | uuid[] | yes | | null = applies to every template; otherwise only these |
| opens_at | time | yes | | required when kind = special_hours |
| closes_at | time | yes | | required when kind = special_hours; check `closes_at > opens_at` |
| name | jsonb LocalizedText | no | | e.g. "Christmas Day"; shown to customers |
| note | text | yes | | staff only |
| created_by_user_id | uuid -> users.id | yes | | |
| created_at, updated_at | timestamptz | no | now() | |

Check: `(kind = 'special_hours') = (opens_at is not null and closes_at is not null)`. Index `(on_date)`. Semantics: `closed` and `holiday` suppress materialisation of matching templates on that date; `special_hours` suppresses matching templates whose `start_time` is outside `[opens_at, closes_at)`. Extra opening slots are created as one-off sessions.

### `sessions` (mutable)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() | pk |
| template_id | uuid -> session_templates.id | yes | | null for one-off sessions, events and imports |
| template_version | integer | yes | | addition; template version that produced the row |
| kind | sessions_kind | no | | |
| title | jsonb LocalizedText | no | | copied from template name |
| description | jsonb LocalizedText | yes | | addition |
| starts_at | timestamptz | no | | UTC |
| ends_at | timestamptz | no | | check `ends_at > starts_at` |
| capacity_seats | integer | yes | | same checks as templates |
| capacity_beds | integer | yes | | |
| credit_kind | sessions_credit_kind | yes | | null = cannot be paid with credits |
| credit_cost | smallint | no | 1 | |
| product_id | uuid -> products.id | yes | | addition; price when paid by order (V1 events use this) |
| status | sessions_status | no | 'open' | |
| event_category | sessions_event_category | yes | | addition; required when kind = event (check), null otherwise |
| partner_company_id | uuid -> companies.id | yes | | addition; organising partner for `partner_event` (R3 partner reports) |
| published_at | timestamptz | yes | | addition; visible to customers only when set; materialised sessions get `now()` |
| has_manual_changes | boolean | no | false | addition; staff edited it, regeneration skips it |
| is_member_only | boolean | no | false | |
| is_lead_magnet | boolean | no | false | R2 behaviour |
| lead_reserved_seats | integer | no | 0 | check `>= 0` and `<= coalesce(capacity_seats, capacity_beds)` |
| lead_window_start_at | timestamptz | yes | | |
| lead_window_end_at | timestamptz | yes | | check `lead_window_end_at > lead_window_start_at` |
| lead_release_rule | sessions_lead_release_rule | no | 'customers_then_public' | addition |
| public_release_at | timestamptz | yes | | addition; null = `lead_window_end_at + claim_window_minutes` |
| is_waitlist_position_visible | boolean | no | false | addition; blueprint 19 "no public ranking unless enabled" |
| claim_window_minutes | integer | no | 120 | check `between 10 and 2880` |
| webinar_id | uuid | yes | | R2; plain uuid, no FK: `webinars.session_id` is the owning FK (webinar module); this column is a denormalised back-pointer written only by `upsertWebinarSession`. A session with `webinar_id` is never bookable here (R64) |
| location | text | yes | | |
| notes | text | yes | | staff only |
| cancelled_at | timestamptz | yes | | addition |
| cancel_reason | text | yes | | addition |
| created_at, updated_at | timestamptz | no | now() | |

Checks: `is_lead_magnet = false or (kind = 'event' and lead_window_start_at is not null and lead_window_end_at is not null)`; `(status = 'cancelled') = (cancelled_at is not null)`; `(kind = 'event') = (event_category is not null)`. Indexes: `(starts_at)`, `(kind, starts_at) where status = 'open'`, `(ends_at) where status <> 'cancelled'` (no-show and event-ended scans), partial unique `(template_id, starts_at) where template_id is not null` (materialisation can never double-insert), partial unique `(webinar_id) where webinar_id is not null`.

Session status machine (`sessionTransition()` in `packages/core/src/booking/policy.ts`): `open -> closed` and `closed -> open` (`setSessionOpen`, `bookings.write`); `open | closed -> cancelled` (`cancelSession`, `bookings.override`); `cancelled` is terminal. `closed` means visible to customers with the label "Closed for booking", no new customer bookings or waitlist joins, existing bookings, check-in and staff bookings unaffected. Every pair is covered by `policy.test.ts`.

All foreign keys to other modules' tables use Drizzle's lazy form `references(() => products.id)`, so the mutual import between `booking.ts` and `commerce.ts` (`order_lines.session_id`, `order_lines.ticket_type_id`) is safe at module load.

### `capacity_holds` (mutable)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() | pk |
| session_id | uuid -> sessions.id on delete cascade | no | | |
| kind | capacity_holds_kind | no | | |
| quantity | integer | no | | check `quantity > 0` |
| company_id | uuid -> companies.id | yes | | required when kind = partner (check) |
| note | text | yes | | staff only, may name a speaker |
| created_by_user_id | uuid -> users.id | yes | | addition |
| created_at, updated_at | timestamptz | no | now() | |

Index `(session_id)`, `(company_id) where company_id is not null`. Invariant (enforced in the action under the session lock): `quantity >= count(active bookings with capacity_hold_id = this hold)`.

### `ticket_types` (mutable; used from R2)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() | pk |
| session_id | uuid -> sessions.id on delete cascade | no | | session kind must be `event` |
| product_id | uuid -> products.id | no | | product kind `ticket`; public and member prices come from its `price_versions` |
| name | jsonb LocalizedText | no | | addition; complete before the event is published |
| capacity | integer | yes | | null = limited only by the session; check `> 0` |
| is_member_only | boolean | no | false | |
| sales_start_at | timestamptz | yes | | null = on sale from publication |
| sales_end_at | timestamptz | yes | | null = until `starts_at`; check `sales_end_at > sales_start_at` |
| max_per_booking | smallint | no | 4 | addition; owner plus guests |
| requires_guest_details | boolean | no | true | addition; first and last name per guest ticket |
| sort_order | smallint | no | 0 | addition |
| is_active | boolean | no | true | addition |
| created_at, updated_at | timestamptz | no | now() | |

Index `(session_id, sort_order)`. Sum of type capacities may exceed session capacity (shared pool); the session capacity is always the hard limit.

### `bookings` (mutable, optimistic `version`)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() | pk |
| session_id | uuid -> sessions.id | no | | |
| person_id | uuid -> persons.id | no | | attendee (owner or guest) |
| status | bookings_status | no | | |
| paid_with | bookings_paid_with | no | | |
| guest_of_booking_id | uuid -> bookings.id | yes | | set on guest rows |
| capacity_units | smallint | no | 1 | addition; seats or beds this row uses; check `between 0 and 1`; 0 = guest sharing the owner's bed |
| order_line_id | uuid -> order_lines.id | yes | | required when paid_with = order and status <> reserved (check); a `reserved` row is inserted first and gets its line id from `commerce.createOrder` in the same transaction (R18) |
| ticket_type_id | uuid -> ticket_types.id | yes | | |
| capacity_hold_id | uuid -> capacity_holds.id | yes | | addition; booking fills a hold instead of general capacity |
| used_lead_seat | boolean | no | false | addition; R2, counts against `lead_reserved_seats` |
| is_over_capacity | boolean | no | false | addition; staff override past capacity |
| is_pay_at_desk | boolean | no | false | addition; staff booking paid at the counter on arrival (R63); only with paid_with = order |
| booked_by_user_id | uuid -> users.id | yes | | staff who booked |
| booked_by_person_id | uuid -> persons.id | yes | | addition; customer who made the booking (owner for guest rows) |
| source | bookings_source | no | | |
| external_ref | text | yes | | addition; id in the source system for imports (e.g. `simplybook:12345`); partial unique where not null |
| reserved_until | timestamptz | yes | | required when status = reserved (check) |
| rescheduled_from_booking_id | uuid -> bookings.id | yes | | addition |
| checkin_code | text | no | | addition; 10 chars Crockford base32, unique; in the QR |
| qr_file_id | uuid -> files.id | yes | | addition; rendered PNG |
| reminder_sent_at | timestamptz | yes | | addition |
| cancelled_at | timestamptz | yes | | |
| cancel_reason_code | bookings_cancel_reason_code | yes | | addition; required when status in (cancelled, late_cancelled) |
| cancel_reason | text | yes | | free text, staff only |
| attended_at | timestamptz | yes | | required when status = attended |
| no_show_marked_at | timestamptz | yes | | addition |
| notes | text | yes | | addition, staff only |
| version | integer | no | 1 | incremented on every update; actions pass the version they read |
| created_at, updated_at | timestamptz | no | now() | |

Constraints and indexes: partial unique `(session_id, person_id) where status in ('reserved','confirmed')` (architecture); unique `(checkin_code)`; index `(session_id, status)`; index `(person_id, created_at desc)`; index `(guest_of_booking_id) where guest_of_booking_id is not null`; index `(order_line_id) where order_line_id is not null`; index `(reserved_until) where status = 'reserved'`. Checks: `guest_of_booking_id <> id`; `paid_with <> 'order' or order_line_id is not null or status = 'reserved'` (R18 sets the line before commit; `server/order-hooks.test.ts` asserts no committed order-paid row lacks a line); `status <> 'reserved' or reserved_until is not null`; `status <> 'attended' or attended_at is not null`; `status not in ('cancelled','late_cancelled') or (cancelled_at is not null and cancel_reason_code is not null)`; `not is_pay_at_desk or paid_with = 'order'`. A `paid_with = 'guest'` row is either a guest row (`guest_of_booking_id` set) or a sharee booking for themself against another person's grant (R55); the ledger entry, not this table, records the grant owner. Index `(rescheduled_from_booking_id) where rescheduled_from_booking_id is not null` (chain length for R31).

### `waitlist_entries` (mutable)

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| id | uuid | no | gen_random_uuid() | pk |
| session_id | uuid -> sessions.id | no | | |
| person_id | uuid -> persons.id | no | | |
| queue | waitlist_entries_queue | no | 'public' | |
| state | waitlist_entries_state | no | 'waiting' | |
| joined_at | timestamptz | no | now() | queue order |
| offered_at | timestamptz | yes | | |
| offer_expires_at | timestamptz | yes | | required when state = offered |
| offers_count | smallint | no | 0 | addition; part of the claim-token derivation; check `<= 5` |
| rejoin_count | smallint | no | 0 | addition; check `between 0 and 1` (R40: one rejoin) |
| claim_token_hash | text | yes | | sha256 hex of the claim token; unique where not null |
| booking_id | uuid -> bookings.id | yes | | required when state = confirmed |
| is_flagged_duplicate | boolean | no | false | |
| flag_reason | text | yes | | e.g. `same_normalised_email:<entry id>` |
| flag_reviewed_by_user_id | uuid -> users.id | yes | | addition |
| flag_reviewed_at | timestamptz | yes | | addition |
| email_normalised | text | yes | | addition; lower-case, `+tag` removed, gmail dots removed; personal data |
| join_ip_hash | text | yes | | addition; sha256(ip + AUTH_SECRET-derived salt); personal data |
| ended_reason | text | yes | | addition; check in (`declined`, `session_started`, `session_cancelled`, `staff`, `booked_directly`, `offer_timeout`, `payment_not_completed`, `flag_withdrawn`, `customer`) |
| created_at, updated_at | timestamptz | no | now() | |

Constraints and indexes: unique `(session_id, person_id)` (architecture); unique `(claim_token_hash) where claim_token_hash is not null`; index `(session_id, state, queue, joined_at)`; index `(offer_expires_at) where state = 'offered'`; index `(session_id, email_normalised)`. Invariant: a `confirmed` entry is terminal and is never updated by a `system` actor (guarded in `packages/core/src/booking/waitlist.ts` `transition()` and asserted in tests).

### Views (`booking.views.ts`, Drizzle `pgView` with `.as(sql\`...\`)`)

`v_session_availability`: one row per session; "now" is `now()`.

```sql
select s.id as session_id, s.kind, s.starts_at, s.ends_at, s.status, s.is_lead_magnet, s.published_at,
  coalesce(s.capacity_beds, s.capacity_seats) as capacity,
  coalesce(h.held, 0) as held,
  coalesce(b.booked, 0) as booked,                       -- active rows outside holds
  coalesce(b.lead_booked, 0) as lead_booked,
  coalesce(o.live_offers, 0) as live_offers,
  coalesce(o.live_lead_offers, 0) as live_lead_offers,
  greatest(0, coalesce(s.capacity_beds, s.capacity_seats) - coalesce(h.held,0) - coalesce(b.booked,0) - coalesce(o.live_offers,0)) as available_total,
  case when s.is_lead_magnet and (now() < s.lead_window_end_at or s.lead_release_rule = 'keep_for_leads')
       then greatest(0, s.lead_reserved_seats - coalesce(b.lead_booked,0) - coalesce(o.live_lead_offers,0)) else 0 end as lead_reserved_remaining,
  case when not s.is_lead_magnet then 'none'
       when now() < s.lead_window_start_at then 'pre'
       when now() < s.lead_window_end_at then 'lead'
       when s.lead_release_rule = 'customers_then_public'
            and now() < coalesce(s.public_release_at, s.lead_window_end_at + make_interval(mins => s.claim_window_minutes)) then 'customer_release'
       else 'public' end as lead_phase,
  -- available_general = available_total - lead_reserved_remaining (floored at 0)
  greatest(0, <available_total> - <lead_reserved_remaining>) as available_general,
  case when s.is_lead_magnet then s.lead_window_end_at end as opens_for_customers_at,
  case when s.is_lead_magnet then coalesce(s.public_release_at, s.lead_window_end_at + make_interval(mins => s.claim_window_minutes)) end as opens_for_public_at,
  coalesce(w.waiting, 0) as waiting
from sessions s
left join (select session_id, sum(quantity) held from capacity_holds group by 1) h on h.session_id = s.id
left join (select session_id, sum(capacity_units) booked, sum(capacity_units) filter (where used_lead_seat) lead_booked
           from bookings where capacity_hold_id is null
             and (status in ('confirmed','attended','no_show') or (status = 'reserved' and reserved_until > now()))
           group by 1) b on b.session_id = s.id
left join (select session_id, count(*) live_offers, count(*) filter (where queue = 'lead') live_lead_offers
           from waitlist_entries where state = 'offered' and offer_expires_at > now() and booking_id is null group by 1) o on o.session_id = s.id
left join (select session_id, count(*) waiting from waitlist_entries where state = 'waiting' group by 1) w on w.session_id = s.id
```
The written view repeats the two expressions instead of `<...>` placeholders. Per-queue availability for one person is computed by `computeAvailability()` in `packages/core/src/booking/availability.ts` from this row plus the person's status (section 3, rules B20-B27).

`v_ticket_type_availability` (addition, R2): `ticket_type_id, session_id, capacity, sold` (= count of bookings with that type in `reserved` live, `confirmed`, `attended`, `no_show`), `available = capacity - sold` (null when capacity null), `is_on_sale = now() between coalesce(sales_start_at, '-infinity') and coalesce(sales_end_at, sessions.starts_at) and is_active`.

`v_person_bookings`: `select b.*, s.kind, s.title, s.starts_at, s.ends_at, s.location, s.status as session_status, (b.guest_of_booking_id is not null) as is_guest, coalesce(owner.person_id, b.person_id) as owner_person_id from bookings b join sessions s on s.id = b.session_id left join bookings owner on owner.id = b.guest_of_booking_id`. Portal queries filter `person_id = $me or owner_person_id = $me`.

`v_session_utilisation` (addition, V1): per session `session_id, template_id, kind, day_on` (`(starts_at at time zone 'Europe/Brussels')::date`), `weekday`, `local_start_time`, `capacity, held, booked_total` (all non-cancelled rows incl. holds), `attended, no_shows, cancellations, late_cancellations, waitlist_peak` (count of entries ever created), `utilisation_pct = round(100.0 * (attended + no_shows) / nullif(capacity, 0), 1)` for past sessions and `round(100.0 * booked_total / nullif(capacity,0), 1)` for future ones.

No-show and cancellation report data (blueprint 48) is ops' V1 view `v_no_show_report`, which reads `bookings`, `sessions`, `credit_entries` and `order_lines` directly; this module defines no second report view. The portal and every customer query select explicit columns from `v_person_bookings` and never return `notes`, `cancel_reason`, `booked_by_user_id` or `checkin_code` of a row the viewer does not attend.

### Tables of other modules this module reads or writes

| Table | Module | Access |
| --- | --- | --- |
| `persons`, `v_person_status` | crm, credits | read; status through `crm.getPersonStatus(...).status`; guests created through `crm.findOrCreatePersonByEmail` / `crm.createPersonWithoutEmail`; reception data through `crm.getReceptionCard`; night emergency contact written through `crm.updatePersonFields` (R62b) |
| `memberships` | credits | read through `credits.getMembershipForPerson(...).isMember` (member-only checks, R15) |
| `form_submissions` | forms | read through `forms.hasValidSubmission(db, { personId, formSlug: 'health-declaration' })` (R62b) |
| `companies` | crm | FK from `capacity_holds.company_id` and `sessions.partner_company_id`; read names |
| `activity_events` | crm | write through `ctx.recordEvent` |
| `products`, `price_versions` | commerce | FK and read through `commerce.getQuote` |
| `orders`, `order_lines` | commerce | FK from `bookings.order_line_id`; created through `commerce.createOrder` with `items[].bookingIds` of the `reserved` rows booking inserted just before (R18); commerce calls back only `confirmBookingsForOrder`, `releaseBookingsForOrder`, `cancelBookingsForOrderLine` and, at the POS, `createBookingForPosLine` |
| `credit_entries`, `v_person_credits` | credits | written only through `credits.consumeCredits` / `credits.releaseCredits`; views read; pre-checks through `credits.checkCredits` |
| `settings` (`booking_rules`, `business_hours`) | platform | declared in `apps/web/modules/booking/config.ts`; read through `getSetting`; written only through platform's `updateSetting` action |
| `users`, `files`, `jobs`, `audit_log` | platform | FKs; `files` written through `storeFile(ctx, ...)`; jobs and audit through `ctx` |
| `terms_acceptances`, `v_legal_versions` | site | read and written through `site.hasAcceptedCurrentTerms`, `site.getCurrentLegalVersion`, `site.recordTermsAcceptance` (R62) |
| `email_messages` | email | written through `email.sendTransactional` |
| `webinars` | webinar | R2; never read; the webinar module calls `upsertWebinarSession` / `cancelWebinarSession` |

## 3. Business rules

### 3.0 `settings.booking_rules` (shape owned by this module)

Zod schema `BookingRules` in `packages/core/src/booking/rules.ts`; declared with its default as setting key `booking_rules` in `apps/web/modules/booking/config.ts` (platform's per-module settings registry); seeded by `packages/db/src/seed/booking.ts`; edited at `/admin/sessions/rules`, whose form submits platform's `updateSetting` action (`settings.write`, `{ key: 'booking_rules', value, expectedVersion }`, audited `settings.update`). This module has no settings-writing action of its own.

```ts
const BookingRules = z.object({
  free_cancel_hours: z.object({ day: z.number().int().min(0).default(24), night: z.number().int().min(0).default(72), event: z.number().int().min(0).nullable().default(null) }), // null = never free (events non-refundable)
  late_cancel_releases_credit: z.boolean().default(false),
  no_show: z.object({ auto_mark: z.boolean().default(true), after_end_minutes: z.number().int().min(0).default(120), releases_credit: z.boolean().default(false) }),
  book_until_minutes_before_start: z.object({ day: z.number().int().default(0), night: z.number().int().default(120), event: z.number().int().default(0) }),
  booking_horizon_days: z.number().int().min(1).max(90).default(60),          // how far ahead customers may book
  max_guests_per_booking: z.number().int().min(0).max(10).default(3),
  max_shared_bed_guests_per_booking: z.number().int().min(0).max(1).default(1),  // a night bed is for at most two people
  max_reschedules_per_booking: z.number().int().min(0).default(2),
  reminder_hours_before: z.object({ day: z.array(z.number().int().min(1).max(336)).default([24]), night: z.array(z.number().int().min(1).max(336)).default([48]),
    event: z.array(z.number().int().min(1).max(336)).default([]) }),         // events: automation `event-registration` sends reminders
  waitlist: z.object({ offer_cutoff_minutes_before_start: z.number().int().default(60), min_claim_minutes: z.number().int().default(15), max_offers_per_person_per_session: z.number().int().min(1).max(5).default(2) }),
  check_in: z.object({ opens_minutes_before_start: z.number().int().default(120), closes_minutes_after_end: z.number().int().default(120), revert_no_show_days: z.number().int().default(7) }),
  pay_at_desk: z.object({ enabled: z.boolean().default(true), kinds: z.array(z.enum(['day','night','event'])).default(['day','night']) }),
  require_health_declaration: z.boolean().default(false),                  // R62b; the same field forms names (`settings.booking_rules.require_health_declaration`)
  require_emergency_contact_for_nights: z.boolean().default(true),         // R62b; crm `persons.emergency_contact`
  guest_abuse: z.object({ distinct_guests_per_30_days: z.number().int().min(1).default(3) }), // read by credits' `v_sharing_review` (credits rule 43)
});
```

Every field of `booking_rules` and `business_hours` is snake_case like every setting (cross-module Convention 3 and D16); rules and screens below name them by these paths (`settings.booking_rules.require_health_declaration`, `settings.booking_rules.reminder_hours_before.event`). The UI-facing TypeScript inputs and outputs of actions and api functions stay camelCase.

Reservation length for unpaid orders is not a booking rule: `bookings.reserved_until` is always `orders.expires_at`, which commerce sets (`settings.commerce.order_expiry_minutes`, default 30); booking reads it from the `orders` row right after `createOrder` and copies it in R18; pay-at-desk orders expire at the session's `ends_at` (R63).

### 3.0b `settings.business_hours` (shape owned by this module)

Zod schema `BusinessHours` in `packages/core/src/booking/rules.ts`, declared in `config.ts`, edited at `/admin/sessions/rules` (second tab) through `updateSetting`:

```ts
const DayHours = z.object({ opens_at: z.string().regex(/^\d{2}:\d{2}$/), closes_at: z.string().regex(/^\d{2}:\d{2}$/) }).nullable(); // null = closed
const BusinessHours = z.object({ week: z.object({ 1: DayHours, 2: DayHours, 3: DayHours, 4: DayHours, 5: DayHours, 6: DayHours, 7: DayHours }),
  reception_phone: z.string().nullable(), note: z.record(z.enum(['nl-BE','fr-BE','en']), z.string()).nullable() });
// seed: Mon closed; Tue-Sun 08:30-19:00 (day blocks); nights are outside business hours by design
```

Business hours are the public opening times shown by `site` (footer, contact page, JSON-LD `openingHoursSpecification`) and on the claim and booking pages. They do not generate sessions; templates and exceptions do. The template form shows a warning (not a block) when a day template starts before `opens_at` or ends after `closes_at` of a selected weekday. A `special_hours` exception overrides the displayed hours for its date (`getOpeningHours(db, { from, to })` in api.ts).

`nextOpeningAt(db, from, opts?)` (api.ts, for automation's task due dates) returns the first instant `>= from` at which the centre is open: the weekday's `opens_at`-`closes_at` from `business_hours`, minus dates with a `closed` or `holiday` exception for all templates (`template_ids is null`), with `special_hours` replacing that day's hours, and, unless `opts.includePublicHolidays = true`, skipping every Belgian public holiday (platform's `belgianPublicHolidays`) even when BEAM keeps the centre open, because the office staff who own tasks are off on legal holidays. `from` inside opening hours returns `from`. It searches at most 30 days ahead and returns `null` when nothing is open (the caller keeps its due time). Pure part: `nextOpening(from, hours, exceptions, holidays)` in `schedule.ts` (4.1).

### 3.1 Schedule and materialisation

- **R1** `sessions.materialise` (daily 03:10) ensures that for every active template and every Brussels calendar date `d` in `[today, today + 90]` where `extract(isodow from d) = any(weekdays)`, `active_from_on <= d`, `active_to_on is null or d <= active_to_on`, and no exception suppresses it (R4), exactly one session exists with `starts_at = zonedTimeToUtc(d + start_time, 'Europe/Brussels')` and `ends_at = starts_at + duration_minutes` (real elapsed minutes, so a night across a DST change keeps its length). Insert uses `on conflict (template_id, starts_at) do nothing`. Running it twice yields the same rows.
- **R2** Editing a template increments `version` and enqueues `sessions.regenerate_template { templateId }` (key `regenerate:<template_id>:<version>`). For each future session of that template: if it has any booking row (any status), any waitlist entry or any hold, or `has_manual_changes = true`, it is **not touched**. Otherwise it is updated to the new title, capacity, credit fields, product and member flag when its `starts_at` still matches the template, or removed when it no longer matches. Missing matching sessions are inserted as in R1.
- **R3** Removing an untouched session means `delete` when it never had bookings, entries or holds (always true by R2), so sessions with history are never deleted by automation.
- **R4** An exception suppresses a template on `on_date` when `template_ids is null or template_id = any(template_ids)` and either `kind in ('closed','holiday')` or (`kind = 'special_hours'` and `start_time` not in `[opens_at, closes_at)`). Creating an exception enqueues `sessions.regenerate_date { onDate }`, which removes suppressed sessions that R2 allows to remove. Sessions on that date that have active bookings are listed on the exception screen as conflicts with a "Cancel these sessions" action (R33); the system never cancels them by itself. Deleting or narrowing an exception enqueues the same job, which re-inserts the now-allowed sessions as in R1.
- **R4b** Belgian public holidays: booking reuses platform's pure `belgianPublicHolidays(year): { on, key }[]` (`@beam/core/platform`, Wave 0; the ten legal holidays 1 Jan, Easter Monday, 1 May, Ascension Day, Whit Monday, 21 Jul, 15 Aug, 1 Nov, 11 Nov, 25 Dec) and owns no second calendar; the names shown to staff and used as the exception `name` come from the catalogue keys `booking.holidays.<key>` in three locales. The exceptions screen lists the next 12 months of them that have no exception yet, each with "Close this day" (creates a `holiday` exception for all templates through `upsertException`). Nothing is closed by default: BEAM decides per holiday.
- **R5** A one-off session (`template_id = null`) or event is created by staff and is never touched by materialisation.
- **R6** Editing a single session sets `has_manual_changes = true`. Capacity may be lowered only to `>= held + booked + live offers`; the action fails with `conflict` reason `capacity_below_bookings` otherwise. Raising capacity enqueues `waitlist.offer_next` (R34).
- **R6b** Room capacity (blueprint 9) is the session's own capacity: one session uses one room, named in `location`. `createSession`, `updateSession` and `createTemplates` return `warnings: [{ code: 'location_overlap', sessionId }]` when another non-cancelled session with the same `lower(location)` overlaps in time; staff may save anyway (two activities can share a large room on purpose). No room table exists (decision 34).
- **R7** Customers see a session when `status in ('open','closed')`, `published_at <= now()`, `starts_at <= now() + booking_horizon_days` and `starts_at > now()`; they can book or join its waitlist only when `status = 'open'` and `starts_at - book_until_minutes_before_start[kind] > now()`. A session with `webinar_id` is listed only by `site` and webinar pages, never in `/account/book` (R64).

### 3.2 Capacity

- **R8** Capacity unit = seat for `day` and `event`, bed for `night`. `capacity = coalesce(capacity_beds, capacity_seats)`.
- **R9** `available_total = capacity - sum(holds.quantity) - sum(capacity_units of live bookings outside holds) - live offers`. Live bookings are `confirmed`, `attended`, `no_show`, and `reserved` with `reserved_until > now()`. Live offers are `offered` entries not yet expired and without a booking.
- **R10** Every booking, claim, hold change and capacity edit runs inside one transaction that first takes `select ... from sessions where id = $1 for update`, then re-reads `v_session_availability`. Two concurrent last-seat requests: exactly one succeeds, the other gets `conflict` with code `session_full`.
- **R11** A booking with `capacity_hold_id` consumes the hold, not general capacity; a hold cannot hold more bookings than its `quantity`, and a hold's `quantity` cannot drop below its bookings.
- **R12** Staff with `bookings.override` may book past capacity; the row gets `is_over_capacity = true` and the audit row says so. No other path exceeds capacity.
- **R13** A night guest sharing the owner's bed has `capacity_units = 0`; every other row has 1. At most `max_shared_bed_guests_per_booking` (default 1) guest shares one owner's bed; only guests of a night booking may share, and only when the owner row itself uses a bed. Each person, sharing a bed or not, pays `credit_cost` (decided: credits are per person, beds only limit capacity). Cancelling the owner of a shared bed while the sharing guest stays converts the guest row to `capacity_units = 1` under the session lock, or refuses with `session_full` and asks to cancel both.

### 3.3 Eligibility and payment

- **R14** One person holds at most one live booking per session (partial unique index). A second attempt returns `conflict` code `already_booked`.
- **R15** `is_member_only` sessions and member-only ticket types require a real membership, `credits.getMembershipForPerson(tx, personId).isMember = true` (`status` `active`, or `past_due` during grace, credits rule 51), never `crm.getPersonStatus` (whose `status` includes the staff override; credits rule 59, crm rule 12) for customer bookings and waitlist joins; staff may bypass with `bookings.override`. Guests of a member on a member-only session are allowed (the member brings them) unless the ticket type is member-only.
- **R16** Payment choice at booking (customer): `credit` when the session has a `credit_kind` and `credits.checkCredits(db, { personId, beneficiaryPersonId, kind, units: credit_cost, validAt: starts_at })` covers it; else `order` when the session (or ticket type) has a product with a price; else `free` when `credit_cost = 0` and no product. Customers cannot choose `free` otherwise. Staff may choose `free` only with `bookings.override` and a reason. Gift vouchers are euro credit and are never consumed by a booking directly (credits rule 20); an order-paid booking can be paid partly or fully with euro credit at checkout (commerce rule 25).
- **R17** Credit payment calls `credits.consumeCredits(tx, ctx, { personId: payer, beneficiaryPersonId: attendee, kind, units: credit_cost, ref: { type: 'booking', id }, validAt: session.starts_at })` in the booking transaction; the booking is `confirmed` immediately. The service catches credits' two error classes: `SharingNotAllowedError` (subclass, `reason` `guest_limit`, `not_shareable` or `share_limit`) maps to `conflict` reason `sharing_not_allowed`, and any other `InsufficientCreditsError` (`reason = 'insufficient'`) to `insufficient_credits`; the `instanceof SharingNotAllowedError` test runs first. Either way the whole transaction rolls back.
- **R18** Order payment, in one transaction under the session lock (commerce rule 21: commerce never reserves capacity): booking validates eligibility and capacity for every seat (owner and guests), inserts one `reserved` row per paid seat (`order_line_id` null, `reserved_until` provisional `now() + 30 min`), then calls `commerce.createOrder(tx, ctx, { personId: payer, channel: 'portal' | 'admin', items: [{ productId, quantity: 1, sessionId, ticketTypeId?, bookingIds: [bookingId] }], promoCode?, clientKey, locale, useEuroCredit?, expiresAt? })` with one quantity-1 item per seat, in the same order as the rows. Commerce stores the ids in `order_lines.data.booking_ids` and returns `lineIds` in item order; booking sets each row's `order_line_id` and `reserved_until = orders.expires_at` before commit (`server/order-hooks.ts` `linkOrderLines`). The attendee is the booking row's `person_id`, so `CartItem` needs no attendee field. Guest rows carry `guest_of_booking_id`. The action returns `{ kind: 'checkout', orderId, redirectTo: '/<locale>/account/checkout/<orderId>' }`: commerce's pay page (reservation countdown, euro credit, terms, `payOrder`) starts the payment; booking does not call a payment function. Commerce calls `booking.confirmBookingsForOrder(tx, ctx, { orderId })` in its paid transaction (`finalizePaidOrder`, online, payment link and POS); the rows become `confirmed`. Lines it returns in `unavailableOrderLineIds` are refunded automatically by commerce through `refundOrderLine(tx, ctx, { orderLineId, reason: 'seat_no_longer_available' })` (job `commerce.refund_unavailable_lines`); no customer-service task is opened (edge case 3, cross-module D22). Commerce calls `booking.releaseBookingsForOrder(tx, ctx, { orderId, reason })` with `payment_expired`, `payment_failed` or `order_cancelled` when the order ends unpaid; rows become `cancelled` with code `payment_expired` (also for `payment_failed`) or `order_cancelled`. A staff refund of a session or ticket line calls `booking.cancelBookingsForOrderLine(tx, ctx, { orderLineId, reason: 'refunded' })` (code `refunded`, no second refund). At the POS (`posSell`) commerce creates the order line first and calls `booking.createBookingForPosLine(tx, ctx, { orderLineId, sessionId, personId })`, which runs the same eligibility and capacity checks under the session lock and inserts a `reserved` row with `source = 'pos'`, `order_line_id` set and `reserved_until = orders.expires_at`; it throws `ConflictError` (`session_full`, `member_only`, `already_booked`), which commerce maps to `sold_out`. `bookings.expire_reservations` (every minute) cancels any `reserved` row past `reserved_until` whose order is not `paid`, as a safety net.
- **R19** Prices always come from commerce: quotes through `commerce.getQuote` (member price version and member discount automatic, promotion codes passed as `promoCode`), order totals through `createOrder`. This module never computes money.

### 3.4 Lead Magnet access (R2; flag `ff_booking_lead_priority`)

- **R20** Lead = `crm.getPersonStatus(tx, personId).status = 'lead'` (the call returns an object; booking reads only `.status`) at the moment of the action (paid nothing; staff correction respected by crm). Customer = `customer` or `member`.
- **R21** Phase `pre` (before `lead_window_start_at`): only general seats (`available_general`) are bookable, by anyone eligible.
- **R22** Phase `lead`: a lead may book a reserved seat (`used_lead_seat = true`) or a general seat; reserved seats are used first. A customer may book only general seats. When `available_general = 0` the customer sees "Opens for you on {opens_for_customers_at}" (Brussels time, locale format) and a "Join the customer queue" button, never a booking button that fails.
- **R23** A lead may book a reserved seat only for themselves; guests of a lead booking need general seats (closes the "bring five friends on lead seats" bypass).
- **R24** At `lead_window_end_at`, by rule: `customers_then_public` offers unused reserved seats to `customer` queue entries in `joined_at` order (one offer per free seat, claim window each); seats not covered by offers are directly bookable by customers and members until `opens_for_public_at`, then by everyone. `public` opens them to everyone at once. `keep_for_leads` keeps reserved seats lead-only until the session starts. During phase `customer_release` only customers and members book directly; a lead sees "Opens for you on {opens_for_public_at}" and may join the `lead` queue (the lead window is over, so the released seats go to customers first, then to everyone). An offer made to a `customer` queue entry at window end uses the email `booking.lead_window_open` (same claim link and expiry as `booking.seat_offered`, wording "The lead window has closed: your seat is ready to claim").
- **R24b** Window-end release runs in `waitlist.expire_offers`: for each future lead-magnet session whose `lead_window_end_at` or `opens_for_public_at` lies in the last 24 hours, it enqueues `waitlist.offer_next { sessionId }` with trigger `release:<phase>`, key `waitlist:<session_id>:offer_next:release:<phase>`. The unique job key makes the per-minute repetition a no-op, and `offer_next` itself only offers what capacity and entry states allow, so a late or repeated run cannot over-offer.
- **R25** From `opens_for_public_at`, the waiting entries still in any queue are offered in order: `customer`, then `lead`, then `public`, each by `joined_at`.
- **R26** A waiting entry in the `lead` queue whose person is no longer a lead moves to the `customer` queue keeping its `joined_at` (event `waitlist.requeued`, `data.from = 'lead', data.to = 'customer', data.reason = 'status_changed'`). `waitlist.expire_offers` does this every minute with one set-based update joining `v_person_status` (no per-entry calls). An `offered` entry keeps its offer until claim or expiry. A `confirmed` entry and its booking never change because of a purchase. The reverse (customer back to lead through a staff status correction) never moves an entry.
- **R27** The queue position is never shown unless `sessions.is_waitlist_position_visible = true`; then the portal shows the 1-based position within the person's own queue.

### 3.5 Booking state machine, cancellation and rescheduling

- **R27b** Booking status transitions (`bookingTransition(from, to, actor)` in `policy.ts`, throws `InvalidTransitionError`; every allowed and every forbidden pair is tested in `policy.test.ts`):

| From | To | By | Rule |
| --- | --- | --- | --- |
| (new) | `reserved` | order-paid `bookSession`, `createManualBooking` (incl. pay at desk) or `claimSeat`, inserted before `commerce.createOrder`; `createBookingForPosLine` (POS) | R18, R44, R63 |
| (new) | `confirmed` | credit, guest or free booking; claim; import | R17, R44, R65 |
| `reserved` | `confirmed` | `confirmBookingsForOrder` (commerce's paid transaction, online, payment link and POS) | R18 |
| `reserved` | `cancelled` | order expiry or cancellation, `expire_reservations`, staff (`staff`), erasure | R18, R32 |
| `confirmed` | `cancelled` | customer or staff in policy, staff force, session cancellation, refund, reschedule, erasure | R28, R31-R33 |
| `confirmed` | `late_cancelled` | customer or staff after the free window, before `starts_at` | R29 |
| `confirmed` | `attended` | check-in | R35 |
| `confirmed` | `no_show` | `bookings.mark_no_shows` or staff | R37 |
| `attended` | `confirmed` | undo check-in | R36 |
| `no_show` | `attended` | late check-in correction | R37 |
| `late_cancelled` | `cancelled` | staff with `bookings.override` (release) | R32 |

`cancelled` is terminal. A customer cannot cancel a `reserved` row: the portal shows "Awaiting payment until {reserved_until}" with "Complete payment" (commerce retry); the row lapses with the order. Nothing can move a row whose session started more than `check_in.closes_minutes_after_end` minutes after `ends_at` except `no_show -> attended` within `check_in.revert_no_show_days`.

- **R28** Free window: a customer may cancel free until `starts_at - free_cancel_hours[kind]` hours. Inside the window: status `cancelled`, credits released through `credits.releaseCredits(tx, ctx, { ref: { type: 'booking', id }, reason: 'cancelled_in_policy' })`, order-paid rows refunded through `commerce.refundOrderLine(tx, ctx, { orderLineId, reason: 'cancelled_in_policy' })` (commerce rule 37a: reasons `cancelled_in_policy` or `session_cancelled`, full line amount, credit note by finance, refund job, idempotent per line and reason; it does not call back `cancelBookingsForOrderLine`). Events with `free_cancel_hours.event = null` are never free for the customer. Date-specific leisure bookings have no 14-day withdrawal right (Belgian Code of Economic Law art. VI.53, 12°); the terms state this and the booking page repeats it.
- **R29** Late cancellation (after the free window, before start): status `late_cancelled`; credits stay consumed unless `late_cancel_releases_credit = true` (then `releaseCredits` with reason `late_cancel_released`); order-paid rows are not refunded. The customer sees which case applies before confirming. After `starts_at` a customer can no longer cancel; the row becomes `attended` or `no_show`.
- **R30** Cancelling an owner's booking asks whether to cancel the guests too (default yes); guest rows follow the same window rule. A guest row can be cancelled alone by the owner or staff.
- **R31** Reschedule = in one transaction, cancel the old row (`cancelled`, code `rescheduled`, no refund) and create a new `confirmed` row on the target session with `rescheduled_from_booking_id`, the same `paid_with`, `order_line_id` and guests. Credit rows: release on the old booking (`releaseCredits` reason `rescheduled`) and consume on the new one (keys differ by booking id). Facts: besides `booking.rescheduled` (old and new ids), the transaction writes `booking.cancelled` for the old row (`data.cancel_reason_code = 'rescheduled'`, `data.by` = actor) and `booking.confirmed` for the new row with `data.rescheduled_from_booking_id` and the old row's `is_first_booking` carried over (so automation exits on the old subject and enters on the new one with the new anchor, and a rescheduled first booking stays first). Neither of these two writes an email: the customer receives one `booking.booking_rescheduled` (R59). Allowed for customers only inside the free window, same `kind`, same `credit_kind`, same `product_id` for order-paid rows, at most `max_reschedules_per_booking` times along the chain. Staff with `bookings.write` may reschedule outside the window; across products needs `bookings.override`.
- **R32** Staff cancellation (`bookings.write`) defaults to the policy result; staff with `bookings.override` may force `cancelled` with credit release (`releaseCredits` reason `staff_override`) or refund outside the window, with a mandatory reason. A `late_cancelled` row can be converted to `cancelled` with release by `bookings.override`.
- **R33** BEAM cancelling a session (`cancelSession`, `bookings.override`): status `cancelled`, every live booking (`reserved` and `confirmed`) `cancelled` with `session_cancelled`, credits released (reason `session_cancelled`), paid order lines refunded through `commerce.refundOrderLine` (also events), unpaid orders cancelled through `commerce.cancelOrder`, waiting and offered entries `released` with `session_cancelled`, one `booking.session_cancelled` email per attendee with an email when `notify = true`. The session is processed in chunks of 50 bookings per transaction (`sessions.cancel_bookings` job) when it has more than 50 live bookings; the session row is `cancelled` in the first transaction so nobody books meanwhile.
- **R34** Any change that frees capacity enqueues `waitlist.offer_next { sessionId }` in the same transaction: a cancellation or late cancellation, an expired or released reservation, a declined, expired or withdrawn offer, a deleted or reduced hold, a capacity increase, reopening a closed session, and an erasure that cancels a future booking.

### 3.6 Attendance, check-in and no-shows

- **R35** Check-in (`bookings.write`): `confirmed` -> `attended`, `attended_at = now()`, allowed from `starts_at - check_in.opens_minutes_before_start` until `ends_at + check_in.closes_minutes_after_end` (defaults 2 h each); earlier or later needs `bookings.override`. Scanning a code of another day's session shows the booking with a warning and no check-in button. A `reserved` row (unpaid, including pay-at-desk) is refused with `payment_required`; the desk card shows "To pay: {amount}" and a "Take payment" button opening `/admin/pos?order=<orderId>`; once commerce confirms the order the card refreshes and check-in is allowed. Guests are checked in one by one; the owner's card lists them with one "Check in all" button that runs one action per row.
- **R36** Undo check-in (`attended` -> `confirmed`) is allowed until `ends_at + check_in.closes_minutes_after_end`, audited. It writes `booking.check_in_undone`; `booking.attended` keeps its dedupe key, so a second check-in after an undo writes a new event with `:<version>` and `is_first_visit` recomputed.
- **R37** `bookings.mark_no_shows` (every 15 min) marks `confirmed` rows of sessions with `ends_at + no_show.after_end_minutes <= now()` as `no_show` when `no_show.auto_mark = true`; credits stay consumed unless `no_show.releases_credit` (then `releaseCredits` reason `no_show_released`). Staff (`bookings.write`) may mark a no-show by hand after `starts_at`, and may convert `no_show` -> `attended` within `check_in.revert_no_show_days` (late check-in correction), audited.
- **R38** `booking.attended` is the only booking fact that counts as a visit (first visit, last visit, review requests, retention). `no_show`, `cancelled` and `late_cancelled` never trigger review requests (blueprint 48 and 31); the review-request automation listens to `booking.attended` only.
- **R39** For sessions of kind `event`, the same job emits `booking.event_ended { attended: boolean, event_category }` per `attended`, `no_show` or still `confirmed` booking once the session is past `ends_at + no_show.after_end_minutes`, whether or not `no_show.auto_mark` is on (post-event follow-up trigger, dedupe `booking:<id>:event_ended`). R2 behaviour: booking-P8 adds this step to the job; the V1 job does not emit it, and P8 emits it only for sessions ending after its deployment (no backfill burst).

### 3.7 Waitlist and claim links

- **R40** A person may join the waitlist only when the session is `open`, not started, eligible for them (member-only, R15), full for them (no bookable unit in their phase), they have no live booking in it, and they have no entry in it (unique). An `expired`, `released` or `withdrawn` entry may rejoin once (`rejoin_count = 0`): state back to `waiting`, `joined_at = now()`, `rejoin_count = 1`, flag fields reset and re-evaluated (R48). A second rejoin returns `conflict` reason `already_waiting`. Rejoin is refused for entries ended with `session_started`, `session_cancelled` or `flag_withdrawn`.
- **R41** Allowed transitions: `waiting -> offered | withdrawn | released`; `offered -> confirmed | expired | released | withdrawn`; `expired | released | withdrawn -> waiting` (rejoin, R40); `confirmed` is terminal. Any other transition throws `InvalidTransitionError`. A system actor can never change a `confirmed` entry (`ProtectedSeatError`), and no staff waitlist action accepts one. Every state is reachable: `offered` by R42 or staff, `confirmed` by R44, `expired` by R45, `released` by R46, R47, R33 or staff, `withdrawn` by the customer or a flag review.
- **R42** `waitlist.offer_next { sessionId }` under the session lock: while `available_total > 0` (or the queue-specific pool in a lead phase) and the next eligible entry exists, set it `offered`, `offers_count + 1`, `offered_at = now()`, `offer_expires_at = least(now() + claim_window_minutes, starts_at - waitlist.offer_cutoff_minutes_before_start)`, `claim_token_hash = sha256(token)`, and call `email.sendTransactional` with `booking.seat_offered` (or `booking.lead_window_open`, R24) and key `waitlist:<entry_id>:offer:<offers_count>`. No offer is made when `offer_expires_at < now() + waitlist.min_claim_minutes`. Entries whose person has no email (staff-added walk-ins) are offered on screen only and staff phone them; the entry still expires normally. Flagged entries (`is_flagged_duplicate`) and entries whose person already has `waitlist.max_offers_per_person_per_session` offers are skipped.
- **R43** Claim token = base64url(HMAC-SHA256(key, `claim:<entry_id>:<offers_count>`)), key derived with HKDF from `AUTH_SECRET` (info `beam-claim-v1`). The plain token is never stored in booking tables; `waitlist.offer_next` recomputes it and passes the claim URL in the `booking.seat_offered` `data`, so it exists only in email's message and job payload until those are pruned (7 days). Each new offer gives a new token; old links stop working.
- **R44** `GET /api/public/claim/<token>` never changes state (mail scanners prefetch links); it redirects to `/[locale]/claim/<token>`. Claiming is a POST (`claimSeat`) that, under the session lock, checks `state = 'offered'`, `offer_expires_at > now()`, then books: credits if the person has them, `free` if free, otherwise a `reserved` booking with an order (R18) and a redirect to commerce's pay page `/[locale]/account/checkout/<orderId>`. A paid claim needs a portal session: when the visitor is not signed in as the entry's person, the claim page shows "Sign in to pay", which sends platform's magic link to the entry person's email with the callback `/[locale]/claim/<token>`; the offer keeps counting as a live offer meanwhile, and after sign-in the `claimSeat` POST creates the reserved row and the order. Credit and free claims need no sign-in (the token proves the person). `booking_id` is set on the entry in the claim transaction (so the offer stops counting as a live offer and the reserved row counts as booked instead); the state becomes `confirmed` when the booking is `confirmed` (at once, or inside `confirmBookingsForOrder`, which transitions linked entries). If that reserved booking is released (`releaseBookingsForOrder`, `expire_reservations`), the entry becomes `expired` with `ended_reason = payment_not_completed` in the same transaction and `waitlist.offer_next` is enqueued. A second POST with the same token returns the existing booking. An expired or superseded token shows "This offer has expired" with a link to the session.
- **R45** `waitlist.expire_offers` (every minute): every `offered` entry with `offer_expires_at <= now()` and `booking_id is null` becomes `expired` (`ended_reason = offer_timeout`, email `booking.offer_expired`); then `waitlist.offer_next` is enqueued for its session. An offered entry with a live reserved booking never expires on its own; it follows that booking (R44). The job also re-enqueues `waitlist.offer_next` for every open session that has free capacity and waiting entries but no pending `offer_next` job (safety net for edge case 23).
- **R46** The customer may decline an offer (`released`, reason `declined`) or withdraw while waiting (`withdrawn`). Both free the place for the next person at once.
- **R47** At `starts_at`, `waiting` and `offered` entries of the session become `released` with `session_started` (in `waitlist.expire_offers`).
- **R48** Duplicate protection: identical email = same person (unique `lower(email)` in crm) and is blocked by R14 and the unique entry. Suspicious secondary address: at join time, an entry is flagged when another entry or live booking in the same session has the same `email_normalised`, the same `persons.phone`, the same `(lower(last_name), birth_on)` when both are present, or the same `join_ip_hash` within 24 h in the `lead` queue. The IP is `ctx.ip` (platform's `Ctx` carries the client IP from `x-forwarded-for`); with `ctx.ip = null` the IP signal is skipped. `join_ip_hash = sha256(ip || HKDF(AUTH_SECRET, info 'beam-ip-v1'))`. Flagged entries stay `waiting` but receive no offer until staff (`waitlist.manage`) clear or withdraw them. Booking a lead seat directly runs the same check and refuses with `needs_review` (the person is put on the lead queue, flagged, instead).
- **R49** Staff (`waitlist.manage`) may offer a seat manually, move an entry between queues, reorder by changing `joined_at`, release or withdraw entries; each is audited with its action name `booking.waitlist_<verb>` (blueprint 56 "Waitlist manually changed"). Changing a `confirmed` entry is impossible; staff cancel the booking instead (`bookings.override` if outside policy).

### 3.8 Events and ticketing

- **R50** An event is a session of kind `event` with an `event_category`, created by staff with `bookings.override`. It can be published (`published_at`) only when `title` is complete in all three locales and, from R2, every active ticket type `name` too. A `member_event` defaults `is_member_only = true` (editable); a `partner_event` requires `partner_company_id`.
- **R51** V1: the event price is `sessions.product_id` (null = free registration). R2 (flag `ff_booking_ticket_types`): when an event has active ticket types, every booking must carry one; the type must be on sale (`is_on_sale`), have availability, respect `is_member_only`, and `max_per_booking` limits owner plus guests.
- **R52** Guest information: for ticket types with `requires_guest_details`, each guest ticket requires first and last name; email is optional (R54).
- **R53** Holds (`partner`, `host`, `speaker`, `staff`, `blocked`) reduce sellable capacity from creation; deleting a hold frees capacity and triggers R34.

### 3.9 Guests and package sharing

- **R54** An owner adds up to `max_guests_per_booking` guests (name required, email optional). With an email the guest is `crm.findOrCreatePersonByEmail(tx, ctx, { email, firstName, lastName, locale: owner's, acquisition: { source: 'guest', referrer_person_id: owner } })` (no consent granted; existing names never overwritten); without one, `crm.createPersonWithoutEmail(tx, ctx, { firstName, lastName, locale, acquisition: { source: 'guest', referrer_person_id: owner } })`. Each guest is a `bookings` row with `guest_of_booking_id = owner row`, `booked_by_person_id = owner`.
- **R55** Guest payment: `guest` = from the owner's credits (`consumeCredits` with `beneficiaryPersonId = guest`); credits applies sharing rules and `max_guest_uses_per_month` and throws `InsufficientCreditsError` with `reason` `guest_limit`, `not_shareable` or `share_limit` when not allowed (R17 maps it to `sharing_not_allowed`); `order` = an extra paid line; `free` only by staff override. A person who has a package shared with them (`package_shares`, R2) books for themself with `paid_with = guest` and `grantOwnerPersonId` = the grant owner, so `consumeCredits` gets `personId = owner, beneficiaryPersonId = me`. The booking form shows "{n} guest uses left this month" from `credits.checkCredits` before submitting.
- **R56** A guest with an email receives `booking.guest_invited` naming the owner (first name only), the session and the guest's own QR code; no marketing consent is implied.
- **R57** Abuse control is credits' `v_sharing_review` (more than 3 distinct guests on one grant in 30 days, one guest on 3 or more owners' grants), shown on the ops action dashboard from R2; any booking screen that links to it reads `credits.countSharingReviewItems` / `listSharingReview`, never its own query, and the threshold is `booking_rules.guest_abuse.distinct_guests_per_30_days`. Booking only guarantees the inputs (`credit_entries.beneficiary_person_id` written through `consumeCredits`, `bookings.booked_by_person_id`); bookings are never blocked by the review.
- **R58** The owner-guest relationship stays visible: the guest's timeline shows "Guest of {owner}" and the owner's shows "Booked for {guest}" (both via `activity_events.data`).

### 3.10 Emails and facts

- **R59** Transactional emails, all through `email.sendTransactional(ctx, { template, personId, locale: persons.locale, data, key, attachments? })` (the Wave 0 contract shape: `data` holds the template props, `key` is the message idempotency key; no `tx` argument, the call uses `ctx.tx`). Template keys are email's registry keys `booking.<name>`, where `<name>` is the file basename with `-` replaced by `_` (`seat-offered.tsx` -> `booking.seat_offered`; one file is one key, variants travel in `data`); the same string is the `sendTransactional` `template` value and the `email_templates.slug` of the system row (cross-module D1). Booking owns the template files and props schemas in `packages/email/src/templates/booking/` and their `defineTemplate()` entries in `templates/booking/index.ts`. The check-in QR code travels as an inline attachment `attachments: [{ fileId: bookings.qr_file_id, filename: 'checkin-qr.png', inline: true }]`, which the template shows as `<img src="cid:checkin-qr.png">`; no signed URL is put in the email.

| Key (`booking.<name>`, file `<name with - for _>.tsx`) | `data` variants | Sent when | Idempotency key (`key`) |
| --- | --- | --- | --- |
| `booking.booking_confirmed` | `payAtDesk: boolean` ("Payment at reception" line) | row becomes `confirmed` from a booking, a paid order or an import with `sendEmail` (QR inline) | `booking:<id>:confirmed` |
| `booking.booking_rescheduled` | none | new row of a reschedule (R31; QR inline; names the old and new times) | `booking:<new id>:confirmed` |
| `booking.seat_claimed` | none | row confirmed from a waitlist claim (R44; QR inline) | `booking:<id>:confirmed` |
| `booking.guest_invited` | none | guest row with an email becomes `confirmed` (R56; QR inline, owner's first name) | `booking:<id>:confirmed` |
| `booking.booking_cancelled` | `reason: 'cancelled' \| 'payment_expired'` | row becomes `cancelled` (not for `rescheduled`, `erased`, `session_cancelled`) | `booking:<id>:cancelled` |
| `booking.booking_late_cancelled` | none | row becomes `late_cancelled` (R29) | `booking:<id>:cancelled` |
| `booking.session_cancelled` | `refunded: boolean`, `creditReleased: boolean` | BEAM cancelled the session (R33) | `booking:<id>:cancelled` |
| `booking.booking_reminder` | `kind: 'day' \| 'night'` | R60 (QR inline) | `booking:<id>:reminder:<h>` |
| `booking.waitlist_joined` | none | R40 join or rejoin | `waitlist:<entry_id>:joined:<rejoin_count>` |
| `booking.seat_offered` | none | R42 offer (claim URL, expiry) | `waitlist:<entry_id>:offer:<offers_count>` |
| `booking.offer_expired` | none | R45 expiry | `waitlist:<entry_id>:expired:<offers_count>` |
| `booking.lead_window_open` (R2) | none | R24 window-end offer to the customer queue | `waitlist:<entry_id>:offer:<offers_count>` |

These twelve keys are exactly the booking entry of email's registry list (cross-module D2; `booking.lead_window_open` ships in R2). The template keys `booking.seat_offered`, `booking.offer_expired` and `booking.waitlist_joined` are email registry keys, not event kinds (the waitlist facts are `waitlist.*`, 4.7). A missing translation blocks the email (`blocked_translation`) and never blocks the booking. Event confirmations are sent by booking; automation's `event-registration` and `after-first-booking` sequences must not add a second confirmation (see section 10).
- **R60** Reminders: `bookings.send_reminders` (every 15 min) sends, per offset `h` in `reminder_hours_before[kind]`, one `booking.booking_reminder` to each `confirmed` booking of kind `day` or `night` with `starts_at - h hours <= now() < starts_at`, only when `created_at < starts_at - h hours` (late-entry skip, as in scenario 1). Event reminders (blueprint 15) are the steps of automation's seeded `event-registration` sequence, triggered by `booking.confirmed` with `data.session_kind = event`; `reminder_hours_before.event` stays `[]` unless BEAM deactivates that sequence. Idempotency key `booking:<id>:reminder:<h>` makes repeated runs harmless.
- **R61** Every state change writes one `activity_events` row with `dedupe_key = booking:<id>:<kind suffix>:<version>` (waitlist: `waitlist:<entry_id>:<kind suffix>:<offers_count>:<rejoin_count>`) and `data` carrying `session_id, session_kind, event_category, starts_at, paid_with, is_guest, guest_of_person_id, owner_person_id, is_first_booking, is_first_visit, queue`, plus `rescheduled_from_booking_id` on `booking.confirmed` of a reschedule's new row and `cancel_reason_code` on `booking.cancelled`/`booking.late_cancelled` (the contract keys crm and automation read; automation reads `is_first_booking` and `is_first_visit`, there is no plain `is_first` key). `is_first_booking` = no earlier non-cancelled booking of the person; `is_first_visit` = no earlier `attended` row of kind `day` or `night`; both computed in the writing transaction after the person row lock `select ... from persons where id = $1 for update`, so two parallel first bookings cannot both claim it.

### 3.11 Terms, pay at desk, webinar sessions and imports

- **R62** Terms and house rules: the current `terms` legal page (site) includes the house rules, cancellation policy and the health self-declaration ("I have no medical reason not to take part, or I have checked with my doctor"); no health answer is stored. `bookSession` and `joinWaitlist` require `acceptTerms: true` when `site.hasAcceptedCurrentTerms(db, personId)` is false and the person has never accepted any `terms` version; the action then calls `site.recordTermsAcceptance(tx, ctx, { personId, versionId, context: 'booking', refType: 'booking', refId, ip: ctx.ip })` in the booking transaction. A material change later shows site's non-blocking banner (site rule 35) and never blocks a booking. Staff bookings record nothing; the desk reminds the guest verbally (the check-in card shows "Terms not yet accepted"). Order-paid bookings accept terms here, so commerce's checkout does not ask twice for the same version (site's idempotency key).
- **R62b** Health declaration, reception card and emergency contact. The house rules and the short health disclaimer are a chapter of site's `terms` (R62, site decision 41). The detailed health declaration is forms' seeded `health-declaration` form; its validity is `forms.hasValidSubmission(db, { personId, formSlug: 'health-declaration' })` (forms ID11), the single source booking reads. Booking does not read `crm.hasValidDeclaration`: crm's `person_declarations` keeps only kind `guardian_consent` (cross-module D15; section 13, decision 48). Display: the portal booking page shows "Health declaration missing or expired: fill it in before your visit" with a link to `/[locale]/f/health-declaration`; the check-in result card, `searchCheckin` rows and the printable day list show a "Health declaration missing/expired" badge. Forms seeds `health-declaration` as a draft that staff publish only after ops' DPIA `sensitive_assessment_processing` is approved or `not_required`; until then the linked form may be unpublished (`/f/health-declaration` shows "form not available"), nobody has a valid submission and the badge shows "missing" (cross-module D39). Blocking: when `settings.booking_rules.require_health_declaration = true` (default `false`), `bookSession` and `claimSeat` for kinds `day` and `night` refuse with `conflict` reason `health_declaration_required` (the form links back to the booking page); staff bookings and check-in are never blocked: reception fills the form with the guest at the desk through forms' `/admin/forms/enter?personId=` and then checks in. Reception card: the check-in result card renders crm's exported `ReceptionCard` component (data from `crm.getReceptionCard(db, personId)`: customer number, status, member badge, tags, emergency contact, minor flag, and `declarations = { termsAccepted, healthDeclarationValid, guardianConsentValid }`, which crm builds from site, forms and crm, cross-module D15) next to credits' `DeskCreditsBadge`. Emergency contact (night bookings): when `require_emergency_contact_for_nights = true` (default) and the attendee owner has no `emergency_contact` (read from `getReceptionCard`), the portal booking form for a `night` session asks for name, phone and optional relation, and `bookSession` refuses without them with `conflict` reason `emergency_contact_required`; the value is written in the booking transaction through `crm.updatePersonFields(tx, ctx, personId, { emergencyContact }, { onlyEmpty: true })`. Staff night bookings show the same fields as a non-blocking prompt. Guests' emergency contacts are not asked (the owner is the contact person on the night).
- **R63** Pay at desk (reception, phone bookings): `createManualBooking` with `payWith: 'order', payAtDesk: true` (only when `pay_at_desk.enabled` and the kind is in `pay_at_desk.kinds`) creates an order through `commerce.createOrder(tx, ctx, { channel: 'admin', expiresAt: session.ends_at, ... })` (commerce accepts `expiresAt` only for channel `admin`; there is no `isPayAtDesk` argument, the pay-at-desk marker is booking's own `is_pay_at_desk`, cross-module D21 and D23) and a `reserved` row with `is_pay_at_desk = true` and `reserved_until = ends_at`. The seat is held; the customer gets `booking.booking_confirmed` with `data.payAtDesk = true` (line "Payment at reception"). Check-in requires payment first (R35); reception takes it at `/admin/pos?order=<orderId>` with commerce's `posPayOrder`, which confirms the row through `confirmBookingsForOrder`. After `ends_at` the order expires and the row is `cancelled` (`payment_expired`); staff see unpaid pay-at-desk rows on the day view.
- **R64** Webinar sessions (R2): `upsertWebinarSession(tx, ctx, { webinarId, sessionId?, title, startsAt, endsAt })` creates or updates the one `sessions` row with `webinar_id` (kind `event`, `event_category = webinar`, `capacity_seats = 0`, `credit_kind = null`, `product_id = null`, `published_at = now()`), keyed by the partial unique index on `webinar_id`; `sessionId`, when the webinar already stores one, must be that row (else `conflict` reason `webinar_session_mismatch`) and is otherwise ignored; it returns `{ sessionId, created }`. `cancelWebinarSession(tx, ctx, { webinarId, reason })` sets it `cancelled` (`cancel_reason = reason`) and returns `{ cancelled: boolean }` (`false` when no row exists; cross-module D50); it is keyed by `webinarId`, not by a bare `sessionId` argument, so the call is idempotent and needs no lookup by the caller (section 13, decision 47). Registration is the webinar module's; `bookSession`, `joinWaitlist` and `createManualBooking` refuse such a session with `conflict` reason `webinar_session`. Both functions are idempotent.
- **R65** Future-booking import (SimplyBook cut-over, ops step `future_bookings_imported`): `importBooking(tx, ctx, row)` finds the materialised or one-off session with the row's `kind` and exact `starts_at` and inserts a `confirmed` row with `source = 'import'`, `external_ref`, `paid_with` from the row (`credit` rows write no ledger entry: ops imports package balances net of future bookings, which the cut-over runbook states; credits' `ledger.reconcile` must skip bookings with `source = 'import'`), and no email. No matching session returns `{ outcome: 'no_session' }` and ops marks the row `error`. A row that would exceed capacity is inserted with `is_over_capacity = true` and returned as `outcome: 'over_capacity'` for the import report. Past bookings are not booking rows and booking exposes no historical-import function: ops imports them into its own `imported_history` table (kinds `visit`, `no_show`, `cancellation`, `event_attendance`). Idempotent on `bookings.external_ref`.

## 4. Server surface

File layout (decided, see section 13): `apps/web/modules/booking/{actions,queries,jobs,api,schedules}.ts` are barrels that `export *` from area files in `actions/`, `queries/`, `jobs/`, `api/`, `schedules/` (`templates`, `sessions`, `bookings`, `attendance`, `waitlist`, `lead`, `tickets`, `partner`). The generators read the barrels; each package edits only its area files. Settings keys and flags are declared in `apps/web/modules/booking/config.ts` (platform convention). Pure logic lives in `packages/core/src/booking/` (`rules.ts`, `schedule.ts`, `availability.ts`, `policy.ts`, `waitlist.ts`, `claim-token.ts`, `duplicates.ts`, `checkin-code.ts`, `describe.ts`); public holidays come from `@beam/core/platform` (R4b).

### 4.1 Pure core functions (`@beam/core/booking`)

```ts
export function planOccurrences(t: TemplateLike, exceptions: ExceptionLike[], fromOn: string, toOn: string): Array<{ startsAt: Date; endsAt: Date }>;
export function diffTemplateSessions(planned: Array<{ startsAt: Date }>, existing: ExistingSession[]): { insert: Date[]; update: string[]; remove: string[]; untouched: string[] };
export function computeAvailability(row: AvailabilityRow, viewer: { status: 'lead'|'customer'|'member'|'anonymous'; isMember: boolean }, now: Date): Availability;
export type Availability = { bookable: number; reason: 'ok'|'full'|'member_only'|'not_open_yet'|'closed'|'cancelled'|'past'|'webinar';
  opensAt: Date | null; useLeadSeat: boolean; canJoinWaitlist: boolean; queue: 'lead'|'customer'|'public' | null; phase: LeadPhase };
export function cancellationOutcome(b: { kind: SessionKind; startsAt: Date; paidWith: PaidWith }, rules: BookingRules, now: Date): { status: 'cancelled'|'late_cancelled'; releaseCredit: boolean; refund: boolean; freeUntil: Date | null };
export function canReschedule(from: BookingLike, to: SessionLike, rules: BookingRules, chainLength: number, now: Date): { ok: true } | { ok: false; code: 'outside_window'|'different_kind'|'different_product'|'too_many' };
export function transition(entry: WaitlistLike, to: WaitlistState, actor: ActorKind): WaitlistLike; // throws InvalidTransitionError, ProtectedSeatError
export function nextOfferCandidates(entries: WaitlistLike[], phase: LeadPhase, pool: 'lead'|'general', limit: number): WaitlistLike[];
export function offerExpiry(now: Date, startsAt: Date, claimWindowMinutes: number, rules: BookingRules): Date | null;
export function claimToken(key: Uint8Array, entryId: string, offersCount: number): string; export function hashToken(token: string): string;
export function normaliseEmail(email: string): string;
export function duplicateSignals(candidate: DupCandidate, others: DupCandidate[]): string[]; // [] = clean
export function newCheckinCode(): string; // 10 chars Crockford base32
export function describeAvailability(a: Availability, locale: Locale): { labelKey: string; params: Record<string, string> };
export function bookingTransition(from: BookingStatus | null, to: BookingStatus, actor: ActorKind): void; // R27b; throws InvalidTransitionError
export function sessionTransition(from: SessionStatus, to: SessionStatus): void;                       // throws InvalidTransitionError
// R4b: no booking holiday calendar; `belgianPublicHolidays(year): { on: string; key: string }[]` is imported from `@beam/core/platform`
export function holidaySuggestions(holidays: Array<{ on: string; key: string }>, exceptions: ExceptionLike[], fromOn: string, toOn: string): Array<{ onDate: string; key: string }>; // R4b, holidays without an exception
export function nextOpening(from: Date, hours: BusinessHours, exceptions: ExceptionLike[], holidays: Array<{ on: string }>): Date | null; // 3.0b nextOpeningAt, 30-day horizon
export function overlapsByLocation(a: { location: string | null; startsAt: Date; endsAt: Date }, others: Array<{ id: string; location: string | null; startsAt: Date; endsAt: Date }>): string[]; // R6b
export function openingHoursFor(onDate: string, hours: BusinessHours, exceptions: ExceptionLike[]): { opensAt: string; closesAt: string } | null; // 3.0b
```

### 4.2 Server actions (`action()` wrapper; every staff write is audited with `audit` = the action name)

| Action (name) | Audience / permission | Input (Zod, summarised) | Output | activity_events kinds |
| --- | --- | --- | --- | --- |
| `createTemplates` (`booking.create_templates`) | staff / `settings.write` | `{ kind, name: LocalizedText, description?, weekdays: int[1..7][], startTimes: 'HH:mm'[] (1-12), durationMinutes, capacitySeats?, capacityBeds?, creditKind?, creditCost, productId?, isMemberOnly, location?, activeFromOn, activeToOn? }` | `{ templateIds: uuid[], warnings: { code: 'location_overlap'\|'outside_business_hours', detail }[] }` | none |
| `updateTemplate` (`booking.update_template`) | staff / `settings.write` | `{ id, expectedVersion, ...same fields partial }` | `{ id, version, regenerationJobId }` | none |
| `setTemplateActive` (`booking.set_template_active`) | staff / `settings.write` | `{ id, isActive }` (activation calls `assertComplete(name)`) | `{ id }` | none |
| `upsertException` / `deleteException` (`booking.upsert_exception`, `booking.delete_exception`) | staff / `settings.write` | `{ id?, onDate, kind, templateIds?, opensAt?, closesAt?, name, note? }` / `{ id }` | `{ id, conflicts: { sessionId, startsAt, liveBookings }[] }` | none |
| (rules and business hours) | staff / `settings.write` | platform's `updateSetting` action with key `booking_rules` or `business_hours` (no booking action) | `{ version }` | none |
| `createSession` (`booking.create_session`) | staff / `bookings.override` | `{ kind, eventCategory? (required for event), partnerCompanyId?, title, description?, startsAt (Brussels local ISO), durationMinutes, capacitySeats?, capacityBeds?, creditKind?, creditCost, productId?, isMemberOnly, location?, claimWindowMinutes?, publish: boolean }` | `{ sessionId, warnings }` | none |
| `updateSession` (`booking.update_session`) | staff / `bookings.override` | `{ id, expectedUpdatedAt, ...partial }` (R6) | `{ id }` | none |
| `publishSession` (`booking.publish_session`) | staff / `bookings.override` | `{ id }` (R50) | `{ publishedAt }` | none |
| `setSessionOpen` (`booking.set_session_open`) | staff / `bookings.write` | `{ id, open: boolean }` | `{ status }` | none |
| `cancelSession` (`booking.cancel_session`) | staff / `bookings.override` | `{ id, reason: string min 3, notify: boolean = true }` (R33) | `{ cancelledBookings, refundsRequested, releasedEntries }` | `booking.cancelled` per booking (`data.by = 'beam'`) |
| `upsertHold` / `deleteHold` (`booking.upsert_hold`, `booking.delete_hold`) | staff / `bookings.write` | `{ id?, sessionId, kind, quantity, companyId?, note? }` / `{ id }` (R11) | `{ id }` | none |
| `bookSession` (`booking.book`) | customer | `{ sessionId, ticketTypeId?, payWith: 'credit'|'order'|'guest'|'free', grantOwnerPersonId?, guests: { firstName, lastName, email?, sharesBed?: boolean, payWith: 'guest'|'order' }[] (max rules), promoCode?: string, useEuroCredit?: boolean, acceptTerms?: boolean (R62), emergencyContact?: { name, phone, relation? } (R62b, nights), clientKey: uuid }` | `{ kind: 'confirmed', bookingIds } \| { kind: 'checkout', orderId, redirectTo: '/<locale>/account/checkout/<orderId>' }` (commerce's pay page, R18) | `booking.reserved` or `booking.confirmed`; `booking.guest_added` per guest |
| `createManualBooking` (`booking.create_manual`) | staff / `bookings.write` (+ `bookings.override` for free, over capacity, member-only bypass) | `{ sessionId, personId, ticketTypeId?, payWith, payAtDesk?: boolean (R63), holdId?, overCapacity?: boolean, reason?, guests, emergencyContact?: { name, phone, relation? } (R62b, optional), sendEmail: boolean = true, clientKey: uuid }` | `{ bookingIds, orderId? }` (order-paid manual bookings create an `admin` channel order; staff then take payment at `/admin/pos?order=<orderId>` or send commerce's payment link) | as `bookSession`, `data.source = 'admin'` |
| `cancelMyBooking` (`booking.cancel_mine`) | customer (own `confirmed` rows or own guest rows; R27b) | `{ bookingId, expectedVersion, includeGuests: boolean = true }` | `{ status, creditReleased, refundRequested }` | `booking.cancelled` or `booking.late_cancelled` |
| `cancelBooking` (`booking.cancel`) | staff / `bookings.write` (+ `bookings.override` for `force`) | `{ bookingId, expectedVersion, includeGuests, reason, force?: 'release_credit'|'refund' }` | same | same, `data.by = 'staff'` |
| `rescheduleMyBooking` (`booking.reschedule_mine`) | customer | `{ bookingId, expectedVersion, targetSessionId }` (R31) | `{ newBookingId }` | `booking.rescheduled` (old and new ids) |
| `rescheduleBooking` (`booking.reschedule`) | staff / `bookings.write` (+ override across products) | `{ bookingId, expectedVersion, targetSessionId, reason }` | `{ newBookingId }` | `booking.rescheduled` |
| `addMyGuest` / `addGuest` (`booking.add_guest_mine`, `booking.add_guest`) | customer / staff `bookings.write` | `{ ownerBookingId, guest: { firstName, lastName, email?, sharesBed?, payWith } }` | `{ bookingId } \| { kind: 'checkout', orderId, redirectTo }` | `booking.guest_added`, `booking.confirmed` |
| `updateBookingNotes` (`booking.update_notes`) | staff / `bookings.write` | `{ bookingId, notes }` | `{ id }` | none |
| `checkIn` (`booking.check_in`) | staff / `bookings.write` | `{ bookingId } \| { checkinCode }` (R35) | `{ bookingId, personName, sessionTitle, status }` | `booking.attended` |
| `undoCheckIn` (`booking.undo_check_in`) | staff / `bookings.write` | `{ bookingId }` | `{ status }` | `booking.check_in_undone` |
| `markNoShow` / `revertNoShow` (`booking.mark_no_show`, `booking.revert_no_show`) | staff / `bookings.write` | `{ bookingId }` | `{ status }` | `booking.no_show` / `booking.attended` |
| `joinWaitlist` (`booking.join_waitlist`) | customer | `{ sessionId, acceptTerms?: boolean }` (R40, R48, R62) | `{ entryId, queue, position?: number }` | `waitlist.joined` (+ `waitlist.flagged`) |
| `withdrawFromWaitlist` / `declineOffer` (`booking.withdraw_waitlist`, `booking.decline_offer`) | customer | `{ entryId }` | `{ state }` | `waitlist.withdrawn` / `waitlist.released` |
| `addToWaitlist` (`booking.waitlist_add`) | staff / `waitlist.manage` | `{ sessionId, personId, queue? }` | `{ entryId }` | `waitlist.joined` |
| `offerSeatManually` (`booking.waitlist_offer`) | staff / `waitlist.manage` | `{ entryId, claimWindowMinutes? }` (needs capacity unless `bookings.override`) | `{ offerExpiresAt }` | `waitlist.offered` |
| `moveWaitlistEntry` (`booking.waitlist_move`) | staff / `waitlist.manage` | `{ entryId, queue?, joinedAt? }` | `{ entryId }` | `waitlist.requeued` |
| `releaseWaitlistEntry` (`booking.waitlist_release`) | staff / `waitlist.manage` | `{ entryId, reason }` | `{ state }` | `waitlist.released` |
| `reviewWaitlistFlag` (`booking.waitlist_review_flag`) | staff / `waitlist.manage` | `{ entryId, decision: 'clear'|'withdraw', note }` | `{ state, isFlagged }` | `waitlist.withdrawn` when withdrawn (`ended_reason = flag_withdrawn`) |
| `claimSeat` (`booking.claim_seat`) | public (the token proves identity; `rateLimit: { key: 'claim:ip:<ip>', limit: 20, windowSeconds: 60 }`) | `{ token, payWith?: 'credit'\|'order' }` (R44); the handler acts as `{ kind: 'customer', userId, personId }` of the entry's person when a customer `users` row exists, else as `public` with `booked_by_person_id = entry person` | `{ kind: 'confirmed', bookingId, redirectTo: '/<locale>/account/bookings/<id>' } \| { kind: 'checkout', orderId, redirectTo }` | `waitlist.confirmed` (when confirmed), `booking.confirmed` or `booking.reserved` |
| `configureLeadMagnet` (`booking.configure_lead_magnet`, R2) | staff / `bookings.override` | `{ sessionId, isLeadMagnet, leadReservedSeats? \| leadReservedPct? (rounded down), leadWindowStartLocal, leadWindowEndLocal (Europe/Brussels wall clock), releaseRule, publicReleaseLocal?, claimWindowMinutes, isWaitlistPositionVisible }` | `{ sessionId }` | none |
| `upsertTicketType` / `archiveTicketType` (`booking.upsert_ticket_type`, `booking.archive_ticket_type`, R2) | staff / `bookings.override` | `{ id?, sessionId, productId, name, capacity?, isMemberOnly, salesStartAt?, salesEndAt?, maxPerBooking, requiresGuestDetails, sortOrder }` | `{ id }` | none |
| `assignHoldSeat` / `unassignHoldSeat` (`booking.assign_hold_seat`, R3) | staff `bookings.write`, or `partner.own` for holds of the user's partner company | `{ holdId, firstName, lastName, email? }` / `{ bookingId }` | `{ bookingId }` | `booking.confirmed` (`paid_with = free`, `data.partner_company_id`) |

Errors are the wrapper's codes; `conflict` carries a `reason` from: `session_full`, `already_booked`, `already_waiting`, `stale_version`, `outside_window`, `not_on_sale`, `member_only`, `insufficient_credits`, `sharing_not_allowed`, `needs_review`, `capacity_below_bookings`, `protected_seat`, `payment_required`, `terms_required`, `health_declaration_required`, `emergency_contact_required`, `webinar_session`, `webinar_session_mismatch`, `session_closed`, `invalid_transition`, `shared_bed_limit`. `validation` covers malformed input.

### 4.3 Queries (`queries.ts`, server components; staff queries call `requirePermission`)

Staff (`bookings.read`): `listSessionsInRange({ from, to, kind? })`, `getDayView({ onDate })` (sessions with availability and attendee counts), `getSessionDetail(id)` (session, availability, holds, ticket types, attendees with person name, payment, guest-of, check-in state, waitlist), `searchCheckin({ onDate, q })` (attendees of that day's sessions whose `first_name || ' ' || last_name` or email `ilike` `%q%`; the set is one day so no index is needed; each row carries `healthDeclaration: { valid, expiresAt }` from `forms.hasValidSubmission` and `termsAccepted`, R62b), `listTemplates()`, `getTemplate(id)`, `listExceptions({ from, to })`, `listBookings({ personId?, sessionId?, status?, from?, to?, cursor })` (keyset on `(created_at, id)`, 50 per page), `getBooking(id)`, `getUtilisation({ from, to, kind? })` (`v_session_utilisation`), `getDayPrintList({ onDate })` (every session of the day with attendees: time, name, guest-of, paid with, to-pay amount, terms not yet accepted, health declaration missing or expired, notes; printable fallback for reception when the network is down), `listUpcomingHolidays()` (R4b), `getOpeningHours({ from, to })`. `waitlist.manage`: `listWaitlist({ sessionId?, state?, flaggedOnly?, cursor })`. `partner.own` (R3): `listMyPartnerHolds()`.
Customer (scoped to `ctx.actor.personId`): `listBookableSessions({ kind, fromOn, toOn, templateId? })` (`templateId` from `?template=`, section 5.2), `getBookableSession(sessionId)` (availability for this person, price quote, payment options, credit balance from `v_person_credits`, health declaration state, whether an emergency contact is needed, R62b), `listMyBookings({ scope: 'upcoming'|'past'|'events' })`, `getMyBooking(id)` (with QR data URL rendered inline as SVG), `listRescheduleTargets(bookingId)`, `listMyWaitlist()`.
Public: `getClaimOffer(token)` (session title, starts_at, expiry, state; no personal data beyond the first name).

### 4.4 Route handlers

| Route | Method | Behaviour |
| --- | --- | --- |
| `/api/public/claim/[token]` | GET | Looks up `claim_token_hash`; 303 to `/{locale}/claim/{token}` with the person's locale (unknown token: 303 to `/{default}/claim/invalid`). No state change. `cache-control: no-store`. |
| `/api/public/claim/[token]` | POST | Not served (405). Claiming is the `claimSeat` server action posted from the claim page, so it runs inside `action()` (transaction, Server Actions origin check, rate limit) like every other mutation. |

No webhooks in this module.

### 4.5 Jobs (`defineJob`; every handler is idempotent and covered by the double-run test)

| Kind | Lane | Payload | Idempotency key | Retries | What it does |
| --- | --- | --- | --- | --- | --- |
| `sessions.materialise` | bulk | `{ fromOn?, days?: 90 }` | `schedule:sessions.materialise:<minute>`; continuations `materialise:<run date>:<fromOn>` | 6, retryable | R1 for all active templates; self-continues per 30-day chunk |
| `sessions.cancel_bookings` | fast | `{ sessionId, afterBookingId? }` | `cancel_session:<session_id>:<afterBookingId or start>` | 6 | R33 chunks of 50 bookings; self-continues |
| `sessions.regenerate_template` | fast | `{ templateId }` | `regenerate:<template_id>:<version>` | 6 | R2 |
| `sessions.regenerate_date` | fast | `{ onDate }` | `regenerate_date:<on_date>:<exception_id>:<updated_at epoch ms>` | 6 | R4 |
| `bookings.expire_reservations` | fast | `{}` | `schedule:bookings.expire_reservations:<minute>` | 3 | R18 safety net; enqueues `waitlist.offer_next` |
| `bookings.mark_no_shows` | fast | `{}` | `schedule:bookings.mark_no_shows:<minute>` | 6 | R37, R39 |
| `bookings.send_reminders` | fast | `{}` | `schedule:bookings.send_reminders:<minute>` | 6 | R60 |
| `waitlist.expire_offers` | fast | `{}` | `schedule:waitlist.expire_offers:<minute>` | 6 | R45, R47, R26 (R2), enqueues `waitlist.offer_next`; also releases lead seats at window end (R24b) |
| `waitlist.offer_next` | fast, priority 1 | `{ sessionId }` | `waitlist:<session_id>:offer_next:<trigger_id>` (trigger = booking id, entry id, hold id, `release:<phase>` or `<minute>`) | 6 | R42; sends `booking.seat_offered` with key `waitlist:<entry_id>:offer:<offers_count>` |

Permanent errors: unknown ids, invalid payload. A job never touches a `confirmed` waitlist entry (asserted by `transition()`).

### 4.6 Schedules (`schedules.ts`, cron in Europe/Brussels)

`waitlist.expire_offers` `* * * * *`; `bookings.expire_reservations` `* * * * *`; `bookings.mark_no_shows` `*/15 * * * *`; `bookings.send_reminders` `*/15 * * * *`; `sessions.materialise` `10 3 * * *`.

### 4.7 Event kinds (`events.ts`, `defineEvent`)

Booking facts: `booking.reserved`, `booking.confirmed`, `booking.cancelled`, `booking.late_cancelled`, `booking.rescheduled`, `booking.guest_added`, `booking.attended`, `booking.check_in_undone`, `booking.no_show`, `booking.event_ended` (R2). Waitlist facts (prefix `waitlist.`, the names crm's timeline catalogue and automation's `waitlist-offer` sequence already use): `waitlist.joined`, `waitlist.flagged`, `waitlist.requeued`, `waitlist.offered`, `waitlist.confirmed`, `waitlist.expired`, `waitlist.released`, `waitlist.withdrawn`. All with `ref_type = 'booking'` or `'waitlist_entry'`, `is_sensitive = false`, subject `person`, declared with `defineEvent` and a Zod `data` schema carrying the R61 keys (`waitlist.offered` adds `offer_expires_at`, the automation anchor). A reschedule writes `booking.rescheduled`, `booking.cancelled` (old row) and `booking.confirmed` (new row, `data.rescheduled_from_booking_id`, old `is_first_booking` carried over) in one transaction (R31). Automation's names `booking.seat_offered`, `booking.seat_claimed`, `booking.offer_expired`, `booking.waitlist_released` and `booking.waitlist_withdrawn` are not emitted; they are `waitlist.offered`, `waitlist.confirmed`, `waitlist.expired`, `waitlist.released` and `waitlist.withdrawn` here (decision 10, cross-module D53 and Convention 2: `<entity>.<past_tense_or_fact>`, each kind declared once in this module's `events.ts`, `data` keys snake_case).

### 4.8 Monitoring signals (SLA: booking not working is a Critical incident)

`api.ts` exports `getBookingHealth(db): Promise<BookingHealth>` with `BookingHealth = { level: 'ok' | 'warn' | 'alert'; materialisedThroughOn: string; overdueOffers: number; overdueReservations: number; unsentConfirmations24h: number }`: the last date with a materialised session for every active template, `offered` entries more than 2 minutes past `offer_expires_at`, `reserved` rows more than 2 minutes past `reserved_until`, and confirmed bookings of the last 24 h without an `email_messages` row for `booking:<id>:confirmed`. `level` is set by booking's thresholds: `alert` when `materialisedThroughOn < today + 60 days` or `overdueOffers > 10` or `overdueReservations > 10`; otherwise `warn` when `overdueOffers > 0` or `overdueReservations > 0`; otherwise `ok`. Platform's `/api/health` shows the result under `checks.booking` and never returns 503 because of it; `alert` raises a High Slack alert from `platform.check_alerts` (fingerprint `booking-health`), `warn` goes to the daily digest (ops' `ops.daily_digest` prints the values) (cross-module D48). A test (`api/health.test.ts`) builds each condition on PGlite and asserts the `level` it yields. The dead-job alert of the architecture covers every booking job; `e2e/booking.spec.ts` is part of the post-deploy smoke suite so a broken booking path is caught within the deploy, not by a customer.

### 4.9 Cross-module API (`apps/web/modules/booking/api.ts`)

```ts
import type { Tx, DbOrTx } from '@beam/db';
import type { Ctx } from '@/lib/ctx';

// availability (Wave 0 contract name and shape)
export function getAvailability(db: DbOrTx, input: { sessionId: string; personId?: string; at?: Date }): Promise<Availability & { sessionId: string; kind: SessionKind; productId: string | null; capacity: number; held: number; booked: number; waiting: number }>;
export function getAvailabilityPreview(db: DbOrTx, input: { kind: 'day'|'night'; from: Date; to: Date }): Promise<Array<{ sessionId: string; startsAt: Date; band: 'available'|'few'|'full' }>>; // site availability_preview block
export function listBookableSessions(db: DbOrTx, input: { kind?: 'day'|'night'|'event'; fromOn: string; toOn: string; personId?: string }): Promise<SessionSummary[]>;
export function listPublicEvents(db: DbOrTx, input: { from: Date; limit: number; offset: number }): Promise<Array<{ sessionId: string; title: LocalizedText; startsAt: Date; endsAt: Date; status: SessionStatus; eventCategory: EventCategory; isMemberOnly: boolean; isLeadMagnet: boolean; leadWindowEndAt: Date | null; location: string | null; productId: string | null; availabilityBand: 'available'|'few'|'full' }>>; // site; webinar sessions included
export function getSessionCards(tx: DbOrTx, sessionIds: string[], locale: Locale): Promise<SessionCard[]>; // email `event` block; R2 (booking-P7) adds `opensForCustomersAt: Date | null`
export function getOpeningHours(db: DbOrTx, input: { from: string; to: string }): Promise<Array<{ onDate: string; opensAt: string | null; closesAt: string | null; exceptionName: LocalizedText | null }>>; // site footer, contact page
export function nextOpeningAt(db: DbOrTx, from: Date, opts?: { includePublicHolidays?: boolean }): Promise<Date | null>; // automation task due dates, 3.0b

// commerce hooks (names and shapes as commerce's spec calls them; booking reserves before createOrder, R18)
export function confirmBookingsForOrder(tx: Tx, ctx: Ctx, input: { orderId: string }): Promise<{ confirmedBookingIds: string[]; unavailableOrderLineIds: string[] }>; // in finalizePaidOrder; commerce refunds each unavailable line automatically (`refundOrderLine` reason `seat_no_longer_available`, no task, edge case 3); also confirms linked waitlist entries
export function releaseBookingsForOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason: 'payment_expired'|'payment_failed'|'order_cancelled' }): Promise<{ releasedBookingIds: string[] }>; // codes payment_expired (also for payment_failed) / order_cancelled
export function cancelBookingsForOrderLine(tx: Tx, ctx: Ctx, input: { orderLineId: string; reason: 'refunded' }): Promise<{ cancelledBookingIds: string[] }>; // staff refund in commerce; code `refunded`, never a second refund
export function createBookingForPosLine(tx: Tx, ctx: Ctx, input: { orderLineId: string; sessionId: string; personId: string }): Promise<{ bookingId: string }>; // POS walk-in, `reserved` until the POS payment; throws ConflictError('session_full'|'member_only'|'already_booked'), commerce maps to `sold_out`

// people and history
export function hasFutureBooking(db: DbOrTx, personId: string, kinds?: Array<'day'|'night'|'event'>): Promise<boolean>; // automation `unless`
export function getNextBooking(tx: DbOrTx, personId: string): Promise<{ bookingId: string; sessionId: string; startsAt: Date; kind: SessionKind } | null>; // email tokens
export function getPersonBookingSummary(db: DbOrTx, personId: string): Promise<{ nextBookingAt: Date|null; upcoming: number; attended: number; noShows: number; cancellations: number; lateCancellations: number; firstVisitAt: Date|null; lastVisitAt: Date|null; nightsBooked: number; eventsAttended: number }>;
export function listPersonBookings(db: DbOrTx, personId: string, opts?: { limit?: number }): Promise<PersonBookingRow[]>; // crm person page
export function listUpcomingBookingsForPerson(db: DbOrTx, personId: string, limit: number): Promise<Array<{ bookingId: string; sessionId: string; title: LocalizedText; kind: SessionKind; startsAt: Date; isGuest: boolean; guestFirstName: string | null }>>; // site account home; rows where the person is attendee or booker, live statuses, starts_at > now(), ordered by starts_at
export function listOpenOffersForPerson(db: DbOrTx, personId: string): Promise<Array<{ entryId: string; sessionId: string; title: LocalizedText; startsAt: Date; offerExpiresAt: Date }>>; // site account home; `offered` and not expired
export function importBooking(tx: Tx, ctx: Ctx, row: { externalRef: string; personId: string; kind: SessionKind; startsAt: Date; paidWith: 'credit'|'order'|'free' }): Promise<{ bookingId: string | null; outcome: 'created'|'existing'|'no_session'|'over_capacity' }>; // ops cut-over import, R65
export function getBookingHealth(db: DbOrTx): Promise<BookingHealth>; // 4.8

// webinar (R2)
export function upsertWebinarSession(tx: Tx, ctx: Ctx, input: { webinarId: string; sessionId?: string; title: LocalizedText; startsAt: Date; endsAt: Date }): Promise<{ sessionId: string; created: boolean }>; // R64
export function cancelWebinarSession(tx: Tx, ctx: Ctx, input: { webinarId: string; reason: string }): Promise<{ cancelled: boolean }>; // R64; no `linkWebinarSession` exists (cross-module D50)
```

`Locale`, `SessionKind`, `SessionStatus`, `EventCategory`, `SessionCard`, `SessionSummary`, `PersonBookingRow` and `BookingHealth` are exported from `@beam/core/booking/types.ts`.

## 5. Screens

All screens use `@beam/ui` (`DataTable`, `LocalizedInput`, `FormField`), dates in Europe/Brussels with `Intl`, and the `booking` catalogue. Every list has an empty state with a next action, a skeleton while loading (`loading.tsx`) and an `error.tsx` that shows the request id and a retry button. Optimistic-version conflicts show "This booking changed meanwhile, reload" and reload the data.

### 5.1 Staff back-office (`app/(admin)/admin/...`, permission checked by `requirePermission`, nav hidden by the same list)

| Route | Permission | Shows | Actions | Empty / special states |
| --- | --- | --- | --- | --- |
| `/admin/sessions` | `bookings.read` | Week calendar (Mon-Sun), filter by kind; each session as a block with booked/capacity, holds, waiting count, lead badge, status colour | open day view, new session (override), go to templates | "No sessions this week: add a template" |
| `/admin/sessions/day/[date]` | `bookings.read` | Day view: sessions in time order with availability bars, attendees count, check-in progress, unpaid pay-at-desk rows, opening hours and exceptions banner for that date | open session, check-in desk, close/reopen session, print day list | closed day banner with the exception name |
| `/admin/sessions/day/[date]/print` | `bookings.read` | `getDayPrintList`: one A4 table per session (time, name, guest of, paid with, to pay, terms pending, notes), print stylesheet, no navigation | browser print | "No sessions on this day" |
| `/admin/sessions/[id]` | `bookings.read` | Session detail: header (time, kind, event category, capacity, held, booked, live offers, waiting, lead phase), attendee list (name, guest-of, paid with, ticket type, status, check-in button, notes), holds tab, waitlist tab (component `ui/session-waitlist-tab.tsx`), ticket types tab (R2), lead magnet tab (R2), history (audit rows) | check in / undo / no-show, manual booking, cancel booking, reschedule, add guest, edit session, publish, cancel session, add/edit hold, manage waitlist, configure lead magnet, ticket types | "No bookings yet"; cancelled session shows reason and refunds status read-only |
| `/admin/sessions/new` | `bookings.override` | One-off session or event form; `LocalizedInput` for title/description with completeness badge | create (draft) or create and publish | publish button disabled with the list of missing locales |
| `/admin/sessions/templates` | `settings.write` | Templates table: kind, name, weekdays, time, duration, capacity, credits, product, member-only, validity, active | add schedule (several start times), edit, activate/deactivate | "No schedule yet: add your first day sessions" |
| `/admin/sessions/templates/[id]` | `settings.write` | Edit form plus a preview of the next 14 days and of the sessions that will not change because they have bookings | save (shows regeneration job status from `jobs`) | regeneration failed: banner with retry link to `/admin/system/jobs` |
| `/admin/sessions/exceptions` | `settings.write` | Calendar list of exceptions, form for closed day, holiday, special hours, template filter; panel "Belgian public holidays in the next 12 months" without an exception (R4b) | add, edit, delete, "Close this day" per holiday; conflicts list with "cancel these sessions" (override) | "No closed days planned" |
| `/admin/sessions/rules` | `settings.write` | Tab 1 `settings.booking_rules` grouped: cancellation, no-show, check-in, booking window, guests, reminders, waitlist, pay at desk. Tab 2 `settings.business_hours` per weekday, reception phone, note | save through platform's `updateSetting` (versioned, audited `settings.update`) | validation errors inline; stale version: "Someone changed these rules, reload" |
| `/admin/sessions/holds` | `bookings.read`; R3 also `partner.own` (own company only, no customer PII beyond the names they entered) | Holds across future sessions: session, kind, quantity, used, company, note | add/edit/delete (`bookings.write`), assign named person to a hold seat (R3) | "No holds" |
| `/admin/bookings` | `bookings.read` | Search and filter bookings (person, session, status, date range, paid with, source), keyset paging | open booking, new manual booking | "No bookings match these filters" |
| `/admin/bookings/new` | `bookings.write` | Manual booking wizard: person search (crm) or "new person" (name, optional email and phone through crm), session picker with live availability, payment choice with credit balance (credit, order now at POS, pay at desk, free), guests, override toggles (only with `bookings.override`), send email checkbox | create | over-capacity toggle shows the warning text |
| `/admin/bookings/[id]` | `bookings.read` | Booking detail: person, session, status history from `activity_events`, credits entries, order line link, guests, QR code, notes, waitlist origin | cancel (policy preview), force options (override), reschedule, add guest, check-in, edit notes | |
| `/admin/bookings/checkin` | `bookings.write` | Reception desk: today's sessions; one focused input that accepts a scanned code (USB/Bluetooth scanner as keyboard, or phone camera opening the QR URL) or a name; result card with big check-in button (guests listed with "Check in all"), crm's `ReceptionCard` (customer number, status, member, tags, emergency contact, minor) and credits' `DeskCreditsBadge` (needs `credits.read`; hidden without it), health declaration state from `forms.hasValidSubmission` (R62b); list of not-yet-arrived per session with the health declaration badge | check in, undo, take payment (opens `/admin/pos?order=<id>` for `reserved` rows), add walk-in (manual booking or commerce POS sale with a session line), mark no-show | wrong-day code warning; unknown code "not found"; already checked in shows time; unpaid: "To pay: €45.00" and no check-in button; "Terms not yet accepted" badge; "Health declaration missing/expired" badge with "Fill in a form" (forms' `/admin/forms/enter?personId=`), never blocking check-in |
| `/admin/waitlist` | `waitlist.manage` | All waitlist entries of future sessions grouped by session and queue; flagged-for-review filter with the duplicate signals | offer seat, move queue, reorder, release, review flag (clear/withdraw), add person | "Nobody is waiting" |

The QR code encodes `https://<host>/admin/bookings/checkin?c=<checkin_code>`; opening it on a logged-in staff device pre-fills the desk; on any other device the admin login page appears and no booking data is shown.

### 5.2 Customer portal (`app/[locale]/(portal)/account/...`, logged-in customer, data scoped to `ctx.actor.personId`)

| Route | Shows | Actions | States |
| --- | --- | --- | --- |
| `/[locale]/account/book` (accepts `?template=<sessionTemplateId>`: opens the tab of that template's kind and lists only its sessions, with a "Show all" chip; an unknown or inactive id is ignored; forms' result CTAs link here) | Tabs Day / Night / Events; date strip for the booking horizon; sessions with time, "x places left" (exact number only when <= 5, otherwise "available"), price or "1 session from your package", member-only badge, lead-window message "Opens for you on ..." | open a session | empty "No sessions on this day"; closed-day label with the holiday name |
| `/[locale]/account/book/[sessionId]` | Session detail and booking form: payment choice (credits with remaining "4 sessions remaining", buy single with price from `getQuote` and a promo-code field, use a package shared with me), guests (name, optional email, share bed for nights, "{n} guest uses left this month"), ticket type picker (R2), cancellation policy text with the free-until time and the no-withdrawal notice (R28), terms checkbox with a link to the current terms when R62 requires it, health declaration notice with a link to the form when missing or expired (R62b; blocking only when `require_health_declaration`), emergency contact fields on night sessions when none is on file (R62b) | book; join waitlist when full; join customer queue (R2) | full: waitlist button; not open yet: opening time; closed: "Closed for booking"; member-only: "For members" with link to membership; errors from `conflict` mapped to messages |
| `/[locale]/account/bookings` | Upcoming and past bookings, event registrations tab, guest bookings I made, bookings where I am a guest | open a booking | "No upcoming bookings" with a Book button |
| `/[locale]/account/bookings/[id]` | Booking detail: QR code for reception, session, guests, payment, policy ("Free cancellation until Tue 14 Jan 18:00" or "Cancelling now keeps the session used") | cancel (confirm dialog shows the outcome), reschedule, invite a guest, add to calendar (`.ics` generated client-side) | cancelled booking read-only; reserved: "Awaiting payment until {time}" with "Complete payment" (commerce) and no cancel button; pay at desk: "Pay at reception" |
| `/[locale]/account/bookings/[id]/reschedule` | Eligible target sessions (R31) | pick and confirm | "No other session available in your free window" |
| `/[locale]/account/waitlist` | My entries: waiting (queue name, position only when enabled), offered (countdown to expiry and "Claim my seat" button), confirmed (link to booking), expired/released | claim, decline, withdraw, rejoin once | "You are not on any waiting list" |

### 5.3 Public (`app/[locale]/(site)/claim/[token]/page.tsx`, owned by this module)

Shows the offer: session title and time, expiry countdown in Brussels time, the person's first name, payment hint, and a "Confirm my seat" button that calls the `claimSeat` server action, plus "I can't come" (`declineOffer` with the token). States: expired or superseded ("This offer has expired; the seat went to the next person"), already claimed (link to the booking), invalid token, session cancelled. `noindex`, `referrer-policy: no-referrer` (the token is in the URL), no third-party scripts. The public site pages for sessions and events are owned by `site`; they call `booking.listPublicEvents`, `getAvailabilityPreview` and `getAvailability` and link to `/[locale]/account/book/[sessionId]`.

### 5.4 Accessibility (portal, claim page and check-in desk)

WCAG 2.1 AA, the level site and commerce also target (European Accessibility Act for consumer booking services, Belgian law of 2022-04-29 transposing it): every control reachable and operable by keyboard; visible focus; session cards are buttons with an accessible name ("Tuesday 14 January, 10:00, Day session, 3 places left"); availability is never conveyed by colour alone; the claim countdown updates an `aria-live="polite"` region once a minute, not every second; error messages from `conflict` are announced (`role="alert"`) and linked to the field; date strip and time pickers work at 200 % zoom and 320 px width; touch targets at least 44 x 44 px; the desk's scan input keeps focus after each scan. Tested by `@axe-core/playwright` scans in `e2e/booking.spec.ts` on `/account/book`, `/account/book/[id]`, `/account/bookings/[id]`, `/account/waitlist`, the claim page and `/admin/bookings/checkin` (zero serious or critical violations).

## 6. Integrations

None directly. This module calls no external service and nothing from `packages/integrations`. Payments and refunds go through `commerce` (Mollie behind `PaymentProvider`), emails through `email.sendTransactional` (Resend), invoices and credit notes through `finance` (Billit). The QR PNG is rendered locally with the `qrcode` library inside the confirming transaction and stored through `storeFile(ctx, { kind: 'image', name: 'checkin-<id>.png', mime: 'image/png', bytes, isPublic: false, expiresAt: ends_at + 1 day, personId })`; the emails carry it as an inline attachment (`attachments: [{ fileId, filename: 'checkin-qr.png', inline: true }]`, shown through `cid:`), so no signed link can lapse; the portal renders the QR inline as SVG. No request leaves the platform. Terms acceptance goes through `site` (R62), no external service. Idempotency of every side effect it triggers is carried by the keys in section 4 (`booking:<id>:confirmed`, `booking:<id>:cancelled`, `booking:<id>:reminder:<h>`, `waitlist:<entry_id>:offer:<n>`, credit keys `consume:<booking_id>:<grant_id>` owned by credits, refunds keyed by order line in commerce).

## 7. Permissions and audit

This module declares no new permission strings; `modules/booking/permissions.ts` registers the use of `bookings.read`, `bookings.write`, `bookings.override`, `waitlist.manage` and documents the borrowed `settings.write`, `partner.own`, `reports.read`.

| Role (default set) | What it can do here |
| --- | --- |
| owner, technical_admin, management | everything: templates, exceptions, rules, events, lead magnet, ticket types, overrides, session cancellation, waitlist |
| customer_service | `bookings.read/write`, `waitlist.manage`: manual bookings, cancel and reschedule inside policy, guests, check-in, no-shows, holds, waitlist management. No free bookings, over-capacity, forced refunds, events or schedule edits |
| reception | same as customer_service in this module (check-in desk is its main screen); with `commerce.sell` it also takes desk payments and walk-in POS sales |
| sales | `bookings.read`: calendars, session detail, booking search |
| marketing, finance | nothing in this module except reports through `ops` (`reports.read`) |
| external_partner | R3: `/admin/sessions/holds` for holds of their own partner company; assign names to those seats; sees counts, never other attendees |
| customer | own bookings, guests they booked, waitlist entries, claim links |

Audited (`audit_log`, written by the `action()` wrapper for every staff write; `entity_type` in parentheses; `old_value`/`new_value` hold the changed columns only): every action in 4.2 with audience staff. Explicit cases required by blueprint 56: `booking.cancel` and `booking.cancel_session` ("Booking cancelled"), every `booking.waitlist_*` action ("Waitlist manually changed"), `booking.create_manual` with `overCapacity`, `free` or `payAtDesk`, `settings.update` for `booking_rules` and `business_hours` (written by platform), `booking.update_template`, `booking.check_in` / `booking.undo_check_in` / `booking.revert_no_show`. System changes (jobs) are not in `audit_log`; they are in `activity_events` with `actor.kind = 'system'`. Customer actions are not audited; they are in `activity_events` with `actor.kind = 'customer'`.

## 8. Multi-language and content

- Catalogue namespace `booking` in `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/booking.json`; keys `booking.<screen>.<element>`, screens: `calendar`, `day`, `session`, `templates`, `exceptions`, `rules`, `holds`, `bookings`, `manual`, `checkin`, `waitlist`, `portalBook`, `portalSession`, `portalBookings`, `portalBooking`, `portalReschedule`, `portalWaitlist`, `claim`, `print`, `holidays` (one name per `belgianPublicHolidays` key), `eventCategory` (one per enum value), `errors` (one key per `conflict` reason), `availability` (`openForYouOn`, `placesLeft`, `full`, `memberOnly`, `notOpenYet`, `closed`, `queuePosition`), `email.<name>.<slot>` with `<name>` the snake_case template name (email's copy-slot convention `<m>.email.<name>.<slot>`, so `booking.email.booking_confirmed.<slot>`).
- LocalizedText fields: `session_templates.name`, `session_templates.description`, `sessions.title`, `sessions.description`, `session_exceptions.name`, `ticket_types.name`. Edited with `LocalizedInput`.
- Publish-time checks with `assertComplete(text, ['nl-BE','fr-BE','en'])`: activating a template (`name`; `description` when present), publishing a session or event (`title`; `description` when present; every active ticket type `name` from R2), saving an exception (`name`). Materialised sessions copy a complete template name, so they are always complete.
- Emails: react-email templates in `packages/email/src/templates/booking/` (`booking-confirmed.tsx`, `booking-rescheduled.tsx`, `guest-invited.tsx`, `booking-cancelled.tsx`, `booking-late-cancelled.tsx`, `session-cancelled.tsx`, `booking-reminder.tsx`, `waitlist-joined.tsx`, `seat-offered.tsx`, `seat-claimed.tsx`, `offer-expired.tsx`; R2 `lead-window-open.tsx`) with their Zod props schemas and the `defineTemplate()` entries in `templates/booking/index.ts` (keys `booking.<name>` with `<name>` = file basename with `-` replaced by `_`, R59), copy slots under `booking.email.<name>.<slot>` (e.g. `booking.email.seat_offered.subject`), rendered in `persons.locale`; a missing key blocks the email (`blocked_translation`), never the booking. Confirmation and reminder emails attach the QR inline from `qr_file_id`; claim emails carry the claim URL computed at send time.
- Dates: `Intl.DateTimeFormat(locale, { timeZone: 'Europe/Brussels', dateStyle: 'full', timeStyle: 'short' })`; "Opens for you on" uses the same format. Admin lead-window inputs are wall-clock Brussels times converted with `date-fns-tz` style helpers in `@beam/core/booking/schedule.ts` (DST-safe).

## 9. Privacy

`apps/web/modules/booking/privacy.ts`:

```ts
export const bookingPrivacy = { tables: ['bookings', 'waitlist_entries'],
  export: (tx, personId) => Promise<{ 'bookings.json': unknown[]; 'waitlist.json': unknown[] }>,
  erase: (tx, personId) => Promise<Array<{ table: string; rows: number; action: 'deleted'|'anonymised'|'retained_legal' }>>,
  // retention handlers called by ops' privacy.retention_sweep as sweep[key](tx, cutoff), keyed by retention policy key
  // (Convention 4, cross-module D37); each returns the rows touched in one batch (ops calls again while the count equals the batch size)
  sweep: { 'booking.waitlist_entries': (tx: Tx, cutoff: Date) => Promise<number>,
           'booking.bookings_free_text': (tx: Tx, cutoff: Date) => Promise<number> } } satisfies PrivacyRegistration; // { tables, export, erase, sweep?, retention? } (cross-module D69)
```

| Table | Person data | Export includes | Erase does | Why |
| --- | --- | --- | --- | --- |
| `bookings` | `person_id`, `booked_by_person_id`, `booked_by_user_id`, `notes`, `cancel_reason`, `checkin_code`, `qr_file_id` | every row where the person is attendee or booker: session title, kind, start, status, paid with, guest-of (guest shown by first name only), cancellation, attendance times | future live rows where the person is the attendee are cancelled first with code `erased` (no refund and no credit release here; credits revokes the person's grants in its own step; no email; `waitlist.offer_next` enqueued per affected session, R34). Guest rows of other people that the erased person booked stay as they are (the guest's seat is the guest's). Then for all rows: `notes = null`, `cancel_reason = null`, `checkin_code` replaced by a fresh random code, QR file deleted, `booked_by_person_id = null` when it is the erased person. Rows are kept (`anonymised`) linked to the anonymised `persons` row | capacity history, utilisation statistics and the credits ledger reconciliation reference booking ids; `persons` itself is anonymised by crm, so the kept rows identify nobody. Rows linked to an `order_line_id` are reported as `retained_legal` (accounting) |
| `waitlist_entries` | `person_id`, `email_normalised`, `join_ip_hash`, `flag_reason` | every entry: session, queue, state, joined/offered/expiry times | **deleted** (architecture: erasure deletes waitlist entries; scenario 7) | no legal reason to keep |
| `capacity_holds` | `note` may name a speaker (not a customer) | not included | not touched | not linked to `persons`; listed in `NO_PII_TABLES` with that justification |
| `sessions`, `session_templates`, `session_exceptions`, `ticket_types` | none | - | - | `NO_PII_TABLES` |

Order in `GDPR_REGISTRY`: booking erase runs after `credits` and `commerce` (so refunds and revocations already happened) and before `crm` anonymises `persons`. The erase job runs under `SET LOCAL beam.allow_rewrite = 'on'` (not needed for these mutable tables, harmless).

Retention policies registered (rows in `retention_policies`, seeded by `packages/db/src/seed/booking.ts`, each inserted `on conflict (key) do nothing`, enforced by `ops`' `privacy.retention_sweep` through the module `sweep` handlers above, because the anchor is the session's `starts_at`, not `created_at`): `booking.waitlist_entries` delete 365 days after the session's `starts_at` (`days = 365`, `action = delete`); `booking.bookings_free_text` anonymise (`notes`, `cancel_reason` set null) 3 years after `starts_at` (`days = 1095`, `action = anonymise`, `table_name = 'bookings'`). Keys follow Convention 4 (cross-module D37: `waitlist_entries` -> `booking.waitlist_entries`, `bookings_free_text` -> `booking.bookings_free_text`). Each handler is called as `sweep[key](tx, cutoff)` with `cutoff = now() - days`, touches one batch of rows whose session `starts_at < cutoff`, ordered by id, and returns the count; booking rows themselves are kept as long as the person record exists (they are removed of identity by the person's erasure or by ops' `ops.marketing_profile` sweep, the 3-year whole-profile anonymisation). QR files expire one day after the session (`files.purge_expired`).

## 10. Dependencies

### Needs from other modules

| Module | Capability (api.ts function or table) | Used for |
| --- | --- | --- |
| platform | `ctx` (`tx`, `actor`, `ip`, `enqueue`, `recordEvent`, `audit`, `require`), `action()` (audiences `staff`, `customer`, `public`), `defineJob`, `defineSchedule`, `defineEvent`, `requirePermission()`, `flag(key, actor)`; `belgianPublicHolidays(year)` from `@beam/core/platform` (R4b, `nextOpeningAt`); `getSetting(tx, 'booking_rules' \| 'business_hours')`; the `updateSetting` action (rules screen); `storeFile(ctx, {...})` (QR PNG, sent as an inline email attachment); `config.ts` registry for settings and flags; `/api/health` (`checks.booking`, never 503; `platform.check_alerts` fingerprint `booking-health` on `alert`) and digest reading `booking.getBookingHealth`; tables `users`, `files`, `settings` | rules, QR files, jobs, audit, monitoring |
| crm | `crm.getPersonStatus(tx, personId): Promise<{ status, derivedStatus, override, hasActiveMembership }>` (booking reads `.status` only: lead windows and queues), `crm.findOrCreatePersonByEmail(tx, ctx, { email, firstName?, lastName?, phone?, locale, acquisition? })`, `crm.createPersonWithoutEmail(tx, ctx, { firstName, lastName?, phone?, locale, acquisition })` (guests and walk-ins; booking never calls a `createPerson`), `crm.searchPersons(tx, { q, limit })` for the manual-booking picker, `crm.getReceptionCard(db, personId)` and the exported `ReceptionCard` component (check-in desk, night emergency-contact check; its `declarations = { termsAccepted, healthDeclarationValid, guardianConsentValid }` are built by crm from site, forms and crm, cross-module D15), `crm.updatePersonFields(tx, ctx, personId, { emergencyContact }, { onlyEmpty: true })` (`emergencyContact: { name, phone, relation? }` is a `PersonFieldPatch` field, cross-module D13); tables `persons` (FK, names, phone, birth_on for duplicate signals, row lock for R61), `companies` (FK) | eligibility, guests, duplicate signals, reception |
| credits | `credits.consumeCredits(tx, ctx, { personId, beneficiaryPersonId, kind, units, ref, validAt })`, `credits.releaseCredits(tx, ctx, { ref, reason })` with reasons `cancelled_in_policy` (R28), `late_cancel_released` (R29), `no_show_released` (R37), `rescheduled` (R31), `session_cancelled` (R33), `staff_override` (R32), `credits.checkCredits(db, {...})`, `credits.getMembershipForPerson(db, personId).isMember` (R15), `countSharingReviewItems` / `listSharingReview` (R2, the abuse list R57 links to), view `v_person_credits`, UI `DeskCreditsBadge` (check-in desk); errors `SharingNotAllowedError` and `InsufficientCreditsError` (with `reason`) | credit and guest payment, releases, pre-checks, member-only checks |
| forms | `forms.hasValidSubmission(db, { personId, formSlug: 'health-declaration' })` (R62b), the seeded `health-declaration` form, the staff entry page `/admin/forms/enter?personId=` | health declaration display and optional blocking |
| commerce | `commerce.getQuote(db, {...})`, `commerce.createOrder(tx, ctx, {...})` with `items[].bookingIds` (returns `lineIds`), `commerce.refundOrderLine(tx, ctx, { orderLineId, reason: 'cancelled_in_policy' \| 'session_cancelled' })`, `commerce.cancelOrder(tx, ctx, { orderId, reason })`; `createOrder({ channel: 'admin', expiresAt })` for pay-at-desk orders (R63, cross-module D21 and D23); `posPayOrder` behind `/admin/pos?order=<orderId>` (desk payments); tables `products`, `order_lines` (FK); pages `/[locale]/account/checkout/[orderId]` (pay an existing order) and `/admin/pos?order=<id>` | paid bookings, refunds, desk payment |
| email | `email.sendTransactional(ctx, { template, personId, locale, data, key, attachments? })` with the twelve `booking.<name>` keys of R59 registered from `packages/email/src/templates/booking/index.ts` (inline `attachments` for the QR code); email's registry list carries all twelve, `booking.lead_window_open` included (cross-module D2) | all booking emails |
| site | `site.getCurrentLegalVersion('terms')`, `site.hasAcceptedCurrentTerms(db, personId)`, `site.recordTermsAcceptance(tx, ctx, {...})` | R62 |
| webinar (R2) | calls `booking.upsertWebinarSession` and `booking.cancelWebinarSession` | webinar events |

Commerce, in turn, calls `booking.confirmBookingsForOrder` in its paid transaction (online, payment link and POS), `booking.releaseBookingsForOrder` when an order expires, fails or is cancelled, `booking.cancelBookingsForOrderLine` on a staff refund of a session or ticket line, and `booking.createBookingForPosLine` for a walk-in session line in `posSell`. These names and shapes are the ones commerce's spec uses (commerce rules 21, 22, 32, 37).

### Provides to other modules

| Consumer | What |
| --- | --- |
| commerce | the four order hooks above (`confirmBookingsForOrder`, `releaseBookingsForOrder`, `cancelBookingsForOrderLine`, `createBookingForPosLine`); reserved rows passed as `items[].bookingIds` to `createOrder`; `getAvailability` (object input, Wave 0 contract) for quotes and `listBookableSessions` for the POS session picker |
| site | `listPublicEvents`, `getAvailabilityPreview`, `getAvailability`, `getOpeningHours`, `listUpcomingBookingsForPerson(db, personId, limit)`, `listOpenOffersForPerson(db, personId)` (single person id, cross-module D66) (both landed by booking-P3 and booking-P5 in V1, before site-P6), `describeAvailability` (core); portal routes `/account/book`, `/account/book/[sessionId]`, `/account/waitlist` |
| email | `getSessionCards(tx, sessionIds, locale)` (R2: `opensForCustomersAt`), `getNextBooking(tx, personId)`; template folder `templates/booking/` with the keys of R59 |
| forms | the portal page `/[locale]/account/book?template=<sessionTemplateId>` for result CTAs; `session_templates` and `sessions` read |
| automation | event kinds of 4.7 as triggers (`booking.confirmed` with `data.is_first_booking` and `data.session_kind`, `booking.attended` with `data.is_first_visit`, `booking.no_show`, `booking.cancelled`, `booking.event_ended` for post-event follow-up, `waitlist.offered` with `data.offer_expires_at` for `waitlist-offer`, `waitlist.confirmed`/`expired`/`released`/`withdrawn` as its exits), `hasFutureBooking` and `v_person_bookings` for `has_future_booking` (inactivity guard), `nextOpeningAt(db, from)` for task due dates. On a reschedule it also gets `booking.cancelled` (old row) and `booking.confirmed` (new row, `rescheduled_from_booking_id`, old `is_first_booking`). `reminder_hours_before.event` defaults to `[]`, so event reminders come only from `event-registration` (scenario 1). Booking sends every booking confirmation and the day and night reminders; automation's seeded `event-registration` and `after-first-booking` must drop their `confirm` steps and `after-first-booking` its `reminder` step to avoid duplicate emails |
| ops | `getPersonBookingSummary` (person_stats), tables `sessions`, `bookings`, `waitlist_entries`, `capacity_holds` for `v_no_show_report` and `ai.bookings`; the view `v_session_utilisation`, which ops' capacity report reads (there is no `v_capacity_utilisation`, cross-module D57); `importBooking(tx, ctx, { externalRef, personId, kind, startsAt, paidWith })` returning `{ bookingId, outcome: 'created' | 'existing' | 'no_session' | 'over_capacity' }`, every row `confirmed` with `source = 'import'`, ops passes no status (future bookings only; no historical import function: past bookings are ops' `imported_history`); `getBookingHealth` (digest); privacy and `sweep` registration |
| crm | `listPersonBookings` for the person page; timeline facts through `activity_events` with the R61 `data` keys |
| webinar | `upsertWebinarSession(tx, ctx, { webinarId, sessionId?, title, startsAt, endsAt })`, `cancelWebinarSession(tx, ctx, { webinarId, reason })` |
| credits | booking ids as ledger `ref` (`ref_type = 'booking'`), consumed by `ledger.reconcile` (which skips `source = 'import'` rows) |

## 11. Edge cases and failure modes

1. **Two customers take the last seat at once.** Both transactions lock the session row; the second re-reads availability after the first commits and gets `conflict: session_full` with a "Join the waiting list" button.
2. **Double submit of a paid booking.** `clientKey` is passed to `commerce.createOrder` as `orders.client_key`; the second submit finds the same order and the partial unique index refuses a second live booking; the action returns the existing checkout.
3. **Payment completes after the reservation expired.** `confirmBookingsForOrder` finds the row `cancelled` (`payment_expired`). If capacity is still free it re-books under the session lock (new `confirmed` row, same order line, the cancelled row untouched); otherwise it returns the line in `unavailableOrderLineIds` and commerce refunds it automatically through `commerce.refund_unavailable_lines` (`refundOrderLine` reason `seat_no_longer_available`) and emails `commerce.refund_confirmation` (commerce edge case 4, cross-module D22); no customer-service task is opened. Rows already `confirmed` are returned in `confirmedBookingIds` again (idempotent). Never overbooked.
4. **Template edited while sessions are booked.** Booked sessions keep their time and capacity (R2); the template screen lists them as "kept because booked"; staff move bookings with reschedule if needed.
5. **DST change.** `planOccurrences` builds each start from the local date and wall-clock time, so 10:00 stays 10:00 local on both sides of the change; a night 21:00 + 720 minutes ends at 08:00 or 09:00 local depending on the night, and the UI shows the real end.
6. **Closed day added on a date with bookings.** Nothing is cancelled automatically; the conflict list appears; the session stays bookable until staff close or cancel it (`setSessionOpen` or `cancelSession`).
7. **Capacity lowered below current bookings.** Refused with `capacity_below_bookings`; staff must cancel or move bookings first.
8. **Offer expires while the person is on the checkout page.** The reserved booking keeps the seat until `reserved_until`; the offer cannot expire while that reservation is live (R45). If payment fails, both end and the seat goes to the next person.
9. **Claim link opened by a mail scanner.** GET only redirects; nothing changes until the POST.
10. **Claim link forwarded to someone else.** The POST books the seat for the entry's person, never for the clicker; the booking page requires that person's login to view details.
11. **Old claim link after a new offer.** `offers_count` changed, so the hash no longer matches; the page says the offer expired.
12. **Person on the waitlist books directly when a seat frees up publicly.** The booking succeeds if capacity allows; the entry moves to `released` with `ended_reason = booked_directly` in the same transaction.
13. **Staff try to remove a confirmed waitlist seat.** No waitlist action accepts a `confirmed` entry (`protected_seat`); the only path is cancelling the booking, which follows cancellation rules and is audited.
14. **Lead buys a package while holding an offer for a lead seat.** The offer stays valid until it expires (R26); after claim, the booking stays confirmed. If the lead was only waiting, the next `waitlist.expire_offers` run moves the entry to the customer queue.
15. **Customer tries to use a second email to get a lead seat.** A different email is a different person, so the unique checks pass, but `duplicateSignals` (same phone, same normalised email, same name and birth date, same IP in 24 h) flags the entry or refuses the direct lead seat with `needs_review`; staff decide in `/admin/waitlist`.
16. **Gmail dot or plus variants.** `normaliseEmail` maps `j.doe+beam@gmail.com` to `jdoe@gmail.com`, flagged as a duplicate signal, never merged automatically (merge is crm's staff action).
17. **Guest already booked in the same session.** The partial unique index refuses the guest row; the owner sees "This guest already has a booking for this session".
18. **Guest use exceeds the package's monthly guest limit.** `consumeCredits` throws `InsufficientCreditsError` with `reason = 'guest_limit'`; the action returns `sharing_not_allowed` and offers to pay the guest by order. The form already showed "0 guest uses left this month" from `checkCredits`, so this only happens in a race.
19. **Session cancelled by BEAM with paid event tickets.** Every paid ticket line is refunded through `commerce.refundOrderLine` (credit notes via finance); unpaid orders are cancelled; credits are released; offers and waiting entries are released; one email per attendee; chunks and refunds carry keys so a retry does not refund twice.
20. **No-show job runs late or twice.** It selects only `confirmed` rows of ended sessions; a second run finds none; event keys dedupe `booking.no_show`.
21. **Reception checks in the wrong day's QR code.** Shown with a warning, no check-in button (R35); override available for `bookings.override`.
22. **Translation missing for an email.** Booking succeeds; the email is `blocked_translation`, listed in the digest; staff fix the catalogue or template.
23. **`waitlist.offer_next` dies (dead job).** The next `waitlist.expire_offers` run re-enqueues it for every session with free capacity and waiting entries, so a dead job delays offers by at most one minute after the cause is fixed.
24. **Imported SimplyBook future booking for a time that matches no session.** `importBooking` returns `no_session`; ops marks the row `error` with that message; staff create the one-off session (or fix the template) and re-run the import, which is idempotent on `external_ref`.
25. **Member status lapses between booking and session.** Existing member-only bookings stay; eligibility is checked only at booking time.
26. **Lead window configured in the past or end before start.** `configureLeadMagnet` refuses (`validation`); a lead magnet event cannot be published without a window.
27. **Pay-at-desk customer never shows up.** The reserved row and its `admin` order expire at `ends_at`; the row becomes `cancelled` (`payment_expired`), not `no_show`, because nothing was paid or consumed; the day view lists it until then so reception can phone.
28. **Two first bookings of the same person in parallel** (portal and staff). The person row lock in R61 serialises the fact writing; only the first commit gets `is_first_booking = true`.
29. **Terms version changes between page load and submit.** The action reads the current version inside the transaction and records that one; if the person had never accepted any version and `acceptTerms` is missing, it returns `terms_required` and the form shows the checkbox.
30. **Belgian public holiday added as "closed" after bookings exist.** Same as edge case 6: conflicts listed, nothing cancelled automatically.
31. **Shared-bed owner cancels, guest stays.** R13: the guest row takes a bed if one is free, otherwise the action refuses with `session_full` and offers to cancel both.
32. **Burst at an event release (load).** 200 customers request the last 20 seats within seconds: the session row lock serialises them, each transaction holds the lock for one booking (target under 50 ms), exactly 20 succeed and 180 get `session_full` with the waitlist button. Covered by `server/book.load.test.ts` (section 12).
33. **Claim link opened after the session was closed by staff.** `claimSeat` refuses with `session_closed`; the offer stays valid until expiry in case staff reopen.
34. **Health declaration expires between booking and visit.** The booking stays; the desk shows "Health declaration expired" and reception fills the form with the guest (forms' staff entry) before or after check-in; check-in is never blocked (decision 49).
35. **Customer submits a night booking without an emergency contact from an old tab.** `bookSession` refuses with `emergency_contact_required`; the form shows the fields; nothing is reserved.
36. **Commerce `createOrder` fails after booking inserted the reserved rows.** The error propagates, the whole transaction rolls back, and no reserved row without an order line is ever committed (R18).

## 12. Build packages

Order and parallelism: **P1 -> (P2 and P3 in parallel) -> (P4 and P5 in parallel) -> P6** for V1 (Waves 1 and 2), then **P7 -> P8** (R2), then **P9** (R3). Shared files are made collision-free by P1: it turns `actions.ts`, `queries.ts`, `jobs.ts`, `api.ts` and `schedules.ts` into barrels over area files and creates every area file as an empty stub, so later packages edit only their own area files. Files that more than one package edits are listed with "(sequential after Pn)". No package edits `package.json`, the lockfile, migrations, `packages/db/src/schema/index.ts`, `registry/*.generated.ts` or frozen Wave 0 files. The module-level `permissions.test.ts` and `jobs.test.ts` the architecture requires are split per area (`actions/<area>.permissions.test.ts`, `jobs/<area>.test.ts`) so parallel packages never edit the same test file. Cross-module functions not yet landed by their owner are mocked in unit tests through their Wave 0 stub signatures. Every package's done-definition includes: `pnpm gen:indexes && pnpm typecheck && pnpm lint` green, its Vitest suites green on `createTestDb()` with the `fake.ts` adapters, `pnpm i18n:check` green.

### booking-P1 (V1): schema, views and pure booking logic

- **Goal:** final tables, enums and V1 views; the pure core used by every other package; module barrels, events, permissions, nav, config (settings and flags) and the V1 message catalogue.
- **Files:** `packages/db/src/schema/booking.ts` (replaces the Wave 0 stub; keeps every contract column), `packages/db/src/schema/booking.views.ts` (`v_session_availability`, `v_person_bookings`, `v_session_utilisation`), `packages/db/src/schema/booking.test.ts`, `packages/core/src/booking/{index,types,rules,schedule,availability,policy,waitlist,claim-token,duplicates,checkin-code,describe,errors}.ts` (`index.ts` and `types.ts` exist from Wave 0) and a `*.test.ts` beside each logic file, `apps/web/modules/booking/{actions,queries,jobs,api,schedules}.ts` (barrels) with stubs `actions/{templates,sessions,bookings,attendance,waitlist,lead,tickets,partner}.ts`, `queries/{schedule,bookings,attendance,waitlist,partner}.ts`, `jobs/{schedule,bookings,attendance,waitlist}.ts`, `api/{schedule,bookings,waitlist,partner,webinar}.ts`, `schedules/{schedule,bookings,attendance,waitlist}.ts`; `apps/web/modules/booking/{events,permissions,nav,config}.ts`; UI stub `apps/web/modules/booking/ui/session-waitlist-tab.tsx` (final props `{ sessionId: string }`, renders nothing until P5); `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/booking.json` (all V1 keys of section 8).
- **Interfaces:** every function of 4.1; `BookingRules` and `BusinessHours` Zod schemas with `DEFAULT_BOOKING_RULES` and `DEFAULT_BUSINESS_HOURS`, declared in `config.ts` as setting keys `booking_rules` and `business_hours`; flags `ff_booking_lead_priority` (exists from Wave 0) and `ff_booking_ticket_types` in `config.ts`; error classes `SessionFullError`, `AlreadyBookedError`, `InvalidTransitionError`, `ProtectedSeatError`, `OutsideWindowError`, `NeedsReviewError`, `PaymentRequiredError`, `TermsRequiredError` (all `conflict` with a `reason`); every event kind of 4.7 with its `data` schema.
- **Depends on:** Wave 0 (`_shared.ts`, contract stubs of `sessions` and `bookings`, `platform:users`, `platform:files`, `platform:config-registry`, `crm:persons`, `crm:companies`, `commerce:products`, `commerce:order_lines`).
- **Tests:** `schedule.test.ts` (weekday filter, validity range, closed/holiday/special-hours suppression, DST spring and autumn for 10:00 day and 21:00 night, 90-day window size, `diffTemplateSessions` keeps booked and manual sessions); `schedule.test.ts` also covers `holidaySuggestions` over platform's `belgianPublicHolidays` for 2026-2028 (Easter Monday 2026-04-06, Ascension 2026-05-14, Whit Monday 2026-05-25; a date with an exception is not suggested) and `nextOpening` (Monday closed, special hours, `closed` exception, Easter Monday skipped, `from` inside hours returns `from`, null after 30 closed days); `i18n:check` proves a `booking.holidays.<key>` name for each of platform's ten keys in three locales; `availability.test.ts` (holds, reserved expiry, live offers, member-only, closed status, webinar session, every lead phase for lead, customer and member viewers incl. lead in `customer_release`, `keep_for_leads`, horizon and cut-off); `policy.test.ts` (free window boundaries 24 h/72 h at the exact second, events null window, late-cancel release flag, reschedule rules, every allowed and forbidden pair of `bookingTransition` and `sessionTransition`, `openingHoursFor` with a special-hours exception, `overlapsByLocation`); `waitlist.test.ts` (every allowed and forbidden transition, system actor on `confirmed` throws `ProtectedSeatError`, candidate ordering per phase, flagged skipped, offer expiry cut-off and minimum, max offers per person); `claim-token.test.ts` (deterministic, differs per `offers_count`, hash length); `duplicates.test.ts` (gmail dots and plus, phone, name and birth date, IP window); `packages/db/src/schema/booking.test.ts` on `createTestDb()` (partial unique booking per session and person, unique entry, unique `(template_id, starts_at)`, unique `webinar_id`, every check constraint incl. `rejoin_count`, `event_category` and pay-at-desk, view row for an empty session and for a session with holds, bookings and offers). Core coverage above 90 % for `booking/waitlist`.
- **Done:** standard definition; `v_session_availability` matches `computeAvailability` on 10 fixture sessions.

### booking-P2 (V1): schedule, templates, exceptions, holds and materialisation

- **Goal:** BEAM edits schedules without a developer; sessions exist 90 days ahead.
- **Files:** `apps/web/modules/booking/actions/templates.ts`, `actions/sessions.ts` (create, update, publish, open/close; not cancel), `queries/schedule.ts`, `api/schedule.ts`, `jobs/schedule.ts`, `schedules/schedule.ts`, `apps/web/modules/booking/seed.ts`, `packages/db/src/seed/booking.ts` (rules and business hours, demo templates: four day blocks Tue-Sun 09:00/11:30/14:00/16:30 120 min 12 seats; night Fri-Sat 21:00 720 min 6 beds; one demo event of category `lecture`; retention policy rows `booking.waitlist_entries` and `booking.bookings_free_text`, `on conflict (key) do nothing`), `apps/web/modules/booking/ui/{calendar-week,day-view,template-form,exception-form,holiday-panel,rules-form,business-hours-form,hold-form}.tsx`, pages `app/(admin)/admin/sessions/{page,loading,error}.tsx`, `sessions/day/[date]/page.tsx`, `sessions/day/[date]/print/page.tsx`, `sessions/new/page.tsx`, `sessions/templates/page.tsx`, `sessions/templates/[id]/page.tsx`, `sessions/exceptions/page.tsx`, `sessions/rules/page.tsx`, `sessions/holds/page.tsx`.
- **Interfaces:** actions `createTemplates`, `updateTemplate`, `setTemplateActive`, `upsertException`, `deleteException`, `createSession`, `updateSession`, `publishSession`, `setSessionOpen`, `upsertHold`, `deleteHold`; queries `listUpcomingHolidays`, `getOpeningHours`, `getDayPrintList`; `api/schedule.ts` with `getOpeningHours` and `nextOpeningAt`; jobs `sessions.materialise`, `sessions.regenerate_template`, `sessions.regenerate_date`; internal `materialiseRange(tx, fromOn, toOn)`. The rules page submits platform's `updateSetting`.
- **Depends on:** booking-P1; `platform:getSetting`, `platform:updateSetting` (action), `platform:belgianPublicHolidays`; `crm:companies` (hold and partner FK); `forms:hasValidSubmission` (print list column).
- **Tests:** `actions/templates.test.ts` (activation blocked on incomplete name; edit bumps version and enqueues regeneration with the right key; overlap and business-hours warnings); `actions/templates.permissions.test.ts` and `actions/sessions.permissions.test.ts` (each action denies without its permission); `jobs/schedule.test.ts` (materialise creates the expected count for 90 days; double run identical; regeneration updates free sessions, keeps booked and manual ones, removes unmatched free ones; closed day removes free sessions and reports booked ones as conflicts; deleting the exception re-inserts them; "Close this day" on a Belgian holiday); `actions/sessions.test.ts` (capacity below bookings refused; publish requires complete title and an `event_category` for events; holds cannot drop below their bookings; hold deletion and capacity increase enqueue `waitlist.offer_next`; every session status transition); `queries/schedule.test.ts` (`getDayPrintList` columns incl. the health declaration column, `getOpeningHours` with a special-hours exception); `api/schedule.test.ts` (`nextOpeningAt`: Sunday evening returns Tuesday opening, a `closed` exception is skipped, Easter Monday skipped by default and returned with `includePublicHolidays`).
- **Done:** standard; seeded `beam_dev` shows 90 days of sessions in `/admin/sessions`.

### booking-P3 (V1): booking engine, payments, cancellation, reschedule, guests, emails

- **Goal:** book, pay (credit, order, guest, free), cancel, reschedule and add guests correctly from any channel; cross-module API.
- **Files:** `apps/web/modules/booking/server/{book,cancel,reschedule,guests,order-hooks,qr,facts,terms,declarations,health}.ts` (internal service used by actions, api and later packages), `actions/bookings.ts` (incl. `cancelSession`), `queries/bookings.ts` (staff and portal booking queries of 4.3), `api/bookings.ts` (every function of 4.9 except `getOpeningHours` and `nextOpeningAt` (P2), `listOpenOffersForPerson` (P5), `upsertWebinarSession` and `cancelWebinarSession` (P8)), `jobs/bookings.ts` (`bookings.expire_reservations`, `bookings.send_reminders`, `sessions.cancel_bookings`), `schedules/bookings.ts`, `packages/email/src/templates/booking/{booking-confirmed,booking-rescheduled,guest-invited,booking-cancelled,booking-late-cancelled,session-cancelled,booking-reminder}.tsx` and `packages/email/src/templates/booking/index.ts` (`defineTemplate()` entries, props schemas, inline QR attachment).
- **Interfaces:** `bookSeats(tx, ctx, input: BookSeatsInput): Promise<BookResult>`, `cancelBookingRow(tx, ctx, input: { bookingId; expectedVersion; includeGuests; by: 'customer'|'staff'|'beam'|'system'; force? }): Promise<CancelResult>`, `rescheduleRow(...)`, `addGuestRow(...)`, `renderCheckinQr(ctx, booking): Promise<string /* file id */>`, `recordBookingFact(ctx, kind, booking, extra)`, `ensureTermsAccepted(tx, ctx, personId, acceptTerms, ref)`, `ensureHealthAndContact(tx, ctx, { personId, kind, emergencyContact?, by })` (R62b), `linkOrderLines(tx, rows, lineIds)`; the api functions listed above, including the four commerce hooks (`confirmBookingsForOrder`, `releaseBookingsForOrder`, `cancelBookingsForOrderLine`, `createBookingForPosLine`), `importBooking` and `getBookingHealth`.
- **Depends on:** booking-P1; `credits:consumeCredits`, `credits:releaseCredits`, `credits:checkCredits`, `credits:v_person_credits`; `commerce:createOrder` (with `bookingIds`), `commerce:getQuote`, `commerce:refundOrderLine`, `commerce:cancelOrder`, commerce's page `/[locale]/account/checkout/[orderId]`; `crm:getPersonStatus`, `crm:findOrCreatePersonByEmail`, `crm:createPersonWithoutEmail`, `crm:getReceptionCard`, `crm:updatePersonFields`; `credits:getMembershipForPerson`; `forms:hasValidSubmission`; `email:sendTransactional`; `site:hasAcceptedCurrentTerms`, `site:recordTermsAcceptance`; `platform:storeFile`. Unlanded functions are mocked through their Wave 0 stubs.
- **Tests:** `server/book.test.ts` (credit booking writes one consume per grant split with `validAt` and confirms; insufficient credits rolls back; order booking inserts the `reserved` rows first (owner and guests), calls `createOrder` with one quantity-1 item per seat carrying `bookingIds: [id]`, sets `order_line_id` and `reserved_until` from the returned `lineIds` and returns `/<locale>/account/checkout/<orderId>`; free refused for customers; member-only; closed session refused; webinar session refused; duplicate person refused; concurrent last seat: two parallel transactions on PGlite, one `session_full`; over-capacity only with override; night shared bed uses 0 units and a second shared-bed guest is refused; first booking and terms acceptance recorded once; booking a session the person waits for releases the entry with `booked_directly`; member-only uses `getMembershipForPerson().isMember` and a staff status override `member` without membership is refused; `SharingNotAllowedError` maps to `sharing_not_allowed` and plain `InsufficientCreditsError` to `insufficient_credits`; `require_health_declaration = true` refuses a day booking with `health_declaration_required` and `false` only shows the notice; a night booking without emergency contact refuses with `emergency_contact_required` and with one writes it through `updatePersonFields` with `onlyEmpty`); `server/book.load.test.ts` (tagged `load`, run by `e2e.yml` against `beam_dev` through `neon-ws`: 200 concurrent attempts on 20 seats, exactly 20 confirmed, p95 under 1 s; skipped on PGlite); `server/cancel.test.ts` (inside window releases credits with `cancelled_in_policy` and requests `refundOrderLine` with `cancelled_in_policy`; late keeps credit, or releases with `late_cancel_released` when the rule says so; staff force uses `staff_override`; session cancellation uses `session_cancelled` for both; event never free; guests cascade; shared-bed owner cancel; customer cannot cancel a `reserved` row; session cancellation cancels all, cancels unpaid orders, releases waitlist and chunks above 50 bookings; frees capacity enqueues `waitlist.offer_next`); `server/reschedule.test.ts` (window, kind, product, chain limit, credit release with reason `rescheduled` and consume keys; events `booking.rescheduled`, `booking.cancelled` for the old row and `booking.confirmed` for the new row with `rescheduled_from_booking_id` and the old `is_first_booking`; one `booking.booking_rescheduled` email and no cancellation email); `server/order-hooks.test.ts` (`linkOrderLines` sets `order_line_id` and `reserved_until = orders.expires_at` on every reserved row, and no committed order-paid row lacks a line; `confirmBookingsForOrder` twice is idempotent; confirm after expiry re-books or returns the line in `unavailableOrderLineIds`; `releaseBookingsForOrder` on `payment_expired`, `payment_failed` and `order_cancelled` with the right codes; `cancelBookingsForOrderLine` never refunds twice; `createBookingForPosLine` reserves under the session lock, refuses a full session with `session_full`, and the POS paid transaction confirms it); `jobs/bookings.test.ts` (every handler twice with the same payload, same state; reminders respect late-entry skip and keys; no event reminders by default; pay-at-desk rows expire at `ends_at`); `api/bookings.test.ts` (`hasFutureBooking`, `getNextBooking`, `getPersonBookingSummary`, `listPublicEvents`, `getAvailabilityPreview`, `getSessionCards`, `importBooking` outcomes and idempotency on `external_ref`); `api/health.test.ts` (each health condition and the `level` it sets); `actions/bookings.permissions.test.ts`; email templates: each of the seven P3 keys renders its `data` variants in three locales with fixture data, and the confirmation, rescheduled, guest and reminder sends pass the QR as an inline attachment (`cid:checkin-qr.png`).
- **Done:** standard; the architecture's tonight path (buy package, book with credit, cancel inside rules, credit back) passes in `server/book.test.ts` against fakes.

### booking-P4 (V1): attendance, check-in, no-shows and staff booking screens

- **Goal:** reception checks people in by QR or name; no-shows are marked; staff manage bookings.
- **Files:** `actions/attendance.ts`, `queries/attendance.ts`, `jobs/attendance.ts` (`bookings.mark_no_shows`), `schedules/attendance.ts`, `apps/web/modules/booking/ui/{attendee-list,checkin-desk,manual-booking-wizard,booking-card,cancel-dialog}.tsx`, pages `app/(admin)/admin/sessions/[id]/page.tsx` (imports P2's `hold-form` and P1's `session-waitlist-tab` stub), `app/(admin)/admin/bookings/{page,loading,error}.tsx`, `bookings/new/page.tsx`, `bookings/[id]/page.tsx`, `bookings/checkin/page.tsx`.
- **Interfaces:** actions `checkIn`, `undoCheckIn`, `markNoShow`, `revertNoShow`, `updateBookingNotes`; query `searchCheckin`; job `bookings.mark_no_shows`.
- **Depends on:** booking-P2 (`hold-form`, day view, print page), booking-P3 (service and booking actions used by the screens); `crm:searchPersons`, `crm:createPersonWithoutEmail`, `crm:getReceptionCard` and its `ReceptionCard` component; `credits:DeskCreditsBadge`; `forms:hasValidSubmission`; `commerce:/admin/pos?order=` page.
- **Tests:** `actions/attendance.test.ts` (check-in window from the `check_in` rules, wrong day, by code and by id, `reserved` row refused with `payment_required`, undo until end + 2 h, revert no-show within 7 days, manual no-show only after start, `booking.attended` event once with `is_first_visit`, recomputed after undo); `actions/attendance.permissions.test.ts`; `jobs/attendance.test.ts` (marks only ended confirmed rows, respects `no_show.auto_mark = false`, keeps credits, double run gives the same state); `queries/attendance.test.ts` (name search limited to the day, finds guests without email, each row carries the health declaration state); check-in is allowed with a missing or expired health declaration even when `require_health_declaration = true`; `e2e/booking.spec.ts` section "reception check-in" (scan code URL, mark attended, pay-at-desk row shows "To pay", axe scan of the desk).
- **Done:** standard; reception flow demoable on seeded data.

### booking-P5 (V1): waitlist, offers and claim links

- **Goal:** waiting list with the full state machine, real expiring single-use links, duplicate protection, protected confirmed seats (scenario 4, V1 acceptance tests).
- **Files:** `actions/waitlist.ts` (incl. the public `claimSeat` action), `queries/waitlist.ts`, `jobs/waitlist.ts` (`waitlist.expire_offers`, `waitlist.offer_next`), `schedules/waitlist.ts`, `api/waitlist.ts` (`listOpenOffersForPerson`), `server/claim.ts`, `app/api/public/claim/[token]/route.ts` (GET redirect only), `app/[locale]/(site)/claim/[token]/page.tsx`, `app/(admin)/admin/waitlist/page.tsx`, `app/[locale]/(portal)/account/waitlist/page.tsx`, `apps/web/modules/booking/ui/{waitlist-table,offer-countdown}.tsx`, `ui/session-waitlist-tab.tsx` (sequential after P1: implements the stub), `packages/email/src/templates/booking/{waitlist-joined,seat-offered,seat-claimed,offer-expired}.tsx`, `packages/email/src/templates/booking/index.ts` (sequential after P3: adds the four keys), `e2e/scenario-4-seat-claim.spec.ts`.
- **Interfaces:** actions of 4.2 for waitlist; `claimSeatRow(tx, ctx, { token, payWith? }): Promise<{ bookingId } | { orderId, redirectTo }>` in `server/claim.ts`; jobs of 4.5.
- **Depends on:** booking-P3 (`bookSeats`, order hooks that transition linked entries); `crm:getPersonStatus`; `email:sendTransactional`.
- **Tests:** `jobs/waitlist.test.ts` (offer to first eligible; expiry after claim window passes to next; cut-off before start; release at start; flagged skipped; max offers per person; walk-in without email offered on screen only; safety-net re-enqueue; every handler twice with the same payload, same state; confirmed entries untouched by every job); `actions/waitlist.test.ts` (join only when full and open; member-only join refused for non-members; same person cannot join twice or hold a seat and an entry; one rejoin then `already_waiting`; secondary address flagged; IP signal skipped when `ctx.ip` is null; staff actions audited with `booking.waitlist_*` names; `protected_seat` on confirmed); `actions/waitlist.permissions.test.ts`; `server/claim.test.ts` (GET does not change state; the action claims once; second call returns the same booking; expired and superseded token refused; a paid claim without a portal session asks for sign-in and changes nothing until the POST after sign-in, then redirects to `/account/checkout/<orderId>`; claim with payment sets `booking_id`, keeps the seat until the reservation ends, then the entry becomes `expired` with `payment_not_completed` when payment lapses and `confirmed` when it is paid; closed session refused); `e2e/scenario-4-seat-claim.spec.ts` (session full, A waits, B cancels, A is offered, link expires with a fake clock, B2 gets the offer and claims, A's old link shows expired, confirmed seat survives a forced `waitlist.expire_offers` run).
- **Done:** standard plus scenario 4 green against `beam_dev`.

### booking-P6 (V1): customer portal booking pages, privacy and V1 acceptance

- **Goal:** customers book, see, cancel, reschedule, invite guests and see waitlist status; GDPR export and erase for this module.
- **Files:** pages `app/[locale]/(portal)/account/book/page.tsx`, `book/[sessionId]/page.tsx`, `bookings/page.tsx`, `bookings/[id]/page.tsx`, `bookings/[id]/reschedule/page.tsx` (each with `loading.tsx` and `error.tsx`), `apps/web/modules/booking/ui/portal/{session-list,book-form,guest-fields,policy-note,qr-card}.tsx`, `apps/web/modules/booking/privacy.ts`, `apps/web/modules/booking/privacy.test.ts`, `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/booking.json` (sequential after P1; adds keys found missing in P2-P5), `e2e/booking.spec.ts` (sequential after P4).
- **Interfaces:** `bookingPrivacy` (section 9).
- **Depends on:** booking-P3, booking-P4 (owns `e2e/booking.spec.ts` first), booking-P5; commerce's pay and return pages `/[locale]/account/checkout/[orderId]` and `/[locale]/account/checkout/return/[orderId]`; `credits:v_person_credits`, `credits:checkCredits`; `site:getCurrentLegalVersion`.
- **Tests:** `privacy.test.ts` (export lists bookings as attendee, booker and guest-of; erase deletes waitlist entries, anonymises bookings, cancels future ones and enqueues `waitlist.offer_next`, keeps guest rows of other people, leaves no `person_id`-linked free text; report rows; both `sweep` handlers, keyed `booking.waitlist_entries` and `booking.bookings_free_text`, take `(tx, cutoff)`, anchor on `starts_at` and return the batch count); `e2e/booking.spec.ts` (register by magic link, accept terms on the first booking, buy package with fake Mollie, book day session with a credit, see "x sessions remaining", cancel inside rules, credit back, timeline shows both; buy a single session with a promo code; book a night with a shared-bed guest after entering an emergency contact; reschedule; member-only refused for a lead; `/account/book?template=<id>` opens the template's tab filtered to it; an order-paid booking lands on `/account/checkout/<orderId>`; axe scans of the portal pages and the claim page with zero serious or critical violations); acceptance items "customer can book, pay and cancel", "administrator can change a booking", "the same person cannot take a second seat", "claim window expires", "confirmed seat is protected" referenced from `e2e/acceptance-v1.spec.ts` (owned by the Wave 2 seam package).
- **Done:** standard plus `e2e/booking.spec.ts` green against `beam_dev`.

### booking-P7 (R2): Lead Magnet access engine

- **Goal:** scenario 3 and the R2 lead-priority acceptance tests behind `ff_booking_lead_priority`.
- **Files:** `actions/lead.ts`, `server/book.ts` (sequential after P3: lead-seat path, R21-R23), `jobs/waitlist.ts` (sequential after P5: window-end release, reclassification, phase ordering), `actions/waitlist.ts` (sequential after P5: queue choice at join), `apps/web/modules/booking/ui/lead-magnet-form.tsx`, `app/(admin)/admin/sessions/[id]/page.tsx` (sequential after P4: lead tab), `apps/web/modules/booking/ui/portal/book-form.tsx` and `session-list.tsx` (sequential after P6: "Opens for you on ..." and customer queue button), `booking.json` x3 (sequential after P6), `packages/email/src/templates/booking/lead-window-open.tsx` and `templates/booking/index.ts` (sequential after P5), `api/bookings.ts` (sequential after P3: `getSessionCards` gains `opensForCustomersAt`), `e2e/scenario-3-lead-access.spec.ts`.
- **Interfaces:** `configureLeadMagnet`; `availabilityFor(tx, sessionId, personId)` returning the phase-aware `Availability`.
- **Depends on:** booking-P6; `crm:getPersonStatus` honouring `status_override`; `commerce:payments.sync` turning a lead into a customer (`v_person_status`).
- **Tests:** `actions/lead.test.ts` (percentage rounding, Brussels wall-clock to UTC across DST, validation); `actions/lead.permissions.test.ts`; `server/lead-book.test.ts` (lead books reserved seat, customer refused reserved seat but sees opening time, lead in `customer_release` sees the public opening time, lead guests need general seats, duplicate signal refuses lead seat with `needs_review`); `jobs/lead-release.test.ts` (window end offers to customer queue with `booking.lead_window_open`, then public at `opens_for_public_at`; `public` and `keep_for_leads` rules; waiting lead who buys moves to customer queue keeping `joined_at` with `waitlist.requeued`; offered lead keeps offer; confirmed lead stays confirmed; double run of each release gives the same state); `e2e/scenario-3-lead-access.spec.ts` (with flag `on` for testers).
- **Done:** standard plus scenario 3 green.

### booking-P8 (R2): ticketing extensions, post-event follow-up, webinar sessions, guest controls

- **Goal:** multiple ticket types with member pricing, per-type capacity and sales windows; guest information; `booking.event_ended`; webinar session link; remaining guest uses shown at booking time.
- **Files:** `actions/tickets.ts`, `packages/db/src/schema/booking.views.ts` (sequential after P1: add `v_ticket_type_availability`), `server/book.ts` (sequential after P7: ticket type checks), `jobs/attendance.ts` (sequential after P4: `booking.event_ended`), `api/webinar.ts` (`upsertWebinarSession`, `cancelWebinarSession`; P1 stub), `apps/web/modules/booking/ui/ticket-types-form.tsx`, `app/(admin)/admin/sessions/[id]/page.tsx` (sequential after P7: ticket tab), `ui/portal/book-form.tsx` and `ui/portal/guest-fields.tsx` (sequential after P7: type picker, guest details, "{n} guest uses left this month"), `booking.json` x3 (sequential after P7).
- **Interfaces:** `upsertTicketType`, `archiveTicketType`; `upsertWebinarSession`, `cancelWebinarSession`.
- **Depends on:** booking-P7; `commerce:products` of kind `ticket` with member `price_versions`; `credits:checkCredits`; `webinar` calls this package's api (no reverse dependency).
- **Tests:** `actions/tickets.test.ts` (publish blocked by incomplete names; sales window; member-only type; per-type capacity under the session lock; `max_per_booking`); `actions/tickets.permissions.test.ts`; `jobs/event-ended.test.ts` (one event per booking, dedupe, attended flag, emitted with `no_show.auto_mark = false`, double run); `api/webinar.test.ts` (upsert creates once and updates title and times, a wrong `sessionId` is refused with `webinar_session_mismatch`, unique `webinar_id`, cancel by `webinarId` sets `cancelled`, returns `{ cancelled: true }` (and `{ cancelled: false }` for an unknown webinar) and is idempotent, booking actions refuse the session with `webinar_session`).
- **Done:** standard.

### booking-P9 (R3): partner holds

- **Goal:** external partners fill their own holds; partner events carry `partner_company_id` for ops' partner reports. R4 needs no booking package (section 1).
- **Files:** `actions/partner.ts`, `queries/partner.ts`, `api/partner.ts`, `app/(admin)/admin/sessions/holds/page.tsx` (sequential after P2: partner-scoped mode), `booking.json` x3 (sequential after P8).
- **Interfaces:** `assignHoldSeat`, `unassignHoldSeat`, `listMyPartnerHolds`.
- **Depends on:** booking-P8; `platform:partnerScope`; `crm:persons.partner_company_id`.
- **Tests:** `actions/partner.test.ts` (partner sees and fills only own company holds, cannot see other attendees, cannot exceed hold quantity; staff can do all; assigned seat is `paid_with = free` with `data.partner_company_id`); `actions/partner.permissions.test.ts`.
- **Done:** standard.

## 13. Decisions made

Additions to the architecture (tables, columns, enums, views, jobs, schedules, files):

1. New table `session_exceptions` with enum `session_exceptions_kind (closed, holiday, special_hours)` for closed days, holidays and exceptional opening hours (blueprint 9); extra opening slots are one-off sessions.
2. `session_templates` additions: `description`, `location`, `version`, `created_by_user_id`. One template per start time; the admin form creates several templates at once. The architecture's single `start_time` stays.
3. `sessions` additions: `template_version`, `description`, `product_id`, `published_at`, `has_manual_changes`, `lead_release_rule` (enum `customers_then_public | public | keep_for_leads`), `public_release_at`, `is_waitlist_position_visible`, `cancelled_at`, `cancel_reason`, `event_category` (enum `sessions_event_category`), `partner_company_id`; partial unique `(template_id, starts_at)` and `(webinar_id)`. `webinar_id` is a plain uuid without FK because `webinars.session_id` is the owning FK; it is written only by `upsertWebinarSession`.
4. `capacity_holds` addition: `created_by_user_id`; bookings may fill a hold through the new `bookings.capacity_hold_id`.
5. `ticket_types` additions: `name`, `max_per_booking` (default 4), `requires_guest_details`, `sort_order`, `is_active`.
6. `bookings` additions: `capacity_units` (0 = shared bed), `capacity_hold_id`, `used_lead_seat`, `is_over_capacity`, `booked_by_person_id`, `external_ref` (import idempotency), `rescheduled_from_booking_id`, `checkin_code`, `qr_file_id`, `reminder_sent_at`, `cancel_reason_code` (enum `bookings_cancel_reason_code`), `no_show_marked_at`, `notes`, `is_pay_at_desk`.
7. `waitlist_entries` additions: `offers_count`, `rejoin_count`, `flag_reviewed_by_user_id`, `flag_reviewed_at`, `email_normalised`, `join_ip_hash`, `ended_reason`.
8. Views added: `v_session_utilisation` (V1 capacity utilisation data) and `v_ticket_type_availability` (R2). No booking report view duplicates ops' `v_no_show_report`. `v_session_availability` also exposes `lead_phase`, `opens_for_public_at`, `available_general`, `lead_reserved_remaining`, `waiting`.
9. Job kinds added: `sessions.regenerate_template`, `sessions.regenerate_date`, `sessions.cancel_bookings`, `bookings.expire_reservations`, `bookings.send_reminders`, `waitlist.offer_next`. Schedules added: `bookings.expire_reservations` every minute, `bookings.mark_no_shows` and `bookings.send_reminders` every 15 minutes. The architecture's names `sessions.materialise`, `waitlist.expire_offers`, `bookings.mark_no_shows` are kept although they do not start with `booking.`.
10. Booking facts start with `booking.`; waitlist facts start with `waitlist.` (`waitlist.joined`, `waitlist.offered`, `waitlist.confirmed`, `waitlist.expired`, ...), the prefix the architecture already uses for the job `waitlist.expire_offers` and the names crm's timeline catalogue, crm's `SEGMENT_ALLOWED_EVENT_KINDS` and automation's `waitlist-offer` sequence already read. crm's catalogue entry `waitlist.offer_expired` becomes `waitlist.expired`.
11. The `settings.booking_rules` and `settings.business_hours` shapes are defined here (sections 3.0 and 3.0b) and declared in `config.ts`, with the architecture's defaults: day 24 h, night 72 h, events never free, late cancel keeps the credit, no-show marked 2 h after the end and keeps the credit. Both are written only through platform's `updateSetting` action.
12. Module file layout: `actions.ts`, `queries.ts`, `jobs.ts`, `api.ts`, `schedules.ts` are barrels over area files so that several booking packages can run in parallel without editing the same file. Internal service code lives in `apps/web/modules/booking/server/`.
13. Flags and settings keys are declared in `apps/web/modules/booking/config.ts` (platform's per-module registry, collected by `pnpm gen:indexes`): flags `ff_booking_lead_priority` (Wave 0) and `ff_booking_ticket_types`.
14. This module owns the public claim page `app/[locale]/(site)/claim/[token]/page.tsx` in addition to the architecture's route list, the way forms owns `(site)/f/[slug]`. `GET /api/public/claim/[token]` only redirects; the claim itself is the public server action `claimSeat`.
15. The check-in desk lives at `/admin/bookings/checkin` (inside the architecture's `bookings` admin folder); holds, rules, templates and exceptions live under `/admin/sessions/`.
16. Wave 0 dependency request (also made by forms and, for axe, by commerce and ops; recorded in `docs/build/dependency-requests.md` by the orchestrator): `qrcode@1.5.4` and `@types/qrcode@1.5.5` (QR PNG and SVG rendering, local, no network), `@axe-core/playwright@4.10.2` (accessibility scans). No booking package adds a dependency itself.

Behaviour decisions the inputs left open:

17. Every booking needs a logged-in customer (magic link proves the email) or a staff user; there is no anonymous booking. The public site links into the portal.
18. Credits are per person, beds are capacity only: a guest sharing the owner's bed uses 0 beds but pays `credit_cost` (R13).
19. A within-window cancellation of an order-paid booking is refunded in money through `commerce.refundOrderLine` (requested addition to commerce's api); a late cancellation is not refunded. BEAM cancelling a session refunds everything, events included. Date-specific bookings have no 14-day withdrawal right (CEL art. VI.53, 12°), stated in the terms.
20. Reschedule is cancel plus new booking in one transaction, limited to the free window, same kind, same credit kind and same product for customers; at most 2 reschedules per chain.
21. Reservations for unpaid orders last until `orders.expires_at` (commerce, 30 minutes by default); pay-at-desk reservations last until the session ends. Booking has no reservation-length setting of its own.
22. Check-in window: 2 h before start until 2 h after end; undo until 2 h after end; no-show correction to attended within 7 days.
23. Day and night reminders are transactional emails sent by this module (one per configured offset: day 24 h, night 48 h), with the late-entry skip. Event reminders, preparation emails and marketing follow-ups are automation's seeded sequences; booking sends every booking confirmation, so automation's sequences carry no confirmation step.
24. Claim tokens are derived (HMAC of entry id and offer count with an HKDF key from `AUTH_SECRET`), never stored in plain text in booking tables; the plain link lives only inside email's message props and job payload until they are pruned, which is acceptable because an offer is valid for at most 48 hours and a newer offer invalidates it.
25. Claim GET never changes state; claiming is the `claimSeat` server action from the claim page. A forwarded link books only for the entry's person.
26. Waitlist entries are one seat each; a person rejoins an ended entry once. Offers stop 60 minutes before start and are never shorter than 15 minutes. One person gets at most 2 offers per session.
27. Non-Lead-Magnet sessions use a single `public` queue. Lead Magnet phases are `pre`, `lead`, `customer_release`, `public`; after public release the order is customer, lead, public queue.
28. Lead seats are only for the lead themself; guests of a lead need general seats. Suspicious duplicates are flagged and receive no offers until staff review; the platform never merges people automatically.
29. Events are created and configured with `bookings.override` (owner, management, technical_admin); no new permission string. Templates, exceptions and booking rules use `settings.write`.
30. V1 events have one price through `sessions.product_id`; multiple ticket types are R2. The `ticket_types` table exists from V1 so the schema does not change in R2.
31. Guest bookings and the guest confirmation email (`booking.guest_invited`) are V1 (blueprint 7 lists them in day sessions); the R2 "controls" are the visible remaining guest uses (booking-P8) and credits' abuse review list `v_sharing_review`.
32. Exact remaining places are shown to customers only when 5 or fewer; otherwise "available".
33. Bookings are anonymised, not deleted, on erasure (capacity history and ledger references); waitlist entries are deleted (and in any case 1 year after the session); booking free text is cleared after 3 years.
34. No room, staff or equipment assignment (proposal question 3, answered here as "seats and beds only" until BEAM says otherwise at the kick-off): room capacity is the session's capacity plus the `location` overlap warning (R6b).
35. Regeneration never touches a session that has any booking, waitlist entry, hold or manual change; templates and exceptions never cancel booked sessions by themselves.
36. If payment completes after the seat was lost, the platform re-books when a seat is free and otherwise returns the line in `unavailableOrderLineIds`, which commerce refunds at once (`seat_no_longer_available`, commerce edge case 4); it never overbooks. The money decision is commerce's.
37. Booking owns `packages/email/src/templates/booking/*.tsx` and `templates/booking/index.ts` (architecture section 11 gives each module package its template folder; email decision 1 agrees that each module owns its folder); email's generated registry imports that index. Keys are `booking.<name>` (file basename with `-` replaced by `_`), one file per message (R59): the twelve keys of email's registry list, `booking.lead_window_open` (R2) included (cross-module D1, D2).
38. Booking-originated paid orders are one quantity-1 item per seat. Booking inserts the `reserved` rows first under the session lock and passes them as `items[].bookingIds` to `commerce.createOrder`, then sets `order_line_id` from the returned `lineIds` in the same transaction (commerce rule 21: commerce never reserves capacity). Commerce calls back only `confirmBookingsForOrder`, `releaseBookingsForOrder`, `cancelBookingsForOrderLine` and `createBookingForPosLine`, the names commerce's spec uses. `booking.reserveForOrderLine`, `confirmOrderBookings`, `releaseOrderBookings`, `CartItem.attendeePersonId` and `createOrder({ isPayAtDesk })` do not exist (cross-module D21; the attendee is the booking row's `person_id`). The `order_line_id` check allows null only while `reserved`.
39. Terms and house rules (including the health self-declaration) are accepted once on the first booking or waitlist join through site's `terms_acceptances` (context `booking`); later material changes never block a booking. No health answer is stored.
40. Pay at desk is a staff-only option for day and night sessions: a `reserved` row with an `admin` order that expires at the session's end; check-in requires payment first.
41. Belgian public holidays are offered, never applied automatically; BEAM closes each one with one click. The calendar is platform's `belgianPublicHolidays` (`@beam/core/platform`); booking keeps no copy and adds only the localized names.
42. Business hours (`settings.business_hours`) are display data for site and portal; templates and exceptions alone decide which sessions exist.
43. Webinar sessions have `capacity_seats = 0`, are written only by `upsertWebinarSession`, and are never bookable through booking actions; registration belongs to the webinar module.
44. The SimplyBook cut-over imports future bookings only, onto existing sessions, as `confirmed` rows without ledger entries (`importBooking`); past bookings are ops' `imported_history` rows, and booking has no historical-import function.
45. Booking health (`getBookingHealth`, with `level: 'ok' | 'warn' | 'alert'`) is part of `/api/health` (under `checks.booking`, never a 503) and the daily digest, because "booking not working" is a Critical incident under the SLA; `alert` raises platform's High Slack alert `booking-health` (cross-module D48).
46. Portal booking pages, the claim page and the check-in desk meet WCAG 2.1 AA, checked with axe in Playwright.

Cross-module review decisions (requests from other modules' reviews; applied unless stated otherwise):

47. Webinar sessions (webinar review): `upsertWebinarSession` accepts the requested optional `sessionId` (checked against the row keyed by `webinarId`, `webinar_session_mismatch` otherwise) and returns `{ sessionId, created }`, a superset of webinar's `{ sessionId }`. `cancelWebinarSession` keeps `(tx, ctx, { webinarId, reason })` instead of the requested `(tx, ctx, sessionId)`: keyed by `webinarId` it is idempotent, needs no lookup by the caller, and stores the reason on `sessions.cancel_reason`. `cancelWebinarSession` returns `{ cancelled: boolean }`. Closed by cross-module D50: webinar calls `upsertWebinarSession(tx, ctx, { webinarId, title, startsAt, endsAt, sessionId? })` expecting `{ sessionId, created }` and `cancelWebinarSession(tx, ctx, { webinarId, reason })` expecting `{ cancelled }`; there is no `linkWebinarSession`.
48. Health declaration source (crm and forms reviews conflict): booking reads only `forms.hasValidSubmission(db, { personId, formSlug: 'health-declaration' })` for the health declaration, and site's `terms` acceptance (R62) for the house rules and the short health disclaimer. It declines crm's request to read `crm.hasValidDeclaration`: site decision 41 makes the house rules a chapter of `terms`, and forms ID11 plus automation's `after-first-booking` (`form_completed: health-declaration`) already use the form, so crm's `person_declarations` kinds `house_rules` and `health_declaration` would be a third, diverging record. Booking applies crm's `getReceptionCard` and `ReceptionCard` on the desk, and the emergency contact for nights. Settled by cross-module D15: crm's `person_declarations` keeps only `guardian_consent`, `hasValidDeclaration` is typed to that kind, and `getReceptionCard().declarations = { termsAccepted, healthDeclarationValid, guardianConsentValid }` is built from site, forms and crm.
49. Blocking (forms and crm asked booking to decide): a missing or expired health declaration never blocks a check-in or a staff booking; it blocks a customer day or night booking only when `settings.booking_rules.require_health_declaration = true` (default `false`). Every `booking_rules` field is snake_case (cross-module D16), so forms' `settings.booking_rules.require_health_declaration` and this module name the same field the same way.
50. Emergency contact (crm review): asked on customer night bookings when none is on file and `require_emergency_contact_for_nights = true` (default), written through `crm.updatePersonFields(tx, ctx, personId, { emergencyContact }, { onlyEmpty: true })` with `emergencyContact: { name, phone, relation? }`, a field of crm's `PersonFieldPatch` (cross-module D13). Never shown to customers other than the person, never in emails.
51. Member-only checks (credits review, also crm rule 12) use `credits.getMembershipForPerson(...).isMember`, a real membership, never `crm.getPersonStatus`; lead windows and queues keep `crm.getPersonStatus(...).status`, which honours the staff override.
52. Credits releases use credits' `ReleaseReason` values: `cancelled_in_policy`, `late_cancel_released`, `no_show_released`, `rescheduled`, `session_cancelled`, `staff_override`; the service tests `SharingNotAllowedError` before `InsufficientCreditsError`. The abuse review is credits' `v_sharing_review` through `countSharingReviewItems` / `listSharingReview`; booking has no `listGuestAbuseCandidates` and owns the threshold `booking_rules.guest_abuse.distinct_guests_per_30_days` (default 3) that the view reads. The check-in desk embeds `DeskCreditsBadge`.
53. Order-paid bookings and paid claims send the customer to commerce's `/[locale]/account/checkout/[orderId]`; booking calls no payment-start function. A paid claim by someone without a portal session first gets platform's magic link back to the claim page (R44).
54. Emails (email review): `sendTransactional(ctx, { template, personId, locale, data, key, attachments? })`, the Wave 0 shape; keys `booking.<name>` (cross-module D1); the QR code is an inline attachment, so emails no longer carry `signFileUrl` links.
55. Reschedule facts (automation review): a reschedule writes `booking.cancelled` (old row) and `booking.confirmed` (new row with `rescheduled_from_booking_id` and the old `is_first_booking`) besides `booking.rescheduled`; `reminder_hours_before.event` defaults to `[]`.
56. Waitlist event names (automation review, declined in part): booking keeps the `waitlist.*` names of decision 10 (`waitlist.offered` carries `offer_expires_at`, `waitlist.confirmed`, `waitlist.expired`, `waitlist.released`, `waitlist.withdrawn`) and the data keys `is_first_booking` / `is_first_visit`, because crm's timeline catalogue and segment allow-list already use them. Closed by cross-module D53: these are the catalogue names automation uses; the event kinds `booking.seat_*`, `booking.offer_expired`, `booking.waitlist_*` and the key `data.is_first` do not exist, automation reads `data.is_first_booking` (`booking.confirmed`) and `data.is_first_visit` (`booking.attended`), and `nextOpeningAt` is in booking's api.
57. `nextOpeningAt(db, from, opts?)` (automation review) honours `business_hours`, exceptions and, by default, Belgian public holidays even when BEAM opens the centre on one (office staff own the tasks); `includePublicHolidays: true` gives the customer-facing opening. Horizon 30 days, `null` when nothing opens.
58. Site's account-home functions take a single `personId: string` (cross-module D66: `bookings` and `waitlist_entries` are mutable and repointed to the winner by crm's merge, so the winner's id finds every row) and return site's requested row shapes; both land in V1 (booking-P3 and P5), before site-P6. `/[locale]/account/book` accepts `?template=<sessionTemplateId>` (forms review).
59. Ops review: there is no `importHistoricalBooking` and no `v_booking_outcomes` view (ops' `v_no_show_report` is the only report view); `cancel_reason_code` stays on `bookings`. Closed by cross-module D57: ops calls `importBooking(tx, ctx, { externalRef, personId, kind, startsAt, paidWith: 'credit' | 'order' | 'free' })`, which always inserts `confirmed` with `source = 'import'` (a `reserved` import would need an order) and returns `{ bookingId, outcome }`; ops' capacity report reads `v_session_utilisation` (no `v_capacity_utilisation` view).
60. Platform review: booking reuses `belgianPublicHolidays` from `@beam/core/platform` (R4b) and deletes its own `holidays.ts`.

Cross-module decisions (`_cross-module-decisions.md`, final and binding):

61. Cross-module decision 1 applied: template keys are `booking.<name>`, `<name>` = file basename with `-` replaced by `_`; every `booking/<file>` reference (R24, R31, R33, R42, R43, R45, R56, R59, R60, R63, 4.5, sections 8 and 10, decisions 31, 37 and 54) now uses the dotted key; copy slots are `booking.email.<name>.<slot>`; `commerce/refund-confirmation` reads `commerce.refund_confirmation`.
62. Cross-module decision 2 applied: R59 lists exactly the twelve keys of email's registry entry for booking (`booking.booking_confirmed` ... `booking.lead_window_open`), same files, same `data` variants and idempotency keys; the QR code stays the inline attachment `checkin-qr.png`.
63. Cross-module decision 13 applied: the night emergency contact is written with `crm.updatePersonFields(tx, ctx, personId, { emergencyContact }, { onlyEmpty: true })`, `emergencyContact: { name, phone, relation? }` being a `PersonFieldPatch` field (R62b, section 10, decision 50).
64. Cross-module decision 15 applied: booking reads site's terms and forms' `health-declaration` only; crm's `person_declarations` keeps only `guardian_consent`; the reception card is crm's `getReceptionCard` with `declarations = { termsAccepted, healthDeclarationValid, guardianConsentValid }` (R62b, section 10, decision 48).
65. Cross-module decision 16 applied: every field of `settings.booking_rules` and `settings.business_hours` is snake_case (sections 3.0 and 3.0b and every rule, screen and test naming one; decision 49).
66. Cross-module decision 21 applied: the state table names `confirmBookingsForOrder` and no `reserveForOrderLine` row; `reserveForOrderLine`, `confirmOrderBookings`, `releaseOrderBookings`, `CartItem.attendeePersonId` and `createOrder({ isPayAtDesk })` do not exist (R27b, decision 38).
67. Cross-module decision 22 applied: lines returned in `unavailableOrderLineIds` are refunded automatically by commerce (`refundOrderLine` reason `seat_no_longer_available`, job `commerce.refund_unavailable_lines`), with no customer-service task (R18, the api comment, edge case 3).
68. Cross-module decision 23 applied: desk payments go through `/admin/pos?order=<orderId>` (commerce's `posPayOrder`), and pay-at-desk orders are created with `createOrder({ channel: 'admin', expiresAt: session.ends_at })` (R35, R63, `createManualBooking`, section 10).
69. Cross-module decision 37 applied: retention keys `booking.waitlist_entries` and `booking.bookings_free_text` in section 9, the `sweep` map and the seed (inserted `on conflict (key) do nothing`).
70. Cross-module decision 39 applied: R62b notes that `health-declaration` may be unpublished until the DPIA `sensitive_assessment_processing` is decided, and the badge then shows "missing".
71. Cross-module decision 48 applied: `getBookingHealth` returns `level: 'ok' | 'warn' | 'alert'` set by booking's thresholds; `/api/health` shows it under `checks.booking` and never returns 503 for it; `alert` raises the High Slack alert `booking-health` (4.8, decision 45).
72. Cross-module decision 50 applied: `upsertWebinarSession(tx, ctx, { webinarId, title, startsAt, endsAt, sessionId? })` returns `{ sessionId, created }` and `cancelWebinarSession(tx, ctx, { webinarId, reason })` returns `{ cancelled: boolean }`; decision 47's conflict note is closed.
73. Cross-module decision 53 applied: booking's event kinds and `data` keys are the catalogue automation reads (`booking.*`, `waitlist.*`, `is_first_booking`, `is_first_visit`, `reminder_hours_before.event = []`, `nextOpeningAt`); decision 56's conflict note is closed.
74. Cross-module decision 57 applied: `importBooking` keeps `{ externalRef, personId, kind, startsAt, paidWith }` and its outcomes, every row `confirmed` with `source = 'import'`; the ops row reads `v_session_utilisation` and names no `v_capacity_utilisation` (section 10, decision 59).
75. Cross-module decision 66 applied: `listUpcomingBookingsForPerson(db, personId, limit)` and `listOpenOffersForPerson(db, personId)` take a single person id; the `crm.resolvePersonIds` comment and dependency are dropped (4.9, section 10, decision 58).
76. Cross-module decision 69 applied: `bookingPrivacy` satisfies `PrivacyRegistration = { tables, export, erase, sweep?, retention? }`, and each `sweep[key]` handler is `(tx, cutoff: Date) => Promise<number>` (section 9).
77. Conventions confirmed applied: event kinds follow Convention 2 (4.7); settings follow Convention 3; retention keys follow Convention 4 (section 9, with ops' `ops.marketing_profile` named as the whole-profile anonymisation); idempotency keys follow Convention 5 (`regenerate:<template_id>:<version>`).
