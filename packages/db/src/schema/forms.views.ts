/**
 * forms views (forms spec section 2 "Views"). Each view is `pgView(name, columns).existing()`
 * with its SQL exported beside it as `<name>Sql`; `pnpm db:views` writes the migration and
 * `createTestDb()` applies the same SQL (DM-1).
 *
 * Read by ops (funnel, conversions, latest results), email (outcome blocks) and forms' own
 * reports. None of them exposes answer values or sensitive data. Counts are cast to `int`.
 */
import { bigint, date, integer, numeric, pgSchema, pgView, text, timestamp, uuid } from "drizzle-orm/pg-core";

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** One row per form per Brussels day: page views and submission statuses by start day. */
export const vFormFunnelDailySql = `with s as (
  select form_id, (started_at at time zone 'Europe/Brussels')::date as day_on,
         count(*)::int as started,
         count(*) filter (where status in ('partial', 'completed') or path <> '{}')::int as engaged,
         count(*) filter (where status = 'completed')::int as completed,
         count(*) filter (where status = 'abandoned')::int as abandoned
  from form_submissions group by 1, 2),
v as (select form_id, day_on, sum(views)::int as views from form_views_daily group by 1, 2)
select coalesce(s.form_id, v.form_id) as form_id, coalesce(s.day_on, v.day_on) as day_on,
       coalesce(v.views, 0) as views, coalesce(s.started, 0) as started, coalesce(s.engaged, 0) as engaged,
       coalesce(s.completed, 0) as completed, coalesce(s.abandoned, 0) as abandoned
from s full join v on v.form_id = s.form_id and v.day_on = s.day_on`;

export const vFormFunnelDaily = pgView("v_form_funnel_daily", {
  formId: uuid("form_id").notNull(),
  dayOn: date("day_on", { mode: "string" }).notNull(),
  views: integer("views").notNull(),
  started: integer("started").notNull(),
  engaged: integer("engaged").notNull(),
  completed: integer("completed").notNull(),
  abandoned: integer("abandoned").notNull(),
}).existing();

/** What a completed, linked submission led to within 30 days (first booking, first payment, revenue). */
export const vFormConversionsSql = `select fs.id as submission_id, fs.form_id, fs.form_version_id, fs.person_id, fs.outcome_key,
       fs.source, fs.campaign, fs.completed_at,
       (select min(b.created_at) from bookings b where b.person_id = fs.person_id
          and b.status in ('confirmed', 'attended') and b.created_at >= fs.completed_at
          and b.created_at < fs.completed_at + interval '30 days') as first_booking_at,
       (select min(o.paid_at) from orders o where o.person_id = fs.person_id and o.paid_at is not null
          and o.paid_at >= fs.completed_at and o.paid_at < fs.completed_at + interval '30 days') as first_paid_at,
       (select coalesce(sum(o.total_cents), 0)::bigint from orders o where o.person_id = fs.person_id
          and o.status = 'paid' and o.paid_at >= fs.completed_at
          and o.paid_at < fs.completed_at + interval '30 days') as revenue_30d_cents
from form_submissions fs where fs.status = 'completed' and fs.person_id is not null`;

export const vFormConversions = pgView("v_form_conversions", {
  submissionId: uuid("submission_id").notNull(),
  formId: uuid("form_id").notNull(),
  formVersionId: uuid("form_version_id").notNull(),
  personId: uuid("person_id").notNull(),
  outcomeKey: text("outcome_key"),
  source: text("source").notNull(),
  campaign: text("campaign"),
  completedAt: tz("completed_at").notNull(),
  firstBookingAt: tz("first_booking_at"),
  firstPaidAt: tz("first_paid_at"),
  revenue30dCents: bigint("revenue_30d_cents", { mode: "number" }).notNull(),
}).existing();

/** Latest completed result per person per form, any version (segments, email content blocks). */
export const vFormLatestResultsSql = `select distinct on (fs.person_id, fs.form_id)
       fs.person_id, fs.form_id, f.slug as form_slug, fs.form_version_id, fs.id as submission_id,
       fs.outcome_key, (fs.score ->> 'total')::numeric as total_score, fs.score ->> 'totalRangeKey' as total_range_key,
       fs.completed_at
from form_submissions fs join forms f on f.id = fs.form_id
where fs.status = 'completed' and fs.person_id is not null
order by fs.person_id, fs.form_id, fs.completed_at desc`;

