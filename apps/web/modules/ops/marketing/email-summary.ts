/**
 * The email performance summary (ops spec 5, `/admin/reports/marketing`, R3): per campaign with
 * messages sent in the range, the sent, delivered, opened, clicked, bounced, complained and
 * unsubscribed counts and their rates, plus the total. Read straight from `email_messages`
 * (ops reads email's tables, spec 2.3); `getCampaignStats` is not needed for a range.
 *
 * Rates: delivery, bounce = over sent; open, click, complaint, unsubscribe = over delivered. An
 * unsubscribe is a withdrawn `unsubscribe_link` consent record of the recipient that names the
 * message (`one_click:<message_id>`) or, for the preference-centre link, falls within 30 days
 * after the send. Test recipients are excluded.
 */
import type { DbOrTx } from "@beam/db";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { inRange, type DateRange } from "../reports/no-shows";

export const EMAIL_SUMMARY_ROWS = 50;

export type EmailCounts = { sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; unsubscribed: number };
export type EmailRates = { deliveryRate: number | null; openRate: number | null; clickRate: number | null; bounceRate: number | null; complaintRate: number | null; unsubscribeRate: number | null };
export type EmailCampaignRow = { campaignId: string; name: string; purpose: string; startedAt: Date | null } & EmailCounts & EmailRates;
export type EmailSummary = { range: DateRange; campaigns: EmailCampaignRow[]; total: EmailCounts & EmailRates; more: boolean };

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export function emailRates(c: EmailCounts): EmailRates {
  return {
    deliveryRate: ratio(c.delivered, c.sent),
    openRate: ratio(c.opened, c.delivered),
    clickRate: ratio(c.clicked, c.delivered),
    bounceRate: ratio(c.bounced, c.sent),
    complaintRate: ratio(c.complained, c.delivered),
    unsubscribeRate: ratio(c.unsubscribed, c.delivered),
  };
}

type Raw = { campaign_id: string; name: string; purpose: string; started_at: string | Date | null } & Record<keyof EmailCounts, number | string>;

const countsOf = (r: Record<keyof EmailCounts, number | string>): EmailCounts => ({
  sent: Number(r.sent),
  delivered: Number(r.delivered),
  opened: Number(r.opened),
  clicked: Number(r.clicked),
  bounced: Number(r.bounced),
  complained: Number(r.complained),
  unsubscribed: Number(r.unsubscribed),
});

/** Campaign performance of the range, most recent campaigns first (at most 50 rows). */
export async function computeEmailSummary(db: DbOrTx, input: { range: DateRange; limit?: number }): Promise<EmailSummary> {
  const limit = input.limit ?? EMAIL_SUMMARY_ROWS;
  const rows = rowsOf<Raw>(
    await db.execute(sql`with m as (
        select em.id, em.campaign_id, em.sent_at, em.delivered_at, em.opened_at, em.clicked_at, em.complained_at,
          (em.bounced_at is not null or em.status = 'bounced') as bounced,
          exists (select 1 from consent_records cr where cr.person_id = em.person_id and cr.method = 'unsubscribe_link' and cr.status = 'withdrawn'
                    and (cr.source = 'one_click:' || em.id::text
                         or (cr.source = 'unsubscribe_link' and cr.recorded_at >= em.sent_at and cr.recorded_at < em.sent_at + interval '30 days'))) as unsubscribed
        from email_messages em left join persons pe on pe.id = em.person_id
        where em.kind = 'campaign' and em.campaign_id is not null and em.sent_at is not null
          and coalesce(pe.is_tester, false) = false and ${inRange(sql`em.sent_at`, input.range)}
      )
      select c.id as campaign_id, c.name, c.purpose::text as purpose, c.started_at,
        count(*)::int as sent, count(m.delivered_at)::int as delivered, count(m.opened_at)::int as opened, count(m.clicked_at)::int as clicked,
        count(*) filter (where m.bounced)::int as bounced, count(m.complained_at)::int as complained, count(*) filter (where m.unsubscribed)::int as unsubscribed
      from m join campaigns c on c.id = m.campaign_id
      group by c.id, c.name, c.purpose, c.started_at
      order by min(m.sent_at) desc, c.id
      limit ${limit + 1}`),
  );
  const [t] = rowsOf<Record<keyof EmailCounts, number | string>>(
    await db.execute(sql`select count(*)::int as sent, count(em.delivered_at)::int as delivered, count(em.opened_at)::int as opened, count(em.clicked_at)::int as clicked,
        count(*) filter (where em.bounced_at is not null or em.status = 'bounced')::int as bounced, count(em.complained_at)::int as complained,
        count(*) filter (where exists (select 1 from consent_records cr where cr.person_id = em.person_id and cr.method = 'unsubscribe_link' and cr.status = 'withdrawn'
                    and (cr.source = 'one_click:' || em.id::text
                         or (cr.source = 'unsubscribe_link' and cr.recorded_at >= em.sent_at and cr.recorded_at < em.sent_at + interval '30 days'))))::int as unsubscribed
      from email_messages em left join persons pe on pe.id = em.person_id
      where em.kind = 'campaign' and em.campaign_id is not null and em.sent_at is not null
        and coalesce(pe.is_tester, false) = false and ${inRange(sql`em.sent_at`, input.range)}`),
  );
  const total = countsOf(t!);
  return {
    range: input.range,
    campaigns: rows.slice(0, limit).map((r) => {
      const c = countsOf(r);
      return { campaignId: r.campaign_id, name: r.name, purpose: r.purpose, startedAt: r.started_at ? new Date(r.started_at) : null, ...c, ...emailRates(c) };
    }),
    total: { ...total, ...emailRates(total) },
    more: rows.length > limit,
  };
}

export const EMAIL_CSV_COLUMNS = ["campaign_id", "campaign", "purpose", "sent", "delivered", "opened", "clicked", "bounced", "complained", "unsubscribed"] as const;

export function emailCsvRowOf(r: EmailCampaignRow): unknown[] {
  return [r.campaignId, r.name, r.purpose, r.sent, r.delivered, r.opened, r.clicked, r.bounced, r.complained, r.unsubscribed];
}
