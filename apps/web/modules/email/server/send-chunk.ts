/**
 * `campaign.send_chunk` (email spec rules 7, 30, 32 to 34, 37, 43, 52, 53), email-P6.
 *
 * One chunk of up to 500 recipients, sent in batches of 100 through `ResendClient.sendBatch()`.
 * Before every batch the chunk reloads the campaign and exits (the job succeeds) unless it is
 * still `sending` in the same run (`run_no`); it then counts today's `news.beam.be` sends against
 * the warm-up cap and, when the cap is reached, re-enqueues itself for 09:00 Brussels the next
 * day (key qualifier `:d<YYYY-MM-DD>`), leaving the rest `planned`.
 *
 * Recipients are claimed with `for update skip locked limit 100`, so an overlapping run of the
 * same chunk never sends a row twice. Each one is re-checked against `v_marketing_reachability`
 * (`suppressed` → `skipped_suppressed`; `withdrawn`, `no_consent` → `skipped_consent`; the rest
 * → `skipped_unreachable`) and against the version's locales with the person's current locale
 * (`skipped_translation`, rule 30); the message goes to the person's current address (edge case 30).
 *
 * Messages are keyed `campaign:<id>:person:<person_id>`; their link token is derived from the
 * message id (`linkTokenFor`), so a retried batch renders the same payload under the same
 * idempotency key and Resend answers with the original ids. The batch key is the chunk job's key
 * plus `:batch:<k>` (`campaign:<id>:chunk:<n>:r<run_no>[:d<day>]:batch:<k>`): a resumed run or a
 * warm-up continuation claims other recipients and must not be answered with an earlier batch's
 * ids. A per-recipient render problem marks that recipient `failed` and the chunk continues.
 *
 * At its end the chunk locks the campaign row, adds its sends to `sent_count` and sets `sent`
 * when no recipient is `planned` any more (rule 34), then evaluates the bounce rate (rule 37).
 */
import { createHash } from "node:crypto";
import type { Tx } from "@beam/db";
import { campaignRecipients, campaigns, emailMessages, emailTemplates, emailTemplateVersions, persons, vMarketingReachability, vPersonStatus } from "@beam/db/schema";
import { MissingTranslationError, PermanentError } from "@beam/core/errors";
import {
  BATCH_SIZE,
  brusselsDayBounds,
  linkTokenFor,
  newLinkToken,
  recipientSkipStatus,
  warmupContinuation,
  warmupRemaining,
  type BlockedReason,
  type CampaignChunkJobInput,
  type RecipientStatus,
} from "@beam/core/email";
import { isLocale, type Locale } from "@beam/core/i18n";
import { buildOutgoingEmail, type FooterParts } from "@beam/email";
import { personalise, tokenNames, type VariantRecipient } from "@beam/email/blocks";
import { renderEmail } from "@beam/email/render";
import { IntegrationError } from "@beam/integrations/_shared";
import type { OutgoingEmail } from "@beam/integrations/resend";
import { and, eq, inArray, sql } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { getSetting } from "@/lib/settings";
import { listLatestOutcomes } from "@/modules/forms/api";
import { evaluateBounceRate } from "./auto-pause";
import { transitionCampaign } from "./campaigns";
import { loadSendSettings, senderFor, type SendSettings } from "./context";
import { buildTokenValues } from "./merge-fields";
import { chunkJobKey } from "./plan";
import { templateFooter } from "./preview";
import { assessmentFormSlugs, linkTokenSecret } from "./send";
import { sinkDecision, storeRenderedCopy, type SinkDecision } from "./sink";
import { applyTracking } from "./tracking";
import { footerPreferenceUrls, listUnsubscribeOption, unsubscribeLinksFor } from "./unsubscribe-links";

export type ChunkResult = {
  sent: number;
  skipped: number;
  failed: number;
  batches: number;
  /** Why the chunk stopped early: the campaign left `sending` (or this run), or the warm-up cap. */
  exited: "status" | "warmup" | null;
  finished: boolean;
};

/** The message key of a campaign recipient (decision 17). */
export const campaignMessageKey = (campaignId: string, personId: string): string => `campaign:${campaignId}:person:${personId}`;

