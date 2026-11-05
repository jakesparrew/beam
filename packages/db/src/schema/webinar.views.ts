/**
 * webinar views (webinar spec section 2.4, data model 2.12). Each view is
 * `pgView(name, columns).existing()` with its SQL exported beside it as `<name>Sql`;
 * `pnpm db:views` writes the migration and `createTestDb()` applies the same SQL (DM-1).
 *
 * Persons are resolved through `persons.merged_into_person_id` (cross-module decision 19): a
 * loser registration kept on the loser by `mergePersons` (both registered for one webinar) is
 * folded into the winner's row, so reports never count one person twice. Watch time is the
 * merged length of a mode's segments (gaps and islands; overlapping and touching intervals
 * merge), the SQL twin of `mergeIntervals()` in `@beam/core/webinar`.
 *
 * `v_webinar_performance_daily` (R4, webinar-P8) holds non-personal aggregates per webinar and
 * Brussels day for ops' `ai.webinar_performance_daily` and the weekly summary. Counts are cast
 * to `int`.
 */
import { boolean, date, doublePrecision, integer, pgView, text, timestamp, uuid } from "drizzle-orm/pg-core";

const tz = (name: string) => timestamp(name, { withTimezone: true });
type WatchModeValue = "live" | "replay" | "on_demand";
type PersonStatusValue = "lead" | "customer" | "member";
type RegistrationStatusValue = "registered" | "cancelled" | "blocked";

/** The effective length: the real `duration_sec`, else the planned duration. */
const DURATION = `coalesce(w.duration_sec, w.planned_duration_minutes * 60)`;

// ---------------------------------------------------------------------------
// v_webinar_watch
// ---------------------------------------------------------------------------

export const vWebinarWatchSql = `with r as (
  select r.id, r.webinar_id, coalesce(p.merged_into_person_id, r.person_id) as person_id
  from webinar_registrations r join persons p on p.id = r.person_id),
s as (
  select r.person_id, ws.webinar_id, ws.mode, ws.from_sec, ws.to_sec, ws.recorded_at,
         max(ws.to_sec) over (partition by r.person_id, ws.webinar_id, ws.mode order by ws.from_sec, ws.to_sec
                              rows between unbounded preceding and 1 preceding) as prev_max
  from watch_segments ws join r on r.id = ws.registration_id),
g as (select s.*, sum(case when prev_max is null or from_sec > prev_max then 1 else 0 end)
         over (partition by person_id, webinar_id, mode order by from_sec, to_sec) as grp from s),
islands as (select person_id, webinar_id, mode, grp, min(from_sec) f, max(to_sec) t,
                   min(recorded_at) first_at, max(recorded_at) last_at from g group by 1,2,3,4),
agg as (select person_id, webinar_id, mode, sum(t - f)::int as watched_sec, max(t) as max_position_sec,
               min(first_at) as first_watched_at, max(last_at) as last_watched_at from islands group by 1,2,3)
select own.id as registration_id, a.*, w.attended_min_sec,
       ${DURATION} as duration_sec,
       a.watched_sec >= w.attended_min_sec as is_attended,
       a.watched_sec >= 900 as is_15m,
       a.watched_sec >= 1800 as is_30m,
       a.watched_sec * 2 >= ${DURATION} as is_half,
       a.max_position_sec >= ${DURATION} - 60 as is_end
from agg a join webinars w on w.id = a.webinar_id
left join webinar_registrations own on own.webinar_id = a.webinar_id and own.person_id = a.person_id`;

export const vWebinarWatch = pgView("v_webinar_watch", {
  registrationId: uuid("registration_id"),
  personId: uuid("person_id").notNull(),
  webinarId: uuid("webinar_id").notNull(),
  mode: text("mode").$type<WatchModeValue>().notNull(),
  watchedSec: integer("watched_sec").notNull(),
  maxPositionSec: integer("max_position_sec").notNull(),
  firstWatchedAt: tz("first_watched_at").notNull(),
  lastWatchedAt: tz("last_watched_at").notNull(),
  attendedMinSec: integer("attended_min_sec").notNull(),
  durationSec: integer("duration_sec").notNull(),
  isAttended: boolean("is_attended").notNull(),
  is15m: boolean("is_15m").notNull(),
  is30m: boolean("is_30m").notNull(),
  isHalf: boolean("is_half").notNull(),
  isEnd: boolean("is_end").notNull(),
}).existing();

