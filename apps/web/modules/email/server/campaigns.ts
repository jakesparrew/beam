/**
 * Campaigns (email spec rules 25 to 37, section 4 campaign actions and queries), email-P6.
 *
 * Every status write goes through `transitionCampaign()`: `canTransition(from, to)` and then
 * `update campaigns set status = $to ... where id = $id and status = $from`, after the row was read
 * `for no key update` (rule 25). `no key update` and not `update`: the chunks insert
 * `email_messages` rows that reference the campaign, and their `for key share` foreign-key locks
 * must not make a pause wait for a running chunk. Every write bumps `version` (the optimistic
 * lock every action passes as `expectedVersion`; a stale one answers `conflict`).
 *
 * Each action handler writes its own `audit_log` row with the spec's name and the old and new
 * status (`email.campaign_*`, `email.recipient_remove|restore`); the action wrapper's own row is off.
 */
import type { DbOrTx } from "@beam/db";
import { campaignRecipients, campaigns, emailTemplates, type emailTemplateVersions, vCampaignStats } from "@beam/db/schema";
import {
  assertTransition,
  RECIPIENT_EDIT_STATUSES,
  sendWindowWarnings,
  type CampaignStatus,
  type CreateCampaignInput,
  type DuplicateCampaignInput,
  type ListCampaignRecipientsInput,
  type ListCampaignsInput,
  type MarketingPurpose,
  type ScheduleCampaignInput,
  type UpdateCampaignInput,
} from "@beam/core/email";
import { ListCampaignRecipientsInput as RecipientsArgs, ListCampaignsInput as ListArgs } from "@beam/core/email";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { footerProblems } from "@beam/email";
import { and, ConflictError, desc, eq, inArray, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getSegmentRef } from "@/modules/crm/api";
import { loadSendSettings } from "./context";
import { audienceLocales, enqueueChunks, getAudienceEstimate, planJobKey, refreshRecipients } from "./plan";
import { createTemplateRecord, draftVersionOf, duplicateTemplateRecord, publishTemplateRecord, slugFromName, versionById, versionCompleteness } from "./templates";

export type CampaignRow = typeof campaigns.$inferSelect;

/** Scheduling bounds (rule 26). */
export const MIN_LEAD_MS = 5 * 60_000;
export const MAX_AHEAD_MS = 90 * 86_400_000;

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

export async function lockCampaign(tx: DbOrTx, campaignId: string): Promise<CampaignRow> {
  const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).for("no key update");
  if (!c) throw new NotFoundError("campaign_not_found");
  return c;
}

function assertVersion(c: CampaignRow, expectedVersion: number): void {
  if (c.version !== expectedVersion) throw new ConflictError("campaign_changed");
}

const staffUserId = (ctx: Ctx): string | null => (ctx.actor.kind === "staff" ? ctx.actor.userId : null);

/** The columns every campaign write sets: next `version`, `updated_at`, the staff editor. */
export function campaignVersionPatch(ctx: Ctx, c: Pick<CampaignRow, "version">) {
  const userId = staffUserId(ctx);
  return { version: c.version + 1, updatedAt: ctx.now, ...(userId ? { updatedByUserId: userId } : {}) };
}

/**
 * The one status write (rule 25): refused unless `canTransition(from, to)`; the `where status =
 * $from` guard makes a concurrent move lose with `conflict`. `paused_reason` is cleared on every
 * move out of `paused` unless the patch sets it.
 */
export async function transitionCampaign(
  ctx: Ctx,
  c: CampaignRow,
  to: CampaignStatus,
  patch: Partial<typeof campaigns.$inferInsert> = {},
): Promise<CampaignRow> {
  assertTransition(c.status, to);
  const [row] = await ctx.tx
    .update(campaigns)
    .set({ ...(to !== "paused" ? { pausedReason: null } : {}), ...patch, status: to, ...campaignVersionPatch(ctx, c) })
    .where(and(eq(campaigns.id, c.id), eq(campaigns.status, c.status), eq(campaigns.version, c.version)))
    .returning();
  if (!row) throw new ConflictError("campaign_changed");
  return row;
}