/**
 * The message id derived from its key (a version-5-style UUID over sha256), so an attempt that
 * reaches Resend and then rolls back re-inserts the same id, renders the same link token and
 * sends a byte-identical batch under the same idempotency key (edge cases 5 and 6).
 */
export function campaignMessageId(key: string): string {
  const h = createHash("sha256").update(`email-message:${key}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Version = typeof emailTemplateVersions.$inferSelect;
type Recipient = typeof campaignRecipients.$inferSelect;
type PersonRow = { id: string; email: string | null; locale: string; erasedAt: Date | null };

type ChunkEnv = {
  campaign: typeof campaigns.$inferSelect;
  version: Version;
  slug: string;
  settings: SendSettings;
  sink: SinkDecision;
  secret: string | null;
  footers: Map<Locale, FooterParts | null>;
};

/** The skip status of a reachability reason (rule 32). */
const skipFor = (reason: BlockedReason | null | undefined): RecipientStatus => recipientSkipStatus(reason ?? "erased");

async function campaignState(tx: Tx, campaignId: string): Promise<{ status: string; runNo: number } | null> {
  const [c] = await tx.select({ status: campaigns.status, runNo: campaigns.runNo }).from(campaigns).where(eq(campaigns.id, campaignId));
  return c ?? null;
}

/** Messages from `news.beam.be` sent on the Brussels day of `now` (rule 7). */
async function sentToday(tx: Tx, now: Date): Promise<number> {
  const { start, end } = brusselsDayBounds(now);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(emailMessages)
    .where(and(eq(emailMessages.fromDomain, "news.beam.be"), sql`${emailMessages.sentAt} >= ${start} and ${emailMessages.sentAt} < ${end}`));
  return Number(row?.n ?? 0);
}

async function footerOf(ctx: JobCtx, env: ChunkEnv, locale: Locale): Promise<FooterParts | null> {
  if (!env.footers.has(locale)) {
    const { footer } = await templateFooter(ctx.tx, { settings: env.settings, locale, purpose: env.campaign.purpose, personId: null, links: null });
    env.footers.set(locale, footer);
  }
  return env.footers.get(locale) ?? null;
}

type Prepared = { recipient: Recipient; messageId: string; outgoing: OutgoingEmail; subject: string; to: string; linkHash: string; links: string[] | null; renderedFileId: string | null };
type Failed = { recipient: Recipient; messageId: string; error: string };

/** Renders one recipient's message; a content problem returns its error code. */
async function prepare(
  ctx: JobCtx,
  env: ChunkEnv,
  r: Recipient,
  p: PersonRow & { locale: Locale },
  variant: VariantRecipient,
  messageId: string,
): Promise<Omit<Prepared, "recipient" | "messageId"> | { error: string }> {
  const v = env.version;
  const link = env.secret ? await linkTokenFor(messageId, env.secret) : newLinkToken();
  const unsubscribe = unsubscribeLinksFor({ linkToken: link.token, kind: "marketing", locale: p.locale });
  const preferenceUrls = footerPreferenceUrls(unsubscribe);
  let rendered: { subject: string; html: string; text: string };
  try {
    const compiled = v.htmlByLocale && v.textByLocale ? { htmlByLocale: v.htmlByLocale, textByLocale: v.textByLocale } : null;
    const footer = compiled?.htmlByLocale[p.locale] ? null : await footerOf(ctx, env, p.locale);
    rendered = await renderEmail({ source: "blocks", locale: p.locale, subject: v.subject, preheader: v.preheader, document: v.document, compiled, recipient: variant, footer });
  } catch (error) {
    if (error instanceof MissingTranslationError) return { error: "missing_translation" };
    if (error instanceof PermanentError) return { error: error.message.split(":")[0]! };
    throw error;
  }
  const names = tokenNames(`${rendered.subject}\n${rendered.html}\n${rendered.text}`);
  const values = await buildTokenValues(ctx.tx, { personId: p.id, locale: p.locale, context: null, names: [...names.tokens, ...names.mergeFields], links: preferenceUrls });
  const subject = personalise(rendered.subject, values, { escape: false }).trim();
  const text = personalise(rendered.text, values, { escape: false }).trim();
  const tracked = applyTracking(personalise(rendered.html, values, { escape: true }), link.token);
  const to = p.email!.trim();
  const sender = senderFor(env.settings, "news.beam.be");
  let outgoing: OutgoingEmail;
  try {
    outgoing = buildOutgoingEmail(
      { messageId, messageKind: "campaign", campaignId: env.campaign.id, to, subject, html: tracked.html, text, headers: {} },
      {
        kind: "marketing",
        from: sender.from,
        replyTo: sender.replyTo,
        listUnsubscribe: listUnsubscribeOption(unsubscribe),
        sinkRewrite: !env.sink.production && env.sink.sink ? { sink: env.sink.sink, env: env.sink.env } : null,
      },
    );
  } catch (error) {
    if (error instanceof PermanentError) return { error: error.message.split(":")[0]! };
    throw error;
  }
  const renderedFileId = env.sink.production ? null : await storeRenderedCopy(ctx, { messageId, templateKey: env.slug, html: tracked.html, personId: p.id });
  return { outgoing, subject, to, linkHash: link.hash, links: tracked.links, renderedFileId };
}

/** The message row of a recipient (`on conflict (idempotency_key) do nothing`, then a select). */
async function messageFor(tx: Tx, env: ChunkEnv, r: Recipient, p: PersonRow & { locale: Locale }): Promise<{ id: string; status: string }> {
  const key = campaignMessageKey(env.campaign.id, r.personId);
  const [inserted] = await tx
    .insert(emailMessages)
    .values({
      id: campaignMessageId(key),
      personId: r.personId,
      toEmail: p.email,
      kind: "campaign",
      purpose: env.campaign.purpose,
      templateVersionId: env.version.id,
      campaignId: env.campaign.id,
      locale: p.locale,
      fromDomain: "news.beam.be",
      idempotencyKey: key,
      status: "queued",
    })
    .onConflictDoNothing({ target: emailMessages.idempotencyKey })
    .returning({ id: emailMessages.id, status: emailMessages.status });
  if (inserted) return inserted;
  const [row] = await tx.select({ id: emailMessages.id, status: emailMessages.status }).from(emailMessages).where(eq(emailMessages.idempotencyKey, key));
  return row!;
}

async function setRecipients(tx: Tx, ids: readonly string[], status: RecipientStatus, now: Date): Promise<void> {
  if (!ids.length) return;
  await tx.update(campaignRecipients).set({ status, updatedAt: now }).where(and(inArray(campaignRecipients.id, [...ids]), eq(campaignRecipients.status, "planned")));
}

/** Variant inputs (status and assessment outcomes, rule 18) of a batch's persons. */
async function variantsOf(tx: Tx, version: Version, personIds: readonly string[], locales: readonly Locale[]): Promise<Map<string, VariantRecipient>> {
  const out = new Map<string, VariantRecipient>();
  if (!personIds.length) return out;
  const statuses = await tx.select({ personId: vPersonStatus.personId, status: vPersonStatus.status }).from(vPersonStatus).where(inArray(vPersonStatus.personId, [...personIds]));
  const statusOf = new Map(statuses.map((s) => [s.personId, s.status as VariantRecipient["status"]]));
  const slugs = [...new Set(locales.flatMap((l) => assessmentFormSlugs(version.document, l)))];
  const outcomes = new Map<string, Map<string, string>>();
  for (const slug of slugs) outcomes.set(slug, await listLatestOutcomes(tx, [...personIds], slug));
  for (const id of personIds) {
    const o: Record<string, string | null> = {};
    for (const slug of slugs) o[slug] = outcomes.get(slug)?.get(id) ?? null;
    out.set(id, { status: statusOf.get(id) ?? null, outcomes: o });
  }
  return out;
}

/** One batch: claim, re-check, render, send. Returns null when nothing was left to claim. */
async function runBatch(ctx: JobCtx, env: ChunkEnv, input: CampaignChunkJobInput, k: number, limit: number): Promise<{ sent: number; skipped: number; failed: number } | null> {
  const tx = ctx.tx;
  const rows = await tx
    .select()
    .from(campaignRecipients)
    .where(and(eq(campaignRecipients.campaignId, input.campaignId), eq(campaignRecipients.chunkNo, input.chunkNo), eq(campaignRecipients.status, "planned")))
    .orderBy(campaignRecipients.id)
    .limit(limit)
    .for("update", { skipLocked: true });
  if (!rows.length) return null;
  const personIds = rows.map((r) => r.personId);
  const people = await tx.select({ id: persons.id, email: persons.email, locale: persons.locale, erasedAt: persons.erasedAt }).from(persons).where(inArray(persons.id, personIds));
  const personOf = new Map(people.map((p) => [p.id, p]));
  const reach = await tx
    .select({ personId: vMarketingReachability.personId, isReachable: vMarketingReachability.isReachable, reason: vMarketingReachability.blockedReason })
    .from(vMarketingReachability)
    .where(and(inArray(vMarketingReachability.personId, personIds), eq(vMarketingReachability.purpose, env.campaign.purpose)));
  const reachOf = new Map(reach.map((r) => [r.personId, r]));

  const skips = new Map<RecipientStatus, string[]>();
  const skip = (status: RecipientStatus, id: string) => skips.set(status, [...(skips.get(status) ?? []), id]);
  const sendable: { r: Recipient; p: PersonRow & { locale: Locale } }[] = [];
  for (const r of rows) {
    const p = personOf.get(r.personId);
    const rr = reachOf.get(r.personId);
    if (!p || p.erasedAt || !p.email) skip("skipped_unreachable", r.id);
    else if (!rr?.isReachable) skip(skipFor(rr?.reason as BlockedReason | null), r.id);
    else if (!isLocale(p.locale) || !env.version.locales.includes(p.locale)) skip("skipped_translation", r.id);
    else sendable.push({ r, p: { ...p, locale: p.locale } });
  }
  let skipped = 0;
  for (const [status, ids] of skips) {
    await setRecipients(tx, ids, status, ctx.now);
    skipped += ids.length;
  }

  const variants = await variantsOf(tx, env.version, sendable.map((s) => s.r.personId), [...new Set(sendable.map((s) => s.p.locale))]);
  const prepared: Prepared[] = [];
  const failed: Failed[] = [];
  for (const { r, p } of sendable) {
    const m = await messageFor(tx, env, r, p);
    const out = await prepare(ctx, env, r, p, variants.get(r.personId) ?? { status: null, outcomes: {} }, m.id);
    if ("error" in out) failed.push({ recipient: r, messageId: m.id, error: out.error });
    else prepared.push({ recipient: r, messageId: m.id, ...out });
  }

  if (prepared.length) {
    let ids: string[] | null = null;
    try {
      ({ ids } = await ctx.integrations.resend.sendBatch(
        prepared.map((x) => x.outgoing),
        { idempotencyKey: `${chunkJobKey(input.campaignId, input.chunkNo, input.runNo, input.day)}:batch:${k}` },
      ));
    } catch (error) {
      if (!(error instanceof IntegrationError) || error.retryable) throw error;
      const code = error.statusCode === 422 ? "invalid_recipient" : `resend_4xx:${error.statusCode ?? "unknown"}`;
      failed.push(...prepared.splice(0).map((x) => ({ recipient: x.recipient, messageId: x.messageId, error: code })));
    }
    if (ids && ids.length !== prepared.length) throw new Error(`email: Resend returned ${ids.length} ids for ${prepared.length} messages`);
    for (const [i, x] of prepared.entries()) {
      await tx
        .update(emailMessages)
        .set({ status: "sent", resendId: ids![i]!, sentAt: ctx.now, toEmail: x.to, subject: x.subject, linkTokenHash: x.linkHash, links: x.links, renderedFileId: x.renderedFileId, error: null, updatedAt: ctx.now })
        .where(eq(emailMessages.id, x.messageId));
      await tx.update(campaignRecipients).set({ status: "sent", emailMessageId: x.messageId, updatedAt: ctx.now }).where(eq(campaignRecipients.id, x.recipient.id));
      await ctx.recordEvent({
        kind: "email.sent",
        personId: x.recipient.personId,
        data: { template_slug: env.slug, campaign_id: env.campaign.id, enrolment_id: null },
        ref: { type: "email_message", id: x.messageId },
        dedupeKey: `email:${x.messageId}:sent`,
      });
    }
  }
  for (const f of failed) {
    await tx.update(emailMessages).set({ status: "failed", error: f.error, updatedAt: ctx.now }).where(and(eq(emailMessages.id, f.messageId), eq(emailMessages.status, "queued")));
    await tx.update(campaignRecipients).set({ status: "failed", emailMessageId: f.messageId, updatedAt: ctx.now }).where(eq(campaignRecipients.id, f.recipient.id));
  }
  return { sent: prepared.length, skipped, failed: failed.length };
}

/** The `campaign.send_chunk` handler. */
export async function sendChunk(ctx: JobCtx, input: CampaignChunkJobInput): Promise<ChunkResult> {
  const tx = ctx.tx;
  const result: ChunkResult = { sent: 0, skipped: 0, failed: 0, batches: 0, exited: null, finished: false };
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId));
  if (!campaign || campaign.status !== "sending" || campaign.runNo !== input.runNo) return { ...result, exited: "status" };
  if (!campaign.templateVersionId) throw new PermanentError("campaign_version_missing");
  const [version] = await tx.select().from(emailTemplateVersions).where(eq(emailTemplateVersions.id, campaign.templateVersionId));
  if (!version) throw new PermanentError("campaign_version_missing");
  const [tpl] = await tx.select({ slug: emailTemplates.slug }).from(emailTemplates).where(eq(emailTemplates.id, version.templateId));
  const env: ChunkEnv = {
    campaign,
    version,
    slug: tpl?.slug ?? "campaign",
    settings: await loadSendSettings(tx),
    sink: sinkDecision(),
    secret: linkTokenSecret(),
    footers: new Map(),
  };
  const schedule = await getSetting(tx, "warmup_schedule");

  for (let k = 0; ; k++) {
    const state = await campaignState(tx, input.campaignId);
    if (!state || state.status !== "sending" || state.runNo !== input.runNo) {
      result.exited = "status";
      break;
    }
    const remaining = warmupRemaining(schedule, ctx.now, await sentToday(tx, ctx.now));
    if (remaining === 0) {
      const next = warmupContinuation(ctx.now);
      await ctx.enqueue({
        kind: "campaign.send_chunk",
        payload: { campaignId: input.campaignId, chunkNo: input.chunkNo, runNo: input.runNo, day: next.day },
        key: chunkJobKey(input.campaignId, input.chunkNo, input.runNo, next.day),
        lane: "bulk",
        priority: 9,
        runAt: next.runAt,
      });
      result.exited = "warmup";
      break;
    }
    const batch = await runBatch(ctx, env, input, k, Math.min(BATCH_SIZE, remaining ?? BATCH_SIZE));
    if (!batch) break;
    result.batches++;
    result.sent += batch.sent;
    result.skipped += batch.skipped;
    result.failed += batch.failed;
  }

  // Rule 34: under the row lock, after this chunk's own rows are written.
  const [locked] = await tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId)).for("no key update");
  if (!locked) return result;
  let current = locked;
  if (result.sent) {
    const [updated] = await tx
      .update(campaigns)
      .set({ sentCount: sql`${campaigns.sentCount} + ${result.sent}`, updatedAt: ctx.now })
      .where(eq(campaigns.id, locked.id))
      .returning();
    current = updated ?? locked;
  }
  if (current.status === "sending") {
    const [planned] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignRecipients)
      .where(and(eq(campaignRecipients.campaignId, current.id), eq(campaignRecipients.status, "planned")));
    if (Number(planned?.n ?? 0) === 0) {
      await transitionCampaign(ctx, current, "sent", { finishedAt: ctx.now });
      result.finished = true;
    }
  }
  await evaluateBounceRate(tx, input.campaignId, ctx);
  return result;
}