// ---------------------------------------------------------------------------
// v_webinar_registration_facts
// ---------------------------------------------------------------------------

/** Per mode prefix (`live_`, `replay_`, `od_`): started and the watch facts of `v_webinar_watch`. */
const modeColumns = (prefix: string, alias: string, mode: WatchModeValue) =>
  `coalesce(ia.${prefix}started, false) as ${prefix}started,
       coalesce(${alias}.watched_sec, 0) as ${prefix}watched_sec,
       coalesce(${alias}.is_attended, false) as ${prefix}attended,
       coalesce(${alias}.is_15m, false) as ${prefix}is_15m,
       coalesce(${alias}.is_30m, false) as ${prefix}is_30m,
       coalesce(${alias}.is_half, false) as ${prefix}is_half,
       coalesce(${alias}.is_end, false) as ${prefix}is_end` + (mode === "on_demand" ? "" : ",");

const watchJoin = (alias: string, mode: WatchModeValue) =>
  `left join v_webinar_watch ${alias} on ${alias}.webinar_id = o.webinar_id and ${alias}.person_id = o.resolved_person_id and ${alias}.mode = '${mode}'`;

const perMode = (expr: (mode: WatchModeValue) => string, name: string) =>
  (["live", "replay", "on_demand"] as const)
    .map((m) => `${expr(m)} as ${name}_${m === "on_demand" ? "od" : m}`)
    .join(",\n         ");

export const vWebinarRegistrationFactsSql = `with rr as (
  select r.id, r.webinar_id, r.person_id, r.person_status, r.registered_mode, r.status, r.created_at,
         coalesce(p.merged_into_person_id, r.person_id) as resolved_person_id
  from webinar_registrations r join persons p on p.id = r.person_id),
o as (
  select distinct on (webinar_id, resolved_person_id) *
  from rr order by webinar_id, resolved_person_id, (person_id = resolved_person_id) desc, created_at, id),
ia as (
  select rr.webinar_id, rr.resolved_person_id,
         bool_or(i.kind = 'started' and i.mode = 'live') as live_started,
         bool_or(i.kind = 'started' and i.mode = 'replay') as replay_started,
         bool_or(i.kind = 'started' and i.mode = 'on_demand') as od_started,
         ${perMode((m) => `count(distinct i.poll_id) filter (where i.kind = 'poll_answer' and i.mode = '${m}')::int`, "poll_answers")},
         ${perMode((m) => `count(*) filter (where i.kind = 'cta_clicked' and i.mode = '${m}')::int`, "cta_clicks")},
         count(*) filter (where i.kind = 'question')::int as questions,
         count(*) filter (where i.kind = 'chat')::int as chats,
         min(i.occurred_at) filter (where i.kind = 'cta_clicked') as first_cta_click_at
  from webinar_interactions i join rr on rr.id = i.registration_id
  group by 1, 2)
select o.id as registration_id, o.webinar_id, o.resolved_person_id as person_id, o.person_status, o.registered_mode,
       o.status, o.created_at as registered_at,
       case when o.registered_mode = 'live' then coalesce(w.starts_at, o.created_at) else o.created_at end as anchor_at,
       ${modeColumns("live_", "wl", "live")}
       ${modeColumns("replay_", "wr", "replay")}
       ${modeColumns("od_", "wo", "on_demand")},
       coalesce(ia.poll_answers_live, 0) as poll_answers_live,
       coalesce(ia.poll_answers_replay, 0) as poll_answers_replay,
       coalesce(ia.poll_answers_od, 0) as poll_answers_od,
       coalesce(ia.cta_clicks_live, 0) as cta_clicks_live,
       coalesce(ia.cta_clicks_replay, 0) as cta_clicks_replay,
       coalesce(ia.cta_clicks_od, 0) as cta_clicks_od,
       coalesce(ia.questions, 0) as questions,
       coalesce(ia.chats, 0) as chats,
       ia.first_cta_click_at
from o join webinars w on w.id = o.webinar_id
left join ia on ia.webinar_id = o.webinar_id and ia.resolved_person_id = o.resolved_person_id
${watchJoin("wl", "live")}
${watchJoin("wr", "replay")}
${watchJoin("wo", "on_demand")}`;

