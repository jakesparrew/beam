/**
 * R4 AI-assisted campaign creation (email spec sections 4 and 6, decision 47), email-P10.
 *
 * - `requestAiDraftRecord` (`requestAiDraft`, `email.write` + `ai.use`): an `email_ai_drafts` row
 *   in `queued` and one `ai.draft_email` job (key `ai:draft:<draft_id>`). Audited
 *   `email.ai_draft_request`.
 * - `runDraftEmail` (job `ai.draft_email`, fast / 5, 2 attempts): builds the non-personal context
 *   (`settings.email_brand`, the last 5 sent campaigns of the purpose with open and click rates,
 *   `booking.getSessionCards()` per locale, `crm.getSegmentSummaries()` names and counts and, for
 *   the chosen segment, counts per commercial status and language and the median days since the
 *   last visit), calls `callClaude` (`ai.draft_email`, opus, `AiCampaignDraftSchema`) and stores the
 *   draft as `ready`. A budget stop, a refusal, invalid output on the last attempt or a provider
 *   failure on the last attempt store `failed` with the error code; nothing else is written.
 * - `acceptAiDraftRecord` (`acceptAiDraft`, `email.write` + `ai.use`): a ready draft becomes a
 *   `draft` campaign (or the content of the draft campaign it was requested for) whose template
 *   draft version carries the AI subject, preheader and document with `ai_draft_id`. The campaign
 *   is never scheduled: scheduling stays a human action with `campaigns.send`.
 * - `discardAiDraftRecord` (`discardAiDraft`, `email.write`).
 *
 * The gateway's `fieldsSent` is `[]`: `ai.draft_email` allows no person field (PL-53) and the
 * context holds none. The context keys (`buildDraftPrompt().fieldsSent`) are part of the stored
 * prompt (`ai_requests.prompt`).
 */
