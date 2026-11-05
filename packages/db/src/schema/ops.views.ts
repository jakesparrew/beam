/**
 * ops views (ops spec 2.4, V1). Each view is `pgView(name, columns).existing()` with its SQL
 * exported beside it as `<name>Sql`; `pnpm db:views` writes the migration and `createTestDb()`
 * applies the same SQL (DM-1). ops-P2 wrote the V1 views; ops-P7 added the R2 webinar columns of
 * `v_person_profile` from webinar's `v_person_webinar_stats` (imported counts included, so the V1
 * `imported_webinars_*` columns keep their place and now follow merges like webinar's view).
 *
 * Thresholds come from `settings.retention_defaults`: each view reads it once through the
 * `c` cross join below, merged over the seeded defaults so a missing row or a partial value
 * still yields every key.
 *
 * `v_person_profile` is the only view the segment compiler targets: no `email`, `phone`, name,
 * birth date or `SENSITIVE_COLUMNS` member, and no erased, merged or restricted person.
 */
import { boolean, date, integer, jsonb, numeric, pgView, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { RETENTION_DEFAULTS, type RetentionReason } from "@beam/core/ops";
import { bookingsCancelReasonCode, bookingsPaidWith, bookingsStatus, sessionsKind } from "./booking";
import { checkoutsAbandonedReason, checkoutsStatus, ordersChannel } from "./commerce";
import { personStatsB2cStage } from "./ops";

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** `settings.retention_defaults` over the seeded defaults (one jsonb `cfg`). */
const CFG = `cross join (select '${JSON.stringify(RETENTION_DEFAULTS)}'::jsonb
    || coalesce((select s.value from settings s where s.key = 'retention_defaults' and jsonb_typeof(s.value) = 'object'), '{}'::jsonb) as cfg) c`;

const cfgInt = (key: keyof typeof RETENTION_DEFAULTS) => `(c.cfg->>'${key}')::int`;
const cfgNum = (key: keyof typeof RETENTION_DEFAULTS) => `(c.cfg->>'${key}')::numeric`;
const cfgDays = (key: keyof typeof RETENTION_DEFAULTS) => `make_interval(days => ${cfgInt(key)})`;

// ---------------------------------------------------------------------------
// v_person_profile
// ---------------------------------------------------------------------------

export const vPersonProfileSql = `select p.id as person_id, p.locale, p.created_at, p.is_tester, p.partner_company_id,
       p.acquisition->>'source' as acquisition_source,
       p.acquisition->>'campaign' as acquisition_campaign,
       p.acquisition->>'medium' as acquisition_medium,
       p.address->>'postal_code' as postal_code, p.address->>'city' as city, p.address->>'country' as country,
       coalesce(st.status, 'lead') as status,
       coalesce(st.is_member, false) as is_member,
       coalesce(tg.keys, '{}'::text[]) as tags,
       coalesce(ps.revenue_cents, 0) as revenue_cents,
       coalesce(ps.purchases, 0) as purchases,
       coalesce(ps.visits, 0) as visits,
       coalesce(ps.events_attended, 0) as events_attended,
       coalesce(ps.no_shows, 0) as no_shows,
       coalesce(ps.avg_order_cents, 0) as avg_order_cents,
       ps.first_purchase_at, ps.last_purchase_at, ps.first_visit_at, ps.last_visit_at, ps.last_activity_at,
       nb.next_booking_at,
       (nb.next_booking_at is not null) as has_future_booking,
       coalesce(ps.b2c_stage, 'lead') as b2c_stage,
       case when ps.last_activity_at is null then null
            else greatest(0, floor(extract(epoch from (now() - ps.last_activity_at)) / 86400))::int end as days_since_activity,
       coalesce(ps.revenue_cents, 0) as lifetime_value_cents,
       (coalesce(ps.revenue_cents, 0) >= ${cfgInt("high_value_revenue_cents")}
          or coalesce(c.cfg->>'vip_tag_key' = any(tg.keys), false)) as is_high_value,
       coalesce(cr.day_remaining, 0) as credits_day_remaining,
       coalesce(cr.night_remaining, 0) as credits_night_remaining,
       coalesce(cr.euro_remaining, 0) as credits_euro_remaining,
       cr.next_expires_at as next_grant_expires_at,
       coalesce((select array_agg(distinct x order by x) from v_person_credits vc cross join lateral unnest(vc.product_ids) x
                 where vc.person_id = p.id and x is not null), '{}'::uuid[]) as package_product_ids,
       ms.status::text as membership_status,
       ms.current_period_end_at as membership_period_end_at,
       coalesce(cs.newsletter, false) as consent_newsletter,
       coalesce(cs.events, false) as consent_events,
       coalesce(cs.member_comms, false) as consent_member_comms,
       coalesce(cs.b2b, false) as consent_b2b,
       exists (select 1 from suppressions su where su.email_hash = p.email_hash and su.scope = 'all') as is_suppressed_all,
       exists (select 1 from company_contacts cc where cc.person_id = p.id and cc.ended_on is null) as is_company_contact,
       exists (select 1 from waitlist_entries w where w.person_id = p.id and w.state in ('waiting', 'offered')) as has_waitlist_waiting,
       la.slug as last_assessment_form_slug,
       la.outcome_key as last_assessment_outcome_key,
       coalesce(ws.imported_webinars_registered, 0) as imported_webinars_registered,
       coalesce(ws.imported_webinars_attended, 0) as imported_webinars_attended,
       coalesce(ws.webinars_registered, 0) as webinars_registered,
       coalesce(ws.webinars_attended_live, 0) as webinars_attended_live,
       ws.last_webinar_attended_at,
       coalesce(ws.replays_watched, 0) as webinars_watched_replay,
       coalesce(ws.on_demand_watched, 0) as webinars_watched_on_demand,
       coalesce(ws.poll_answers, 0) as webinar_poll_answers,
       coalesce(ws.cta_clicks, 0) as webinar_cta_clicks,
       (coalesce(ws.webinars_registered, 0) + coalesce(ws.imported_webinars_registered, 0))::int as webinars_registered_total,
       (coalesce(ws.webinars_attended_live, 0) + coalesce(ws.imported_webinars_attended, 0))::int as webinars_attended_total,
       case when exists (select 1 from dpia_records d where d.key = 'watch_time_profiling' and d.status in ('approved', 'not_required'))
            then coalesce(ws.watch_sec_total, 0) end as watch_sec_total
from persons p
${CFG}
left join v_person_status st on st.person_id = p.id
left join person_stats ps on ps.person_id = p.id
left join lateral (select array_agg(t.key order by t.key) as keys from person_tags pt join tags t on t.id = pt.tag_id
                   where pt.person_id = p.id) tg on true
left join lateral (select min(s.starts_at) as next_booking_at from bookings b join sessions s on s.id = b.session_id
                   where b.person_id = p.id and b.status in ('reserved', 'confirmed') and s.starts_at > now()) nb on true
left join lateral (select sum(vc.remaining_units) filter (where vc.credit_kind = 'day')::int as day_remaining,
                          sum(vc.remaining_units) filter (where vc.credit_kind = 'night')::int as night_remaining,
                          sum(vc.remaining_units) filter (where vc.credit_kind = 'euro')::int as euro_remaining,
                          min(vc.next_expires_at) as next_expires_at
                   from v_person_credits vc where vc.person_id = p.id) cr on true
left join lateral (select m.status, m.current_period_end_at from memberships m where m.person_id = p.id
                   order by m.started_at desc, m.created_at desc, m.id desc limit 1) ms on true
left join lateral (select bool_or(cc.status = 'granted') filter (where cc.purpose = 'newsletter') as newsletter,
                          bool_or(cc.status = 'granted') filter (where cc.purpose = 'events') as events,
                          bool_or(cc.status = 'granted') filter (where cc.purpose = 'member_comms') as member_comms,
                          bool_or(cc.status = 'granted') filter (where cc.purpose = 'b2b') as b2b
                   from v_consent_current cc where cc.person_id = p.id) cs on true
left join lateral (select f.slug, fs.outcome_key from form_submissions fs join forms f on f.id = fs.form_id
                   where fs.person_id = p.id and fs.status = 'completed' and f.kind = 'assessment'
                   order by fs.completed_at desc nulls last, fs.id desc limit 1) la on true
left join v_person_webinar_stats ws on ws.person_id = p.id
where p.erased_at is null and p.merged_into_person_id is null and p.processing_restricted_at is null`;

export const vPersonProfile = pgView("v_person_profile", {
  personId: uuid("person_id").notNull(),
  locale: text("locale").$type<"nl-BE" | "fr-BE" | "en">().notNull(),
  createdAt: tz("created_at").notNull(),
  isTester: boolean("is_tester").notNull(),
  partnerCompanyId: uuid("partner_company_id"),
  acquisitionSource: text("acquisition_source"),
  acquisitionCampaign: text("acquisition_campaign"),
  acquisitionMedium: text("acquisition_medium"),
  postalCode: text("postal_code"),
  city: text("city"),
  country: text("country"),
  status: text("status").$type<"lead" | "customer" | "member">().notNull(),
  isMember: boolean("is_member").notNull(),
  tags: text("tags").array().notNull(),
  revenueCents: integer("revenue_cents").notNull(),
  purchases: integer("purchases").notNull(),
  visits: integer("visits").notNull(),
  eventsAttended: integer("events_attended").notNull(),
  noShows: integer("no_shows").notNull(),
  avgOrderCents: integer("avg_order_cents").notNull(),
  firstPurchaseAt: tz("first_purchase_at"),
  lastPurchaseAt: tz("last_purchase_at"),
  firstVisitAt: tz("first_visit_at"),
  lastVisitAt: tz("last_visit_at"),
  lastActivityAt: tz("last_activity_at"),
  nextBookingAt: tz("next_booking_at"),
  hasFutureBooking: boolean("has_future_booking").notNull(),
  b2cStage: personStatsB2cStage("b2c_stage").notNull(),
  daysSinceActivity: integer("days_since_activity"),
  lifetimeValueCents: integer("lifetime_value_cents").notNull(),
  isHighValue: boolean("is_high_value").notNull(),
  creditsDayRemaining: integer("credits_day_remaining").notNull(),
  creditsNightRemaining: integer("credits_night_remaining").notNull(),
  creditsEuroRemaining: integer("credits_euro_remaining").notNull(),
  nextGrantExpiresAt: tz("next_grant_expires_at"),
  packageProductIds: uuid("package_product_ids").array().notNull(),
  membershipStatus: text("membership_status"),
  membershipPeriodEndAt: tz("membership_period_end_at"),
  consentNewsletter: boolean("consent_newsletter").notNull(),
  consentEvents: boolean("consent_events").notNull(),
  consentMemberComms: boolean("consent_member_comms").notNull(),
  consentB2b: boolean("consent_b2b").notNull(),
  isSuppressedAll: boolean("is_suppressed_all").notNull(),
  isCompanyContact: boolean("is_company_contact").notNull(),
  hasWaitlistWaiting: boolean("has_waitlist_waiting").notNull(),
  lastAssessmentFormSlug: text("last_assessment_form_slug"),
  lastAssessmentOutcomeKey: text("last_assessment_outcome_key"),
  importedWebinarsRegistered: integer("imported_webinars_registered").notNull(),
  importedWebinarsAttended: integer("imported_webinars_attended").notNull(),
  // R2 (ops-P7): webinar's `v_person_webinar_stats`; native counts exclude imported history (decision 58).
  webinarsRegistered: integer("webinars_registered").notNull(),
  webinarsAttendedLive: integer("webinars_attended_live").notNull(),
  lastWebinarAttendedAt: tz("last_webinar_attended_at"),
  webinarsWatchedReplay: integer("webinars_watched_replay").notNull(),
  webinarsWatchedOnDemand: integer("webinars_watched_on_demand").notNull(),
  webinarPollAnswers: integer("webinar_poll_answers").notNull(),
  webinarCtaClicks: integer("webinar_cta_clicks").notNull(),
  webinarsRegisteredTotal: integer("webinars_registered_total").notNull(),
  webinarsAttendedTotal: integer("webinars_attended_total").notNull(),
  /** Null unless `dpia_records.watch_time_profiling` is `approved` or `not_required` (rule 70). */
  watchSecTotal: integer("watch_sec_total"),
}).existing();

// ---------------------------------------------------------------------------
// v_retention_candidates (eight rule blocks)
// ---------------------------------------------------------------------------

const VALUE = `least(30, pp.revenue_cents / 20000)`;
const INACTIVE_URGENCY = `least(20, coalesce(pp.days_since_activity, 0) / 10)`;
const daysUntil = (col: string) => `floor(extract(epoch from (${col} - now())) / 86400)::int`;
const grantDetail = `jsonb_build_object('grant_id', b.grant_id, 'remaining', b.remaining_units, 'units_granted', b.base_units,
         'expires_at', b.expires_at, 'product_name', coalesce(pr.name->>pp.locale::text, pr.name->>'en'))`;

export const vRetentionCandidatesSql = `with pp as (select * from v_person_profile where is_tester = false)
select pp.person_id, 'visiting_less'::text as reason,
       (30 + ${VALUE} + ${INACTIVE_URGENCY})::int as score, 'person'::text as ref_type, pp.person_id as ref_id,
       jsonb_build_object('visits_last_60d', ps.visits_last_60d, 'visits_prev_180d', ps.visits_prev_180d,
         'days_since_activity', pp.days_since_activity) as detail
from pp join person_stats ps on ps.person_id = pp.person_id ${CFG}
where ps.visits_prev_180d >= ${cfgInt("baseline_min_visits")}
  and ps.visits_last_60d / 60.0 < ${cfgNum("visit_drop_ratio")} * ps.visits_prev_180d / 180.0
  and not pp.has_future_booking
union all
select pp.person_id, 'package_nearly_finished', (35 + ${VALUE})::int, 'grant', b.grant_id, ${grantDetail}
from pp join v_credit_grant_balances b on b.person_id = pp.person_id left join products pr on pr.id = b.product_id ${CFG}
where b.status = 'active' and b.base_units > 0 and b.remaining_units >= 1
  and (b.base_units - b.remaining_units) * 100 / b.base_units >= ${cfgInt("nearly_finished_pct")}
union all
select pp.person_id, 'package_finished_no_repurchase', (40 + ${VALUE})::int, 'grant', b.grant_id, ${grantDetail}
from pp join v_credit_grant_balances b on b.person_id = pp.person_id left join products pr on pr.id = b.product_id ${CFG}
where b.status = 'exhausted' and b.last_used_at is not null
  and b.last_used_at <= now() - ${cfgDays("finished_no_repurchase_min_days")}
  and b.last_used_at >= now() - ${cfgDays("finished_no_repurchase_max_days")}
  and not exists (select 1 from credit_grants g2 where g2.person_id = b.person_id and g2.credit_kind = b.credit_kind
                  and g2.id <> b.grant_id and g2.created_at > b.last_used_at)
  and not exists (select 1 from memberships m where m.person_id = pp.person_id and m.status in ('active', 'past_due'))
union all
select pp.person_id, 'package_expiring', (45 + ${VALUE} + greatest(0, 20 - ${daysUntil("b.expires_at")}))::int, 'grant', b.grant_id, ${grantDetail}
from pp join v_credit_grant_balances b on b.person_id = pp.person_id left join products pr on pr.id = b.product_id ${CFG}
where b.status = 'active' and b.remaining_units > 0 and b.expires_at is not null
  and b.expires_at > now() and b.expires_at <= now() + ${cfgDays("expiry_days")}
union all
select pp.person_id, 'high_value_inactive', (50 + ${VALUE} + ${INACTIVE_URGENCY})::int, 'person', pp.person_id,
       jsonb_build_object('visits_last_60d', coalesce(ps.visits_last_60d, 0), 'visits_prev_180d', coalesce(ps.visits_prev_180d, 0),
         'days_since_activity', pp.days_since_activity)
from pp left join person_stats ps on ps.person_id = pp.person_id ${CFG}
where pp.is_high_value and pp.days_since_activity >= ${cfgInt("high_value_inactive_days")} and not pp.has_future_booking
union all
select pp.person_id, 'membership_renewal_due',
       (40 + ${VALUE} + greatest(0, 20 - ${daysUntil("m.current_period_end_at")}) + case when m.cancel_at is not null then 10 else 0 end)::int,
       'membership', m.id,
       jsonb_build_object('membership_id', m.id, 'period_end_at', m.current_period_end_at, 'cancel_at', m.cancel_at)
from pp join memberships m on m.person_id = pp.person_id ${CFG}
where m.status in ('active', 'past_due') and m.current_period_end_at <= now() + ${cfgDays("renewal_days")}
union all
select pp.person_id, 'purchased_never_booked', (30 + ${VALUE})::int, 'grant', b.grant_id, ${grantDetail}
from pp join v_credit_grant_balances b on b.person_id = pp.person_id join credit_grants g on g.id = b.grant_id
left join products pr on pr.id = b.product_id ${CFG}
where b.source = 'purchase' and g.created_at < now() - ${cfgDays("never_booked_days")}
  and not exists (select 1 from bookings bk where bk.person_id = pp.person_id)
union all
select pp.person_id, 'unused_sessions', (25 + ${VALUE} + ${INACTIVE_URGENCY})::int, 'grant', b.grant_id, ${grantDetail}
from pp join v_credit_grant_balances b on b.person_id = pp.person_id join credit_grants g on g.id = b.grant_id
left join products pr on pr.id = b.product_id ${CFG}
where b.status = 'active' and b.remaining_units > 0 and not pp.has_future_booking
  and g.created_at < now() - ${cfgDays("unused_days")}
  and not exists (select 1 from credit_entries e where e.grant_id = b.grant_id and e.kind = 'consume'
                  and e.created_at >= now() - ${cfgDays("unused_days")})`;

export const vRetentionCandidates = pgView("v_retention_candidates", {
  personId: uuid("person_id").notNull(),
  reason: text("reason").$type<RetentionReason>().notNull(),
  score: integer("score").notNull(),
  refType: text("ref_type").$type<"person" | "grant" | "membership">().notNull(),
  refId: uuid("ref_id").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
}).existing();

// ---------------------------------------------------------------------------
// v_revenue_daily
// ---------------------------------------------------------------------------

/**
 * Sales per Brussels day, channel and product kind, plus one `refund` row per day and channel.
 * Credit-note VAT is stored negative by finance and negated here, so `refunds_vat_cents` is
 * positive. Company orders count; tester persons' orders do not.
 */
export const vRevenueDailySql = `select (o.paid_at at time zone 'Europe/Brussels')::date as day_on, o.channel, p.kind::text as product_kind,
       count(distinct o.id)::int as orders, sum(ol.line_total_cents)::int as gross_cents,
       sum(ol.vat_cents)::int as vat_cents, 0 as refunds_cents, 0 as refunds_vat_cents
from orders o join order_lines ol on ol.order_id = o.id join products p on p.id = ol.product_id
left join persons pe on pe.id = o.person_id
where o.paid_at is not null and o.status in ('paid', 'partially_refunded', 'refunded')
  and coalesce(pe.is_tester, false) = false
group by 1, 2, 3
union all
select (r.created_at at time zone 'Europe/Brussels')::date, o.channel, 'refund', 0, 0, 0,
       sum(r.amount_cents)::int, (-coalesce(sum(cn.vat_cents), 0))::int
from refunds r join payments pm on pm.id = r.payment_id join orders o on o.id = pm.order_id
left join persons pe on pe.id = o.person_id
left join invoices cn on cn.id = r.credit_note_id
where r.status = 'refunded' and coalesce(pe.is_tester, false) = false
group by 1, 2`;

export const vRevenueDaily = pgView("v_revenue_daily", {
  dayOn: date("day_on", { mode: "string" }).notNull(),
  channel: ordersChannel("channel").notNull(),
  productKind: text("product_kind").notNull(),
  orders: integer("orders").notNull(),
  grossCents: integer("gross_cents").notNull(),
  vatCents: integer("vat_cents").notNull(),
  refundsCents: integer("refunds_cents").notNull(),
  refundsVatCents: integer("refunds_vat_cents").notNull(),
}).existing();

// ---------------------------------------------------------------------------
// v_no_show_report
// ---------------------------------------------------------------------------

export const vNoShowReportSql = `select b.id as booking_id, b.person_id, b.session_id, s.template_id, s.kind as session_kind, s.starts_at,
       extract(isodow from (s.starts_at at time zone 'Europe/Brussels'))::int as weekday,
       extract(hour from (s.starts_at at time zone 'Europe/Brussels'))::int as hour,
       b.status, b.paid_with, b.cancelled_at, b.cancel_reason_code,
       (s.status = 'cancelled') as is_session_cancelled,
       case when b.cancelled_at is null then null
            else round((extract(epoch from (s.starts_at - b.cancelled_at)) / 3600)::numeric, 1) end as notice_hours,
       (case b.paid_with
          when 'credit' then coalesce(ce.consumed_value_cents, 0)
          when 'order' then coalesce(round(ol.line_total_cents::numeric / nullif(ol.quantity, 0)), 0)
          else 0 end)::int as value_cents,
       greatest(0, coalesce(ce.forfeited_units, 0))::int as credit_units_forfeited
from bookings b join sessions s on s.id = b.session_id
left join order_lines ol on ol.id = b.order_line_id
left join lateral (select coalesce(-sum(e.quantity * g.unit_value_cents) filter (where e.kind = 'consume'), 0) as consumed_value_cents,
                          coalesce(-sum(e.quantity), 0) as forfeited_units
                   from credit_entries e join credit_grants g on g.id = e.grant_id
                   where e.ref_type = 'booking' and e.ref_id = b.id and e.kind in ('consume', 'release')) ce on true
where b.status in ('cancelled', 'late_cancelled', 'no_show')`;

export const vNoShowReport = pgView("v_no_show_report", {
  bookingId: uuid("booking_id").notNull(),
  personId: uuid("person_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  templateId: uuid("template_id"),
  sessionKind: sessionsKind("session_kind").notNull(),
  startsAt: tz("starts_at").notNull(),
  weekday: integer("weekday").notNull(),
  hour: integer("hour").notNull(),
  status: bookingsStatus("status").notNull(),
  paidWith: bookingsPaidWith("paid_with").notNull(),
  cancelledAt: tz("cancelled_at"),
  cancelReasonCode: bookingsCancelReasonCode("cancel_reason_code"),
  isSessionCancelled: boolean("is_session_cancelled").notNull(),
  noticeHours: numeric("notice_hours", { precision: 10, scale: 1 }),
  valueCents: integer("value_cents").notNull(),
  creditUnitsForfeited: integer("credit_units_forfeited").notNull(),
}).existing();

// ---------------------------------------------------------------------------
// v_abandoned_checkouts
// ---------------------------------------------------------------------------

export const vAbandonedCheckoutsSql = `select c.id as checkout_id, c.person_id, c.email, c.status, c.created_at, c.abandoned_at, c.abandoned_reason,
       c.locale, c.utm,
       coalesce((select sum(case when jsonb_typeof(i->'quantity') = 'number' then (i->>'quantity')::int else 0 end)
                 from jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) i), 0)::int as item_count,
       c.total_cents as value_cents,
       coalesce((select array_agg(distinct (i->>'productId')::uuid order by (i->>'productId')::uuid)
                 from jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) i
                 where i->>'productId' ~ '^[0-9a-fA-F-]{36}$'), '{}'::uuid[]) as product_ids,
       coalesce(c.abandoned_reason in ('payment_failed', 'payment_expired'), false) as had_payment_failure,
       c.recovery_message_id, c.recovered_order_id,
       case when o.status in ('paid', 'partially_refunded', 'refunded') then o.total_cents end as recovered_revenue_cents,
       c.recovered_at
from checkouts c left join orders o on o.id = c.recovered_order_id
where c.abandoned_at is not null`;

export const vAbandonedCheckouts = pgView("v_abandoned_checkouts", {
  checkoutId: uuid("checkout_id").notNull(),
  personId: uuid("person_id"),
  email: text("email"),
  status: checkoutsStatus("status").notNull(),
  createdAt: tz("created_at").notNull(),
  abandonedAt: tz("abandoned_at").notNull(),
  abandonedReason: checkoutsAbandonedReason("abandoned_reason"),
  locale: text("locale").notNull(),
  utm: jsonb("utm").$type<Record<string, string>>(),
  itemCount: integer("item_count").notNull(),
  valueCents: integer("value_cents"),
  productIds: uuid("product_ids").array().notNull(),
  hadPaymentFailure: boolean("had_payment_failure").notNull(),
  recoveryMessageId: uuid("recovery_message_id"),
  recoveredOrderId: uuid("recovered_order_id"),
  recoveredRevenueCents: integer("recovered_revenue_cents"),
  recoveredAt: tz("recovered_at"),
}).existing();

// ---------------------------------------------------------------------------
// Attribution (R3, ops-P8): v_marketing_touches and v_person_first_touch
// ---------------------------------------------------------------------------

/**
 * The canonical source of a touch (rule 73): BEAM's UTM convention is `utm_source = meta|google`;
 * crm's acquisition sources `paid_meta` and `paid_google` and the Meta and Google spellings of
 * forms' rule A2 (`facebook`, `fb`, `instagram`, `ig`, `adwords`) map to the same two values, so
 * a person acquired through a Meta ad and a later Meta checkout share one campaign key and both
 * join `ad_spend_daily`. Every other value is lower-cased and trimmed; empty becomes null.
 */
const canonSource = (expr: string) => `case when lower(trim(${expr})) in ('paid_meta', 'meta', 'facebook', 'fb', 'instagram', 'ig') then 'meta'
            when lower(trim(${expr})) in ('paid_google', 'google', 'adwords') then 'google'
            else nullif(lower(trim(${expr})), '') end`;

/** The acquisition campaign of `persons p`, lower-cased (the stored `campaign`, else `utm.campaign`). */
const ACQ_CAMPAIGN = `nullif(lower(trim(coalesce(nullif(trim(p.acquisition->>'campaign'), ''), p.acquisition->'utm'->>'campaign'))), '')`;
const ACQ_MEDIUM = `nullif(lower(trim(coalesce(p.acquisition->>'medium', p.acquisition->'utm'->>'medium'))), '')`;

/**
 * `v_marketing_touches` (R3): one row per marketing touch of a person, the union of
 * `persons.acquisition` (at `persons.created_at`, kind `acquisition`), completed
 * `form_submissions` (forms' derived `source` and `campaign`, at `completed_at`, kind `form`) and
 * `checkouts.utm` (at `created_at`, kind `checkout`). Null and empty campaigns are removed;
 * values are lower-cased; `campaign_key = source|campaign` with `direct` for a missing source.
 */
export const vMarketingTouchesSql = `select t.person_id, t.touched_at, t.source, t.medium, t.campaign, t.touch_kind,
       t.source || '|' || t.campaign as campaign_key
from (
  select p.id as person_id, p.created_at as touched_at,
         coalesce(${canonSource("p.acquisition->>'source'")}, 'direct') as source,
         ${ACQ_MEDIUM} as medium,
         ${ACQ_CAMPAIGN} as campaign,
         'acquisition' as touch_kind
  from persons p
  where p.merged_into_person_id is null and jsonb_typeof(p.acquisition) = 'object'
  union all
  select fs.person_id, fs.completed_at,
         coalesce(${canonSource("fs.source")}, 'direct'),
         nullif(lower(trim(fs.utm->>'medium')), ''),
         nullif(lower(trim(coalesce(nullif(trim(fs.campaign), ''), fs.utm->>'campaign'))), ''),
         'form'
  from form_submissions fs
  where fs.person_id is not null and fs.status = 'completed' and fs.completed_at is not null
  union all
  select c.person_id, c.created_at,
         coalesce(${canonSource("c.utm->>'source'")}, 'direct'),
         nullif(lower(trim(c.utm->>'medium')), ''),
         nullif(lower(trim(c.utm->>'campaign')), ''),
         'checkout'
  from checkouts c
  where c.person_id is not null and jsonb_typeof(c.utm) = 'object'
) t
where t.campaign is not null`;

export const vMarketingTouches = pgView("v_marketing_touches", {
  personId: uuid("person_id").notNull(),
  touchedAt: tz("touched_at").notNull(),
  source: text("source").notNull(),
  medium: text("medium"),
  campaign: text("campaign").notNull(),
  touchKind: text("touch_kind").$type<"acquisition" | "form" | "checkout">().notNull(),
  campaignKey: text("campaign_key").notNull(),
}).existing();

/**
 * `v_person_first_touch` (R3, +): the first touch of every person who is not merged, from
 * `persons.acquisition` (rule 72): the canonical source, medium and campaign, and the campaign
 * key `source|campaign`, `direct|none` when the acquisition has no campaign. Erased people keep
 * their row: erasure keeps `{ source, campaign, medium }` for aggregate attribution (crm spec 9).
 * The first-touch credits, cost per lead, CAC, LTV by campaign and the funnel read it.
 */
export const vPersonFirstTouchSql = `select p.id as person_id, p.created_at, p.is_tester, p.erased_at is not null as is_erased,
       p.acquisition->>'source' as acquisition_source,
       coalesce(${canonSource("p.acquisition->>'source'")}, 'direct') as source,
       ${ACQ_MEDIUM} as medium,
       ${ACQ_CAMPAIGN} as campaign,
       case when ${ACQ_CAMPAIGN} is null then 'direct|none'
            else coalesce(${canonSource("p.acquisition->>'source'")}, 'direct') || '|' || ${ACQ_CAMPAIGN} end as campaign_key
from persons p
where p.merged_into_person_id is null`;

export const vPersonFirstTouch = pgView("v_person_first_touch", {
  personId: uuid("person_id").notNull(),
  createdAt: tz("created_at").notNull(),
  isTester: boolean("is_tester").notNull(),
  isErased: boolean("is_erased").notNull(),
  acquisitionSource: text("acquisition_source"),
  source: text("source").notNull(),
  medium: text("medium"),
  campaign: text("campaign"),
  campaignKey: text("campaign_key").notNull(),
}).existing();