export const vFormLatestResults = pgView("v_form_latest_results", {
  personId: uuid("person_id").notNull(),
  formId: uuid("form_id").notNull(),
  formSlug: text("form_slug").notNull(),
  formVersionId: uuid("form_version_id").notNull(),
  submissionId: uuid("submission_id").notNull(),
  outcomeKey: text("outcome_key"),
  /** `numeric` read as a string by the driver; null for an unscored form. */
  totalScore: numeric("total_score"),
  totalRangeKey: text("total_range_key"),
  completedAt: tz("completed_at").notNull(),
}).existing();

// ---------------------------------------------------------------------------
// R3 (forms-P9): marketing KPIs and campaign attribution
// ---------------------------------------------------------------------------

/** Brussels day of a timestamp expression. */
const bxl = (expr: string) => `(${expr} at time zone 'Europe/Brussels')::date`;

/**
 * When crm stamped `persons p`'s acquisition (`captured_at`, crm's `ctx.now` of the creating
 * transaction); null for a missing or malformed value, so a hand-imported acquisition never
 * breaks the view.
 */
const CAPTURED_AT = `case when p.acquisition->>'captured_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (p.acquisition->>'captured_at')::timestamptz end`;

/** The campaign of `form_submissions fs` for attribution: `utm.campaign`, trimmed and lower-cased; null when empty. */
const UTM_CAMPAIGN = `nullif(lower(trim(fs.utm->>'campaign')), '')`;

/**
 * `v_form_kpis_daily` (R3, marketing dashboard and `/admin/forms/attribution`): one row per Brussels
 * day with leads created by forms (persons whose acquisition carries a `form_slug`, by the day crm
 * captured it; testers, merged losers and existing persons whose empty acquisition a form filled
 * later, crm's `person.acquisition_filled`, excluded), completed submissions, result CTA clicks
 * (`assessment.cta_clicked`), and the submissions completed that day that converted within 30 days
 * (a booking or a paid order, from `v_form_conversions`) with their 30-day revenue. No person ids.
 */
export const vFormKpisDailySql = `with l as (
  select ${bxl(CAPTURED_AT)} as day_on, count(*)::int as leads
  from persons p
  where p.merged_into_person_id is null and p.is_tester = false and jsonb_typeof(p.acquisition) = 'object'
    and coalesce(p.acquisition->>'form_slug', '') <> '' and ${CAPTURED_AT} is not null
    and not exists (select 1 from activity_events e where e.person_id = p.id and e.kind = 'person.acquisition_filled')
  group by 1),
c as (
  select ${bxl("fs.completed_at")} as day_on, count(*)::int as completions
  from form_submissions fs where fs.status = 'completed' and fs.completed_at is not null group by 1),
k as (
  select ${bxl("e.occurred_at")} as day_on, count(*)::int as cta_clicks
  from activity_events e where e.kind = 'assessment.cta_clicked' group by 1),
v as (
  select ${bxl("v.completed_at")} as day_on,
         count(*) filter (where v.first_booking_at is not null or v.first_paid_at is not null)::int as conversions,
         count(*) filter (where v.first_booking_at is not null)::int as bookings,
         count(*) filter (where v.first_paid_at is not null)::int as purchases,
         coalesce(sum(v.revenue_30d_cents), 0)::bigint as revenue_30d_cents
  from v_form_conversions v group by 1),
d as (select day_on from l union select day_on from c union select day_on from k union select day_on from v)
select d.day_on, coalesce(l.leads, 0) as leads, coalesce(c.completions, 0) as completions,
       coalesce(k.cta_clicks, 0) as cta_clicks, coalesce(v.conversions, 0) as conversions,
       coalesce(v.bookings, 0) as bookings, coalesce(v.purchases, 0) as purchases,
       coalesce(v.revenue_30d_cents, 0)::bigint as revenue_30d_cents
from d left join l on l.day_on = d.day_on left join c on c.day_on = d.day_on
  left join k on k.day_on = d.day_on left join v on v.day_on = d.day_on`;