import { z } from "zod";
import type { DbOrTx } from "@beam/db";
import { campaigns, emailAiDrafts, emailTemplates, emailTemplateVersions, type EmailAiDraftInputs } from "@beam/db/schema";
import { MARKETING_PURPOSES, type MarketingPurpose } from "@beam/core/email";
import { PermanentError, RetryableError } from "@beam/core/errors";
import { LOCALES } from "@beam/core/i18n";
import { callClaude } from "@/lib/ai";
import { and, desc, eq, inArray, NotFoundError, sql, ValidationError, writeDurably, type Ctx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import { getSessionCards } from "@/modules/booking/api";
import { getSegmentSummaries, segmentAudienceSql } from "@/modules/crm/api";
import {
  AI_DRAFT_MAX_SESSIONS,
  AI_DRAFT_PREVIOUS_CAMPAIGNS,
  AiCampaignDraftSchema,
  buildDraftPrompt,
  draftDocumentIssues,
  type AiCampaignDraft,
  type DraftBrand,
  type DraftPreviousCampaign,
  type DraftSegmentAggregate,
  type DraftSession,
} from "../../../../../packages/core/src/email/ai";
import { campaignVersionPatch, createCampaignRecord, lockCampaign } from "./campaigns";
import { getCampaignStats } from "./reports";
import { draftVersionOf, saveTemplateDraftRecord, versionById } from "./templates";

/** The job kind and the `callClaude` feature key (platform-P3 request; email jobs.ts). */
export const AI_DRAFT_JOB_KIND = "ai.draft_email" as const;
export const AI_DRAFT_FEATURE = "ai.draft_email" as const;
/** Spec section 4 "Jobs": 2 attempts. */
export const AI_DRAFT_MAX_ATTEMPTS = 2;
export const AI_DRAFT_MAX_TOKENS = 8000;

export const aiDraftJobKey = (draftId: string): string => `ai:draft:${draftId}`;

export const RequestAiDraftInput = z.object({
  brief: z.string().trim().min(10).max(4000),
  sessionIds: z.array(z.uuid()).max(AI_DRAFT_MAX_SESSIONS).default([]),
  segmentId: z.uuid().nullish(),
  purpose: z.enum(MARKETING_PURPOSES),
  campaignId: z.uuid().optional(),
});
export const AcceptAiDraftInput = z.object({ draftId: z.uuid(), campaignName: z.string().trim().min(1).max(160) });
export const DiscardAiDraftInput = z.object({ draftId: z.uuid() });
export const DraftEmailJobInput = z.object({ draftId: z.uuid() });

export type RequestAiDraftInput = z.input<typeof RequestAiDraftInput>;
export type AiDraftRow = typeof emailAiDrafts.$inferSelect;

const staffUserId = (ctx: Ctx): string => {
  if (ctx.actor.kind !== "staff") throw new ValidationError("staff_required", { actor: "staff_required" });
  return ctx.actor.userId;
};

async function lockDraft(tx: DbOrTx, draftId: string): Promise<AiDraftRow> {
  const [row] = await tx.select().from(emailAiDrafts).where(eq(emailAiDrafts.id, draftId)).for("update");
  if (!row) throw new NotFoundError("ai_draft_not_found");
  return row;
}

async function activeSegment(tx: DbOrTx, segmentId: string): Promise<{ id: string; name: string } | null> {
  const list = await getSegmentSummaries(tx);
  return list.find((s) => s.id === segmentId) ?? null;
}

// ---------------------------------------------------------------------------
// requestAiDraft
// ---------------------------------------------------------------------------

export async function requestAiDraftRecord(ctx: Ctx, raw: RequestAiDraftInput): Promise<{ draftId: string; jobId: string }> {
  ctx.require("ai.use");
  const input = RequestAiDraftInput.parse(raw);
  const userId = staffUserId(ctx);
  const tx = ctx.tx;
  const sessionIds = [...new Set(input.sessionIds)];
  const segmentId = input.segmentId ?? null;
  if (segmentId && !(await activeSegment(tx, segmentId))) throw new ValidationError("segment_not_found", { segmentId: "segment_not_found" });
  if (input.campaignId) {
    const [c] = await tx.select({ status: campaigns.status, purpose: campaigns.purpose }).from(campaigns).where(eq(campaigns.id, input.campaignId));
    if (!c) throw new NotFoundError("campaign_not_found");
    if (c.status !== "draft") throw new ValidationError("campaign_not_draft", { campaignId: "campaign_not_draft" });
    if (c.purpose !== input.purpose) throw new ValidationError("purpose_mismatch", { purpose: "purpose_mismatch" });
  }
  const inputs: EmailAiDraftInputs = { sessionIds, segmentId, purpose: input.purpose, locales: [...LOCALES] };
  const [row] = await tx
    .insert(emailAiDrafts)
    .values({ brief: input.brief, inputs, status: "queued", campaignId: input.campaignId ?? null, createdByUserId: userId })
    .returning({ id: emailAiDrafts.id });
  const draftId = row!.id;
  const job = await ctx.enqueue({ kind: AI_DRAFT_JOB_KIND, payload: { draftId }, key: aiDraftJobKey(draftId), lane: "fast", priority: 5, maxAttempts: AI_DRAFT_MAX_ATTEMPTS });
  await ctx.audit({
    action: "email.ai_draft_request",
    entityType: "email_ai_draft",
    entityId: draftId,
    newValue: { purpose: input.purpose, session_ids: sessionIds, segment_id: segmentId, campaign_id: input.campaignId ?? null, status: "queued" },
  });
  return { draftId, jobId: job.id };
}

// ---------------------------------------------------------------------------
// Context (aggregates only)
// ---------------------------------------------------------------------------

/** The last sent campaigns of `purpose`: subject, preheader and Dutch text of their sent version. */
export async function previousCampaigns(tx: DbOrTx, purpose: MarketingPurpose, limit = AI_DRAFT_PREVIOUS_CAMPAIGNS): Promise<DraftPreviousCampaign[]> {
  const rows = await tx
    .select({ id: campaigns.id, name: campaigns.name, finishedAt: campaigns.finishedAt, v: emailTemplateVersions })
    .from(campaigns)
    .innerJoin(emailTemplateVersions, eq(emailTemplateVersions.id, campaigns.templateVersionId))
    .where(and(eq(campaigns.purpose, purpose), inArray(campaigns.status, ["sent", "stopped"])))
    .orderBy(sql`${campaigns.finishedAt} desc nulls last`, desc(campaigns.createdAt))
    .limit(limit);
  const stats = new Map((await getCampaignStats(tx, rows.map((r) => r.id))).map((s) => [s.campaignId, s]));
  return rows.map((r) => {
    const s = stats.get(r.id);
    const base = s ? Math.max(s.delivered, 0) : 0;
    const texts = r.v.textByLocale?.["nl-BE"] ?? {};
    const text = texts["default"] ?? Object.values(texts)[0] ?? "";
    return {
      name: r.name,
      subject: r.v.subject["nl-BE"] ?? "",
      preheader: r.v.preheader["nl-BE"] ?? "",
      text,
      sentAt: r.finishedAt,
      openRate: base > 0 ? s!.opened / base : null,
      clickRate: base > 0 ? s!.clicked / base : null,
    };
  });
}

/** Session cards of the chosen sessions with their title per locale (a missing title is left out). */
export async function draftSessions(tx: DbOrTx, sessionIds: readonly string[]): Promise<DraftSession[]> {
  if (!sessionIds.length) return [];
  const byId = new Map<string, DraftSession>();
  for (const locale of LOCALES) {
    let cards;
    try {
      cards = await getSessionCards(tx, [...sessionIds], locale);
    } catch {
      continue; // a title missing in this locale: the other locales still describe the session
    }
    for (const c of cards) {
      const existing = byId.get(c.sessionId);
      if (existing) existing.title[locale] = c.title;
      else
        byId.set(c.sessionId, {
          sessionId: c.sessionId,
          title: { [locale]: c.title },
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          location: c.location,
          isMemberOnly: c.isMemberOnly,
          isLeadMagnet: c.isLeadMagnet,
          availabilityBand: c.availabilityBand,
        });
    }
  }
  return sessionIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/** Counts of the segment's audience per commercial status and language, and the median days since the last visit. */
export async function segmentAggregate(tx: DbOrTx, segment: { id: string; name: string }, now: Date): Promise<DraftSegmentAggregate> {
  const [row] = rowsOf<{ total: number; lead: number; customer: number; member: number; nl: number; fr: number; en: number; median_days: number | string | null }>(
    await tx.execute(sql`
      with a as (select distinct person_id from (${segmentAudienceSql(segment.id)}) s)
      select
        count(*)::int as total,
        count(*) filter (where coalesce(st.status, 'lead') = 'lead')::int as lead,
        count(*) filter (where st.status = 'customer')::int as customer,
        count(*) filter (where st.status = 'member')::int as member,
        count(*) filter (where p.locale = 'nl-BE')::int as nl,
        count(*) filter (where p.locale = 'fr-BE')::int as fr,
        count(*) filter (where p.locale = 'en')::int as en,
        percentile_cont(0.5) within group (order by extract(epoch from (${now}::timestamptz - ps.last_visit_at)) / 86400.0)
          filter (where ps.last_visit_at is not null) as median_days
      from a
      join persons p on p.id = a.person_id
      left join v_person_status st on st.person_id = a.person_id
      left join person_stats ps on ps.person_id = a.person_id`),
  );
  const n = (v: unknown) => Number(v ?? 0);
  return {
    id: segment.id,
    name: segment.name,
    total: n(row?.total),
    byStatus: { lead: n(row?.lead), customer: n(row?.customer), member: n(row?.member) },
    byLocale: { "nl-BE": n(row?.nl), "fr-BE": n(row?.fr), en: n(row?.en) },
    medianDaysSinceLastVisit: row?.median_days === null || row?.median_days === undefined ? null : Math.round(Number(row.median_days)),
  };
}

const DEFAULT_BRAND: DraftBrand = { tone_of_voice: "", guidelines: "", do_not_say: [], sample_phrases: [] };

/** Everything `buildDraftPrompt` needs for a draft row. */
export async function draftPromptFor(tx: DbOrTx, draft: Pick<AiDraftRow, "brief" | "inputs">, now: Date) {
  const brand = ((await getSetting(tx, "email_brand")) as DraftBrand | null) ?? DEFAULT_BRAND;
  const list = await getSegmentSummaries(tx);
  const chosen = draft.inputs.segmentId ? list.find((s) => s.id === draft.inputs.segmentId) : undefined;
  return buildDraftPrompt({
    brand,
    previousCampaigns: await previousCampaigns(tx, draft.inputs.purpose),
    sessions: await draftSessions(tx, draft.inputs.sessionIds),
    segments: {
      list: list.map((s) => ({ id: s.id, name: s.name, description: s.description, count: s.lastCount })),
      chosen: chosen ? await segmentAggregate(tx, chosen, now) : null,
    },
    purpose: draft.inputs.purpose,
    brief: draft.brief,
    now,
  });
}

// ---------------------------------------------------------------------------
// Job ai.draft_email
// ---------------------------------------------------------------------------

export type DraftEmailResult = { status: "ready"; aiRequestId: string } | { status: "failed"; error: string } | { status: "skipped"; current: string } | { status: "missing" };

const errorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "ai_unavailable").slice(0, 200);
};

