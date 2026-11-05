/**
 * R4 AI and summary hooks (webinar spec 12 webinar-P8, 4.7 `getWebinarWeeklyFacts`; ops rule 78).
 *
 * The weekly facts are sums over `v_webinar_performance_daily`, which holds aggregates per webinar
 * and Brussels day only (no person id, name, e-mail, text or `SENSITIVE_COLUMNS` member), so what
 * ops sends to Claude for the weekly management summary is never person-level data.
 *
 * The week is the seven Brussels days starting on the Brussels date of `weekStart` (ops passes the
 * Monday of the week; any instant of that day gives the same week). Each fact falls on the day it
 * happened (see the view): registrations on the day they were made, attendees and viewers on the
 * day of their first watch in the mode, CTA clicks on their day, and `conversions_30d` on the
 * anchor day of the registration (the webinar's start for live registrations): the registrations
 * anchored in the week whose person booked or paid within 30 days after the anchor, so far.
 * `avg_live_watch_min` is the merged live watch time of the week's live watchers divided by their
 * number, in minutes with one decimal (0 without live watchers).
 */
import { sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

/** The facts `getWebinarWeeklyFacts` returns, in this order. */
export const WEBINAR_WEEKLY_FACTS = [
  "registrations",
  "live_attendees",
  "replay_viewers",
  "on_demand_viewers",
  "avg_live_watch_min",
  "cta_clicks",
  "conversions_30d",
] as const;

export type WebinarWeeklyFact = (typeof WEBINAR_WEEKLY_FACTS)[number];

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** The facts of the week that starts on the Brussels date of `weekStart` (seven days). */
export async function webinarWeeklyFacts(db: DbOrTx, weekStart: Date): Promise<Array<{ fact: WebinarWeeklyFact; value: number }>> {
  if (!(weekStart instanceof Date) || Number.isNaN(weekStart.getTime())) throw new TypeError("getWebinarWeeklyFacts: weekStart must be a valid Date");
  const first = sql`(${weekStart.toISOString()}::timestamptz at time zone 'Europe/Brussels')::date`;
  const [row] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select
        coalesce(sum(registrations), 0)::bigint as registrations,
        coalesce(sum(live_attendees), 0)::bigint as live_attendees,
        coalesce(sum(replay_viewers), 0)::bigint as replay_viewers,
        coalesce(sum(on_demand_viewers), 0)::bigint as on_demand_viewers,
        coalesce(sum(live_watchers), 0)::bigint as live_watchers,
        coalesce(sum(live_watch_sec), 0)::bigint as live_watch_sec,
        coalesce(sum(cta_clicks), 0)::bigint as cta_clicks,
        coalesce(sum(conversions_30d), 0)::bigint as conversions_30d
      from v_webinar_performance_daily
      where day_on >= ${first} and day_on < ${first} + 7`),
  );
  const r = row ?? {};
  const watchers = num(r.live_watchers);
  const values: Record<WebinarWeeklyFact, number> = {
    registrations: num(r.registrations),
    live_attendees: num(r.live_attendees),
    replay_viewers: num(r.replay_viewers),
    on_demand_viewers: num(r.on_demand_viewers),
    avg_live_watch_min: watchers > 0 ? Math.round((num(r.live_watch_sec) / 60 / watchers) * 10) / 10 : 0,
    cta_clicks: num(r.cta_clicks),
    conversions_30d: num(r.conversions_30d),
  };
  return WEBINAR_WEEKLY_FACTS.map((fact) => ({ fact, value: values[fact] }));
}