export const vWebinarRegistrationFacts = pgView("v_webinar_registration_facts", {
  registrationId: uuid("registration_id").notNull(),
  webinarId: uuid("webinar_id").notNull(),
  personId: uuid("person_id").notNull(),
  personStatus: text("person_status").$type<PersonStatusValue>().notNull(),
  registeredMode: text("registered_mode").$type<WatchModeValue>().notNull(),
  status: text("status").$type<RegistrationStatusValue>().notNull(),
  registeredAt: tz("registered_at").notNull(),
  anchorAt: tz("anchor_at").notNull(),
  liveStarted: boolean("live_started").notNull(),
  liveWatchedSec: integer("live_watched_sec").notNull(),
  liveAttended: boolean("live_attended").notNull(),
  liveIs15m: boolean("live_is_15m").notNull(),
  liveIs30m: boolean("live_is_30m").notNull(),
  liveIsHalf: boolean("live_is_half").notNull(),
  liveIsEnd: boolean("live_is_end").notNull(),
  replayStarted: boolean("replay_started").notNull(),
  replayWatchedSec: integer("replay_watched_sec").notNull(),
  replayAttended: boolean("replay_attended").notNull(),
  replayIs15m: boolean("replay_is_15m").notNull(),
  replayIs30m: boolean("replay_is_30m").notNull(),
  replayIsHalf: boolean("replay_is_half").notNull(),
  replayIsEnd: boolean("replay_is_end").notNull(),
  odStarted: boolean("od_started").notNull(),
  odWatchedSec: integer("od_watched_sec").notNull(),
  odAttended: boolean("od_attended").notNull(),
  odIs15m: boolean("od_is_15m").notNull(),
  odIs30m: boolean("od_is_30m").notNull(),
  odIsHalf: boolean("od_is_half").notNull(),
  odIsEnd: boolean("od_is_end").notNull(),
  pollAnswersLive: integer("poll_answers_live").notNull(),
  pollAnswersReplay: integer("poll_answers_replay").notNull(),
  pollAnswersOd: integer("poll_answers_od").notNull(),
  ctaClicksLive: integer("cta_clicks_live").notNull(),
  ctaClicksReplay: integer("cta_clicks_replay").notNull(),
  ctaClicksOd: integer("cta_clicks_od").notNull(),
  questions: integer("questions").notNull(),
  chats: integer("chats").notNull(),
  firstCtaClickAt: tz("first_cta_click_at"),
}).existing();

// ---------------------------------------------------------------------------
// v_webinar_conversions
// ---------------------------------------------------------------------------

/** No window here: the report filters on `conversion_window_days` or the period picked. */
export const vWebinarConversionsSql = `select f.registration_id, f.webinar_id, f.person_id, f.person_status, f.anchor_at,
       (select min(b.created_at) from bookings b
         where b.person_id = f.person_id and b.status in ('confirmed', 'attended') and b.created_at > f.anchor_at) as first_booking_at,
       fo.paid_at as first_paid_order_at,
       fo.total_cents as first_paid_order_cents,
       coalesce((select sum(o.total_cents) from orders o
         where o.person_id = f.person_id and o.status = 'paid' and o.paid_at > f.anchor_at
           and o.paid_at <= f.anchor_at + interval '365 days'), 0)::int as revenue_365d_cents
from v_webinar_registration_facts f
left join lateral (select o.paid_at, o.total_cents from orders o
                   where o.person_id = f.person_id and o.status = 'paid' and o.paid_at > f.anchor_at
                   order by o.paid_at, o.id limit 1) fo on true`;

