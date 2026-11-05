/**
 * The campaign audience (email spec rules 8, 27, 29, 31): the live estimate, the snapshot of
 * `campaign.plan`, the manual refresh and the minute dispatch of due campaigns.
 *
 * - `getAudienceEstimate(db, { segmentId, excludeSegmentIds, purpose })`: members of the segment
 *   minus every exclusion segment (`crm.segmentAudienceSql`), split by reachability for the
 *   purpose (`v_marketing_reachability`) and, for the reachable ones, by locale.
 * - `planCampaign(ctx, { campaignId, version })` (job `campaign.plan`): refreshes the segment
 *   (`crm.refreshSegment(..., 'campaign')`) and inserts one `campaign_recipients` row per reachable
 *   person in one `insert ... select`, `chunk_no = floor((row_number - 1) / 500)`; during warm-up
 *   the most recently engaged (latest `opened_at`) come first, otherwise the order is `person_id`.
 *   The last attempt that fails moves the campaign back to `draft` with `last_error`.
 * - `refreshRecipients(ctx, campaign)`: newly qualifying persons are added, `planned` rows that no
 *   longer qualify become `skipped_unreachable`, `removed` and sent rows are never touched, and
 *   chunks are renumbered over the `planned` and `removed` rows.
 * - `dispatchDueCampaigns(ctx)` (schedule `email.dispatch_due_campaigns`): claims due campaigns
 *   with `for update skip locked`, sets `sending` and enqueues one chunk per chunk number.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { campaigns } from "@beam/db/schema";
import { BLOCKED_REASONS, CHUNK_SIZE, isWarmingUp, type BlockedReason, type MarketingPurpose } from "@beam/core/email";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { and, eq, sql, type Ctx, type SQL } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import { refreshSegment, segmentAudienceSql } from "@/modules/crm/api";
import { transitionCampaign, type CampaignRow } from "./campaigns";

/** `campaign.plan`: 3 attempts; the last failure moves the campaign back to `draft` (rule 25). */
export const PLAN_MAX_ATTEMPTS = 3;

export const planJobKey = (campaignId: string, version: number): string => `campaign:${campaignId}:plan:${version}`;

/** `campaign:<id>:chunk:<n>:r<run_no>`, plus `:d<YYYY-MM-DD>` for a warm-up continuation (rule 7). */
export const chunkJobKey = (campaignId: string, chunkNo: number, runNo: number, day?: string): string =>
  `campaign:${campaignId}:chunk:${chunkNo}:r${runNo}${day ? `:d${day}` : ""}`;

export type AudienceEstimate = {
  total: number;
  reachable: number;
  byLocale: Record<Locale, number>;
  blockedByReason: Partial<Record<BlockedReason, number>>;
};

/** The distinct persons of the segment minus the exclusion segments. */
function audienceSql(segmentId: string, excludeSegmentIds: readonly string[]): SQL {
  return sql`select distinct a.person_id from (${segmentAudienceSql(segmentId, [...excludeSegmentIds])}) a`;
}

/**
 * Persons of the audience with their locale and reachability for `purpose`. A person without a
 * reachability row (merged into another) reads as its person row says.
 */
function reachabilitySql(segmentId: string, excludeSegmentIds: readonly string[], purpose: MarketingPurpose): SQL {
  return sql`
    select p.id as person_id, p.locale,
      coalesce(r.is_reachable, false) as is_reachable,
      case when r.person_id is not null then r.blocked_reason
           when p.erased_at is not null then 'erased'
           when p.email is null then 'no_email'
           else 'suppressed' end as blocked_reason
    from (${audienceSql(segmentId, excludeSegmentIds)}) aud
    join persons p on p.id = aud.person_id
    left join v_marketing_reachability r on r.person_id = p.id and r.purpose = ${purpose}`;
}