export const vFormKpisDaily = pgView("v_form_kpis_daily", {
  dayOn: date("day_on", { mode: "string" }).notNull(),
  leads: integer("leads").notNull(),
  completions: integer("completions").notNull(),
  ctaClicks: integer("cta_clicks").notNull(),
  conversions: integer("conversions").notNull(),
  bookings: integer("bookings").notNull(),
  purchases: integer("purchases").notNull(),
  revenue30dCents: bigint("revenue_30d_cents", { mode: "number" }).notNull(),
}).existing();

/**
 * `v_form_campaign_attribution` (R3): one row per `utm_campaign` (trimmed, lower-cased; null = no
 * campaign) per Brussels day. `leads` = distinct linked persons and `completions` = completed
 * submissions of that day; `bookings` and `revenue_30d_cents` = what those submissions led to
 * within 30 days (`v_form_conversions`); `spend_cents` = ops' `ad_spend_daily` of that day for the
 * campaigns forms has seen, joined by campaign id (BEAM's UTM convention puts the ad campaign id in
 * `utm_campaign`) and, when no form campaign has that id, by campaign name. A day with spend and
 * no lead keeps its row. `cost_per_lead_cents` is that day's spend / leads (null without leads or
 * spend); a range recomputes it from the summed columns.
 */
export const vFormCampaignAttributionSql = `with s as (
  select ${UTM_CAMPAIGN} as utm_campaign, ${bxl("fs.completed_at")} as day_on,
         count(*)::int as completions, count(distinct fs.person_id)::int as leads
  from form_submissions fs where fs.status = 'completed' and fs.completed_at is not null
  group by 1, 2),
cv as (
  select ${UTM_CAMPAIGN} as utm_campaign, ${bxl("v.completed_at")} as day_on,
         count(*) filter (where v.first_booking_at is not null)::int as bookings,
         coalesce(sum(v.revenue_30d_cents), 0)::bigint as revenue_30d_cents
  from v_form_conversions v join form_submissions fs on fs.id = v.submission_id
  group by 1, 2),
k as (select distinct utm_campaign from s where utm_campaign is not null),
a as (
  select k.utm_campaign, a.day_on, sum(a.spend_cents)::bigint as spend_cents
  from ad_spend_daily a
  join k on k.utm_campaign = lower(trim(a.campaign_external_id))
    or (k.utm_campaign = lower(trim(a.campaign_name))
        and not exists (select 1 from k k2 where k2.utm_campaign = lower(trim(a.campaign_external_id))))
  group by 1, 2),
d as (select utm_campaign, day_on from s union select utm_campaign, day_on from a)
select d.utm_campaign, d.day_on, coalesce(s.leads, 0) as leads, coalesce(s.completions, 0) as completions,
       coalesce(cv.bookings, 0) as bookings, coalesce(cv.revenue_30d_cents, 0)::bigint as revenue_30d_cents,
       coalesce(a.spend_cents, 0)::bigint as spend_cents,
       case when coalesce(s.leads, 0) > 0 and a.spend_cents is not null then round(a.spend_cents::numeric / s.leads)::bigint end as cost_per_lead_cents
from d
left join s on s.utm_campaign is not distinct from d.utm_campaign and s.day_on = d.day_on
left join cv on cv.utm_campaign is not distinct from d.utm_campaign and cv.day_on = d.day_on
left join a on a.utm_campaign is not distinct from d.utm_campaign and a.day_on = d.day_on`;

export const vFormCampaignAttribution = pgView("v_form_campaign_attribution", {
  utmCampaign: text("utm_campaign"),
  dayOn: date("day_on", { mode: "string" }).notNull(),
  leads: integer("leads").notNull(),
  completions: integer("completions").notNull(),
  bookings: integer("bookings").notNull(),
  revenue30dCents: bigint("revenue_30d_cents", { mode: "number" }).notNull(),
  spendCents: bigint("spend_cents", { mode: "number" }).notNull(),
  costPerLeadCents: bigint("cost_per_lead_cents", { mode: "number" }),
}).existing();

// ---------------------------------------------------------------------------
// R4 (forms-P10): non-sensitive form views in the read-only `ai` schema
// ---------------------------------------------------------------------------

/**
 * The `ai` schema of the natural-language questions (`runAiReadOnlyQuery` as `beam_ai_ro`,
 * platform's `0100_ai_readonly.sql`). Declared here so the schema exists before these views are
 * created (`createTestDb()` builds it from the TypeScript schema); `0100` creates it with
 * `if not exists` and holds the role's usage grant. `select` on the two views below is granted
 * to `beam_ai_ro` with the custom SQL that grants ops' `ai` views (forms-P10 request).
 */
