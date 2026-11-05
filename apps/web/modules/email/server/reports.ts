/**
 * Campaign reporting (email spec rules 61 and 62, section 5 `/admin/campaigns/[id]/report`),
 * email-P7.
 *
 * - `campaignStatsRows(db, ids)`: the `v_campaign_stats` row of each campaign, or its frozen
 *   `stats_snapshot` when present (rule 62: reports read the snapshot, so retention deletes do
 *   not change historic numbers).
 * - `buildSnapshot(db, campaignId)`: what `email.freeze_campaign_stats` stores. The view row in
 *   its own snake_case keys (the campaign list reads `open_rate` and `click_rate` from it), plus
 *   the aggregates the report shows beside it (`skipped_by_reason`, `clicks_by_link`,
 *   `by_locale`, `sends_timeline`) and `frozen_at`. Aggregates only: no person data.
 * - `getCampaignReport(db, campaignId, { unmasked })`: stats, skipped by reason, not sent
 *   (stopped), clicks per link index, per-locale counts, sends per 15 minutes, and the bounces
 *   and complaints list (live rows; masked addresses unless `persons.read`).
 * - `campaignReportCsv(db, campaignId)`: the export (ids, statuses, open and click times; no
 *   addresses).
 * - `getCampaignStats(db, ids)`: the cross-module `CampaignStats` shape.
 */
import type { DbOrTx } from "@beam/db";
import { campaigns } from "@beam/db/schema";
import type { CampaignStats } from "@beam/core/email";
import { eq, inArray, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { maskEmail } from "./campaigns";

export type ReportStats = {
  recipients: number;
  planned: number;
  removed: number;
  skipped: number;
  sent: number;
  delivered: number;
  hardBounced: number;
  softBounced: number;
  complained: number;
  uniqueOpens: number;
  privacyProxyOpens: number;
  uniqueClicks: number;
  unsubscribed: number;
  openRate: number | null;
  clickRate: number | null;
  clickToOpenRate: number | null;
  bounceRate: number | null;
  complaintRate: number | null;
  unsubscribeRate: number | null;
};

export type LinkClicks = { linkIndex: number; url: string | null; uniqueClicks: number; clicks: number };
export type LocaleCounts = { locale: string; recipients: number; sent: number; delivered: number; uniqueOpens: number; uniqueClicks: number };
export type TimelineBucket = { at: string; sent: number };
export type BounceRow = { emailMessageId: string; personId: string | null; email: string | null; kind: "hard" | "soft" | "complaint"; at: Date | null };

export type CampaignReport = {
  campaign: {
    id: string;
    name: string;
    status: string;
    purpose: string;
    scheduledAt: Date | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    stoppedAt: Date | null;
  };
  frozenAt: string | null;
  stats: ReportStats;
  skippedByReason: Record<string, number>;
  /** Planned recipients of a stopped campaign (rule 36). */
  notSentStopped: number;
  clicksByLink: LinkClicks[];
  byLocale: LocaleCounts[];
  timeline: TimelineBucket[];
  bounces: BounceRow[];
  /** R3 (email-P9): revenue, orders and first purchases. */
  attribution: null;
};

const num = (v: unknown): number => (v === null || v === undefined || v === "" ? 0 : Number(v));
const rate = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

/** A `v_campaign_stats` row (snake_case keys, as the view and the snapshot hold it) as `ReportStats`. */
export function statsFromRow(row: Record<string, unknown> | null | undefined): ReportStats {
  const r = row ?? {};
  return {
    recipients: num(r.recipients),
    planned: num(r.planned),
    removed: num(r.removed),
    skipped: num(r.skipped),
    sent: num(r.sent),
    delivered: num(r.delivered),
    hardBounced: num(r.hard_bounced),
    softBounced: num(r.soft_bounced),
    complained: num(r.complained),
    uniqueOpens: num(r.unique_opens),
    privacyProxyOpens: num(r.privacy_proxy_opens),
    uniqueClicks: num(r.unique_clicks),
    unsubscribed: num(r.unsubscribed),
    openRate: rate(r.open_rate),
    clickRate: rate(r.click_rate),
    clickToOpenRate: rate(r.click_to_open_rate),
    bounceRate: rate(r.bounce_rate),
    complaintRate: rate(r.complaint_rate),
    unsubscribeRate: rate(r.unsubscribe_rate),
  };
}

/** The live view rows of `ids`, keyed by campaign id (snake_case, as the snapshot stores them). */
async function liveStatsRows(db: DbOrTx, ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
  if (!ids.length) return new Map();
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`select * from v_campaign_stats where campaign_id in (${list})`));
  return new Map(rows.map((r) => [String(r.campaign_id), r]));
}