export async function getAudienceEstimate(
  db: DbOrTx,
  input: { segmentId: string; excludeSegmentIds?: readonly string[]; purpose: MarketingPurpose },
): Promise<AudienceEstimate> {
  const rows = rowsOf<{ locale: string; is_reachable: boolean; blocked_reason: string | null; n: number | string }>(
    await db.execute(sql`
      select x.locale, x.is_reachable, x.blocked_reason, count(*)::int as n
      from (${reachabilitySql(input.segmentId, input.excludeSegmentIds ?? [], input.purpose)}) x
      group by 1, 2, 3`),
  );
  const out: AudienceEstimate = { total: 0, reachable: 0, byLocale: Object.fromEntries(LOCALES.map((l) => [l, 0])) as Record<Locale, number>, blockedByReason: {} };
  for (const r of rows) {
    const n = Number(r.n);
    out.total += n;
    if (r.is_reachable) {
      out.reachable += n;
      if ((LOCALES as readonly string[]).includes(r.locale)) out.byLocale[r.locale as Locale] += n;
    } else {
      const reason = (BLOCKED_REASONS as readonly string[]).includes(r.blocked_reason ?? "") ? (r.blocked_reason as BlockedReason) : "suppressed";
      out.blockedByReason[reason] = (out.blockedByReason[reason] ?? 0) + n;
    }
  }
  return out;
}

/** The locales with at least one reachable person (rule 26: the template must be complete for them). */
export function audienceLocales(estimate: AudienceEstimate): Locale[] {
  return LOCALES.filter((l) => estimate.byLocale[l] > 0);
}

/** Rule 8: the order of recipients before chunks are assigned. */
function orderSql(warmingUp: boolean, personColumn: SQL): SQL {
  return warmingUp
    ? sql`(select max(m.opened_at) from email_messages m where m.person_id = ${personColumn}) desc nulls last, ${personColumn}`
    : sql`${personColumn}`;
}

async function warmingUpOn(tx: DbOrTx, day: Date): Promise<boolean> {
  return isWarmingUp(await getSetting(tx, "warmup_schedule"), day);
}

/** The day the campaign sends (its `scheduled_at`, or now when that is past). */
const sendDay = (c: Pick<CampaignRow, "scheduledAt">, now: Date): Date => (c.scheduledAt && c.scheduledAt > now ? c.scheduledAt : now);

/** Recomputes `recipients_count` and `chunk_count` from the rows. */
async function recount(tx: DbOrTx, campaignId: string): Promise<{ recipients: number; chunks: number }> {
  const [row] = rowsOf<{ recipients: number | string; chunks: number | string }>(
    await tx.execute(sql`
      select count(*)::int as recipients,
        coalesce(max(chunk_no) filter (where status in ('planned', 'removed')) + 1, 0)::int as chunks
      from campaign_recipients where campaign_id = ${campaignId}::uuid`),
  );
  return { recipients: Number(row?.recipients ?? 0), chunks: Number(row?.chunks ?? 0) };
}

/** Rule 27: inserts the snapshot; persons not reachable for the purpose are not inserted. */
export async function snapshotRecipients(tx: Tx, ctx: Pick<Ctx, "now">, c: CampaignRow): Promise<{ recipients: number; chunks: number }> {
  const warm = await warmingUpOn(tx, sendDay(c, ctx.now));
  await tx.execute(sql`
    insert into campaign_recipients (campaign_id, person_id, locale, chunk_no, status)
    select ${c.id}::uuid, x.person_id, x.locale,
      floor((row_number() over (order by ${orderSql(warm, sql`x.person_id`)}) - 1) / ${CHUNK_SIZE})::int, 'planned'
    from (${reachabilitySql(c.segmentId!, c.excludeSegmentIds, c.purpose)}) x
    where x.is_reachable and x.locale in ('nl-BE', 'fr-BE', 'en')
    on conflict (campaign_id, person_id) do nothing`);
  return recount(tx, c.id);
}

/** Renumbers the chunks of the `planned` and `removed` rows (rule 29), keeping the engagement order. */
async function renumberChunks(tx: DbOrTx, c: CampaignRow, now: Date): Promise<void> {
  const warm = await warmingUpOn(tx, sendDay(c, now));
  await tx.execute(sql`
    update campaign_recipients cr set chunk_no = o.chunk_no, updated_at = now()
    from (
      select id, floor((row_number() over (order by ${orderSql(warm, sql`person_id`)}) - 1) / ${CHUNK_SIZE})::int as chunk_no
      from campaign_recipients where campaign_id = ${c.id}::uuid and status in ('planned', 'removed')
    ) o
    where cr.id = o.id and cr.chunk_no <> o.chunk_no`);
}