async function auditStatus(ctx: Ctx, action: string, c: CampaignRow, next: CampaignRow, extra: Record<string, unknown> = {}): Promise<void> {
  await ctx.audit({ action, entityType: "campaign", entityId: c.id, oldValue: { status: c.status }, newValue: { status: next.status, ...extra } });
}

async function countPlanned(tx: DbOrTx, campaignId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(and(eq(campaignRecipients.campaignId, campaignId), eq(campaignRecipients.status, "planned")));
  return Number(row?.n ?? 0);
}

async function assertSegments(tx: DbOrTx, segmentId: string | null | undefined, excluded: readonly string[]): Promise<void> {
  for (const [field, id] of [...(segmentId ? [["segmentId", segmentId] as const] : []), ...excluded.map((e) => ["excludeSegmentIds", e] as const)]) {
    const ref = await getSegmentRef(tx, id);
    if (!ref || ref.isArchived) throw new ValidationError("segment_not_found", { [field]: "segment_not_found" });
  }
  if (segmentId && excluded.includes(segmentId)) throw new ValidationError("segment_excluded", { excludeSegmentIds: "segment_excluded" });
}

/** `20261105` of a Brussels day. */
const yyyymmdd = (at: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(at).replaceAll("-", "");

async function campaignTemplateSlug(tx: DbOrTx, name: string, now: Date): Promise<string> {
  const base = `campaign-${yyyymmdd(now)}-${slugFromName(name).replace(/^tpl-/, "")}`.slice(0, 74).replace(/-+$/g, "");
  const rows = await tx
    .select({ slug: emailTemplates.slug })
    .from(emailTemplates)
    .where(sql`${emailTemplates.slug} = ${base} or ${emailTemplates.slug} like ${`${base}-%`}`);
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ---------------------------------------------------------------------------
// createCampaign, updateCampaign, duplicateCampaign
// ---------------------------------------------------------------------------

export async function createCampaignRecord(ctx: Ctx, input: CreateCampaignInput): Promise<{ campaignId: string }> {
  const tx = ctx.tx;
  const userId = staffUserId(ctx);
  if (!userId) throw new ValidationError("staff_required", { actor: "staff_required" });
  let templateId = input.templateId ?? null;
  if (templateId) {
    const [t] = await tx.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
    if (!t) throw new NotFoundError("template_not_found");
    if (t.kind !== "marketing" || t.status === "archived") throw new ValidationError("template_not_marketing", { templateId: "template_not_marketing" });
    if (t.purpose !== input.purpose) throw new ValidationError("purpose_mismatch", { purpose: "purpose_mismatch" });
  } else {
    const slug = await campaignTemplateSlug(tx, input.name, ctx.now);
    ({ templateId } = await createTemplateRecord(ctx, { name: input.name, kind: "marketing", purpose: input.purpose, slug }));
  }
  const [row] = await tx
    .insert(campaigns)
    .values({ name: input.name, templateId, purpose: input.purpose, status: "draft", createdByUserId: userId, updatedByUserId: userId })
    .returning();
  await ctx.audit({ action: "email.campaign_create", entityType: "campaign", entityId: row!.id, newValue: { name: input.name, purpose: input.purpose, templateId, status: "draft" } });
  return { campaignId: row!.id };
}

export async function updateCampaignRecord(ctx: Ctx, input: UpdateCampaignInput): Promise<{ version: number }> {
  const tx = ctx.tx;
  const c = await lockCampaign(tx, input.campaignId);
  assertVersion(c, input.expectedVersion);
  if (c.status !== "draft") throw new ValidationError("campaign_not_draft", { status: c.status });
  const segmentId = input.segmentId === undefined ? c.segmentId : input.segmentId;
  const excluded = input.excludeSegmentIds ?? c.excludeSegmentIds;
  if (input.segmentId !== undefined || input.excludeSegmentIds !== undefined) await assertSegments(tx, segmentId, [...new Set(excluded)]);
  const patch: Partial<typeof campaigns.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.segmentId !== undefined) patch.segmentId = input.segmentId;
  if (input.excludeSegmentIds !== undefined) patch.excludeSegmentIds = [...new Set(input.excludeSegmentIds)];
  if (input.scheduledAt !== undefined) patch.scheduledAt = input.scheduledAt;
  const [row] = await tx
    .update(campaigns)
    .set({ ...patch, ...campaignVersionPatch(ctx, c) })
    .where(and(eq(campaigns.id, c.id), eq(campaigns.version, c.version)))
    .returning({ version: campaigns.version });
  if (!row) throw new ConflictError("campaign_changed");
  await ctx.audit({
    action: "email.campaign_update",
    entityType: "campaign",
    entityId: c.id,
    oldValue: { name: c.name, segmentId: c.segmentId, excludeSegmentIds: c.excludeSegmentIds, scheduledAt: c.scheduledAt },
    newValue: patch,
  });
  return { version: row.version };
}

/** A new draft campaign whose new template's draft copies the source content (section 4). */
export async function duplicateCampaignRecord(ctx: Ctx, input: DuplicateCampaignInput, copyLabel?: (name: string) => string): Promise<{ campaignId: string }> {
  const tx = ctx.tx;
  const [source] = await tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId));
  if (!source) throw new NotFoundError("campaign_not_found");
  const userId = staffUserId(ctx);
  if (!userId) throw new ValidationError("staff_required", { actor: "staff_required" });
  const name = (copyLabel ? copyLabel(source.name) : `${source.name} (copy)`).slice(0, 160);
  const { templateId } = await duplicateTemplateRecord(ctx, { templateId: source.templateId, name });
  const [row] = await tx
    .insert(campaigns)
    .values({
      name,
      templateId,
      purpose: source.purpose,
      segmentId: source.segmentId,
      excludeSegmentIds: source.excludeSegmentIds,
      status: "draft",
      createdByUserId: userId,
      updatedByUserId: userId,
    })
    .returning();
  await ctx.audit({ action: "email.campaign_create", entityType: "campaign", entityId: row!.id, newValue: { name, purpose: source.purpose, templateId, duplicatedFrom: source.id, status: "draft" } });
  return { campaignId: row!.id };
}