export const vWebinarConversions = pgView("v_webinar_conversions", {
  registrationId: uuid("registration_id").notNull(),
  webinarId: uuid("webinar_id").notNull(),
  personId: uuid("person_id").notNull(),
  personStatus: text("person_status").$type<PersonStatusValue>().notNull(),
  anchorAt: tz("anchor_at").notNull(),
  firstBookingAt: tz("first_booking_at"),
  firstPaidOrderAt: tz("first_paid_order_at"),
  firstPaidOrderCents: integer("first_paid_order_cents"),
  revenue365dCents: integer("revenue_365d_cents").notNull(),
}).existing();

// ---------------------------------------------------------------------------
// v_person_webinar_stats
// ---------------------------------------------------------------------------

/**
 * Per resolved person. Native counts exclude imported history; `imported_*` count ops'
 * `imported_history` rows, and the two `last_*` columns consider both (cross-module decision
 * 58: ops aliases these columns in `v_person_profile` and adds the totals itself).
 */
export const vPersonWebinarStatsSql = `with nat as (
  select person_id,
         count(*) filter (where status <> 'cancelled')::int as webinars_registered,
         count(*) filter (where live_attended)::int as webinars_attended_live,
         count(*) filter (where replay_attended)::int as replays_watched,
         count(*) filter (where od_attended)::int as on_demand_watched,
         sum(live_watched_sec + replay_watched_sec + od_watched_sec)::int as watch_sec_total,
         sum(poll_answers_live + poll_answers_replay + poll_answers_od)::int as poll_answers,
         sum(cta_clicks_live + cta_clicks_replay + cta_clicks_od)::int as cta_clicks,
         max(registered_at) filter (where status <> 'cancelled') as last_registered_at
  from v_webinar_registration_facts group by person_id),
att as (select person_id, max(last_watched_at) as last_attended_at from v_webinar_watch where is_attended group by person_id),
imp as (
  select coalesce(p.merged_into_person_id, h.person_id) as person_id,
         count(*) filter (where h.kind = 'webinar_registration')::int as imported_registered,
         count(*) filter (where h.kind = 'webinar_attendance')::int as imported_attended,
         max(h.occurred_at) filter (where h.kind = 'webinar_registration') as imported_last_registered_at,
         max(h.occurred_at) filter (where h.kind = 'webinar_attendance') as imported_last_attended_at
  from imported_history h join persons p on p.id = h.person_id
  where h.kind in ('webinar_registration', 'webinar_attendance')
  group by 1),
ids as (select person_id from nat union select person_id from imp)
select ids.person_id,
       coalesce(nat.webinars_registered, 0) as webinars_registered,
       coalesce(nat.webinars_attended_live, 0) as webinars_attended_live,
       coalesce(nat.replays_watched, 0) as replays_watched,
       coalesce(nat.on_demand_watched, 0) as on_demand_watched,
       coalesce(nat.watch_sec_total, 0) as watch_sec_total,
       coalesce(nat.poll_answers, 0) as poll_answers,
       coalesce(nat.cta_clicks, 0) as cta_clicks,
       greatest(nat.last_registered_at, imp.imported_last_registered_at) as last_webinar_registered_at,
       greatest(att.last_attended_at, imp.imported_last_attended_at) as last_webinar_attended_at,
       coalesce(imp.imported_registered, 0) as imported_webinars_registered,
       coalesce(imp.imported_attended, 0) as imported_webinars_attended
from ids
left join nat on nat.person_id = ids.person_id
left join att on att.person_id = ids.person_id
left join imp on imp.person_id = ids.person_id`;

export const vPersonWebinarStats = pgView("v_person_webinar_stats", {
  personId: uuid("person_id").notNull(),
  webinarsRegistered: integer("webinars_registered").notNull(),
  webinarsAttendedLive: integer("webinars_attended_live").notNull(),
  replaysWatched: integer("replays_watched").notNull(),
  onDemandWatched: integer("on_demand_watched").notNull(),
  watchSecTotal: integer("watch_sec_total").notNull(),
  pollAnswers: integer("poll_answers").notNull(),
  ctaClicks: integer("cta_clicks").notNull(),
  lastWebinarRegisteredAt: tz("last_webinar_registered_at"),
  lastWebinarAttendedAt: tz("last_webinar_attended_at"),
  importedWebinarsRegistered: integer("imported_webinars_registered").notNull(),
  importedWebinarsAttended: integer("imported_webinars_attended").notNull(),
}).existing();

