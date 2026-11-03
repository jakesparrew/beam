# Module spec: booking (Booking, capacity, events and waitlists)

Owner paths: `packages/db/src/schema/booking.ts`, `packages/db/src/schema/booking.views.ts`, `packages/core/src/booking/`, `apps/web/modules/booking/`, `apps/web/app/(admin)/admin/{sessions,bookings,waitlist}/`, `apps/web/app/[locale]/(portal)/account/{book,bookings,waitlist}/`, `apps/web/app/[locale]/(site)/claim/`, `apps/web/app/api/public/claim/`, `packages/email/src/templates/booking/`, `packages/core/src/i18n/messages/*/booking.json`, `packages/db/src/seed/booking.ts`, `e2e/booking.spec.ts`, `e2e/scenario-3-lead-access.spec.ts`, `e2e/scenario-4-seat-claim.spec.ts`.

Blueprint sections: 7, 8, 9, 10, 15, 19, 48, 49, plus booking requirements in 5 (timeline), 12 (member-only and waitlist rules), 21 and 31 (reminders, review requests, inactivity guard), 22 (retention inputs), 53 (booking history import), 56 (audit of booking and waitlist changes), 62 and 63 (deletion and retention of bookings and waitlists), 76 and 87 (acceptance tests and scenarios 3 and 4).

## 1. Purpose and release mapping

The booking module replaces SimplyBook. It owns the schedule (templates, exceptions, materialised sessions), capacity (seats, beds, holds), bookings for day sessions, nights and events, attendance and check-in, the waitlist with expiring claim links, and the Lead Magnet access engine. It emits the booking facts that the timeline, automations, retention and reports use. It never stores identity (that is `crm.persons`), money (that is `commerce`) or balances (that is `credits`).

| Release | Weeks | What ships in this module |
| --- | --- | --- |
| **V1** | 1-6 | Session templates with weekdays, start times, durations, capacities and validity; sessions materialised 90 days ahead and regenerated on template change without touching booked sessions; exceptions (closed days, holidays, special hours); one-off sessions; capacity holds (staff, partner, host, speaker, blocked); day sessions counting seats and nights counting beds; guests (individual or shared bed); bookings from the portal and by staff (manual, override, over capacity); payment by credits, order, guest use of a shared package, or free; rescheduling and cancellation under `settings.booking_rules`; confirmation and reminder emails; check-in by QR code and name search; no-show marking; basic events (session of kind `event`, one price through `sessions.product_id`, capacity, holds, registration, attendance); waitlist with the full seat-offer state machine, real expiring single-use claim links, duplicate protection and protected confirmed seats (single `public` queue); `v_session_availability`, `v_person_bookings`, `v_session_utilisation` (capacity utilisation data for basic reporting); booking history import API; portal pages and admin screens. |
| **Release 2** | 9-10 | Lead Magnet activation: lead-reserved seats, lead window in Europe/Brussels, release rule, `lead`/`customer`/`public` queues, "Opens for you on ..." messaging, optional visible waitlist position, waiting lead who buys moves to the customer queue (scenario 3 and the R2 acceptance tests). Events and ticketing extensions: multiple `ticket_types` per event with product-based prices, member-only types, capacity per type and sales windows; guest information per ticket; post-event follow-up event `booking.event_ended`. No-show and cancellation report data (`v_booking_outcomes`). Guest and package-sharing controls: remaining guest uses shown at booking time, abuse review list for owners with many distinct guests (`listGuestAbuseCandidates`). (Guest bookings and the `guest-invited` email are V1.) |
| **Release 3** | 11-12 | Partner management: `external_partner` users see and fill their own partner holds (`partner.own`) at `/admin/sessions/holds`; partner-attributed bookings feed the referral and partner reports owned by `ops`. |
| **Release 4** | 13-14 | `v_session_utilisation` and `v_booking_outcomes` exposed to the `ai` schema for natural-language questions and custom dashboards (non-sensitive views only); booking-frequency inputs (`getPersonBookingSummary`) for churn and repurchase indicators built by `ops`. No new booking behaviour. |
| **Later** (out of scope) | - | Native mobile app (blueprint 81), gamification (52), voice AI booking, predictive no-show models, room, staff or equipment assignment per session (proposal question 3 answered as "seats and beds only"), SMS reminders, door access integration. |

## 2. Domain model