// ---------------------------------------------------------------------------
// scheduleCampaign (rules 5, 26, 27), unscheduleCampaign
// ---------------------------------------------------------------------------

export type ScheduleCheck = { check: string; detail?: string };

export type ReviewChecklist = {
  checks: { key: "segment" | "content" | "locales" | "test_send" | "footer"; ok: boolean; detail?: string }[];
  audienceLocales: Locale[];
  missing: { locale: Locale; missing: string[] }[];
};

/** The content scheduling would publish: the draft, else the current version. */
async function contentVersion(tx: DbOrTx, templateId: string) {
  const [t] = await tx.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
  if (!t) throw new NotFoundError("template_not_found");
  const draft = await draftVersionOf(tx, t.id);
  const current = await versionById(tx, t.currentVersionId);
  return { template: t, draft, current, content: draft ?? current };
}

/** The Review step's checklist (rule 26 without the time checks), shared by the screen and the action. */
export async function reviewChecklist(tx: DbOrTx, c: CampaignRow): Promise<ReviewChecklist> {
  const { content } = await contentVersion(tx, c.templateId);
  const estimate = c.segmentId ? await getAudienceEstimate(tx, { segmentId: c.segmentId, excludeSegmentIds: c.excludeSegmentIds, purpose: c.purpose }) : null;
  const locales = estimate ? audienceLocales(estimate) : [];
  const missing = content ? versionCompleteness(content, locales).filter((m) => m.missing.length) : [];
  const settings = await loadSendSettings(tx);
  const footer = footerProblems({ company: settings.company, footerSettings: settings.footer, purpose: c.purpose, locales: LOCALES });
  const tested = !!(content && c.testSentAt && c.testSentAt.getTime() > content.updatedAt.getTime());
  return {
    audienceLocales: locales,
    missing: missing.map((m) => ({ locale: m.locale, missing: m.missing })),
    checks: [
      { key: "segment", ok: !!c.segmentId },
      { key: "content", ok: !!content },
      { key: "locales", ok: !!content && !!c.segmentId && missing.length === 0, ...(missing.length ? { detail: missing.map((m) => m.locale).join(", ") } : {}) },
      { key: "test_send", ok: tested },
      { key: "footer", ok: footer.length === 0, ...(footer.length ? { detail: footer.join(", ") } : {}) },
    ],
  };
}

