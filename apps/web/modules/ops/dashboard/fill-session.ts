/**
 * "Fill this session" (owner requirements 6, marketing opportunities): the people likely to book a
 * session with free places, and a campaign draft aimed at them. Nothing is ever sent from here:
 * staff open the draft, write it and schedule it on the campaign page as any other campaign.
 *
 * The audience of a session, each person with the reasons they are in it:
 * - `credits`: unused credits of the session's kind (day or night), from `v_person_credits`;
 * - `lapsed_regular`: at least 3 past visits of the same kind and no booking of that kind
 *   (past or upcoming) in the last 42 days;
 * - `waitlist`: on a waiting list of a session of the same kind starting in the last 30 days or later.
 * Always left out: testers, erased and merged persons, people already booked on the session, and
 * anyone not reachable for the campaign's purpose in email's `v_marketing_reachability` (no
 * marketing consent, suppressed, restricted, no email). The purpose is `events` for an event,
 * else `newsletter`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import type { MarketingPurpose } from "@beam/core/email";
import { t, type Locale } from "@beam/core/i18n";
import { NotFoundError, sql, ValidationError, type Ctx, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { createStaticSegment } from "@/modules/crm/api";
import { createCampaignDraft } from "@/modules/email/api";

export const REGULAR_MIN_VISITS = 3;
export const LAPSED_AFTER_DAYS = 42;
export const WAITLIST_LOOKBACK_DAYS = 30;

export const FILL_REASONS = ["credits", "lapsed_regular", "waitlist"] as const;
export type FillReason = (typeof FILL_REASONS)[number];

type FillSession = { id: string; kind: "day" | "night" | "event"; credit_kind: "day" | "night" | null; starts_at: string | Date; title: Record<string, string> | string; status: string };

export const fillPurpose = (kind: FillSession["kind"]): MarketingPurpose => (kind === "event" ? "events" : "newsletter");

async function loadSession(db: DbOrTx, sessionId: string): Promise<FillSession> {
  const [s] = rowsOf<FillSession>(await db.execute(sql`select id, kind, credit_kind, starts_at, title, status from sessions where id = ${sessionId}::uuid`));
  if (!s) throw new NotFoundError("session_not_found");
  return s;
}

/** `select person_id, reasons` of the session's audience (see the file comment). */
function audienceSql(s: FillSession, now: Date): SQL {
  const at = sql`${now.toISOString()}::timestamptz`;
  const credits = s.credit_kind
    ? sql`select pc.person_id, 'credits' as reason from v_person_credits pc where pc.credit_kind::text = ${s.credit_kind} and pc.remaining_units > 0`
    : sql`select null::uuid as person_id, 'credits' as reason where false`;
  return sql`
    with cand as (
      ${credits}
      union all
      select b.person_id, 'lapsed_regular' from bookings b join sessions bs on bs.id = b.session_id
      where bs.kind::text = ${s.kind} and b.status in ('reserved', 'confirmed', 'attended', 'no_show')
      group by b.person_id
      having count(*) filter (where b.status in ('confirmed', 'attended') and bs.starts_at < ${at}) >= ${REGULAR_MIN_VISITS}
         and max(bs.starts_at) < ${at} - ${LAPSED_AFTER_DAYS}::int * interval '1 day'
      union all
      select w.person_id, 'waitlist' from waitlist_entries w join sessions ws on ws.id = w.session_id
      where ws.kind::text = ${s.kind} and w.state in ('waiting', 'offered', 'expired', 'released')
        and ws.starts_at >= ${at} - ${WAITLIST_LOOKBACK_DAYS}::int * interval '1 day'
    )
    select c.person_id, array_agg(distinct c.reason order by c.reason) as reasons
    from cand c
    join persons p on p.id = c.person_id
    join v_marketing_reachability r on r.person_id = c.person_id and r.purpose = ${fillPurpose(s.kind)} and r.is_reachable
    where p.is_tester = false and p.erased_at is null and p.merged_into_person_id is null
      and not exists (select 1 from bookings x where x.person_id = c.person_id and x.session_id = ${s.id}::uuid
                      and x.status in ('reserved', 'confirmed', 'attended', 'no_show'))
    group by c.person_id`;
}

export type FillAudience = { sessionId: string; purpose: MarketingPurpose; total: number; byReason: Record<FillReason, number> };

async function audienceRows(db: DbOrTx, s: FillSession, now: Date): Promise<{ person_id: string; reasons: string[] | string }[]> {
  return rowsOf(await db.execute(sql`select a.person_id, a.reasons from (${audienceSql(s, now)}) a order by a.person_id`));
}

const reasonsOf = (v: string[] | string): string[] => (Array.isArray(v) ? v : v.replace(/[{}]/g, "").split(",").filter(Boolean));

/** The size of the session's audience, in total and per reason (one person can have several). */
export async function getFillAudience(db: DbOrTx, input: { sessionId: string; now: Date }): Promise<FillAudience> {
  const s = await loadSession(db, input.sessionId);
  const rows = await audienceRows(db, s, input.now);
  const byReason = Object.fromEntries(FILL_REASONS.map((r) => [r, 0])) as Record<FillReason, number>;
  for (const row of rows) for (const r of reasonsOf(row.reasons)) if (r in byReason) byReason[r as FillReason] += 1;
  return { sessionId: s.id, purpose: fillPurpose(s.kind), total: rows.length, byReason };
}

/**
 * A static crm segment holding the audience as it is now, and an email campaign draft aimed at
 * it (both named after the session, in the staff member's language). Refuses a session that is
 * not open or already started, and an empty audience.
 */
export async function createFillDraft(tx: Tx, ctx: Ctx, input: { sessionId: string; locale: Locale }): Promise<{ campaignId: string; segmentId: string; recipients: number }> {
  const s = await loadSession(tx, input.sessionId);
  if (s.status !== "open" || new Date(s.starts_at).getTime() <= ctx.now.getTime()) throw new ValidationError("session_not_open", { sessionId: "session_not_open" });
  const personIds = (await audienceRows(tx, s, ctx.now)).map((r) => r.person_id);
  if (!personIds.length) throw new ValidationError("audience_empty", { sessionId: "audience_empty" });
  const titles = typeof s.title === "string" ? (JSON.parse(s.title) as Record<string, string>) : s.title;
  const when = new Intl.DateTimeFormat(input.locale, { timeZone: "Europe/Brussels", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(s.starts_at));
  const name = t(input.locale, "ops.dashboard.daily.campaign_name", { title: titles[input.locale] ?? titles["nl-BE"] ?? "", when }).slice(0, 160);
  const { segmentId, count } = await createStaticSegment(tx, ctx, { name, description: t(input.locale, "ops.dashboard.daily.segment_description"), personIds });
  const { campaignId } = await createCampaignDraft(ctx, { name, purpose: fillPurpose(s.kind), segmentId });
  return { campaignId, segmentId, recipients: count };
}