// ---------------------------------------------------------------------------
// v_webinar_performance_daily (R4)
// ---------------------------------------------------------------------------

/** The Brussels calendar day of a `timestamptz` expression. */
const brusselsDay = (expr: string) => `(${expr} at time zone 'Europe/Brussels')::date`;

/** The column prefix of each watch mode in the performance view. */
const PERF_MODES = ["live", "replay", "on_demand"] as const satisfies readonly WatchModeValue[];

/**
 * Per webinar per Brussels day (`day_on`); no person id, name, e-mail or text column, so ops can
 * expose it to the read-only `ai` schema as is (cross-module decision 46). Tester persons are
 * left out and persons are resolved through `merged_into_person_id` (the underlying views fold a
 * merged loser into the winner). Each fact falls on the day it happened:
 *
 * - `registrations`: native registrations not cancelled, on the day they were made;
 * - `live_attendees`, `replay_viewers`, `on_demand_viewers`: persons who reached the webinar's
 *   attendance threshold in that mode (`v_webinar_watch.is_attended`, the `webinar.attended`
 *   trigger), on the day of their first watch in the mode; `<mode>_watchers` and
 *   `<mode>_watch_sec` count everyone with watch time in the mode and its merged seconds, and
 *   `avg_<mode>_watch_min` = `<mode>_watch_sec ÷ <mode>_watchers ÷ 60` (one decimal, null
 *   without watchers), so a longer period is averaged from the sums;
 * - `poll_answers`: one per person, poll and mode (as `v_webinar_registration_facts`), on the day
 *   of the first answer; `cta_clicks`: every click, on its day;
 * - `conversions_30d`: registrations (not cancelled) whose person booked (confirmed or attended)
 *   or paid an order within 30 days after the anchor (`v_webinar_conversions`), on the anchor's
 *   day (the webinar's start for live registrations).
 */