export async function scheduleCampaignRecord(ctx: Ctx, input: ScheduleCampaignInput): Promise<{ status: "planning" }> {
  const tx = ctx.tx;
  const c = await lockCampaign(tx, input.campaignId);
  assertVersion(c, input.expectedVersion);
  if (c.status !== "draft") throw new ValidationError("campaign_not_draft", { status: c.status });
  const at = input.scheduledAt === "now" ? ctx.now : input.scheduledAt;

  const review = await reviewChecklist(tx, c);
  const failed: Record<string, string> = {};
  for (const check of review.checks) {
    if (check.ok) continue;
    if (check.key === "locales") for (const m of review.missing) failed[`locale:${m.locale}`] = "missing_locale";
    else failed[check.key] = `${check.key}_required`;
  }
  if (input.scheduledAt !== "now") {
    if (at.getTime() < ctx.now.getTime() + MIN_LEAD_MS) failed.scheduledAt = "too_soon";
    else if (at.getTime() > ctx.now.getTime() + MAX_AHEAD_MS) failed.scheduledAt = "too_far";
  }
  const warnings = sendWindowWarnings(at);
  if (warnings.length && !input.confirmOutsideWindow) failed.confirmOutsideWindow = `outside_window:${warnings.join(",")}`;
  if (Object.keys(failed).length) throw new ValidationError("schedule_refused", failed);

  const { template, draft, current } = await contentVersion(tx, c.templateId);
  const versionId = draft ? (await publishTemplateRecord(ctx, { templateId: template.id, draftUpdatedAt: draft.updatedAt })).versionId : current!.id;
  const next = await transitionCampaign(ctx, c, "planning", { templateVersionId: versionId, scheduledAt: at, lastError: null });
  await ctx.enqueue({ kind: "campaign.plan", payload: { campaignId: c.id, version: next.version }, key: planJobKey(c.id, next.version), lane: "bulk", priority: 9 });
  await auditStatus(ctx, "email.campaign_schedule", c, next, { scheduledAt: at.toISOString(), templateVersionId: versionId, ...(warnings.length ? { outsideWindow: warnings } : {}) });
  return { status: "planning" };
}

export async function unscheduleCampaignRecord(ctx: Ctx, input: { campaignId: string; expectedVersion: number }): Promise<{ status: "draft" }> {
  const tx = ctx.tx;
  const c = await lockCampaign(tx, input.campaignId);
  assertVersion(c, input.expectedVersion);
  await tx.delete(campaignRecipients).where(and(eq(campaignRecipients.campaignId, c.id), inArray(campaignRecipients.status, ["planned", "removed"])));
  const next = await transitionCampaign(ctx, c, "draft", { recipientsCount: 0, chunkCount: 0, audienceSnapshotAt: null });
  await auditStatus(ctx, "email.campaign_unschedule", c, next);
  return { status: "draft" };
}