/** The stats row of each campaign: its snapshot when frozen, else the live view row. */
export async function campaignStatsRows(db: DbOrTx, ids: readonly string[]): Promise<Map<string, { row: Record<string, unknown>; frozen: boolean }>> {
  const out = new Map<string, { row: Record<string, unknown>; frozen: boolean }>();
  if (!ids.length) return out;
  const snaps = await db.select({ id: campaigns.id, snap: campaigns.statsSnapshot }).from(campaigns).where(inArray(campaigns.id, [...ids]));
  const live = await liveStatsRows(
    db,
    snaps.filter((s) => !s.snap).map((s) => s.id),
  );
  for (const s of snaps) {
    if (s.snap) out.set(s.id, { row: s.snap, frozen: true });
    else out.set(s.id, { row: live.get(s.id) ?? { campaign_id: s.id }, frozen: false });
  }
  return out;
}

export async function getCampaignStats(db: DbOrTx, campaignIds: string[]): Promise<CampaignStats[]> {
  const ids = [...new Set(campaignIds)];
  const rows = await campaignStatsRows(db, ids);
  return ids
    .filter((id) => rows.has(id))
    .map((id) => {
      const s = statsFromRow(rows.get(id)!.row);
      return {
        campaignId: id,
        recipients: s.recipients,
        sent: s.sent,
        delivered: s.delivered,
        opened: s.uniqueOpens,
        clicked: s.uniqueClicks,
        bounced: s.hardBounced + s.softBounced,
        complained: s.complained,
        unsubscribed: s.unsubscribed,
      };
    });
}

