/**
 * forms views (forms spec section 2 "Views"). Each view is `pgView(name, columns).existing()`
 * with its SQL exported beside it as `<name>Sql`; `pnpm db:views` writes the migration and
 * `createTestDb()` applies the same SQL (DM-1).
 *
 * Read by ops (funnel, conversions, latest results), email (outcome blocks) and forms' own
 * reports. None of them exposes answer values or sensitive data. Counts are cast to `int`.
 */
import { bigint, date, integer, numeric, pgView, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