export async function refreshAudienceRecord(ctx: Ctx, input: { campaignId: string; expectedVersion: number }): Promise<{ added: number; skipped: number }> {
  const tx = ctx.tx;
  const c = await lockCampaign(tx, input.campaignId);
  assertVersion(c, input.expectedVersion);
  if (c.status !== "scheduled") throw new ValidationError("campaign_not_scheduled", { status: c.status });
  const result = await refreshRecipients(tx, ctx, c);
  await tx
    .update(campaigns)
    .set({ recipientsCount: result.recipients, chunkCount: result.chunks, audienceSnapshotAt: ctx.now, ...campaignVersionPatch(ctx, c) })
    .where(eq(campaigns.id, c.id));
  await ctx.audit({ action: "email.campaign_refresh", entityType: "campaign", entityId: c.id, newValue: { added: result.added, skipped: result.skipped } });
  return { added: result.added, skipped: result.skipped };
}

// ---------------------------------------------------------------------------
// Recipients (rule 28)
// ---------------------------------------------------------------------------

async function editRecipient(ctx: Ctx, input: { campaignId: string; personId: string }, mode: "remove" | "restore"): Promise<{ ok: true }> {
  const tx = ctx.tx;
  const c = await lockCampaign(tx, input.campaignId);
  if (!(RECIPIENT_EDIT_STATUSES as readonly string[]).includes(c.status)) throw new ValidationError("campaign_not_editable", { status: c.status });
  const [r] = await tx
    .select()
    .from(campaignRecipients)
    .where(and(eq(campaignRecipients.campaignId, c.id), eq(campaignRecipients.personId, input.personId)))
    .for("update");
  if (!r) throw new NotFoundError("recipient_not_found");
  const from = mode === "remove" ? "planned" : "removed";
  if (r.status !== from) throw new ValidationError(mode === "remove" ? "recipient_not_planned" : "recipient_not_removed", { status: r.status });
  const userId = staffUserId(ctx);
  if (mode === "remove" && !userId) throw new ValidationError("staff_required", { actor: "staff_required" });
  await tx
    .update(campaignRecipients)
    .set(mode === "remove" ? { status: "removed", removedByUserId: userId, removedAt: ctx.now, updatedAt: ctx.now } : { status: "planned", removedByUserId: null, removedAt: null, updatedAt: ctx.now })
    .where(and(eq(campaignRecipients.id, r.id), eq(campaignRecipients.status, from)));
  await ctx.audit({
    action: mode === "remove" ? "email.recipient_remove" : "email.recipient_restore",
    entityType: "campaign_recipient",
    entityId: r.id,
    oldValue: { status: from },
    newValue: { status: mode === "remove" ? "removed" : "planned", person_id: r.personId, campaign_id: c.id },
  });
  return { ok: true };
}

export const removeRecipientRecord = (ctx: Ctx, input: { campaignId: string; personId: string }) => editRecipient(ctx, input, "remove");
export const restoreRecipientRecord = (ctx: Ctx, input: { campaignId: string; personId: string }) => editRecipient(ctx, input, "restore");

// ---------------------------------------------------------------------------
// pause, resume, stop, cancel (rules 35, 36, 37)
// ---------------------------------------------------------------------------

export async function pauseCampaignRecord(ctx: Ctx, input: { campaignId: string; expectedVersion: number }): Promise<{ status: CampaignStatus }> {
  const c = await lockCampaign(ctx.tx, input.campaignId);
  assertVersion(c, input.expectedVersion);
  const next = await transitionCampaign(ctx, c, "paused", { pausedReason: "manual" });
  await auditStatus(ctx, "email.campaign_pause", c, next, { pausedReason: "manual" });
  return { status: next.status };
}

/**
 * Resume (rule 35): a new `run_no` and one chunk job per chunk with planned recipients; with none
 * left the campaign is `sent` at once. After a bounce-rate pause the campaign name must be typed.
 */