export const aiSchema = pgSchema("ai");

/*
 * Every `ai` view is declared twice with the same columns:
 *
 * - `aiFormFunnelDaily` / `aiFormOutcomes` are the typed handles for Drizzle queries
 *   (`select ... from "ai"."form_funnel_daily"`), used by `modules/forms/dashboard-sources.ts`;
 * - `aiFormFunnelDailyDdl` / `aiFormOutcomesDdl` carry the schema-qualified name that
 *   `pnpm db:views` and `createTestDb()` read through `getViewConfig(view).name` to write
 *   `create or replace view ai.<name>`; never query them (Drizzle would quote the dotted name).
 *
 * Neither view has a person id, a name, a contact field, an answer or a score: only form ids,
 * slugs, kinds, versions, outcome keys, Brussels days and counts. No AI on answers (spec section 1).
 */

const aiFormFunnelDailyColumns = () => ({
  formId: uuid("form_id").notNull(),
  formSlug: text("form_slug").notNull(),
  formKind: text("form_kind").notNull(),
  dayOn: date("day_on", { mode: "string" }).notNull(),
  views: integer("views").notNull(),
  started: integer("started").notNull(),
  engaged: integer("engaged").notNull(),
  completed: integer("completed").notNull(),
  abandoned: integer("abandoned").notNull(),
});

/**
 * `ai.form_funnel_daily` (R4): `v_form_funnel_daily` with the form's slug and kind. One row per
 * form per Brussels day; submissions count on the day they started (the report's cohort day).
 */
export const aiFormFunnelDailyDdlSql = `select f.id as form_id, f.slug as form_slug, f.kind::text as form_kind, d.day_on,
       d.views, d.started, d.engaged, d.completed, d.abandoned
from v_form_funnel_daily d join forms f on f.id = d.form_id`;

export const aiFormFunnelDailyDdl = pgView("ai.form_funnel_daily", aiFormFunnelDailyColumns()).existing();
export const aiFormFunnelDaily = aiSchema.view("form_funnel_daily", aiFormFunnelDailyColumns()).existing();

/** Below this many completions of one outcome on one day and version, the outcome is reported as `other`. */
export const AI_FORM_OUTCOME_MIN_COUNT = 5;
/** The outcome key of the merged small groups in `ai.form_outcomes`. */
export const AI_FORM_OUTCOME_OTHER = "other";

const aiFormOutcomesColumns = () => ({
  formId: uuid("form_id").notNull(),
  formSlug: text("form_slug").notNull(),
  formVersion: integer("form_version").notNull(),
  dayOn: date("day_on", { mode: "string" }).notNull(),
  /** Null = completed without an outcome; `other` also holds the outcomes merged below the minimum count. */
  outcomeKey: text("outcome_key"),
  completions: integer("completions").notNull(),
});

/**
 * `ai.form_outcomes` (R4): completed submissions per form, version, Brussels day (the start day,
 * as `v_form_funnel_daily` and `getFormReport` count them) and outcome key. An outcome (or "no
 * outcome") with fewer than 5 completions on that day and version is merged into `other`, so a
 * rare outcome cannot single out a person; the day's total stays exact.
 */
export const aiFormOutcomesDdlSql = `with c as (
  select fs.form_id, fs.form_version_id, ${bxl("fs.started_at")} as day_on, fs.outcome_key, count(*)::int as n
  from form_submissions fs where fs.status = 'completed'
  group by 1, 2, 3, 4)
select c.form_id, f.slug as form_slug, fv.version as form_version, c.day_on,
       case when c.n < ${AI_FORM_OUTCOME_MIN_COUNT} then '${AI_FORM_OUTCOME_OTHER}' else c.outcome_key end as outcome_key,
       sum(c.n)::int as completions
from c join forms f on f.id = c.form_id join form_versions fv on fv.id = c.form_version_id
group by 1, 2, 3, 4, 5`;

export const aiFormOutcomesDdl = pgView("ai.form_outcomes", aiFormOutcomesColumns()).existing();
export const aiFormOutcomes = aiSchema.view("form_outcomes", aiFormOutcomesColumns()).existing();