async function markFailed(tx: DbOrTx, draftId: string, error: string, now: Date): Promise<void> {
  await tx
    .update(emailAiDrafts)
    .set({ status: "failed", error, updatedAt: now })
    .where(and(eq(emailAiDrafts.id, draftId), eq(emailAiDrafts.status, "queued")));
}

export async function runDraftEmail(ctx: JobCtx, input: z.infer<typeof DraftEmailJobInput>): Promise<DraftEmailResult> {
  const [draft] = await ctx.tx.select().from(emailAiDrafts).where(eq(emailAiDrafts.id, input.draftId)).for("update");
  if (!draft) return { status: "missing" };
  if (draft.status !== "queued") return { status: "skipped", current: draft.status };
  const lastAttempt = ctx.job.attempt >= AI_DRAFT_MAX_ATTEMPTS;

  let result: { parsed: AiCampaignDraft; aiRequestId: string };
  try {
    const prompt = await draftPromptFor(ctx.tx, draft, ctx.now);
    result = await callClaude(ctx, {
      feature: AI_DRAFT_FEATURE,
      model: "opus",
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      fieldsSent: [],
      outputSchema: AiCampaignDraftSchema,
      maxTokens: AI_DRAFT_MAX_TOKENS,
    });
  } catch (error) {
    // Edge case 21 and provider outages: retry while attempts remain; then the draft is failed.
    if (!(error instanceof PermanentError) && !lastAttempt) throw error;
    const code = error instanceof PermanentError ? errorCode(error) : "ai_unavailable";
    await markFailed(ctx.tx, draft.id, code, ctx.now);
    return { status: "failed", error: code };
  }

  const issues = draftDocumentIssues(result.parsed.document, draft.inputs.sessionIds);
  if (issues.length) {
    if (!lastAttempt) throw new RetryableError(`invalid_output: ${issues.slice(0, 3).join("; ")}`);
    await markFailed(ctx.tx, draft.id, "invalid_output", ctx.now);
    return { status: "failed", error: "invalid_output" };
  }

  await ctx.tx
    .update(emailAiDrafts)
    .set({ status: "ready", output: result.parsed, error: null, updatedAt: ctx.now })
    .where(eq(emailAiDrafts.id, draft.id));
  // `ai_requests` is written durably after the job's transaction; the link follows it there.
  const aiRequestId = result.aiRequestId;
  await writeDurably(ctx, async (db) => {
    await db.update(emailAiDrafts).set({ aiRequestId }).where(eq(emailAiDrafts.id, draft.id));
  });
  return { status: "ready", aiRequestId };
}