export async function resumeCampaignRecord(ctx: Ctx, input: { campaignId: string; expectedVersion: number; confirmName?: string | undefined }): Promise<{ status: CampaignStatus }> {
  const c = await lockCampaign(ctx.tx, input.campaignId);
  assertVersion(c, input.expectedVersion);
  if (c.status !== "paused") assertTransition(c.status, "sending");
  if (c.pausedReason === "bounce_rate" && input.confirmName?.trim() !== c.name.trim()) throw new ValidationError("confirm_name_required", { confirmName: "confirm_name_required" });
  const planned = await countPlanned(ctx.tx, c.id);
  if (planned === 0) {
    const next = await transitionCampaign(ctx, c, "sent", { finishedAt: ctx.now });
    await auditStatus(ctx, "email.campaign_resume", c, next);
    return { status: next.status };
  }
  const next = await transitionCampaign(ctx, c, "sending", { runNo: c.runNo + 1 });
  await enqueueChunks(ctx, c.id, next.runNo);
  await auditStatus(ctx, "email.campaign_resume", c, next, { runNo: next.runNo });
  return { status: next.status };
}

export async function stopCampaignRecord(ctx: Ctx, input: { campaignId: string; expectedVersion: number }): Promise<{ status: "stopped"; notSent: number }> {
  const c = await lockCampaign(ctx.tx, input.campaignId);
  assertVersion(c, input.expectedVersion);
  const next = await transitionCampaign(ctx, c, "stopped", { stoppedAt: ctx.now });
  const notSent = await countPlanned(ctx.tx, c.id);
  await auditStatus(ctx, "email.campaign_stop", c, next, { notSent });
  return { status: "stopped", notSent };
}