All tables live in `packages/db/src/schema/booking.ts`; views in `packages/db/src/schema/booking.views.ts`. Conventions from the architecture apply: `id uuid pk default gen_random_uuid()`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` on mutable tables, enums named `<table>_<column>`, `LocalizedText` jsonb via `localized()`. None of this module's tables is APPEND or IMMUTABLE: the append-only history of booking facts is `activity_events` (crm), money is in `order_lines` (commerce) and credit use is in `credit_entries` (credits). This module has **no sensitive columns**; staff are told in the UI that `notes` and `cancel_reason` must not contain health information (health notes go to `crm.person_sensitive_fields`).

### Enums

| Enum | Values |
| --- | --- |
| `session_templates_kind`, `sessions_kind` | `day`, `night`, `event` |
| `session_templates_credit_kind`, `sessions_credit_kind` | `day`, `night` |
| `sessions_status` | `open`, `closed`, `cancelled` |
| `sessions_lead_release_rule` (addition) | `customers_then_public`, `public`, `keep_for_leads` |
| `session_exceptions_kind` (addition) | `closed`, `holiday`, `special_hours` |
| `capacity_holds_kind` | `staff`, `partner`, `host`, `speaker`, `blocked` |
| `bookings_status` | `reserved`, `confirmed`, `cancelled`, `late_cancelled`, `no_show`, `attended` |
| `bookings_paid_with` | `credit`, `order`, `guest`, `free` |
| `bookings_source` | `portal`, `admin`, `waitlist`, `import`, `pos`, `site` |
| `bookings_cancel_reason_code` (addition) | `customer`, `staff`, `session_cancelled`, `payment_expired`, `payment_failed`, `refunded`, `rescheduled`, `erased`, `duplicate` |
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
| webinar_id | uuid | yes | | R2; plain uuid, no FK (webinar owns the link; avoids a schema import cycle) |
| location | text | yes | | |
| notes | text | yes | | staff only |
| cancelled_at | timestamptz | yes | | addition |
| cancel_reason | text | yes | | addition |
| created_at, updated_at | timestamptz | no | now() | |

Checks: `is_lead_magnet = false or (kind = 'event' and lead_window_start_at is not null and lead_window_end_at is not null)`; `(status = 'cancelled') = (cancelled_at is not null)`. Indexes: `(starts_at)`, `(kind, starts_at) where status = 'open'`, partial unique `(template_id, starts_at) where template_id is not null` (materialisation can never double-insert).

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
| order_line_id | uuid -> order_lines.id | yes | | required when paid_with = order (check) |
| ticket_type_id | uuid -> ticket_types.id | yes | | |
| capacity_hold_id | uuid -> capacity_holds.id | yes | | addition; booking fills a hold instead of general capacity |
| used_lead_seat | boolean | no | false | addition; R2, counts against `lead_reserved_seats` |
| is_over_capacity | boolean | no | false | addition; staff override past capacity |
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

Constraints and indexes: partial unique `(session_id, person_id) where status in ('reserved','confirmed')` (architecture); unique `(checkin_code)`; index `(session_id, status)`; index `(person_id, created_at desc)`; index `(guest_of_booking_id) where guest_of_booking_id is not null`; index `(order_line_id) where order_line_id is not null`; index `(reserved_until) where status = 'reserved'`. Checks: `paid_with <> 'guest' or guest_of_booking_id is not null`; `guest_of_booking_id <> id`.

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
| offers_count | smallint | no | 0 | addition; part of the claim-token derivation |
| claim_token_hash | text | yes | | sha256 hex of the claim token; unique where not null |
| booking_id | uuid -> bookings.id | yes | | required when state = confirmed |
| is_flagged_duplicate | boolean | no | false | |
| flag_reason | text | yes | | e.g. `same_normalised_email:<entry id>` |
| flag_reviewed_by_user_id | uuid -> users.id | yes | | addition |
| flag_reviewed_at | timestamptz | yes | | addition |
| email_normalised | text | yes | | addition; lower-case, `+tag` removed, gmail dots removed; personal data |
| join_ip_hash | text | yes | | addition; sha256(ip + AUTH_SECRET-derived salt); personal data |
| ended_reason | text | yes | | addition; `declined`, `session_started`, `session_cancelled`, `staff`, `booked_directly` |
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

`v_booking_outcomes` (addition, R2): one row per booking with `booking_id, person_id, owner_person_id, session_id, kind, starts_at, day_on, weekday, local_hour, status, paid_with, cancel_reason_code, cancelled_at, hours_before_start` (for cancellations), `credit_units_kept` (from `credit_entries`: consumed minus released for `ref_type = 'booking' and ref_id = booking_id`), `revenue_cents_kept` (`order_lines.line_total_cents` minus refunded amount from `refunds` linked to the line, 0 when not order-paid). `ops` builds `v_no_show_report` and the report screens over it.

### Tables of other modules this module reads or writes

| Table | Module | Access |
| --- | --- | --- |
| `persons`, `v_person_status` | crm | read; guests created through `crm.findOrCreatePersonByEmail` / `crm.createPerson` |
| `companies` | crm | FK from `capacity_holds.company_id`; read names |
| `activity_events` | crm | write through `ctx.recordEvent` |
| `products`, `price_versions` | commerce | FK and read through `commerce.quote` |
| `orders`, `order_lines`, `refunds` | commerce | FK from `bookings.order_line_id`; created through `commerce.createOrder`; read in `v_booking_outcomes` |
| `credit_entries`, `v_person_credits` | credits | written only through `credits.consumeCredits` / `credits.releaseCredits`; views read |
| `settings` (`booking_rules`) | platform | read and written through `platform.getSetting` / `platform.updateSetting` |
| `users`, `files`, `jobs`, `audit_log` | platform | FKs; `files` written through `platform.storeFile`; jobs and audit through `ctx` |
| `email_messages` | email | written through `email.sendTransactional` |
| `webinars` | webinar | R2; `sessions.webinar_id` set by webinar module |

## 3. Business rules

### 3.0 `settings.booking_rules` (shape owned by this module)

Zod schema `BookingRules` in `packages/core/src/booking/rules.ts`; seeded by `packages/db/src/seed/booking.ts`; edited at `/admin/sessions/rules`.

```ts
const BookingRules = z.object({
  freeCancelHours: z.object({ day: z.number().int().min(0).default(24), night: z.number().int().min(0).default(72), event: z.number().int().min(0).nullable().default(null) }), // null = never free (events non-refundable)
  lateCancelReleasesCredit: z.boolean().default(false),
  noShow: z.object({ autoMark: z.boolean().default(true), afterEndMinutes: z.number().int().min(0).default(120), releasesCredit: z.boolean().default(false) }),
  bookUntilMinutesBeforeStart: z.object({ day: z.number().int().default(0), night: z.number().int().default(120), event: z.number().int().default(0) }),
  bookingHorizonDays: z.number().int().min(1).max(90).default(60),          // how far ahead customers may book
  reservationHoldMinutes: z.number().int().min(5).max(60).default(30),      // equals payments.scan_expired window
  maxGuestsPerBooking: z.number().int().min(0).max(10).default(3),
  maxReschedulesPerBooking: z.number().int().min(0).default(2),
  reminderHoursBefore: z.object({ day: z.array(z.number()).default([24]), night: z.array(z.number()).default([48]), event: z.array(z.number()).default([168, 24]) }),
  waitlist: z.object({ offerCutoffMinutesBeforeStart: z.number().int().default(60), minClaimMinutes: z.number().int().default(15), maxOffersPerPersonPerSession: z.number().int().default(2) }),
  guestAbuse: z.object({ distinctGuestsPer30Days: z.number().int().default(3) }),
});
```

### 3.1 Schedule and materialisation

- **R1** `sessions.materialise` (daily 03:10) ensures that for every active template and every Brussels calendar date `d` in `[today, today + 90]` where `extract(isodow from d) = any(weekdays)`, `active_from_on <= d`, `active_to_on is null or d <= active_to_on`, and no exception suppresses it (R4), exactly one session exists with `starts_at = zonedTimeToUtc(d + start_time, 'Europe/Brussels')` and `ends_at = starts_at + duration_minutes` (real elapsed minutes, so a night across a DST change keeps its length). Insert uses `on conflict (template_id, starts_at) do nothing`. Running it twice yields the same rows.
- **R2** Editing a template increments `version` and enqueues `sessions.regenerate_template { templateId }` (key `regenerate:<template_id>:v<version>`). For each future session of that template: if it has any booking row (any status), any waitlist entry or any hold, or `has_manual_changes = true`, it is **not touched**. Otherwise it is updated to the new title, capacity, credit fields, product and member flag when its `starts_at` still matches the template, or removed when it no longer matches. Missing matching sessions are inserted as in R1.
- **R3** Removing an untouched session means `delete` when it never had bookings, entries or holds (always true by R2), so sessions with history are never deleted by automation.
- **R4** An exception suppresses a template on `on_date` when `template_ids is null or template_id = any(template_ids)` and either `kind in ('closed','holiday')` or (`kind = 'special_hours'` and `start_time` not in `[opens_at, closes_at)`). Creating an exception enqueues `sessions.regenerate_date { onDate }`, which removes suppressed sessions that R2 allows to remove. Sessions on that date that have active bookings are listed on the exception screen as conflicts with a "Cancel these sessions" action (R33); the system never cancels them by itself.
- **R5** A one-off session (`template_id = null`) or event is created by staff and is never touched by materialisation.
- **R6** Editing a single session sets `has_manual_changes = true`. Capacity may be lowered only to `>= held + booked`; the action fails with `conflict` otherwise.
- **R7** Customers see a session only when `status = 'open'`, `published_at <= now()`, `starts_at <= now() + bookingHorizonDays` and `starts_at - bookUntilMinutesBeforeStart[kind] > now()`.

### 3.2 Capacity

- **R8** Capacity unit = seat for `day` and `event`, bed for `night`. `capacity = coalesce(capacity_beds, capacity_seats)`.
- **R9** `available_total = capacity - sum(holds.quantity) - sum(capacity_units of live bookings outside holds) - live offers`. Live bookings are `confirmed`, `attended`, `no_show`, and `reserved` with `reserved_until > now()`. Live offers are `offered` entries not yet expired and without a booking.
- **R10** Every booking, claim, hold change and capacity edit runs inside one transaction that first takes `select ... from sessions where id = $1 for update`, then re-reads `v_session_availability`. Two concurrent last-seat requests: exactly one succeeds, the other gets `conflict` with code `session_full`.
- **R11** A booking with `capacity_hold_id` consumes the hold, not general capacity; a hold cannot hold more bookings than its `quantity`, and a hold's `quantity` cannot drop below its bookings.
- **R12** Staff with `bookings.override` may book past capacity; the row gets `is_over_capacity = true` and the audit row says so. No other path exceeds capacity.
- **R13** A night guest sharing the owner's bed has `capacity_units = 0`; every other row has 1. Each person, sharing a bed or not, pays `credit_cost` (decided: credits are per person, beds only limit capacity).

### 3.3 Eligibility and payment

- **R14** One person holds at most one live booking per session (partial unique index). A second attempt returns `conflict` code `already_booked`.
- **R15** `is_member_only` sessions and member-only ticket types require `crm.getPersonStatus(personId) = 'member'` for customer bookings; staff may bypass with `bookings.override`.
- **R16** Payment choice at booking (customer): `credit` when the session has a `credit_kind` and the person's `v_person_credits` for that kind covers `credit_cost` per seat paid; else `order` when the session (or ticket type) has a product with a price; else `free` when `credit_cost = 0` and no product. Customers cannot choose `free` otherwise. Staff may choose `free` only with `bookings.override` and a reason.
- **R17** Credit payment calls `credits.consumeCredits(tx, ctx, { personId: payer, beneficiaryPersonId: attendee, kind, units: credit_cost, ref: { type: 'booking', id } })` in the booking transaction; the booking is `confirmed` immediately. If the call throws `InsufficientCreditsError` the whole transaction rolls back.
- **R18** Order payment creates the bookings as `reserved` with `reserved_until = now() + reservationHoldMinutes`, then calls `commerce.createOrder` with one line per paid seat carrying `session_id` and `ticket_type_id`; `order_line_id` is set on each row; the customer is sent to `/[locale]/account/checkout/<orderId>`. `commerce` calls `booking.confirmBookingsForOrder` in the `payments.sync` paid transaction; the rows become `confirmed`. `commerce` calls `booking.releaseBookingsForOrder` when the order expires or fails; rows become `cancelled` with `payment_expired` or `payment_failed`. `bookings.expire_reservations` (every minute) cancels any `reserved` row past `reserved_until` whose order is not paid, as a safety net.
- **R19** Prices always come from `commerce.quote` (member price version and member discount are automatic). This module never computes money.

### 3.4 Lead Magnet access (R2; flag `ff_booking_lead_priority`)

- **R20** Lead = `crm.getPersonStatus = 'lead'` at the moment of the action (paid nothing; staff correction respected by crm). Customer = `customer` or `member`.
- **R21** Phase `pre` (before `lead_window_start_at`): only general seats (`available_general`) are bookable, by anyone eligible.
- **R22** Phase `lead`: a lead may book a reserved seat (`used_lead_seat = true`) or a general seat; reserved seats are used first. A customer may book only general seats. When `available_general = 0` the customer sees "Opens for you on {opens_for_customers_at}" (Brussels time, locale format) and a "Join the customer queue" button, never a booking button that fails.
- **R23** A lead may book a reserved seat only for themselves; guests of a lead booking need general seats (closes the "bring five friends on lead seats" bypass).
- **R24** At `lead_window_end_at`, by rule: `customers_then_public` offers unused reserved seats to `customer` queue entries in `joined_at` order (one offer per free seat, claim window each); seats not covered by offers are directly bookable by customers and members until `opens_for_public_at`, then by everyone. `public` opens them to everyone at once. `keep_for_leads` keeps reserved seats lead-only until the session starts.
- **R25** From `opens_for_public_at`, the waiting entries still in any queue are offered in order: `customer`, then `lead`, then `public`, each by `joined_at`.
- **R26** A waiting entry in the `lead` queue whose person is no longer a lead moves to the `customer` queue keeping its `joined_at` (event `booking.waitlist_requeued`). An `offered` entry keeps its offer until claim or expiry. A `confirmed` entry and its booking never change because of a purchase.
- **R27** The queue position is never shown unless `sessions.is_waitlist_position_visible = true`; then the portal shows the 1-based position within the person's own queue.

### 3.5 Cancellation and rescheduling

- **R28** Free window: a customer may cancel free until `starts_at - freeCancelHours[kind]` hours. Inside the window: status `cancelled`, credits released through `credits.releaseCredits(tx, ctx, { ref: { type: 'booking', id }, reason: 'cancelled_in_policy' })`, order-paid rows refunded through `commerce.refundOrderLine` (full line amount, credit note by finance). Events with `freeCancelHours.event = null` are never free for the customer.
- **R29** Late cancellation (after the free window, before start): status `late_cancelled`; credits stay consumed unless `lateCancelReleasesCredit = true`; order-paid rows are not refunded. The customer sees which case applies before confirming.
- **R30** Cancelling an owner's booking asks whether to cancel the guests too (default yes); guest rows follow the same window rule. A guest row can be cancelled alone by the owner or staff.
- **R31** Reschedule = in one transaction, cancel the old row (`cancelled`, code `rescheduled`, no refund) and create a new `confirmed` row on the target session with `rescheduled_from_booking_id`, the same `paid_with`, `order_line_id` and guests. Credit rows: release on the old booking and consume on the new one (keys differ by booking id). Allowed for customers only inside the free window, same `kind`, same `credit_kind`, same `product_id` for order-paid rows, at most `maxReschedulesPerBooking` times along the chain. Staff with `bookings.write` may reschedule outside the window; across products needs `bookings.override`.
- **R32** Staff cancellation (`bookings.write`) defaults to the policy result; staff with `bookings.override` may force `cancelled` with credit release or refund outside the window, with a mandatory reason. A `late_cancelled` row can be converted to `cancelled` with release by `bookings.override`.
- **R33** BEAM cancelling a session (`cancelSession`, `bookings.override`): status `cancelled`, every live booking `cancelled` with `session_cancelled`, credits released, order lines refunded (also events), waiting and offered entries `released` with `session_cancelled`, one `session-cancelled` email per attendee.
- **R34** A cancellation that frees capacity enqueues `waitlist.offer_next { sessionId }` in the same transaction.

### 3.6 Attendance, check-in and no-shows

- **R35** Check-in (`bookings.write`): `confirmed` -> `attended`, `attended_at = now()`, allowed from `starts_at - 2 h` until `ends_at + 2 h`; earlier or later needs `bookings.override`. Scanning a code of another day's session shows the booking with a warning and no check-in button.
- **R36** Undo check-in (`attended` -> `confirmed`) is allowed until `ends_at + 2 h`, audited.
- **R37** `bookings.mark_no_shows` (every 15 min) marks `confirmed` rows of sessions with `ends_at + afterEndMinutes <= now()` as `no_show` when `noShow.autoMark = true`; credits stay consumed unless `noShow.releasesCredit`. Staff may convert `no_show` -> `attended` within 7 days (late check-in correction), audited.
- **R38** `booking.attended` is the only booking fact that counts as a visit (first visit, last visit, review requests, retention). `no_show`, `cancelled` and `late_cancelled` never trigger review requests (blueprint 48 and 31); the review-request automation listens to `booking.attended` only.
- **R39** For sessions of kind `event`, the same job emits `booking.event_ended { attended: boolean }` per non-cancelled booking once the session is past `ends_at + afterEndMinutes` (post-event follow-up trigger, dedupe `booking:<id>:event_ended`).

### 3.7 Waitlist and claim links

- **R40** A person may join the waitlist only when the session is full for them (no bookable unit in their phase), they have no live booking in it, and they have no entry in it (unique). An `expired`, `released` or `withdrawn` entry may rejoin once: state back to `waiting`, `joined_at = now()`.
- **R41** Allowed transitions: `waiting -> offered | withdrawn | released`; `offered -> confirmed | expired | released | withdrawn`; `expired | released | withdrawn -> waiting` (rejoin, R40); `confirmed` is terminal. Any other transition throws `InvalidTransitionError`. A system actor can never change a `confirmed` entry.
- **R42** `waitlist.offer_next { sessionId }` under the session lock: while `available_total > 0` (or the queue-specific pool in a lead phase) and the next eligible entry exists, set it `offered`, `offers_count + 1`, `offered_at = now()`, `offer_expires_at = least(now() + claim_window_minutes, starts_at - offerCutoffMinutesBeforeStart)`, `claim_token_hash = sha256(token)`, and enqueue the offer email. No offer is made when `offer_expires_at < now() + minClaimMinutes`. Flagged entries (`is_flagged_duplicate`) and entries whose person already has `maxOffersPerPersonPerSession` offers are skipped.
- **R43** Claim token = base64url(HMAC-SHA256(key, `claim:<entry_id>:<offers_count>`)), key derived with HKDF from `AUTH_SECRET` (info `beam-claim-v1`). The plain token is never stored; the email job recomputes it. Each new offer gives a new token; old links stop working.
- **R44** `GET /api/public/claim/<token>` never changes state (mail scanners prefetch links); it redirects to `/[locale]/claim/<token>`. Claiming is a POST (`claimSeat`) that, under the session lock, checks `state = 'offered'`, `offer_expires_at > now()`, then books: credits if the person has them, `free` if free, otherwise a `reserved` booking with an order and checkout; the entry becomes `confirmed` with `booking_id` when the booking is confirmed (at once, or by `confirmBookingsForOrder`). A second POST with the same token returns the existing booking. An expired or superseded token shows "This offer has expired" with a link to the session.
- **R45** `waitlist.expire_offers` (every minute): every `offered` entry with `offer_expires_at <= now()` and no live reserved booking becomes `expired`; then `waitlist.offer_next` is enqueued for its session. An offer whose reserved booking is waiting for payment expires with that booking (R18).
- **R46** The customer may decline an offer (`released`, reason `declined`) or withdraw while waiting (`withdrawn`). Both free the place for the next person at once.
- **R47** At `starts_at`, `waiting` and `offered` entries of the session become `released` with `session_started` (in `waitlist.expire_offers`).
- **R48** Duplicate protection: identical email = same person (unique `lower(email)` in crm) and is blocked by R14 and the unique entry. Suspicious secondary address: at join time, an entry is flagged when another entry or live booking in the same session has the same `email_normalised`, the same `persons.phone`, the same `(lower(last_name), birth_on)` when both are present, or the same `join_ip_hash` within 24 h in the `lead` queue. Flagged entries stay `waiting` but receive no offer until staff (`waitlist.manage`) clear or withdraw them. Booking a lead seat directly runs the same check and refuses with `needs_review` (the person is put on the lead queue, flagged, instead).
- **R49** Staff (`waitlist.manage`) may offer a seat manually, move an entry between queues, reorder by changing `joined_at`, release or withdraw entries; each is audited as `waitlist.<verb>` (blueprint 56 "Waitlist manually changed"). Changing a `confirmed` entry is impossible; staff cancel the booking instead (`bookings.override` if outside policy).

### 3.8 Events and ticketing

- **R50** An event is a session of kind `event` created by staff with `bookings.override`. It can be published (`published_at`) only when `title` is complete in all three locales and, from R2, every active ticket type `name` too.
- **R51** V1: the event price is `sessions.product_id` (null = free registration). R2 (flag `ff_booking_ticket_types`): when an event has active ticket types, every booking must carry one; the type must be on sale (`is_on_sale`), have availability, respect `is_member_only`, and `max_per_booking` limits owner plus guests.
- **R52** Guest information: for ticket types with `requires_guest_details`, each guest ticket requires first and last name; email is optional (R54).
- **R53** Holds (`partner`, `host`, `speaker`, `staff`, `blocked`) reduce sellable capacity from creation; deleting a hold frees capacity and triggers R34.

### 3.9 Guests and package sharing

- **R54** An owner adds up to `maxGuestsPerBooking` guests (name required, email optional). With an email the guest is `crm.findOrCreatePersonByEmail` (locale = owner's, no consent granted); without one, `crm.createPerson` with names only. Each guest is a `bookings` row with `guest_of_booking_id = owner row`, `booked_by_person_id = owner`.
- **R55** Guest payment: `guest` = from the owner's credits (`consumeCredits` with `beneficiaryPersonId = guest`); credits applies sharing rules and `max_guest_uses_per_month` and throws `SharingNotAllowedError` when not allowed; `order` = an extra paid line; `free` only by staff override. A person who has a package shared with them (`package_shares`) books for themself with `paid_with = guest` and the grant owner's credits.
- **R56** A guest with an email receives a `guest-invited` email naming the owner (first name only) and the session; no marketing consent is implied.
- **R57** R2 abuse control: when an owner's bookings in the last 30 days have more than `guestAbuse.distinctGuestsPer30Days` distinct guests, the owner appears in `listGuestAbuseCandidates()` (consumed by the ops action dashboard); bookings are not blocked.
- **R58** The owner-guest relationship stays visible: the guest's timeline shows "Guest of {owner}" and the owner's shows "Booked for {guest}" (both via `activity_events.data`).

### 3.10 Emails and facts

- **R59** Transactional emails (all through `email.sendTransactional`, keys in section 4): `booking-confirmed` (with QR), `booking-cancelled`, `booking-late-cancelled`, `booking-rescheduled`, `booking-reminder`, `session-cancelled`, `guest-invited`, `waitlist-joined`, `seat-offered`, `seat-claimed`, `offer-expired`. A missing translation blocks the email (`blocked_translation`) and never blocks the booking.
- **R60** Reminders: `bookings.send_reminders` (every 15 min) sends, per offset `h` in `reminderHoursBefore[kind]`, one `booking-reminder` to each `confirmed` booking with `starts_at - h hours <= now() < starts_at`, only when `created_at < starts_at - h hours` (late-entry skip, as in scenario 1). Idempotency key `booking:<id>:reminder:<h>` makes repeated runs harmless.
- **R61** Every state change writes one `activity_events` row with `dedupe_key = booking:<id>:<kind suffix>:<version>` and `data` carrying `session_id, session_kind, starts_at, paid_with, is_guest, owner_person_id, is_first` (`is_first` = first booking / first visit of the person, used by the timeline "First booking" and "First visit").

## 4. Server surface

File layout (decided, see section 13): `apps/web/modules/booking/{actions,queries,jobs,api}.ts` are barrels that `export *` from area files in `actions/`, `queries/`, `jobs/`, `api/` (`templates`, `sessions`, `bookings`, `attendance`, `waitlist`, `lead`, `tickets`, `partner`). The generators read the barrels; each package edits only its area files. Pure logic lives in `packages/core/src/booking/` (`rules.ts`, `schedule.ts`, `availability.ts`, `policy.ts`, `waitlist.ts`, `claim-token.ts`, `duplicates.ts`, `checkin-code.ts`, `describe.ts`).

### 4.1 Pure core functions (`@beam/core/booking`)

```ts
export function planOccurrences(t: TemplateLike, exceptions: ExceptionLike[], fromOn: string, toOn: string): Array<{ startsAt: Date; endsAt: Date }>;
export function diffTemplateSessions(planned: Array<{ startsAt: Date }>, existing: ExistingSession[]): { insert: Date[]; update: string[]; remove: string[]; untouched: string[] };
export function computeAvailability(row: AvailabilityRow, viewer: { status: 'lead'|'customer'|'member'|'anonymous'; isMember: boolean }, now: Date): Availability;
export type Availability = { bookable: number; reason: 'ok'|'full'|'member_only'|'not_open_yet'|'closed'|'cancelled'|'past';
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
```

### 4.2 Server actions (`action()` wrapper; every staff write is audited with `audit` = the action name)

| Action (name) | Audience / permission | Input (Zod, summarised) | Output | activity_events kinds |
| --- | --- | --- | --- | --- |
| `createTemplates` (`booking.create_templates`) | staff / `settings.write` | `{ kind, name: LocalizedText, description?, weekdays: int[1..7][], startTimes: 'HH:mm'[] (1-12), durationMinutes, capacitySeats?, capacityBeds?, creditKind?, creditCost, productId?, isMemberOnly, location?, activeFromOn, activeToOn? }` | `{ templateIds: uuid[] }` | none |
| `updateTemplate` (`booking.update_template`) | staff / `settings.write` | `{ id, expectedVersion, ...same fields partial }` | `{ id, version, regenerationJobId }` | none |
| `setTemplateActive` (`booking.set_template_active`) | staff / `settings.write` | `{ id, isActive }` (activation calls `assertComplete(name)`) | `{ id }` | none |
| `upsertException` / `deleteException` (`booking.upsert_exception`, `booking.delete_exception`) | staff / `settings.write` | `{ id?, onDate, kind, templateIds?, opensAt?, closesAt?, name, note? }` / `{ id }` | `{ id, conflicts: { sessionId, startsAt, liveBookings }[] }` | none |
| `updateBookingRules` (`booking.update_rules`) | staff / `settings.write` | `{ rules: BookingRules, expectedVersion }` | `{ version }` | none |
| `createSession` (`booking.create_session`) | staff / `bookings.override` | `{ kind, title, description?, startsAt (Brussels local ISO), durationMinutes, capacitySeats?, capacityBeds?, creditKind?, creditCost, productId?, isMemberOnly, location?, claimWindowMinutes?, publish: boolean }` | `{ sessionId }` | none |
| `updateSession` (`booking.update_session`) | staff / `bookings.override` | `{ id, expectedUpdatedAt, ...partial }` (R6) | `{ id }` | none |
| `publishSession` (`booking.publish_session`) | staff / `bookings.override` | `{ id }` (R50) | `{ publishedAt }` | none |
| `setSessionOpen` (`booking.set_session_open`) | staff / `bookings.write` | `{ id, open: boolean }` | `{ status }` | none |
| `cancelSession` (`booking.cancel_session`) | staff / `bookings.override` | `{ id, reason: string min 3, notify: boolean = true }` (R33) | `{ cancelledBookings, refundsRequested, releasedEntries }` | `booking.cancelled` per booking (`data.by = 'beam'`) |
| `upsertHold` / `deleteHold` (`booking.upsert_hold`, `booking.delete_hold`) | staff / `bookings.write` | `{ id?, sessionId, kind, quantity, companyId?, note? }` / `{ id }` (R11) | `{ id }` | none |
| `bookSession` (`booking.book`) | customer | `{ sessionId, ticketTypeId?, payWith: 'credit'|'order'|'guest'|'free', grantOwnerPersonId?, guests: { firstName, lastName, email?, sharesBed?: boolean, payWith: 'guest'|'order' }[] (max rules), clientKey: uuid }` | `{ kind: 'confirmed', bookingIds } \| { kind: 'checkout', orderId, redirectTo }` | `booking.reserved` or `booking.confirmed`; `booking.guest_added` per guest |
| `createManualBooking` (`booking.create_manual`) | staff / `bookings.write` (+ `bookings.override` for free, over capacity, member-only bypass) | `{ sessionId, personId, ticketTypeId?, payWith, holdId?, overCapacity?: boolean, reason?, guests, sendEmail: boolean = true }` | `{ bookingIds, orderId? }` (order-paid manual bookings create an `admin` channel order; staff then use POS or a payment link from commerce) | as `bookSession`, `data.source = 'admin'` |
| `cancelMyBooking` (`booking.cancel_mine`) | customer (own or own guest rows) | `{ bookingId, expectedVersion, includeGuests: boolean = true }` | `{ status, creditReleased, refundRequested }` | `booking.cancelled` or `booking.late_cancelled` |
| `cancelBooking` (`booking.cancel`) | staff / `bookings.write` (+ `bookings.override` for `force`) | `{ bookingId, expectedVersion, includeGuests, reason, force?: 'release_credit'|'refund' }` | same | same, `data.by = 'staff'` |
| `rescheduleMyBooking` (`booking.reschedule_mine`) | customer | `{ bookingId, expectedVersion, targetSessionId }` (R31) | `{ newBookingId }` | `booking.rescheduled` (old and new ids) |
| `rescheduleBooking` (`booking.reschedule`) | staff / `bookings.write` (+ override across products) | `{ bookingId, expectedVersion, targetSessionId, reason }` | `{ newBookingId }` | `booking.rescheduled` |
| `addMyGuest` / `addGuest` (`booking.add_guest_mine`, `booking.add_guest`) | customer / staff `bookings.write` | `{ ownerBookingId, guest: { firstName, lastName, email?, sharesBed?, payWith } }` | `{ bookingId } \| { kind: 'checkout', orderId, redirectTo }` | `booking.guest_added`, `booking.confirmed` |
| `updateBookingNotes` (`booking.update_notes`) | staff / `bookings.write` | `{ bookingId, notes }` | `{ id }` | none |
| `checkIn` (`booking.check_in`) | staff / `bookings.write` | `{ bookingId } \| { checkinCode }` (R35) | `{ bookingId, personName, sessionTitle, status }` | `booking.attended` |
| `undoCheckIn` (`booking.undo_check_in`) | staff / `bookings.write` | `{ bookingId }` | `{ status }` | `booking.check_in_undone` |
| `markNoShow` / `revertNoShow` (`booking.mark_no_show`, `booking.revert_no_show`) | staff / `bookings.write` | `{ bookingId }` | `{ status }` | `booking.no_show` / `booking.attended` |
| `joinWaitlist` (`booking.join_waitlist`) | customer | `{ sessionId }` (R40, R48) | `{ entryId, queue, position?: number }` | `booking.waitlist_joined` (+ `booking.waitlist_flagged`) |
| `withdrawFromWaitlist` / `declineOffer` (`booking.withdraw_waitlist`, `booking.decline_offer`) | customer | `{ entryId }` | `{ state }` | `booking.waitlist_withdrawn` / `booking.waitlist_released` |
| `addToWaitlist` (`waitlist.add`) | staff / `waitlist.manage` | `{ sessionId, personId, queue? }` | `{ entryId }` | `booking.waitlist_joined` |
| `offerSeatManually` (`waitlist.offer`) | staff / `waitlist.manage` | `{ entryId, claimWindowMinutes? }` (needs capacity unless `bookings.override`) | `{ offerExpiresAt }` | `booking.seat_offered` |
| `moveWaitlistEntry` (`waitlist.move`) | staff / `waitlist.manage` | `{ entryId, queue?, joinedAt? }` | `{ entryId }` | `booking.waitlist_requeued` |
| `releaseWaitlistEntry` (`waitlist.release`) | staff / `waitlist.manage` | `{ entryId, reason }` | `{ state }` | `booking.waitlist_released` |
| `reviewWaitlistFlag` (`waitlist.review_flag`) | staff / `waitlist.manage` | `{ entryId, decision: 'clear'|'withdraw', note }` | `{ state, isFlagged }` | `booking.waitlist_withdrawn` when withdrawn |
| `configureLeadMagnet` (`booking.configure_lead_magnet`, R2) | staff / `bookings.override` | `{ sessionId, isLeadMagnet, leadReservedSeats? \| leadReservedPct? (rounded down), leadWindowStartLocal, leadWindowEndLocal (Europe/Brussels wall clock), releaseRule, publicReleaseLocal?, claimWindowMinutes, isWaitlistPositionVisible }` | `{ sessionId }` | none |
| `upsertTicketType` / `archiveTicketType` (`booking.upsert_ticket_type`, `booking.archive_ticket_type`, R2) | staff / `bookings.override` | `{ id?, sessionId, productId, name, capacity?, isMemberOnly, salesStartAt?, salesEndAt?, maxPerBooking, requiresGuestDetails, sortOrder }` | `{ id }` | none |
| `assignHoldSeat` / `unassignHoldSeat` (`booking.assign_hold_seat`, R3) | staff `bookings.write`, or `partner.own` for holds of the user's partner company | `{ holdId, firstName, lastName, email? }` / `{ bookingId }` | `{ bookingId }` | `booking.confirmed` (`paid_with = free`, `data.partner_company_id`) |

Errors are the wrapper's codes; `conflict` carries a `reason` from: `session_full`, `already_booked`, `already_waiting`, `stale_version`, `outside_window`, `not_on_sale`, `member_only`, `insufficient_credits`, `sharing_not_allowed`, `needs_review`, `capacity_below_bookings`, `protected_seat`.

### 4.3 Queries (`queries.ts`, server components; staff queries call `requirePermission`)

Staff (`bookings.read`): `listSessionsInRange({ from, to, kind? })`, `getDayView({ onDate })` (sessions with availability and attendee counts), `getSessionDetail(id)` (session, availability, holds, ticket types, attendees with person name, payment, guest-of, check-in state, waitlist), `searchCheckin({ onDate, q })` (attendees of that day's sessions whose `first_name || ' ' || last_name` or email `ilike` `%q%`; the set is one day so no index is needed), `listTemplates()`, `getTemplate(id)`, `listExceptions({ from, to })`, `listBookings({ personId?, sessionId?, status?, from?, to?, cursor })` (keyset on `(created_at, id)`, 50 per page), `getBooking(id)`, `getUtilisation({ from, to, kind? })` (`v_session_utilisation`). `waitlist.manage`: `listWaitlist({ sessionId?, state?, flaggedOnly?, cursor })`. `partner.own` (R3): `listMyPartnerHolds()`.
Customer (scoped to `ctx.actor.personId`): `listBookableSessions({ kind, fromOn, toOn })`, `getBookableSession(sessionId)` (availability for this person, price quote, payment options, credit balance from `v_person_credits`), `listMyBookings({ scope: 'upcoming'|'past'|'events' })`, `getMyBooking(id)` (with QR data URL rendered inline as SVG), `listRescheduleTargets(bookingId)`, `listMyWaitlist()`.
Public: `getClaimOffer(token)` (session title, starts_at, expiry, state; no personal data beyond the first name).

### 4.4 Route handlers

| Route | Method | Behaviour |
| --- | --- | --- |
| `/api/public/claim/[token]` | GET | Looks up `claim_token_hash`; 303 to `/{locale}/claim/{token}` with the person's locale (unknown token: 303 to `/{default}/claim/invalid`). No state change. `cache-control: no-store`. |
| `/api/public/claim/[token]` | POST | Form post from the claim page (same-origin `Origin` check; WAF limit 60/min/IP). Runs `claimSeat(token, { payWith? })` with a customer actor for the entry's person (the token proves identity). Returns 303 to the booking page (`/{locale}/account/bookings/{id}`, which may ask for login) or to `/{locale}/account/checkout/{orderId}`. |

No webhooks in this module.

### 4.5 Jobs (`defineJob`; every handler is idempotent and covered by the double-run test)

| Kind | Lane | Payload | Idempotency key | Retries | What it does |
| --- | --- | --- | --- | --- | --- |
| `sessions.materialise` | bulk | `{ fromOn?, days?: 90 }` | `schedule:sessions.materialise:<minute>` | 6, retryable | R1 for all active templates; self-continues per 30-day chunk |
| `sessions.regenerate_template` | fast | `{ templateId }` | `regenerate:<template_id>:v<version>` | 6 | R2 |
| `sessions.regenerate_date` | fast | `{ onDate }` | `regenerate_date:<on_date>:<exception_id>:<updated_at epoch ms>` | 6 | R4 |
| `bookings.expire_reservations` | fast | `{}` | `schedule:bookings.expire_reservations:<minute>` | 3 | R18 safety net; enqueues `waitlist.offer_next` |
| `bookings.mark_no_shows` | fast | `{}` | `schedule:bookings.mark_no_shows:<minute>` | 6 | R37, R39 |
| `bookings.send_reminders` | fast | `{}` | `schedule:bookings.send_reminders:<minute>` | 6 | R60 |
| `waitlist.expire_offers` | fast | `{}` | `schedule:waitlist.expire_offers:<minute>` | 6 | R45, R47, R26 (R2), enqueues `waitlist.offer_next`; also releases lead seats at window end (R24) |
| `waitlist.offer_next` | fast, priority 1 | `{ sessionId }` | `waitlist:<session_id>:offer_next:<trigger_id>` (trigger = booking id, entry id or `<minute>`) | 6 | R42; sends `seat-offered` with key `waitlist:<entry_id>:offer:<offers_count>` |

Permanent errors: unknown ids, invalid payload. A job never touches a `confirmed` waitlist entry (asserted by `transition()`).

### 4.6 Schedules (`schedules.ts`, cron in Europe/Brussels)

`waitlist.expire_offers` `* * * * *`; `bookings.expire_reservations` `* * * * *`; `bookings.mark_no_shows` `*/15 * * * *`; `bookings.send_reminders` `*/15 * * * *`; `sessions.materialise` `10 3 * * *`.

### 4.7 Event kinds (`events.ts`, `defineEvent`)

`booking.reserved`, `booking.confirmed`, `booking.cancelled`, `booking.late_cancelled`, `booking.rescheduled`, `booking.guest_added`, `booking.attended`, `booking.check_in_undone`, `booking.no_show`, `booking.event_ended`, `booking.waitlist_joined`, `booking.waitlist_flagged`, `booking.waitlist_requeued`, `booking.seat_offered`, `booking.seat_claimed`, `booking.offer_expired`, `booking.waitlist_released`, `booking.waitlist_withdrawn`. All with `ref_type = 'booking'` or `'waitlist_entry'`, `is_sensitive = false`.

### 4.8 Cross-module API (`apps/web/modules/booking/api.ts`)

```ts
import type { Tx, DbOrTx } from '@beam/db';
import type { Ctx } from '@/lib/ctx';

export function getAvailability(db: DbOrTx, input: { sessionId: string; personId?: string; at?: Date }): Promise<Availability & { sessionId: string; capacity: number; held: number; booked: number; waiting: number }>;
export function listBookableSessions(db: DbOrTx, input: { kind?: 'day'|'night'|'event'; fromOn: string; toOn: string; personId?: string }): Promise<SessionSummary[]>; // site entry points
export function confirmBookingsForOrder(tx: Tx, ctx: Ctx, input: { orderId: string }): Promise<{ confirmedBookingIds: string[]; unavailableOrderLineIds: string[] }>; // commerce refunds unavailable lines (edge case 3)
export function releaseBookingsForOrder(tx: Tx, ctx: Ctx, input: { orderId: string; reason: 'payment_expired'|'payment_failed'|'order_cancelled' }): Promise<{ releasedBookingIds: string[] }>;
export function cancelBookingsForOrderLine(tx: Tx, ctx: Ctx, input: { orderLineId: string; reason: 'refunded' }): Promise<{ cancelledBookingIds: string[] }>; // commerce refund path, no second refund
export function createBookingForPosLine(tx: Tx, ctx: Ctx, input: { orderLineId: string; sessionId: string; personId: string }): Promise<{ bookingId: string }>; // POS walk-in, source 'pos'
export function hasFutureBooking(db: DbOrTx, personId: string, kinds?: Array<'day'|'night'|'event'>): Promise<boolean>; // automation `unless`
export function getPersonBookingSummary(db: DbOrTx, personId: string): Promise<{ nextBookingAt: Date|null; upcoming: number; attended: number; noShows: number; cancellations: number; lateCancellations: number; firstVisitAt: Date|null; lastVisitAt: Date|null; nightsBooked: number }>;
export function listPersonBookings(db: DbOrTx, personId: string, opts?: { limit?: number }): Promise<PersonBookingRow[]>; // crm person page
export function importHistoricalBooking(tx: Tx, ctx: Ctx, row: { externalRef: string; personId: string; kind: 'day'|'night'|'event'; startsAt: Date; endsAt: Date; title: LocalizedText; status: 'attended'|'no_show'|'cancelled'|'confirmed'; paidWith: 'credit'|'order'|'free' }): Promise<{ bookingId: string; created: boolean }>; // ops imports; finds or creates a one-off session (kind, starts_at); idempotent on `bookings.external_ref`
export function listGuestAbuseCandidates(db: DbOrTx, input: { days?: 30 }): Promise<Array<{ ownerPersonId: string; distinctGuests: number }>>; // R2, ops action dashboard
export function linkWebinarSession(tx: Tx, input: { sessionId: string; webinarId: string }): Promise<void>; // R2, webinar module
```

## 5. Screens

All screens use `@beam/ui` (`DataTable`, `LocalizedInput`, `FormField`), dates in Europe/Brussels with `Intl`, and the `booking` catalogue. Every list has an empty state with a next action, a skeleton while loading (`loading.tsx`) and an `error.tsx` that shows the request id and a retry button. Optimistic-version conflicts show "This booking changed meanwhile, reload" and reload the data.

### 5.1 Staff back-office (`app/(admin)/admin/...`, permission checked by `requirePermission`, nav hidden by the same list)

| Route | Permission | Shows | Actions | Empty / special states |
| --- | --- | --- | --- | --- |
| `/admin/sessions` | `bookings.read` | Week calendar (Mon-Sun), filter by kind; each session as a block with booked/capacity, holds, waiting count, lead badge, status colour | open day view, new session (override), go to templates | "No sessions this week: add a template" |
| `/admin/sessions/day/[date]` | `bookings.read` | Day view: sessions in time order with availability bars, attendees count, check-in progress, exceptions banner for that date | open session, check-in desk, close/reopen session | closed day banner with the exception name |
| `/admin/sessions/[id]` | `bookings.read` | Session detail: header (time, kind, capacity, held, booked, live offers, waiting, lead phase), attendee list (name, guest-of, paid with, ticket type, status, check-in button, notes), holds tab, waitlist tab, ticket types tab (R2), lead magnet tab (R2), history (audit rows) | check in / undo / no-show, manual booking, cancel booking, reschedule, add guest, edit session, publish, cancel session, add/edit hold, manage waitlist, configure lead magnet, ticket types | "No bookings yet"; cancelled session shows reason and refunds status read-only |
| `/admin/sessions/new` | `bookings.override` | One-off session or event form; `LocalizedInput` for title/description with completeness badge | create (draft) or create and publish | publish button disabled with the list of missing locales |
| `/admin/sessions/templates` | `settings.write` | Templates table: kind, name, weekdays, time, duration, capacity, credits, product, member-only, validity, active | add schedule (several start times), edit, activate/deactivate | "No schedule yet: add your first day sessions" |
| `/admin/sessions/templates/[id]` | `settings.write` | Edit form plus a preview of the next 14 days and of the sessions that will not change because they have bookings | save (shows regeneration job status from `jobs`) | regeneration failed: banner with retry link to `/admin/system/jobs` |
| `/admin/sessions/exceptions` | `settings.write` | Calendar list of exceptions, form for closed day, holiday, special hours, template filter | add, edit, delete; conflicts list with "cancel these sessions" (override) | "No closed days planned" |
| `/admin/sessions/rules` | `settings.write` | `settings.booking_rules` form grouped: cancellation, no-show, booking window, guests, reminders, waitlist | save (versioned setting, audited) | validation errors inline |
| `/admin/sessions/holds` | `bookings.read`; R3 also `partner.own` (own company only, no customer PII beyond the names they entered) | Holds across future sessions: session, kind, quantity, used, company, note | add/edit/delete (`bookings.write`), assign named person to a hold seat (R3) | "No holds" |
| `/admin/bookings` | `bookings.read` | Search and filter bookings (person, session, status, date range, paid with, source), keyset paging | open booking, new manual booking | "No bookings match these filters" |
| `/admin/bookings/new` | `bookings.write` | Manual booking wizard: person search (crm), session picker with live availability, payment choice with credit balance, guests, override toggles (only with `bookings.override`), send email checkbox | create | over-capacity toggle shows the warning text |
| `/admin/bookings/[id]` | `bookings.read` | Booking detail: person, session, status history from `activity_events`, credits entries, order line link, guests, QR code, notes, waitlist origin | cancel (policy preview), force options (override), reschedule, add guest, check-in, edit notes | |
| `/admin/bookings/checkin` | `bookings.write` | Reception desk: today's sessions; one focused input that accepts a scanned code (USB/Bluetooth scanner as keyboard, or phone camera opening the QR URL) or a name; result card with big check-in button; list of not-yet-arrived per session | check in, undo, add walk-in (manual booking), mark no-show | wrong-day code warning; unknown code "not found"; already checked in shows time |
| `/admin/waitlist` | `waitlist.manage` | All waitlist entries of future sessions grouped by session and queue; flagged-for-review filter with the duplicate signals | offer seat, move queue, reorder, release, review flag (clear/withdraw), add person | "Nobody is waiting" |

The QR code encodes `https://<host>/admin/bookings/checkin?c=<checkin_code>`; opening it on a logged-in staff device pre-fills the desk; on any other device the admin login page appears and no booking data is shown.

### 5.2 Customer portal (`app/[locale]/(portal)/account/...`, logged-in customer, data scoped to `ctx.actor.personId`)

| Route | Shows | Actions | States |
| --- | --- | --- | --- |
| `/[locale]/account/book` | Tabs Day / Night / Events; date strip for the booking horizon; sessions with time, "x places left" (exact number only when <= 5, otherwise "available"), price or "1 session from your package", member-only badge, lead-window message "Opens for you on ..." | open a session | empty "No sessions on this day"; closed-day label with the holiday name |
| `/[locale]/account/book/[sessionId]` | Session detail and booking form: payment choice (credits with remaining "4 sessions remaining", buy single, use a package shared with me), guests (name, optional email, share bed for nights), ticket type picker (R2), cancellation policy text with the free-until time | book; join waitlist when full; join customer queue (R2) | full: waitlist button; not open yet: opening time; member-only: "For members" with link to membership; errors from `conflict` mapped to messages |
| `/[locale]/account/bookings` | Upcoming and past bookings, event registrations tab, guest bookings I made, bookings where I am a guest | open a booking | "No upcoming bookings" with a Book button |
| `/[locale]/account/bookings/[id]` | Booking detail: QR code for reception, session, guests, payment, policy ("Free cancellation until Tue 14 Jan 18:00" or "Cancelling now keeps the session used") | cancel (confirm dialog shows the outcome), reschedule, invite a guest, add to calendar (`.ics` generated client-side) | cancelled booking read-only |
| `/[locale]/account/bookings/[id]/reschedule` | Eligible target sessions (R31) | pick and confirm | "No other session available in your free window" |
| `/[locale]/account/waitlist` | My entries: waiting (queue name, position only when enabled), offered (countdown to expiry and "Claim my seat" button), confirmed (link to booking), expired/released | claim, decline, withdraw, rejoin once | "You are not on any waiting list" |

### 5.3 Public (`app/[locale]/(site)/claim/[token]/page.tsx`, owned by this module)

Shows the offer: session title and time, expiry countdown in Brussels time, the person's first name, payment hint, and a "Confirm my seat" form posting to `/api/public/claim/[token]`, plus "I can't come" (decline). States: expired or superseded ("This offer has expired; the seat went to the next person"), already claimed (link to the booking), invalid token, session cancelled. `noindex`, no third-party scripts. The public site pages for sessions and events are owned by `site`; they call `booking.listBookableSessions` and `getAvailability` and link to `/[locale]/account/book/[sessionId]`.

## 6. Integrations

None directly. This module calls no external service and nothing from `packages/integrations`. Payments and refunds go through `commerce` (Mollie behind `PaymentProvider`), emails through `email.sendTransactional` (Resend), invoices and credit notes through `finance` (Billit). The QR PNG is rendered locally with the `qrcode` library inside the confirming transaction and stored through `platform.storeFile` (kind `image`, `is_public = true`, `expires_at = ends_at + 1 day`), so no request leaves the platform. Idempotency of every side effect it triggers is carried by the keys in section 4 (`booking:<id>:confirmed`, `booking:<id>:cancelled`, `booking:<id>:reminder:<h>`, `waitlist:<entry_id>:offer:<n>`, credit keys `consume:<booking_id>:<grant_id>` owned by credits, refunds keyed by order line in commerce).

## 7. Permissions and audit

This module declares no new permission strings; `modules/booking/permissions.ts` registers the use of `bookings.read`, `bookings.write`, `bookings.override`, `waitlist.manage` and documents the borrowed `settings.write`, `partner.own`, `reports.read`.

| Role (default set) | What it can do here |
| --- | --- |
| owner, technical_admin, management | everything: templates, exceptions, rules, events, lead magnet, ticket types, overrides, session cancellation, waitlist |
| customer_service | `bookings.read/write`, `waitlist.manage`: manual bookings, cancel and reschedule inside policy, guests, check-in, no-shows, holds, waitlist management. No free bookings, over-capacity, forced refunds, events or schedule edits |
| reception | same as customer_service in this module (check-in desk is its main screen) |
| sales | `bookings.read`: calendars, session detail, booking search |
| marketing, finance | nothing in this module except reports through `ops` (`reports.read`) |
| external_partner | R3: `/admin/sessions/holds` for holds of their own partner company; assign names to those seats; sees counts, never other attendees |
| customer | own bookings, guests they booked, waitlist entries, claim links |

Audited (`audit_log`, written by the `action()` wrapper for every staff write; `entity_type` in parentheses; `old_value`/`new_value` hold the changed columns only): every action in 4.2 with audience staff. Explicit cases required by blueprint 56: `booking.cancel` and `booking.cancel_session` ("Booking cancelled"), every `waitlist.*` action ("Waitlist manually changed"), `booking.create_manual` with `overCapacity` or `free`, `booking.update_rules`, `booking.update_template`, `booking.check_in` / `booking.undo_check_in` / `booking.revert_no_show`. System changes (jobs) are not in `audit_log`; they are in `activity_events` with `actor.kind = 'system'`. Customer actions are not audited; they are in `activity_events` with `actor.kind = 'customer'`.

## 8. Multi-language and content

- Catalogue namespace `booking` in `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/booking.json`; keys `booking.<screen>.<element>`, screens: `calendar`, `day`, `session`, `templates`, `exceptions`, `rules`, `holds`, `bookings`, `manual`, `checkin`, `waitlist`, `portalBook`, `portalSession`, `portalBookings`, `portalBooking`, `portalReschedule`, `portalWaitlist`, `claim`, `errors` (one key per `conflict` reason), `availability` (`openForYouOn`, `placesLeft`, `full`, `memberOnly`, `notOpenYet`, `queuePosition`), `email.<template>.<part>`.
- LocalizedText fields: `session_templates.name`, `session_templates.description`, `sessions.title`, `sessions.description`, `session_exceptions.name`, `ticket_types.name`. Edited with `LocalizedInput`.
- Publish-time checks with `assertComplete(text, ['nl-BE','fr-BE','en'])`: activating a template (`name`; `description` when present), publishing a session or event (`title`; `description` when present; every active ticket type `name` from R2), saving an exception (`name`). Materialised sessions copy a complete template name, so they are always complete.
- Emails: react-email templates in `packages/email/src/templates/booking/` (`booking-confirmed.tsx`, `booking-cancelled.tsx`, `booking-late-cancelled.tsx`, `booking-rescheduled.tsx`, `booking-reminder.tsx`, `session-cancelled.tsx`, `guest-invited.tsx`, `waitlist-joined.tsx`, `seat-offered.tsx`, `seat-claimed.tsx`, `offer-expired.tsx`), rendered in `persons.locale`; a missing key blocks the email (`blocked_translation`), never the booking.
- Dates: `Intl.DateTimeFormat(locale, { timeZone: 'Europe/Brussels', dateStyle: 'full', timeStyle: 'short' })`; "Opens for you on" uses the same format. Admin lead-window inputs are wall-clock Brussels times converted with `date-fns-tz` style helpers in `@beam/core/booking/schedule.ts` (DST-safe).

## 9. Privacy

`apps/web/modules/booking/privacy.ts`:

```ts
export const bookingPrivacy = { tables: ['bookings', 'waitlist_entries'],
  export: (tx, personId) => Promise<{ 'bookings.json': unknown[]; 'waitlist.json': unknown[] }>,
  erase: (tx, personId) => Promise<Array<{ table: string; rows: number; action: 'deleted'|'anonymised'|'retained_legal' }>> };
```

| Table | Person data | Export includes | Erase does | Why |
| --- | --- | --- | --- | --- |
| `bookings` | `person_id`, `booked_by_person_id`, `booked_by_user_id`, `notes`, `cancel_reason`, `checkin_code`, `qr_file_id` | every row where the person is attendee or booker: session title, kind, start, status, paid with, guest-of (guest shown by first name only), cancellation, attendance times | future live rows are cancelled first with code `erased` (no refund and no credit release here; credits revokes the person's grants in its own step). Then for all rows: `notes = null`, `cancel_reason = null`, `checkin_code` replaced by a fresh random code, QR file deleted, `booked_by_person_id = null` when it is the erased person. Rows are kept (`anonymised`) linked to the anonymised `persons` row | capacity history, utilisation statistics and the credits ledger reconciliation reference booking ids; `persons` itself is anonymised by crm, so the kept rows identify nobody. Rows linked to an `order_line_id` are reported as `retained_legal` (accounting) |
| `waitlist_entries` | `person_id`, `email_normalised`, `join_ip_hash`, `flag_reason` | every entry: session, queue, state, joined/offered/expiry times | **deleted** (architecture: erasure deletes waitlist entries; scenario 7) | no legal reason to keep |
| `capacity_holds` | `note` may name a speaker (not a customer) | not included | not touched | not linked to `persons`; listed in `NO_PII_TABLES` with that justification |
| `sessions`, `session_templates`, `session_exceptions`, `ticket_types` | none | - | - | `NO_PII_TABLES` |

Order in `GDPR_REGISTRY`: booking erase runs after `credits` and `commerce` (so refunds and revocations already happened) and before `crm` anonymises `persons`. The erase job runs under `SET LOCAL beam.allow_rewrite = 'on'` (not needed for these mutable tables, harmless).

Retention policies registered (rows in `retention_policies`, seeded by `packages/db/src/seed/booking.ts`, enforced by `ops`' `privacy.retention_sweep`): `waitlist_entries` delete 365 days after the session's `starts_at`; `bookings_free_text` anonymise (`notes`, `cancel_reason` set null) 3 years after `starts_at`; booking rows themselves are kept as long as the person record exists (they are removed of identity by the person's erasure or the 3-year marketing-profile anonymisation run by crm/ops). QR files expire one day after the session (`files.purge_expired`).

## 10. Dependencies

### Needs from other modules

| Module | Capability (api.ts function or table) | Used for |
| --- | --- | --- |
| platform | `ctx.enqueue`, `ctx.recordEvent`, `ctx.audit`, `defineJob`, `defineSchedule`, `defineEvent`, `action()`, `requirePermission()`, `flag()`; `platform.getSetting(db, 'booking_rules')`, `platform.updateSetting(tx, ctx, { key, value, expectedVersion })`, `platform.storeFile(tx, { kind: 'image', name, mime, bytes, isPublic, expiresAt, personId })`, `platform.deleteFile(tx, id)`; tables `users`, `files`, `settings` | rules, QR files, jobs, audit |
| crm | `crm.getPersonStatus(db, personId): Promise<'lead'|'customer'|'member'>`, `crm.findOrCreatePersonByEmail(tx, ctx, { email, firstName, lastName, locale, source })`, `crm.createPerson(tx, ctx, { firstName, lastName, locale })`, `crm.searchPersons(db, { q, limit })` (manual booking picker); tables `persons` (FK, names, phone, birth_on for duplicate signals), `companies` (FK) | eligibility, guests, duplicate signals |
| credits | `credits.consumeCredits(tx, ctx, { personId, beneficiaryPersonId, kind, units, ref })`, `credits.releaseCredits(tx, ctx, { ref, reason })`, view `v_person_credits`; errors `InsufficientCreditsError`, `SharingNotAllowedError` | credit and guest payment, releases |
| commerce | `commerce.quote(input)`, `commerce.createOrder(tx, ctx, { personId, channel, items: { productId, quantity, sessionId?, ticketTypeId? }[], clientKey })` returning lines, `commerce.refundOrderLine(tx, ctx, { orderLineId, reason })`; tables `products`, `order_lines`, `refunds` (FK and `v_booking_outcomes`); checkout page `/[locale]/account/checkout/[orderId]` | paid bookings, refunds |
| email | `email.sendTransactional(tx, { personId, template, data, idempotencyKey })` | all booking emails |
| webinar (R2) | sets `sessions.webinar_id` through `booking.linkWebinarSession` | webinar events |

Commerce, in turn, must call `booking.confirmBookingsForOrder` in its paid transaction, `booking.releaseBookingsForOrder` when an order expires, fails or is cancelled, `booking.cancelBookingsForOrderLine` on a staff refund of a session or ticket line, and `booking.createBookingForPosLine` for POS walk-ins.

### Provides to other modules

| Consumer | What |
| --- | --- |
| commerce | the four order hooks above; `getAvailability` before creating a session or ticket line |
| site | `listBookableSessions`, `getAvailability`, `describeAvailability` (core) for public schedule and event pages |
| automation | event kinds of 4.7 as triggers (`booking.confirmed` for after-first-booking, `booking.attended` for after-first-visit and review requests, `booking.event_ended` for post-event follow-up, `booking.offer_expired` for the `waitlist-offer` sequence), `hasFutureBooking` for `unless: { has_future_booking }` (inactivity guard) |
| ops | `getPersonBookingSummary` (person_stats visits, no-shows, next booking, first/last visit), views `v_session_utilisation`, `v_booking_outcomes` (R2, no-show and cancellation report), `listGuestAbuseCandidates` (R2 action dashboard), `importHistoricalBooking` (SimplyBook migration), privacy registration |
| crm | `listPersonBookings` for the person page; timeline facts through `activity_events` |
| webinar | `linkWebinarSession`; event sessions as registration capacity |
| credits | booking ids as ledger `ref` (`ref_type = 'booking'`), consumed by `ledger.reconcile` |

## 11. Edge cases and failure modes

1. **Two customers take the last seat at once.** Both transactions lock the session row; the second re-reads availability after the first commits and gets `conflict: session_full` with a "Join the waiting list" button.
2. **Double submit of a paid booking.** `clientKey` is passed to `commerce.createOrder` as `orders.client_key`; the second submit finds the same order and the partial unique index refuses a second live booking; the action returns the existing checkout.
3. **Payment completes after the reservation expired.** `confirmBookingsForOrder` finds the row `cancelled` (`payment_expired`). If capacity is still free it re-books (new `confirmed` row, same order line); otherwise it returns the line in `unavailableOrderLineIds` and commerce refunds it automatically with reason `seat_no_longer_available`; the customer gets the refund email from commerce. Rows already `confirmed` are returned in `confirmedBookingIds` again (idempotent). Never overbooked.
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
18. **Guest use exceeds the package's monthly guest limit.** `consumeCredits` throws `SharingNotAllowedError`; the action returns `sharing_not_allowed` and offers to pay the guest by order.
19. **Session cancelled by BEAM with paid event tickets.** Every ticket line is refunded through `commerce.refundOrderLine` (credit notes via finance); credits are released; offers and waiting entries are released; one email per attendee; jobs carry keys so a retry does not refund twice.
20. **No-show job runs late or twice.** It selects only `confirmed` rows of ended sessions; a second run finds none; event keys dedupe `booking.no_show`.
21. **Reception checks in the wrong day's QR code.** Shown with a warning, no check-in button (R35); override available for `bookings.override`.
22. **Translation missing for an email.** Booking succeeds; the email is `blocked_translation`, listed in the digest; staff fix the catalogue or template.
23. **`waitlist.offer_next` dies (dead job).** The next `waitlist.expire_offers` run re-enqueues it for every session with free capacity and waiting entries, so a dead job delays offers by at most one minute after the cause is fixed.
24. **Imported SimplyBook booking for a session time that does not match a template.** `importHistoricalBooking` creates a one-off past session (`template_id = null`) once per (kind, starts_at) and is idempotent on `external_ref`.
25. **Member status lapses between booking and session.** Existing member-only bookings stay; eligibility is checked only at booking time.
26. **Lead window configured in the past or end before start.** `configureLeadMagnet` refuses (`validation`); a lead magnet event cannot be published without a window.

## 12. Build packages

Order and parallelism: **P1 -> (P2 and P3 in parallel) -> (P4 and P5 in parallel) -> P6** for V1 (Waves 1 and 2), then **P7 -> P8** (R2), then **P9** (R3/R4). Shared files are made collision-free by P1: it turns `actions.ts`, `queries.ts`, `jobs.ts`, `api.ts` and `schedules.ts` into barrels over area files and creates every area file as an empty stub, so later packages edit only their own area files. Files that more than one package edits are listed with "(sequential after Pn)". No package edits `package.json`, the lockfile, migrations, `packages/db/src/schema/index.ts`, `registry/*.generated.ts` or frozen Wave 0 files. Every package's done-definition includes: `pnpm gen:indexes && pnpm typecheck && pnpm lint` green, its Vitest suites green on `createTestDb()` with the `fake.ts` adapters, `pnpm i18n:check` green.

### booking-P1 (V1): schema, views and pure booking logic

- **Goal:** final tables, enums and V1 views; the pure core used by every other package; module barrels, events, permissions, nav, flags and the V1 message catalogue.
- **Files:** `packages/db/src/schema/booking.ts` (replaces the Wave 0 stub; keeps every contract column), `packages/db/src/schema/booking.views.ts` (`v_session_availability`, `v_person_bookings`, `v_session_utilisation`), `packages/core/src/booking/{index,rules,schedule,availability,policy,waitlist,claim-token,duplicates,checkin-code,describe,errors}.ts` and a `*.test.ts` beside each logic file, `apps/web/modules/booking/{actions,queries,jobs,api,schedules}.ts` (barrels) with stubs `actions/{templates,sessions,bookings,attendance,waitlist,lead,tickets,partner}.ts`, `queries/{schedule,bookings,attendance,waitlist,partner}.ts`, `jobs/{schedule,bookings,attendance,waitlist}.ts`, `api/{bookings,waitlist,partner}.ts`, `schedules/{schedule,bookings,attendance,waitlist}.ts`; `apps/web/modules/booking/{events,permissions,nav,flags}.ts`; `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/booking.json` (all V1 keys of section 8).
- **Interfaces:** every function of 4.1; `BookingRules` Zod schema and `DEFAULT_BOOKING_RULES`; error classes `SessionFullError`, `AlreadyBookedError`, `InvalidTransitionError`, `ProtectedSeatError`, `OutsideWindowError`, `NeedsReviewError` (all `conflict` with a `reason`); `BOOKING_FLAGS = ['ff_booking_lead_priority', 'ff_booking_ticket_types'] as const`.
- **Depends on:** Wave 0 (`_shared.ts`, contract stubs of `sessions` and `bookings`, `platform:users`, `crm:persons`, `crm:companies`, `commerce:products`, `commerce:order_lines`, `platform:files`).
- **Tests:** `schedule.test.ts` (weekday filter, validity range, closed/holiday/special-hours suppression, DST spring and autumn for 10:00 day and 21:00 night, 90-day window size, `diffTemplateSessions` keeps booked and manual sessions); `availability.test.ts` (holds, reserved expiry, live offers, member-only, every lead phase for lead, customer and member viewers, `keep_for_leads`, horizon and cut-off); `policy.test.ts` (free window boundaries 24 h/72 h at the exact second, events null window, late-cancel release flag, reschedule rules); `waitlist.test.ts` (every allowed and forbidden transition, system actor on `confirmed` throws `ProtectedSeatError`, candidate ordering per phase, flagged skipped, offer expiry cut-off and minimum); `claim-token.test.ts` (deterministic, differs per `offers_count`, hash length); `duplicates.test.ts` (gmail dots and plus, phone, name and birth date, IP window); `schema.test.ts` on `createTestDb()` (partial unique booking per session and person, unique entry, unique `(template_id, starts_at)`, check constraints, view row for an empty session and for a session with holds, bookings and offers). Core coverage above 90 % for `booking/waitlist`.
- **Done:** standard definition; `v_session_availability` matches `computeAvailability` on 10 fixture sessions.

### booking-P2 (V1): schedule, templates, exceptions, holds and materialisation

- **Goal:** BEAM edits schedules without a developer; sessions exist 90 days ahead.
- **Files:** `apps/web/modules/booking/actions/templates.ts`, `actions/sessions.ts` (create, update, publish, open/close; not cancel), `queries/schedule.ts`, `jobs/schedule.ts`, `schedules/schedule.ts`, `apps/web/modules/booking/seed.ts`, `packages/db/src/seed/booking.ts` (rules, demo templates: four day blocks Tue-Sun 09:00/11:30/14:00/16:30 120 min 12 seats; night Fri-Sat 21:00 720 min 6 beds; retention policy rows), `apps/web/modules/booking/ui/{calendar-week,day-view,template-form,exception-form,rules-form,hold-form}.tsx`, pages `app/(admin)/admin/sessions/{page,loading,error}.tsx`, `sessions/day/[date]/page.tsx`, `sessions/new/page.tsx`, `sessions/templates/page.tsx`, `sessions/templates/[id]/page.tsx`, `sessions/exceptions/page.tsx`, `sessions/rules/page.tsx`, `sessions/holds/page.tsx`.
- **Interfaces:** actions `createTemplates`, `updateTemplate`, `setTemplateActive`, `upsertException`, `deleteException`, `updateBookingRules`, `createSession`, `updateSession`, `publishSession`, `setSessionOpen`, `upsertHold`, `deleteHold`; jobs `sessions.materialise`, `sessions.regenerate_template`, `sessions.regenerate_date`; internal `materialiseRange(tx, fromOn, toOn)`.
- **Depends on:** booking-P1; `platform:getSetting`, `platform:updateSetting`; `crm:companies` (hold FK).
- **Tests:** `actions/templates.test.ts` (permission denied without `settings.write`; activation blocked on incomplete name; edit bumps version and enqueues regeneration with the right key); `jobs/schedule.test.ts` (materialise creates the expected count for 90 days; double run identical; regeneration updates free sessions, keeps booked and manual ones, removes unmatched free ones; closed day removes free sessions and reports booked ones as conflicts); `actions/sessions.test.ts` (capacity below bookings refused; publish requires complete title; holds cannot drop below their bookings); `permissions.test.ts` part for these actions.
- **Done:** standard; seeded `beam_dev` shows 90 days of sessions in `/admin/sessions`.

### booking-P3 (V1): booking engine, payments, cancellation, reschedule, guests, emails

- **Goal:** book, pay (credit, order, guest, free), cancel, reschedule and add guests correctly from any channel; cross-module API.
- **Files:** `apps/web/modules/booking/server/{book,cancel,reschedule,guests,order-hooks,qr,facts}.ts` (internal service used by actions, api and later packages), `actions/bookings.ts` (incl. `cancelSession`), `queries/bookings.ts` (staff and portal booking queries of 4.3), `api/bookings.ts` (every function of 4.8 except `listGuestAbuseCandidates` and `linkWebinarSession`), `jobs/bookings.ts` (`bookings.expire_reservations`, `bookings.send_reminders`), `schedules/bookings.ts`, `packages/email/src/templates/booking/{booking-confirmed,booking-cancelled,booking-late-cancelled,booking-rescheduled,booking-reminder,session-cancelled,guest-invited}.tsx`.
- **Interfaces:** `bookSeats(tx, ctx, input: BookSeatsInput): Promise<BookResult>`, `cancelBookingRow(tx, ctx, input: { bookingId; expectedVersion; includeGuests; by: 'customer'|'staff'|'beam'; force? }): Promise<CancelResult>`, `rescheduleRow(...)`, `addGuestRow(...)`, `renderCheckinQr(tx, booking): Promise<string /* file id */>`, `recordBookingFact(ctx, kind, booking, extra)`; the api functions of 4.8.
- **Depends on:** booking-P1; `credits:consumeCredits`, `credits:releaseCredits`, `credits:v_person_credits`; `commerce:createOrder`, `commerce:quote`, `commerce:refundOrderLine`; `crm:getPersonStatus`, `crm:findOrCreatePersonByEmail`, `crm:createPerson`; `email:sendTransactional`; `platform:storeFile`. Callers' stubs are mocked in unit tests where the owner has not landed them.
- **Tests:** `server/book.test.ts` (credit booking writes one consume per grant split and confirms; insufficient credits rolls back; order booking reserves and creates an order with `session_id` lines; free refused for customers; member-only; duplicate person refused; concurrent last seat: two parallel transactions on PGlite, one `session_full`; over-capacity only with override; night shared bed uses 0 units); `server/cancel.test.ts` (inside window releases credits and requests refund; late keeps credit; event never free; guests cascade; session cancellation cancels all and releases waitlist; frees capacity enqueues `waitlist.offer_next`); `server/reschedule.test.ts` (window, kind, product, chain limit, credit release and consume keys); `server/order-hooks.test.ts` (confirm twice is idempotent; confirm after expiry re-books or returns unavailable line; release on expiry); `jobs/bookings.test.ts` (double run; reminders respect late-entry skip and keys); `api/bookings.test.ts` (`hasFutureBooking`, `getPersonBookingSummary`, `importHistoricalBooking` idempotent on `external_ref`); `permissions.test.ts` part; email templates render in three locales with fixture data.
- **Done:** standard; the architecture's tonight path (buy package, book with credit, cancel inside rules, credit back) passes in `server/book.test.ts` against fakes.

### booking-P4 (V1): attendance, check-in, no-shows and staff booking screens

- **Goal:** reception checks people in by QR or name; no-shows are marked; staff manage bookings.
- **Files:** `actions/attendance.ts`, `queries/attendance.ts`, `jobs/attendance.ts` (`bookings.mark_no_shows`), `schedules/attendance.ts`, `apps/web/modules/booking/ui/{attendee-list,checkin-desk,manual-booking-wizard,booking-card,cancel-dialog}.tsx`, pages `app/(admin)/admin/sessions/[id]/page.tsx`, `app/(admin)/admin/bookings/{page,loading,error}.tsx`, `bookings/new/page.tsx`, `bookings/[id]/page.tsx`, `bookings/checkin/page.tsx`.
- **Interfaces:** actions `checkIn`, `undoCheckIn`, `markNoShow`, `revertNoShow`, `updateBookingNotes`; query `searchCheckin`; job `bookings.mark_no_shows`.
- **Depends on:** booking-P3 (service and booking actions used by the screens); `crm:searchPersons`.
- **Tests:** `actions/attendance.test.ts` (check-in window, wrong day, by code and by id, undo until end + 2 h, revert no-show within 7 days, `booking.attended` event once with `is_first`); `jobs/attendance.test.ts` (marks only ended confirmed rows, respects `autoMark = false`, keeps credits, double run); `queries/attendance.test.ts` (name search limited to the day); `e2e/booking.spec.ts` section "reception check-in" (scan code URL, mark attended).
- **Done:** standard; reception flow demoable on seeded data.

### booking-P5 (V1): waitlist, offers and claim links

- **Goal:** waiting list with the full state machine, real expiring single-use links, duplicate protection, protected confirmed seats (scenario 4, V1 acceptance tests).
- **Files:** `actions/waitlist.ts`, `queries/waitlist.ts`, `jobs/waitlist.ts` (`waitlist.expire_offers`, `waitlist.offer_next`), `schedules/waitlist.ts`, `api/waitlist.ts` (`claimSeat` service), `app/api/public/claim/[token]/route.ts`, `app/[locale]/(site)/claim/[token]/page.tsx`, `app/(admin)/admin/waitlist/page.tsx`, `app/[locale]/(portal)/account/waitlist/page.tsx`, `apps/web/modules/booking/ui/{waitlist-table,offer-countdown}.tsx`, `packages/email/src/templates/booking/{waitlist-joined,seat-offered,seat-claimed,offer-expired}.tsx`, `e2e/scenario-4-seat-claim.spec.ts`.
- **Interfaces:** actions of 4.2 for waitlist; `claimSeat(tx, ctx, { token, payWith? }): Promise<{ bookingId } | { orderId, redirectTo }>`; jobs of 4.5.
- **Depends on:** booking-P3 (`bookSeats`); `crm:getPersonStatus`; `email:sendTransactional`.
- **Tests:** `jobs/waitlist.test.ts` (offer to first eligible; expiry after claim window passes to next; cut-off before start; release at start; flagged skipped; double run; confirmed entries untouched by every job); `actions/waitlist.test.ts` (join only when full; same person cannot join twice or hold a seat and an entry; secondary address flagged; staff actions audited; `protected_seat` on confirmed); `api/claim.test.ts` (GET does not change state; POST claims once; second POST returns same booking; expired and superseded token refused; claim with payment keeps seat until reservation ends); `e2e/scenario-4-seat-claim.spec.ts` (session full, A waits, B cancels, A is offered, link expires with a fake clock, B2 gets the offer and claims, A's old link shows expired, confirmed seat survives a forced `waitlist.expire_offers` run).
- **Done:** standard plus scenario 4 green against `beam_dev`.

### booking-P6 (V1): customer portal booking pages, privacy and V1 acceptance

- **Goal:** customers book, see, cancel, reschedule, invite guests and see waitlist status; GDPR export and erase for this module.
- **Files:** pages `app/[locale]/(portal)/account/book/page.tsx`, `book/[sessionId]/page.tsx`, `bookings/page.tsx`, `bookings/[id]/page.tsx`, `bookings/[id]/reschedule/page.tsx` (each with `loading.tsx` and `error.tsx`), `apps/web/modules/booking/ui/portal/{session-list,book-form,guest-fields,policy-note,qr-card}.tsx`, `apps/web/modules/booking/privacy.ts`, `apps/web/modules/booking/privacy.test.ts`, `packages/core/src/i18n/messages/{en,nl-BE,fr-BE}/booking.json` (sequential after P1; adds keys found missing in P2-P5), `e2e/booking.spec.ts` (sequential after P4).
- **Interfaces:** `bookingPrivacy` (section 9).
- **Depends on:** booking-P3, booking-P4 (owns `e2e/booking.spec.ts` first), booking-P5; `commerce:/[locale]/account/checkout/[orderId]` page; `credits:v_person_credits`.
- **Tests:** `privacy.test.ts` (export lists bookings as attendee, booker and guest-of; erase deletes waitlist entries, anonymises bookings, cancels future ones, leaves no `person_id`-linked free text; report rows); `e2e/booking.spec.ts` (register by magic link, buy package with fake Mollie, book day session with a credit, see "x sessions remaining", cancel inside rules, credit back, timeline shows both; book a night with a shared-bed guest; reschedule; member-only refused for a lead); acceptance items "customer can book, pay and cancel", "administrator can change a booking", "the same person cannot take a second seat", "claim window expires", "confirmed seat is protected" referenced from `e2e/acceptance-v1.spec.ts` (owned by the Wave 2 seam package).
- **Done:** standard plus `e2e/booking.spec.ts` green against `beam_dev`.

### booking-P7 (R2): Lead Magnet access engine

- **Goal:** scenario 3 and the R2 lead-priority acceptance tests behind `ff_booking_lead_priority`.
- **Files:** `actions/lead.ts`, `server/book.ts` (sequential after P3: lead-seat path, R21-R23), `jobs/waitlist.ts` (sequential after P5: window-end release, reclassification, phase ordering), `actions/waitlist.ts` (sequential after P5: queue choice at join), `apps/web/modules/booking/ui/lead-magnet-form.tsx`, `app/(admin)/admin/sessions/[id]/page.tsx` (sequential after P4: lead tab), `apps/web/modules/booking/ui/portal/book-form.tsx` and `session-list.tsx` (sequential after P6: "Opens for you on ..." and customer queue button), `booking.json` x3 (sequential after P6), `e2e/scenario-3-lead-access.spec.ts`.
- **Interfaces:** `configureLeadMagnet`; `availabilityFor(tx, sessionId, personId)` returning the phase-aware `Availability`.
- **Depends on:** booking-P6; `crm:getPersonStatus` honouring `status_override`; `commerce:payments.sync` turning a lead into a customer.
- **Tests:** `actions/lead.test.ts` (percentage rounding, Brussels wall-clock to UTC across DST, validation); `server/lead-book.test.ts` (lead books reserved seat, customer refused reserved seat but sees opening time, lead guests need general seats, duplicate signal refuses lead seat with `needs_review`); `jobs/lead-release.test.ts` (window end offers to customer queue then public at `opens_for_public_at`; `public` and `keep_for_leads` rules; waiting lead who buys moves to customer queue keeping `joined_at`; offered lead keeps offer; confirmed lead stays confirmed); `e2e/scenario-3-lead-access.spec.ts`.
- **Done:** standard plus scenario 3 green.

### booking-P8 (R2): ticketing extensions, post-event follow-up, report data, guest controls

- **Goal:** multiple ticket types with member pricing, per-type capacity and sales windows; guest information; `booking.event_ended`; `v_booking_outcomes`; guest abuse list.
- **Files:** `actions/tickets.ts`, `packages/db/src/schema/booking.views.ts` (sequential after P1: add `v_ticket_type_availability`, `v_booking_outcomes`), `server/book.ts` (sequential after P7: ticket type checks), `jobs/attendance.ts` (sequential after P4: `booking.event_ended`), `api/bookings.ts` (sequential after P3: `listGuestAbuseCandidates`, `linkWebinarSession`), `apps/web/modules/booking/ui/ticket-types-form.tsx`, `app/(admin)/admin/sessions/[id]/page.tsx` (sequential after P7: ticket tab), `ui/portal/book-form.tsx` (sequential after P7: type picker, guest details), `booking.json` x3 (sequential after P7).
- **Depends on:** booking-P7; `commerce:products` of kind `ticket` with member `price_versions`; `commerce:refunds` (view).
- **Tests:** `actions/tickets.test.ts` (publish blocked by incomplete names; sales window; member-only type; per-type capacity under the session lock; `max_per_booking`); `views/outcomes.test.ts` (credit units kept for late cancel and no-show, zero after release; revenue kept after partial refund); `jobs/event-ended.test.ts` (one event per booking, dedupe, attended flag); `api/guest-abuse.test.ts`.
- **Done:** standard.

### booking-P9 (R3, R4): partner holds and reporting catalogue

- **Goal:** external partners fill their own holds (R3); booking views described for NL questions and custom dashboards (R4).
- **Files:** `actions/partner.ts`, `queries/partner.ts`, `api/partner.ts`, `app/(admin)/admin/sessions/holds/page.tsx` (sequential after P2: partner-scoped mode), `packages/core/src/booking/ai-catalog.ts` (column descriptions of `v_session_utilisation` and `v_booking_outcomes`, no person columns beyond ids), `booking.json` x3 (sequential after P8).
- **Interfaces:** `assignHoldSeat`, `unassignHoldSeat`, `listMyPartnerHolds`; `BOOKING_AI_VIEWS: Array<{ view: string; columns: Record<string, string> }>`.
- **Depends on:** booking-P8; `crm:persons.partner_company_id`; `ops` R4 consumes `BOOKING_AI_VIEWS`.
- **Tests:** `actions/partner.test.ts` (partner sees and fills only own company holds, cannot see other attendees, cannot exceed hold quantity; staff can do all); `ai-catalog.test.ts` (no `SENSITIVE_COLUMNS` member, no email or phone column).
- **Done:** standard.

## 13. Decisions made

Additions to the architecture (tables, columns, enums, views, jobs, schedules, files):

1. New table `session_exceptions` with enum `session_exceptions_kind (closed, holiday, special_hours)` for closed days, holidays and exceptional opening hours (blueprint 9); extra opening slots are one-off sessions.
2. `session_templates` additions: `description`, `location`, `version`, `created_by_user_id`. One template per start time; the admin form creates several templates at once. The architecture's single `start_time` stays.
3. `sessions` additions: `template_version`, `description`, `product_id`, `published_at`, `has_manual_changes`, `lead_release_rule` (enum `customers_then_public | public | keep_for_leads`), `public_release_at`, `is_waitlist_position_visible`, `cancelled_at`, `cancel_reason`; partial unique `(template_id, starts_at)`. `webinar_id` is a plain uuid without FK to avoid a schema import cycle with `webinar.ts`.
4. `capacity_holds` addition: `created_by_user_id`; bookings may fill a hold through the new `bookings.capacity_hold_id`.
5. `ticket_types` additions: `name`, `max_per_booking` (default 4), `requires_guest_details`, `sort_order`, `is_active`.
6. `bookings` additions: `capacity_units` (0 = shared bed), `capacity_hold_id`, `used_lead_seat`, `is_over_capacity`, `booked_by_person_id`, `external_ref` (import idempotency), `rescheduled_from_booking_id`, `checkin_code`, `qr_file_id`, `reminder_sent_at`, `cancel_reason_code` (enum `bookings_cancel_reason_code`), `no_show_marked_at`, `notes`.
7. `waitlist_entries` additions: `offers_count`, `flag_reviewed_by_user_id`, `flag_reviewed_at`, `email_normalised`, `join_ip_hash`, `ended_reason`.
8. Views added: `v_session_utilisation` (V1 capacity utilisation data), `v_booking_outcomes` and `v_ticket_type_availability` (R2). `v_session_availability` also exposes `lead_phase`, `opens_for_public_at`, `available_general`, `lead_reserved_remaining`, `waiting`.
9. Job kinds added: `sessions.regenerate_template`, `sessions.regenerate_date`, `bookings.expire_reservations`, `bookings.send_reminders`, `waitlist.offer_next`. Schedules added: `bookings.expire_reservations` every minute, `bookings.mark_no_shows` and `bookings.send_reminders` every 15 minutes. The architecture's names `sessions.materialise`, `waitlist.expire_offers`, `bookings.mark_no_shows` are kept although they do not start with `booking.`.
10. Event kinds all start with `booking.` (including waitlist facts such as `booking.seat_offered`) to follow the `<module>.<past_tense>` convention.
11. The `settings.booking_rules` shape is defined here (section 3.0) with the architecture's defaults: day 24 h, night 72 h, events never free, late cancel keeps the credit, no-show marked 2 h after the end and keeps the credit.
12. Module file layout: `actions.ts`, `queries.ts`, `jobs.ts`, `api.ts`, `schedules.ts` are barrels over area files so that several booking packages can run in parallel without editing the same file. Internal service code lives in `apps/web/modules/booking/server/`.
13. Flags registry by convention: `apps/web/modules/booking/flags.ts` exports `ff_booking_lead_priority` and `ff_booking_ticket_types`, collected by `pnpm gen:indexes` like the other per-module registries.
14. This module owns the public claim page `app/[locale]/(site)/claim/[token]/page.tsx` in addition to the architecture's route list, the way forms owns `(site)/f/[slug]`.
15. The check-in desk lives at `/admin/bookings/checkin` (inside the architecture's `bookings` admin folder); holds, rules, templates and exceptions live under `/admin/sessions/`.
16. Wave 0 dependency request: `qrcode@1.5.4` and `@types/qrcode@1.5.5` (QR PNG and SVG rendering, local, no network). Listed here for the orchestrator to add to Wave 0's dependency install; booking-P3 must not add it itself.

Behaviour decisions the inputs left open:

17. Every booking needs a logged-in customer (magic link proves the email) or a staff user; there is no anonymous booking. The public site links into the portal.
18. Credits are per person, beds are capacity only: a guest sharing the owner's bed uses 0 beds but pays `credit_cost` (R13).
19. A within-window cancellation of an order-paid booking is refunded in money through `commerce.refundOrderLine`; a late cancellation is not refunded. BEAM cancelling a session refunds everything, events included.
20. Reschedule is cancel plus new booking in one transaction, limited to the free window, same kind, same credit kind and same product for customers; at most 2 reschedules per chain.
21. Reservations for unpaid orders last 30 minutes, matching `payments.scan_expired`.
22. Check-in window: 2 h before start until 2 h after end; undo until 2 h after end; no-show correction to attended within 7 days.
23. Reminders are transactional emails sent by this module (one per configured offset: day 24 h, night 48 h, events 7 days and 24 h), with the late-entry skip; preparation and marketing follow-ups stay in automation.
24. Claim tokens are derived (HMAC of entry id and offer count with an HKDF key from `AUTH_SECRET`), never stored in plain text in booking tables; the plain link lives only inside the email job payload until jobs are pruned, which is acceptable because an offer is valid for at most 48 hours.
25. Claim GET never changes state; claiming is a POST from the claim page. A forwarded link books only for the entry's person.
26. Waitlist entries are one seat each; a person rejoins an ended entry once. Offers stop 60 minutes before start and are never shorter than 15 minutes. One person gets at most 2 offers per session.
27. Non-Lead-Magnet sessions use a single `public` queue. Lead Magnet phases are `pre`, `lead`, `customer_release`, `public`; after public release the order is customer, lead, public queue.
28. Lead seats are only for the lead themself; guests of a lead need general seats. Suspicious duplicates are flagged and receive no offers until staff review; the platform never merges people automatically.
29. Events are created and configured with `bookings.override` (owner, management, technical_admin); no new permission string. Templates, exceptions and booking rules use `settings.write`.
30. V1 events have one price through `sessions.product_id`; multiple ticket types are R2. The `ticket_types` table exists from V1 so the schema does not change in R2.
31. Guest bookings and the `guest-invited` email are V1 (blueprint 7 lists them in day sessions); the R2 "controls" are the visible remaining guest uses and the abuse review list.
32. Exact remaining places are shown to customers only when 5 or fewer; otherwise "available".
33. Bookings are anonymised, not deleted, on erasure (capacity history and ledger references); waitlist entries are deleted (and in any case 1 year after the session); booking free text is cleared after 3 years.
34. No room, staff or equipment assignment (proposal question 3): only seats and beds.
35. Regeneration never touches a session that has any booking, waitlist entry, hold or manual change; templates and exceptions never cancel booked sessions by themselves.
36. If payment completes after the seat was lost, the platform refunds automatically rather than overbooking.
