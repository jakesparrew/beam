/**
 * email views (email spec section 2 "Views", email-P3). Each view is `pgView(name, columns)
 * .existing()` with its SQL exported beside it as `<name>Sql`; `pnpm db:views` writes the
 * migration and `createTestDb()` applies the same SQL (DM-1).
 *
 * - `v_marketing_reachability`: one row per (non-merged) person and marketing purpose. The
 *   suppression logic, including "only a newer form, portal or preference_centre grant lifts a
 *   scoped unsubscribe", lives once in crm's `v_suppression_status`; this view only orders the
 *   reasons exactly as `resolveReachability()` (`@beam/core/email`) does.
 * - `v_campaign_stats`: the per-campaign counters and rates of the campaign report (rule 61).
 *   `v_email_attribution` (R3) is added by email-P9.
 */
import { boolean, integer, numeric, pgView, text, uuid } from "drizzle-orm/pg-core";

export type ReachabilityPurpose = "newsletter" | "events" | "member_comms" | "b2b";
export type ReachabilityBlockedReason = "erased" | "no_email" | "restricted" | "suppressed" | "withdrawn" | "no_consent";

// ---------------------------------------------------------------------------
// v_marketing_reachability
// ---------------------------------------------------------------------------

export const vMarketingReachabilitySql = `with base as (
  select p.id as person_id, ss.purpose,
    case
      when p.erased_at is not null then 'erased'
      when p.email is null then 'no_email'
      when p.processing_restricted_at is not null then 'restricted'
      when ss.is_suppressed then 'suppressed'
      when c.status = 'withdrawn' then 'withdrawn'
      when c.status = 'granted' then null
      else 'no_consent'
    end as blocked_reason
  from persons p
  join v_suppression_status ss on ss.person_id = p.id
  left join v_consent_current c on c.person_id = p.id and c.purpose::text = ss.purpose
  where p.merged_into_person_id is null
)
select person_id, purpose, blocked_reason, blocked_reason is null as is_reachable from base`;

export const vMarketingReachability = pgView("v_marketing_reachability", {
  personId: uuid("person_id").notNull(),
  purpose: text("purpose").$type<ReachabilityPurpose>().notNull(),
  blockedReason: text("blocked_reason").$type<ReachabilityBlockedReason>(),
  isReachable: boolean("is_reachable").notNull(),
}).existing();

// ---------------------------------------------------------------------------
// v_campaign_stats
// ---------------------------------------------------------------------------

/**
 * `unsubscribed` (decision 22): a campaign message whose one-click suppression names it
 * (`source = 'one_click:<email_message_id>'`), or, for paths that name no message, an
 * `unsubscribe` suppression of scope `all` or the campaign purpose for the person's
 * `email_hash` created within 7 days after `sent_at`.
 */
export const vCampaignStatsSql = `with r as (
  select cr.campaign_id,
    count(*)::int as recipients,
    count(*) filter (where cr.status = 'planned')::int as planned,
    count(*) filter (where cr.status = 'removed')::int as removed,
    count(*) filter (where cr.status::text like 'skipped%')::int as skipped
  from campaign_recipients cr group by cr.campaign_id
), mf as (
  select m.campaign_id, m.sent_at, m.delivered_at, m.bounce_type, m.complained_at, m.opened_at, m.clicked_at,
    (select e.payload->>'ua_family' from email_events e
      where e.email_message_id = m.id and e.type = 'opened' order by e.occurred_at, e.created_at limit 1) as first_open_ua,
    (m.sent_at is not null and exists (
      select 1 from suppressions s where s.reason = 'unsubscribe' and (
        s.source = 'one_click:' || m.id::text
        or (s.email_hash = p.email_hash and (s.scope = 'all' or s.scope::text = c.purpose::text)
            and s.created_at >= m.sent_at and s.created_at <= m.sent_at + interval '7 days')))) as is_unsubscribed
  from email_messages m
  join campaigns c on c.id = m.campaign_id
  left join persons p on p.id = m.person_id
  where m.kind = 'campaign'
), m as (
  select campaign_id,
    count(*) filter (where sent_at is not null)::int as sent,
    count(*) filter (where delivered_at is not null)::int as delivered,
    count(*) filter (where bounce_type = 'hard')::int as hard_bounced,
    count(*) filter (where bounce_type = 'soft')::int as soft_bounced,
    count(*) filter (where complained_at is not null)::int as complained,
    count(*) filter (where opened_at is not null)::int as unique_opens,
    count(*) filter (where first_open_ua = 'apple_mpp')::int as privacy_proxy_opens,
    count(*) filter (where clicked_at is not null)::int as unique_clicks,
    count(*) filter (where is_unsubscribed)::int as unsubscribed
  from mf group by campaign_id
), t as (
  select c.id as campaign_id,
    coalesce(r.recipients, 0) as recipients, coalesce(r.planned, 0) as planned, coalesce(r.removed, 0) as removed,
    coalesce(r.skipped, 0) as skipped, coalesce(m.sent, 0) as sent, coalesce(m.delivered, 0) as delivered,
    coalesce(m.hard_bounced, 0) as hard_bounced, coalesce(m.soft_bounced, 0) as soft_bounced,
    coalesce(m.complained, 0) as complained, coalesce(m.unique_opens, 0) as unique_opens,
    coalesce(m.privacy_proxy_opens, 0) as privacy_proxy_opens, coalesce(m.unique_clicks, 0) as unique_clicks,
    coalesce(m.unsubscribed, 0) as unsubscribed
  from campaigns c
  left join r on r.campaign_id = c.id
  left join m on m.campaign_id = c.id
)
select t.*,
  round(unique_opens::numeric / nullif(delivered, 0), 4)::numeric(6,4) as open_rate,
  round(unique_clicks::numeric / nullif(delivered, 0), 4)::numeric(6,4) as click_rate,
  round(unique_clicks::numeric / nullif(unique_opens, 0), 4)::numeric(6,4) as click_to_open_rate,
  round(hard_bounced::numeric / nullif(sent, 0), 4)::numeric(6,4) as bounce_rate,
  round(complained::numeric / nullif(delivered, 0), 4)::numeric(6,4) as complaint_rate,
  round(unsubscribed::numeric / nullif(delivered, 0), 4)::numeric(6,4) as unsubscribe_rate
from t`;

export const vCampaignStats = pgView("v_campaign_stats", {
  campaignId: uuid("campaign_id").notNull(),
  recipients: integer("recipients").notNull(),
  planned: integer("planned").notNull(),
  removed: integer("removed").notNull(),
  skipped: integer("skipped").notNull(),
  sent: integer("sent").notNull(),
  delivered: integer("delivered").notNull(),
  hardBounced: integer("hard_bounced").notNull(),
  softBounced: integer("soft_bounced").notNull(),
  complained: integer("complained").notNull(),
  uniqueOpens: integer("unique_opens").notNull(),
  privacyProxyOpens: integer("privacy_proxy_opens").notNull(),
  uniqueClicks: integer("unique_clicks").notNull(),
  unsubscribed: integer("unsubscribed").notNull(),
  openRate: numeric("open_rate", { precision: 6, scale: 4 }),
  clickRate: numeric("click_rate", { precision: 6, scale: 4 }),
  clickToOpenRate: numeric("click_to_open_rate", { precision: 6, scale: 4 }),
  bounceRate: numeric("bounce_rate", { precision: 6, scale: 4 }),
  complaintRate: numeric("complaint_rate", { precision: 6, scale: 4 }),
  unsubscribeRate: numeric("unsubscribe_rate", { precision: 6, scale: 4 }),
}).existing();