/** Dead letter (retries ran out, a lock went stale): the draft is `failed`. */
export async function onDraftEmailDead(ctx: JobCtx, input: z.infer<typeof DraftEmailJobInput>): Promise<void> {
  await markFailed(ctx.tx, input.draftId, "ai_unavailable", ctx.now);
}

// ---------------------------------------------------------------------------
// acceptAiDraft, discardAiDraft
// ---------------------------------------------------------------------------

/** The stored output of a ready draft, re-checked against the schema. */
export function draftOutput(row: Pick<AiDraftRow, "output">): AiCampaignDraft | null {
  const parsed = AiCampaignDraftSchema.safeParse(row.output);
  return parsed.success ? parsed.data : null;
}

export async function acceptAiDraftRecord(ctx: Ctx, raw: z.input<typeof AcceptAiDraftInput>): Promise<{ campaignId: string }> {
  ctx.require("ai.use");
  const input = AcceptAiDraftInput.parse(raw);
  const userId = staffUserId(ctx);
  const tx = ctx.tx;
  const draft = await lockDraft(tx, input.draftId);
  if (draft.status !== "ready") throw new ValidationError("ai_draft_not_ready", { draftId: draft.status });
  const output = draftOutput(draft);
  if (!output) throw new ValidationError("ai_draft_invalid", { draftId: "invalid_output" });

  // The model's segment when it is an active segment, else the one the brief named.
  let segmentId: string | null = null;
  for (const candidate of [output.segment.segmentId, draft.inputs.segmentId]) {
    if (candidate && (await activeSegment(tx, candidate))) {
      segmentId = candidate;
      break;
    }
  }

  let campaignId: string;
  if (draft.campaignId) {
    campaignId = draft.campaignId;
  } else {
    ({ campaignId } = await createCampaignRecord(ctx, { name: input.campaignName, purpose: draft.inputs.purpose }));
  }
  const c = await lockCampaign(tx, campaignId);
  if (c.status !== "draft") throw new ValidationError("campaign_not_draft", { campaignId: "campaign_not_draft" });
  const [template] = await tx.select().from(emailTemplates).where(eq(emailTemplates.id, c.templateId));
  if (!template) throw new NotFoundError("template_not_found");
  const base = (await draftVersionOf(tx, template.id)) ?? (await versionById(tx, template.currentVersionId));
  if (!base) throw new NotFoundError("version_not_found");
  const saved = await saveTemplateDraftRecord(ctx, {
    templateId: template.id,
    draftUpdatedAt: base.updatedAt,
    subject: output.subject,
    preheader: output.preheader,
    document: output.document,
  });
  await tx.update(emailTemplateVersions).set({ aiDraftId: draft.id }).where(eq(emailTemplateVersions.id, saved.draftVersionId));
  await tx
    .update(campaigns)
    .set({ aiDraftId: draft.id, ...(segmentId && !c.segmentId ? { segmentId } : {}), ...campaignVersionPatch(ctx, c) })
    .where(eq(campaigns.id, c.id));
  await tx
    .update(emailAiDrafts)
    .set({ status: "accepted", campaignId, decidedByUserId: userId, decidedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(emailAiDrafts.id, draft.id));
  await ctx.audit({
    action: "email.ai_draft_accept",
    entityType: "email_ai_draft",
    entityId: draft.id,
    oldValue: { status: "ready" },
    newValue: { status: "accepted", campaign_id: campaignId, draft_version_id: saved.draftVersionId, segment_id: segmentId },
  });
  return { campaignId };
}

export async function discardAiDraftRecord(ctx: Ctx, raw: z.input<typeof DiscardAiDraftInput>): Promise<{ ok: true }> {
  const input = DiscardAiDraftInput.parse(raw);
  const userId = staffUserId(ctx);
  const draft = await lockDraft(ctx.tx, input.draftId);
  if (draft.status === "accepted") throw new ValidationError("ai_draft_accepted", { draftId: "accepted" });
  if (draft.status === "discarded") return { ok: true };
  await ctx.tx
    .update(emailAiDrafts)
    .set({ status: "discarded", decidedByUserId: userId, decidedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(emailAiDrafts.id, draft.id));
  await ctx.audit({ action: "email.ai_draft_discard", entityType: "email_ai_draft", entityId: draft.id, oldValue: { status: draft.status }, newValue: { status: "discarded" } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// listAiDrafts
// ---------------------------------------------------------------------------

export type AiDraftListRow = {
  id: string;
  brief: string;
  status: AiDraftRow["status"];
  error: string | null;
  purpose: MarketingPurpose;
  sessionIds: string[];
  segmentId: string | null;
  campaignId: string | null;
  output: AiCampaignDraft | null;
  createdAt: Date;
  decidedAt: Date | null;
};

/** The newest drafts (of one staff user when `createdByUserId` is given), at most `limit`. */
export async function listAiDraftRows(db: DbOrTx, input: { createdByUserId?: string; campaignId?: string; limit?: number } = {}): Promise<AiDraftListRow[]> {
  const conditions = [
    ...(input.createdByUserId ? [eq(emailAiDrafts.createdByUserId, input.createdByUserId)] : []),
    ...(input.campaignId ? [eq(emailAiDrafts.campaignId, input.campaignId)] : []),
  ];
  const rows = await db
    .select()
    .from(emailAiDrafts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(emailAiDrafts.createdAt), desc(emailAiDrafts.id))
    .limit(Math.min(Math.max(input.limit ?? 20, 1), 100));
  return rows.map((r) => ({
    id: r.id,
    brief: r.brief,
    status: r.status,
    error: r.error,
    purpose: r.inputs.purpose,
    sessionIds: r.inputs.sessionIds,
    segmentId: r.inputs.segmentId,
    campaignId: r.campaignId,
    output: r.status === "ready" || r.status === "accepted" ? draftOutput(r) : null,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  }));
}