async function skippedByReason(db: DbOrTx, campaignId: string): Promise<Record<string, number>> {
  const rows = rowsOf<{ status: string; n: number }>(
    await db.execute(sql`
      select status::text as status, count(*)::int as n from campaign_recipients
      where campaign_id = ${campaignId}::uuid and status::text like 'skipped%' group by status`),
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

async function clicksByLink(db: DbOrTx, campaignId: string): Promise<LinkClicks[]> {
  const rows = rowsOf<{ link_index: number; url: string | null; unique_clicks: number; clicks: number }>(
    await db.execute(sql`
      select e.link_index, max(e.url) as url, count(distinct e.email_message_id)::int as unique_clicks, count(*)::int as clicks
      from email_events e join email_messages m on m.id = e.email_message_id
      where m.campaign_id = ${campaignId}::uuid and m.kind = 'campaign' and e.type = 'clicked' and e.link_index is not null
      group by e.link_index order by e.link_index`),
  );
  return rows.map((r) => ({ linkIndex: Number(r.link_index), url: r.url, uniqueClicks: Number(r.unique_clicks), clicks: Number(r.clicks) }));
}

async function byLocale(db: DbOrTx, campaignId: string): Promise<LocaleCounts[]> {
  const rows = rowsOf<{ locale: string; recipients: number; sent: number; delivered: number; unique_opens: number; unique_clicks: number }>(
    await db.execute(sql`
      select cr.locale, count(*)::int as recipients,
        count(m.sent_at)::int as sent, count(m.delivered_at)::int as delivered,
        count(m.opened_at)::int as unique_opens, count(m.clicked_at)::int as unique_clicks
      from campaign_recipients cr left join email_messages m on m.id = cr.email_message_id
      where cr.campaign_id = ${campaignId}::uuid
      group by cr.locale order by cr.locale`),
  );
  return rows.map((r) => ({
    locale: r.locale,
    recipients: Number(r.recipients),
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    uniqueOpens: Number(r.unique_opens),
    uniqueClicks: Number(r.unique_clicks),
  }));
}

async function sendsTimeline(db: DbOrTx, campaignId: string): Promise<TimelineBucket[]> {
  const rows = rowsOf<{ at: string | Date; sent: number }>(
    await db.execute(sql`
      select to_timestamp(floor(extract(epoch from sent_at) / 900) * 900) as at, count(*)::int as sent
      from email_messages where campaign_id = ${campaignId}::uuid and kind = 'campaign' and sent_at is not null
      group by 1 order by 1`),
  );
  return rows.map((r) => ({ at: new Date(r.at).toISOString(), sent: Number(r.sent) }));
}

/** What `email.freeze_campaign_stats` stores: the view row plus the report's aggregates. */
export async function buildSnapshot(db: DbOrTx, campaignId: string, frozenAt: Date): Promise<Record<string, unknown> | null> {
  const live = (await liveStatsRows(db, [campaignId])).get(campaignId);
  if (!live) return null;
  return {
    ...live,
    skipped_by_reason: await skippedByReason(db, campaignId),
    clicks_by_link: await clicksByLink(db, campaignId),
    by_locale: await byLocale(db, campaignId),
    sends_timeline: await sendsTimeline(db, campaignId),
    frozen_at: frozenAt.toISOString(),
  };
}

const REPORT_BOUNCE_LIMIT = 200;

async function bounceRows(db: DbOrTx, campaignId: string, unmasked: boolean): Promise<BounceRow[]> {
  const rows = rowsOf<{ id: string; person_id: string | null; to_email: string | null; bounce_type: "hard" | "soft" | null; complained_at: string | Date | null; bounced_at: string | Date | null }>(
    await db.execute(sql`
      select id, person_id, to_email, bounce_type, complained_at, bounced_at from email_messages
      where campaign_id = ${campaignId}::uuid and kind = 'campaign' and (bounce_type is not null or complained_at is not null)
      order by coalesce(complained_at, bounced_at) desc nulls last, id limit ${REPORT_BOUNCE_LIMIT}`),
  );
  return rows.map((r) => ({
    emailMessageId: r.id,
    personId: r.person_id,
    email: unmasked ? r.to_email : maskEmail(r.to_email),
    kind: r.complained_at ? "complaint" : (r.bounce_type ?? "hard"),
    at: r.complained_at ? new Date(r.complained_at) : r.bounced_at ? new Date(r.bounced_at) : null,
  }));
}

const asArray = <T>(v: unknown): T[] | null => (Array.isArray(v) ? (v as T[]) : null);

export async function getCampaignReport(db: DbOrTx, campaignId: string, opts: { unmasked: boolean } = { unmasked: false }): Promise<CampaignReport | null> {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!c) return null;
  const snap = c.statsSnapshot as Record<string, unknown> | null;
  const row = snap ?? (await liveStatsRows(db, [c.id])).get(c.id) ?? null;
  const stats = statsFromRow(row);
  const skipped = (snap?.skipped_by_reason as Record<string, number> | undefined) ?? (await skippedByReason(db, c.id));
  return {
    campaign: {
      id: c.id,
      name: c.name,
      status: c.status,
      purpose: c.purpose,
      scheduledAt: c.scheduledAt,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      stoppedAt: c.stoppedAt,
    },
    frozenAt: snap ? (typeof snap.frozen_at === "string" ? snap.frozen_at : c.updatedAt.toISOString()) : null,
    stats,
    skippedByReason: skipped,
    notSentStopped: c.status === "stopped" ? stats.planned : 0,
    clicksByLink: (snap && asArray<LinkClicks>(snap.clicks_by_link)) ?? (await clicksByLink(db, c.id)),
    byLocale: (snap && asArray<LocaleCounts>(snap.by_locale)) ?? (await byLocale(db, c.id)),
    timeline: (snap && asArray<TimelineBucket>(snap.sends_timeline)) ?? (await sendsTimeline(db, c.id)),
    bounces: await bounceRows(db, c.id, opts.unmasked),
    attribution: null,
  };
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const REPORT_CSV_COLUMNS = [
  "recipient_id",
  "person_id",
  "email_message_id",
  "locale",
  "recipient_status",
  "message_status",
  "sent_at",
  "delivered_at",
  "opened_at",
  "clicked_at",
  "bounce_type",
  "complained_at",
] as const;

/** One line per recipient: ids, statuses and times (no addresses). */
export async function campaignReportCsv(db: DbOrTx, campaignId: string): Promise<string> {
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select cr.id as recipient_id, cr.person_id, cr.email_message_id, cr.locale, cr.status::text as recipient_status,
        m.status::text as message_status, m.sent_at, m.delivered_at, m.opened_at, m.clicked_at, m.bounce_type::text as bounce_type, m.complained_at
      from campaign_recipients cr left join email_messages m on m.id = cr.email_message_id
      where cr.campaign_id = ${campaignId}::uuid order by cr.chunk_no, cr.id`),
  );
  const lines = [REPORT_CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      REPORT_CSV_COLUMNS.map((k) => {
        const v = r[k];
        return csvCell(v && (k.endsWith("_at") as boolean) ? new Date(v as string) : v);
      }).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