export const vWebinarPerformanceDailySql = `with reg as (
  select f.webinar_id, ${brusselsDay("f.registered_at")} as day_on, count(*)::int as registrations
  from v_webinar_registration_facts f join persons pe on pe.id = f.person_id
  where f.status <> 'cancelled' and pe.is_tester = false
  group by 1, 2),
wa as (
  select ww.webinar_id, ${brusselsDay("ww.first_watched_at")} as day_on,
         ${PERF_MODES.map(
           (m) => `count(*) filter (where ww.mode = '${m}' and ww.is_attended)::int as ${m}_attended,
         count(*) filter (where ww.mode = '${m}')::int as ${m}_watchers,
         coalesce(sum(ww.watched_sec) filter (where ww.mode = '${m}'), 0)::int as ${m}_watch_sec`,
         ).join(",\n         ")}
  from v_webinar_watch ww join persons pe on pe.id = ww.person_id
  where pe.is_tester = false
  group by 1, 2),
ia as (
  select i.webinar_id, coalesce(p.merged_into_person_id, r.person_id) as person_id, i.kind, i.mode, i.poll_id, i.occurred_at
  from webinar_interactions i
  join webinar_registrations r on r.id = i.registration_id
  join persons p on p.id = r.person_id
  join persons pe on pe.id = coalesce(p.merged_into_person_id, r.person_id)
  where i.kind in ('poll_answer', 'cta_clicked') and pe.is_tester = false),
pa as (
  select webinar_id, ${brusselsDay("min(occurred_at)")} as day_on
  from ia where kind = 'poll_answer'
  group by webinar_id, person_id, poll_id, mode),
pol as (select webinar_id, day_on, count(*)::int as poll_answers from pa group by 1, 2),
cta as (
  select webinar_id, ${brusselsDay("occurred_at")} as day_on, count(*)::int as cta_clicks
  from ia where kind = 'cta_clicked' group by 1, 2),
conv as (
  select c.webinar_id, ${brusselsDay("c.anchor_at")} as day_on, count(*)::int as conversions_30d
  from v_webinar_conversions c
  join webinar_registrations r on r.id = c.registration_id
  join persons pe on pe.id = c.person_id
  where r.status <> 'cancelled' and pe.is_tester = false
    and (c.first_booking_at <= c.anchor_at + interval '30 days'
         or c.first_paid_order_at <= c.anchor_at + interval '30 days')
  group by 1, 2),
k as (
  select webinar_id, day_on from reg union select webinar_id, day_on from wa
  union select webinar_id, day_on from pol union select webinar_id, day_on from cta
  union select webinar_id, day_on from conv)
select k.webinar_id, k.day_on,
       coalesce(reg.registrations, 0) as registrations,
       coalesce(wa.live_attended, 0) as live_attendees,
       coalesce(wa.replay_attended, 0) as replay_viewers,
       coalesce(wa.on_demand_attended, 0) as on_demand_viewers,
       ${PERF_MODES.map(
         (m) => `coalesce(wa.${m}_watchers, 0) as ${m}_watchers,
       coalesce(wa.${m}_watch_sec, 0) as ${m}_watch_sec,
       case when wa.${m}_watchers > 0 then round(wa.${m}_watch_sec / 60.0 / wa.${m}_watchers, 1)::float8 end as avg_${m}_watch_min`,
       ).join(",\n       ")},
       coalesce(pol.poll_answers, 0) as poll_answers,
       coalesce(cta.cta_clicks, 0) as cta_clicks,
       coalesce(conv.conversions_30d, 0) as conversions_30d
from k
left join reg on reg.webinar_id = k.webinar_id and reg.day_on = k.day_on
left join wa on wa.webinar_id = k.webinar_id and wa.day_on = k.day_on
left join pol on pol.webinar_id = k.webinar_id and pol.day_on = k.day_on
left join cta on cta.webinar_id = k.webinar_id and cta.day_on = k.day_on
left join conv on conv.webinar_id = k.webinar_id and conv.day_on = k.day_on`;

export const vWebinarPerformanceDaily = pgView("v_webinar_performance_daily", {
  webinarId: uuid("webinar_id").notNull(),
  dayOn: date("day_on", { mode: "string" }).notNull(),
  registrations: integer("registrations").notNull(),
  liveAttendees: integer("live_attendees").notNull(),
  replayViewers: integer("replay_viewers").notNull(),
  onDemandViewers: integer("on_demand_viewers").notNull(),
  liveWatchers: integer("live_watchers").notNull(),
  liveWatchSec: integer("live_watch_sec").notNull(),
  avgLiveWatchMin: doublePrecision("avg_live_watch_min"),
  replayWatchers: integer("replay_watchers").notNull(),
  replayWatchSec: integer("replay_watch_sec").notNull(),
  avgReplayWatchMin: doublePrecision("avg_replay_watch_min"),
  onDemandWatchers: integer("on_demand_watchers").notNull(),
  onDemandWatchSec: integer("on_demand_watch_sec").notNull(),
  avgOnDemandWatchMin: doublePrecision("avg_on_demand_watch_min"),
  pollAnswers: integer("poll_answers").notNull(),
  ctaClicks: integer("cta_clicks").notNull(),
  conversions30d: integer("conversions_30d").notNull(),
}).existing();

/** The column names of `v_webinar_performance_daily`, for tests and ops' AI field lists. */
export const WEBINAR_PERFORMANCE_DAILY_COLUMNS = [
  "webinar_id",
  "day_on",
  "registrations",
  "live_attendees",
  "replay_viewers",
  "on_demand_viewers",
  ...PERF_MODES.flatMap((m) => [`${m}_watchers`, `${m}_watch_sec`, `avg_${m}_watch_min`]),
  "poll_answers",
  "cta_clicks",
  "conversions_30d",
] as const;
