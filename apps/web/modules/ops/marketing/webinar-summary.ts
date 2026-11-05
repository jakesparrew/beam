/**
 * The webinar performance summary (ops spec 5, `/admin/reports/marketing`, R3): for the native
 * registrations made in the range (cancelled ones and testers excluded), per webinar and in
 * total: registered, attended live (webinar's `v_webinar_watch.is_attended` for mode `live`,
 * which applies the webinar's `attended_min_sec`), average watch time over the registrations
 * that watched, replay and on-demand views, poll answers and CTA clicks
 * (`webinar_interactions`). The conversion by lead, customer and member is rule 75's webinar
 * conversion (`kpis-marketing.ts`); the page shows both side by side.
 */
import type { DbOrTx } from "@beam/db";
import type { LocalizedText } from "@beam/core/i18n";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { inRange, type DateRange } from "../reports/no-shows";

export const WEBINAR_SUMMARY_ROWS = 50;

export type WebinarFigures = {
  registered: number;
  attendedLive: number;
  avgWatchSec: number | null;
  replayViews: number;
  onDemandViews: number;
  pollAnswers: number;
  ctaClicks: number;
};
export type WebinarSummaryRow = { webinarId: string; slug: string; title: LocalizedText; startsAt: Date | null } & WebinarFigures;
export type WebinarSummary = { range: DateRange; webinars: WebinarSummaryRow[]; total: WebinarFigures; more: boolean };

type Raw = { webinar_id: string; slug: string; title: LocalizedText | string; starts_at: string | Date | null } & Record<string, number | string | null>;

const figures = (r: Record<string, number | string | null>): WebinarFigures => ({
  registered: Number(r.registered ?? 0),
  attendedLive: Number(r.attended_live ?? 0),
  avgWatchSec: r.avg_watch_sec === null || r.avg_watch_sec === undefined ? null : Math.round(Number(r.avg_watch_sec)),
  replayViews: Number(r.replay_views ?? 0),
  onDemandViews: Number(r.on_demand_views ?? 0),
  pollAnswers: Number(r.poll_answers ?? 0),
  ctaClicks: Number(r.cta_clicks ?? 0),
});

/** Webinar performance of the registrations made in `range`. */
export async function computeWebinarSummary(db: DbOrTx, input: { range: DateRange; limit?: number }): Promise<WebinarSummary> {
  const limit = input.limit ?? WEBINAR_SUMMARY_ROWS;
  const perRegistration = sql`with r as (
      select wr.id, wr.webinar_id from webinar_registrations wr join persons pe on pe.id = wr.person_id
      where pe.is_tester = false and wr.status <> 'cancelled' and ${inRange(sql`wr.created_at`, input.range)}
    ), rw as (
      select r.id, r.webinar_id,
        coalesce((select bool_or(w.is_attended) from v_webinar_watch w where w.registration_id = r.id and w.mode = 'live'), false) as attended_live,
        (select sum(w.watched_sec) from v_webinar_watch w where w.registration_id = r.id) as watch_sec,
        exists (select 1 from v_webinar_watch w where w.registration_id = r.id and w.mode = 'replay') as replay,
        exists (select 1 from v_webinar_watch w where w.registration_id = r.id and w.mode = 'on_demand') as on_demand,
        (select count(*) from webinar_interactions wi where wi.registration_id = r.id and wi.kind = 'poll_answer') as polls,
        (select count(*) from webinar_interactions wi where wi.registration_id = r.id and wi.kind = 'cta_clicked') as ctas
      from r
    )`;
  const cols = sql`count(*)::int as registered, count(*) filter (where rw.attended_live)::int as attended_live, avg(rw.watch_sec) as avg_watch_sec,
      count(*) filter (where rw.replay)::int as replay_views, count(*) filter (where rw.on_demand)::int as on_demand_views,
      coalesce(sum(rw.polls), 0)::int as poll_answers, coalesce(sum(rw.ctas), 0)::int as cta_clicks`;
  const rows = rowsOf<Raw>(
    await db.execute(sql`${perRegistration}
      select wb.id as webinar_id, wb.slug, wb.title, wb.starts_at, ${cols}
      from rw join webinars wb on wb.id = rw.webinar_id
      group by wb.id, wb.slug, wb.title, wb.starts_at
      order by count(*) desc, wb.starts_at desc nulls last, wb.id
      limit ${limit + 1}`),
  );
  const [t] = rowsOf<Record<string, number | string | null>>(await db.execute(sql`${perRegistration} select ${cols} from rw`));
  return {
    range: input.range,
    webinars: rows.slice(0, limit).map((r) => ({
      webinarId: r.webinar_id,
      slug: r.slug,
      title: (typeof r.title === "string" ? JSON.parse(r.title) : r.title) as LocalizedText,
      startsAt: r.starts_at ? new Date(r.starts_at) : null,
      ...figures(r),
    })),
    total: figures(t ?? {}),
    more: rows.length > limit,
  };
}

export const WEBINAR_CSV_COLUMNS = ["webinar_id", "slug", "registered", "attended_live", "avg_watch_sec", "replay_views", "on_demand_views", "poll_answers", "cta_clicks"] as const;

export function webinarCsvRowOf(r: WebinarSummaryRow): unknown[] {
  return [r.webinarId, r.slug, r.registered, r.attendedLive, r.avgWatchSec ?? "", r.replayViews, r.onDemandViews, r.pollAnswers, r.ctaClicks];
}