/** Rule 29: "Refresh audience" while `scheduled`. */
export async function refreshRecipients(tx: Tx, ctx: Ctx, c: CampaignRow): Promise<{ added: number; skipped: number; recipients: number; chunks: number }> {
  await refreshSegment(tx, ctx, c.segmentId!, "campaign");
  const added = rowsOf<{ id: string }>(
    await tx.execute(sql`
      insert into campaign_recipients (campaign_id, person_id, locale, chunk_no, status)
      select ${c.id}::uuid, x.person_id, x.locale, 0, 'planned'
      from (${reachabilitySql(c.segmentId!, c.excludeSegmentIds, c.purpose)}) x
      where x.is_reachable and x.locale in ('nl-BE', 'fr-BE', 'en')
      on conflict (campaign_id, person_id) do nothing
      returning id`),
  ).length;
  const skipped = rowsOf<{ id: string }>(
    await tx.execute(sql`
      update campaign_recipients cr set status = 'skipped_unreachable', updated_at = now()
      where cr.campaign_id = ${c.id}::uuid and cr.status = 'planned'
        and not exists (
          select 1 from (${reachabilitySql(c.segmentId!, c.excludeSegmentIds, c.purpose)}) x
          where x.person_id = cr.person_id and x.is_reachable)
      returning cr.id`),
  ).length;
  await renumberChunks(tx, c, ctx.now);
  return { added, skipped, ...(await recount(tx, c.id)) };
}

// ---------------------------------------------------------------------------
// campaign.plan
// ---------------------------------------------------------------------------

export type PlanResult = { status: "scheduled" | "draft" | "skipped"; recipients?: number; chunks?: number; error?: string };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * The `campaign.plan` handler (rule 27). A campaign that is not `planning` at the version the
 * schedule wrote is left alone, so a second run changes nothing.
 */
export async function planCampaign(ctx: JobCtx, input: { campaignId: string; version: number }): Promise<PlanResult> {
  const tx = ctx.tx;
  const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId)).for("no key update");
  if (!c || c.status !== "planning" || c.version !== input.version) return { status: "skipped" };
  try {
    const counts = await tx.transaction(async (sp) => {
      if (!c.segmentId) throw new Error("segment_required");
      await refreshSegment(sp, ctx, c.segmentId, "campaign");
      return snapshotRecipients(sp, ctx, c);
    });
    await transitionCampaign(ctx, c, "scheduled", {
      recipientsCount: counts.recipients,
      chunkCount: counts.chunks,
      audienceSnapshotAt: ctx.now,
      lastError: null,
    });
    return { status: "scheduled", recipients: counts.recipients, chunks: counts.chunks };
  } catch (error) {
    if (ctx.job.attempt < PLAN_MAX_ATTEMPTS) throw error;
    await transitionCampaign(ctx, c, "draft", { lastError: errorText(error) });
    return { status: "draft", error: errorText(error) };
  }
}

// ---------------------------------------------------------------------------
// email.dispatch_due_campaigns and chunk enqueueing
// ---------------------------------------------------------------------------

/** The chunk numbers that still have `planned` recipients. */
export async function plannedChunks(tx: DbOrTx, campaignId: string): Promise<number[]> {
  const rows = rowsOf<{ chunk_no: number }>(
    await tx.execute(sql`select distinct chunk_no from campaign_recipients where campaign_id = ${campaignId}::uuid and status = 'planned' order by chunk_no`),
  );
  return rows.map((r) => Number(r.chunk_no));
}

/** Enqueues one `campaign.send_chunk` per chunk with planned recipients (bulk lane, priority 9, rule 31). */
export async function enqueueChunks(ctx: Ctx, campaignId: string, runNo: number): Promise<number[]> {
  const chunks = await plannedChunks(ctx.tx, campaignId);
  for (const chunkNo of chunks) {
    await ctx.enqueue({ kind: "campaign.send_chunk", payload: { campaignId, chunkNo, runNo }, key: chunkJobKey(campaignId, chunkNo, runNo), lane: "bulk", priority: 9 });
  }
  return chunks;
}

/** Rule 31: claims due campaigns (`for update skip locked`), sets `sending` and enqueues their chunks. */
export async function dispatchDueCampaigns(ctx: JobCtx): Promise<{ dispatched: string[] }> {
  const due = await ctx.tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.status, "scheduled"), sql`${campaigns.scheduledAt} <= ${ctx.now}`))
    .orderBy(campaigns.scheduledAt)
    .for("no key update", { skipLocked: true });
  const dispatched: string[] = [];
  for (const c of due) {
    const sending = await transitionCampaign(ctx, c, "sending", { startedAt: ctx.now });
    const chunks = await enqueueChunks(ctx, c.id, sending.runNo);
    if (!chunks.length) await transitionCampaign(ctx, sending, "sent", { finishedAt: ctx.now });
    dispatched.push(c.id);
  }
  return { dispatched };
}