export async function cancelCampaignRecord(ctx: Ctx, input: { campaignId: string; expectedVersion: number }): Promise<{ status: "cancelled" }> {
  const c = await lockCampaign(ctx.tx, input.campaignId);
  assertVersion(c, input.expectedVersion);
  const next = await transitionCampaign(ctx, c, "cancelled", { cancelledAt: ctx.now });
  await auditStatus(ctx, "email.campaign_cancel", c, next);
  return { status: "cancelled" };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const CAMPAIGNS_PAGE_SIZE = 50;

export type CampaignListRow = {
  id: string;
  name: string;
  status: CampaignStatus;
  purpose: MarketingPurpose;
  segmentId: string | null;
  segmentName: string | null;
  scheduledAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  recipients: number;
  openRate: number | null;
  clickRate: number | null;
  createdAt: Date;
};

const rate = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

export async function listCampaignRows(db: DbOrTx, input: ListCampaignsInput = {}): Promise<{ items: CampaignListRow[]; total: number; page: number; pageSize: number }> {
  const args = ListArgs.parse(input);
  const where = and(
    args.status ? eq(campaigns.status, args.status) : undefined,
    args.q ? sql`${campaigns.name} ilike ${`%${args.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}` : undefined,
  );
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(campaigns).where(where);
  const rows = await db
    .select({
      c: campaigns,
      segmentName: sql<string | null>`(select s.name from segments s where s.id = ${campaigns.segmentId})`,
      openRate: vCampaignStats.openRate,
      clickRate: vCampaignStats.clickRate,
    })
    .from(campaigns)
    .leftJoin(vCampaignStats, eq(vCampaignStats.campaignId, campaigns.id))
    .where(where)
    .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
    .limit(CAMPAIGNS_PAGE_SIZE)
    .offset((args.page - 1) * CAMPAIGNS_PAGE_SIZE);
  return {
    total: Number(count?.n ?? 0),
    page: args.page,
    pageSize: CAMPAIGNS_PAGE_SIZE,
    items: rows.map(({ c, segmentName, openRate, clickRate }) => {
      const snap = c.statsSnapshot as { open_rate?: unknown; click_rate?: unknown } | null;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        purpose: c.purpose,
        segmentId: c.segmentId,
        segmentName,
        scheduledAt: c.scheduledAt,
        startedAt: c.startedAt,
        finishedAt: c.finishedAt,
        recipients: c.recipientsCount,
        openRate: snap ? rate(snap.open_rate) : rate(openRate),
        clickRate: snap ? rate(snap.click_rate) : rate(clickRate),
        createdAt: c.createdAt,
      };
    }),
  };
}

export type CampaignDetail = {
  campaign: CampaignRow;
  template: typeof emailTemplates.$inferSelect;
  draft: typeof emailTemplateVersions.$inferSelect | null;
  current: typeof emailTemplateVersions.$inferSelect | null;
  segment: { id: string; name: string; isArchived: boolean } | null;
  excluded: { id: string; name: string }[];
  review: ReviewChecklist;
  counts: Record<string, number>;
};

export async function loadCampaignDetail(db: DbOrTx, campaignId: string): Promise<CampaignDetail | null> {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!c) return null;
  const { template, draft, current } = await contentVersion(db, c.templateId);
  const seg = c.segmentId ? await getSegmentRef(db, c.segmentId) : null;
  const excluded: { id: string; name: string }[] = [];
  for (const id of c.excludeSegmentIds) {
    const ref = await getSegmentRef(db, id);
    excluded.push({ id, name: ref?.name ?? id });
  }
  const countRows = await db
    .select({ status: campaignRecipients.status, n: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, c.id))
    .groupBy(campaignRecipients.status);
  return {
    campaign: c,
    template,
    draft,
    current,
    segment: seg ? { id: seg.id, name: seg.name, isArchived: seg.isArchived } : null,
    excluded,
    review: await reviewChecklist(db, c),
    counts: Object.fromEntries(countRows.map((r) => [r.status, Number(r.n)])),
  };
}

export type RecipientListRow = {
  id: string;
  personId: string;
  name: string;
  email: string | null;
  locale: string;
  status: string;
  chunkNo: number;
  messageStatus: string | null;
};

/** `j***@example.com` (spec section 5: masked unless `persons.read`). */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export async function listRecipientRows(
  db: DbOrTx,
  input: ListCampaignRecipientsInput,
  opts: { unmasked: boolean } = { unmasked: false },
): Promise<{ items: RecipientListRow[]; total: number; page: number; pageSize: number }> {
  const args = RecipientsArgs.parse(input);
  const like = args.q ? `%${args.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const filter = sql`cr.campaign_id = ${args.campaignId}::uuid
    ${args.status ? sql`and cr.status = ${args.status}` : sql``}
    ${like ? sql`and (lower(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) like ${like} or lower(p.email) like ${like})` : sql``}`;
  const [count] = rowsOf<{ n: number | string }>(await db.execute(sql`select count(*)::int as n from campaign_recipients cr join persons p on p.id = cr.person_id where ${filter}`));
  const rows = rowsOf<{ id: string; person_id: string; first_name: string | null; last_name: string | null; email: string | null; locale: string; status: string; chunk_no: number; message_status: string | null }>(
    await db.execute(sql`
      select cr.id, cr.person_id, p.first_name, p.last_name, p.email, cr.locale, cr.status, cr.chunk_no, m.status as message_status
      from campaign_recipients cr
      join persons p on p.id = cr.person_id
      left join email_messages m on m.id = cr.email_message_id
      where ${filter}
      order by cr.chunk_no, p.last_name nulls last, p.first_name nulls last, cr.id
      limit ${args.pageSize} offset ${(args.page - 1) * args.pageSize}`),
  );
  return {
    total: Number(count?.n ?? 0),
    page: args.page,
    pageSize: args.pageSize,
    items: rows.map((r) => ({
      id: r.id,
      personId: r.person_id,
      name: [r.first_name, r.last_name].filter((x) => x?.trim()).join(" "),
      email: opts.unmasked ? r.email : maskEmail(r.email),
      locale: r.locale,
      status: r.status,
      chunkNo: Number(r.chunk_no),
      messageStatus: r.message_status,
    })),
  };
}

