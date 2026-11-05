/**
 * `site.propose_page` (site spec section 4 jobs, rules 41-44 and 56, edge cases 7-11 and 38;
 * site-P4). Key `page_edit:<edit_request_id>:propose`, 3 attempts. A no-op unless the request is
 * `pending`/`running` without `result_version_id`. The page archived before the job ran fails the
 * request with `page_archived`. Claude is called through `callClaude` (model opus, structured output
 * `ProposalOutput`, max 16000 tokens); invalid output gets one repair call, a second failure ends
 * the request `invalid_output` with no version. `PermanentError('budget')` ends it
 * `budget_exceeded`; provider 5xx, 429 and timeouts retry, and the last attempt ends it
 * `ai_unavailable`. On success the `proposed` version (created by `claude`, for the requester) is
 * inserted and the request set `succeeded` in one transaction.
 *
 * No row lock is held during the Claude call: the request and page rows are locked (page first,
 * like `archivePageTx`) only when the outcome is written, and the status is re-checked then, so a
 * request cancelled or a page archived meanwhile gets no version. Because the job runs in one
 * transaction, `running` would only become visible at the commit together with the outcome, so
 * the request moves from `pending` straight to its final status (the panel shows "running" for
 * any active request).
 *
 * R4 (site-P10): a `translate` request fills the target locales (those the base lacks) from the
 * base's source locale. Claude's answer is merged onto the base first (`mergeTranslation`): the
 * base locales are taken from the base unchanged and only the target locales from the answer, so a
 * translation can never alter or drop an existing locale. `translationErrors` then requires every
 * target locale to repeat the source blocks' ids, order, types and references; a mismatch counts as
 * invalid output (the one repair round applies).
 */
import { z } from "zod";
import { pageEditRequests, pages, pageVersions } from "@beam/db/schema";
import { PermanentError, RetryableError } from "@beam/core/errors";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { ProposalOutput, type Block, type VersionContent } from "@beam/core/site";
import { IntegrationError } from "@beam/integrations/_shared";
import { callClaude } from "@/lib/ai";
import { and, eq, inArray } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { getEditorPickers } from "../queries/admin";
import { buildProposalPrompt, buildRepairMessages, capRefs, translationSource, type ProposalRefs } from "../server/ai-prompt";
import { validateProposal } from "../server/proposal-validate";
import { getSiteSettings } from "../server/settings";
import { allocateVersion, contentColumns, getVersionRow, lockPage, versionContent, type PageRow } from "../server/versions";

export const ProposePageInput = z.object({ editRequestId: z.string().uuid() });
export type ProposePageInput = z.infer<typeof ProposePageInput>;

/** The job key of a request (site spec section 4 jobs). */
export function proposeJobKey(editRequestId: string): string {
  return `page_edit:${editRequestId}:propose`;
}

/** `maxAttempts` of the `site.propose_page` registration in `jobs.ts`. */
export const PROPOSE_MAX_ATTEMPTS = 3;

export type ProposeErrorCode = "budget_exceeded" | "invalid_output" | "ai_unavailable" | "page_archived";

export type ProposePageResult =
  | { outcome: "proposed"; versionId: string; repaired: boolean }
  | { outcome: "failed"; errorCode: ProposeErrorCode }
  | { outcome: "skipped"; reason: string };

type RequestRow = typeof pageEditRequests.$inferSelect;
const ACTIVE = ["pending", "running"] as const;

async function readRequest(ctx: JobCtx, id: string): Promise<RequestRow | null> {
  const [row] = await ctx.tx.select().from(pageEditRequests).where(eq(pageEditRequests.id, id));
  return row ?? null;
}

/** Locks the page, then the request; returns both while the request is still active and unanswered. */
async function lockActive(ctx: JobCtx, req: RequestRow): Promise<{ row: RequestRow; page: PageRow } | null> {
  const page = await lockPage(ctx.tx, req.pageId);
  const [row] = await ctx.tx.select().from(pageEditRequests).where(eq(pageEditRequests.id, req.id)).for("update");
  if (!row || row.resultVersionId || !(ACTIVE as readonly string[]).includes(row.status)) return null;
  return { row, page };
}

/** Ends an active request `failed` with `code` (a no-op when it is no longer active). */
async function failRequest(ctx: JobCtx, req: RequestRow, code: ProposeErrorCode, message: string | null, aiRequestId: string | null = null): Promise<ProposePageResult> {
  const locked = await lockActive(ctx, req);
  if (!locked) return { outcome: "skipped", reason: "request_closed" };
  const row = locked.row;
  await ctx.tx
    .update(pageEditRequests)
    .set({ status: "failed", errorCode: code, errorMessage: message ? message.slice(0, 1000) : null, finishedAt: ctx.now, updatedAt: ctx.now, ...(aiRequestId ? { aiRequestId } : {}) })
    .where(eq(pageEditRequests.id, row.id));
  await ctx.audit({ action: "site.proposal.failed", entityType: "page", entityId: row.pageId, newValue: { editRequestId: row.id, errorCode: code } });
  return { outcome: "failed", errorCode: code };
}

/** The reference lists of rule 42 (products, upcoming events, published forms, other pages), capped. */
export async function loadProposalRefs(ctx: JobCtx, pageId: string): Promise<ProposalRefs> {
  const pickers = await getEditorPickers("en", ctx.tx, ctx.now);
  return capRefs({
    products: pickers.products.map((p) => ({ id: p.id, name: p.label })),
    sessions: pickers.sessions.map((s) => ({ id: s.id, title: s.label, ...(s.hint ? { startsAt: s.hint } : {}) })),
    forms: pickers.forms.map((f) => ({ slug: f.slug, name: f.label })),
    pages: pickers.pages.filter((p) => p.id !== pageId).map((p) => ({ id: p.id, title: p.label })),
  });
}

// ---------------------------------------------------------------------------------------------
// Translations (R4)
// ---------------------------------------------------------------------------------------------

const PER_LOCALE_KEYS = ["title", "paths", "blocks", "seo", "excerpt"] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The answer of a translation merged onto the base: every per-locale field holds the base's value
 * for the base locales and the answer's value for the target locales only; other locales of the
 * answer are dropped. A value that is not an object is returned unchanged (it fails validation).
 */
export function mergeTranslation(base: VersionContent, raw: unknown, targets: readonly Locale[]): unknown {
  if (!isRecord(raw)) return raw;
  const merged: Record<string, unknown> = { ...raw };
  for (const key of PER_LOCALE_KEYS) {
    const fromBase = (base[key] ?? {}) as Partial<Record<Locale, unknown>>;
    const fromAnswer = (isRecord(raw[key]) ? raw[key] : {}) as Partial<Record<Locale, unknown>>;
    const out: Partial<Record<Locale, unknown>> = {};
    for (const l of LOCALES) {
      const value = base.locales.includes(l) ? fromBase[l] : targets.includes(l) ? fromAnswer[l] : undefined;
      if (value !== undefined && value !== null) out[l] = value;
    }
    if (key === "excerpt" && !Object.keys(out).length) delete merged.excerpt;
    else merged[key] = out;
  }
  return merged;
}

/** Keys whose string values are references (a translation keeps them); other strings are text. */
const REFERENCE_KEYS = new Set(["id", "type", "kind", "mediaId", "posterMediaId", "formSlug", "sessionId", "productId", "productIds", "pageId", "webinarId", "youtubeId", "imageSide", "route"]);
/** Rich text documents: their wording and paragraphs may differ between languages. */
const RICH_TEXT_KEYS = new Set(["doc", "answer"]);

/** A block without its text: references, numbers, switches and list lengths only. */
function skeleton(value: unknown, key: string | null = null): unknown {
  if (Array.isArray(value)) return value.map((v) => skeleton(v, key));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      if (RICH_TEXT_KEYS.has(k)) continue;
      const v = skeleton(value[k], k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (typeof value === "string") return key && REFERENCE_KEYS.has(key) ? value : undefined;
  return value;
}

/**
 * The structure check of a translation: each target locale has a title and the source locale's
 * blocks in the same order with the same ids, types and references (only the text differs).
 */
export function translationErrors(content: Pick<VersionContent, "title" | "blocks">, source: Locale, targets: readonly Locale[]): string[] {
  const errors: string[] = [];
  const src: Block[] = content.blocks[source] ?? [];
  for (const l of targets) {
    if (!(content.title[l] ?? "").trim()) errors.push(`title.${l}: the translation has no title`);
    const blocks: Block[] = content.blocks[l] ?? [];
    if (blocks.length !== src.length) {
      errors.push(`blocks.${l}: the translation has ${blocks.length} blocks and ${source} has ${src.length}; translate every block and add none`);
      continue;
    }
    blocks.forEach((b, i) => {
      const s = src[i]!;
      if (b.id !== s.id || b.type !== s.type) errors.push(`blocks.${l}[${i}]: expected the ${s.type} block with id ${s.id} (the order of ${source}), got ${b.type} ${b.id}`);
      else if (JSON.stringify(skeleton(b)) !== JSON.stringify(skeleton(s))) errors.push(`blocks.${l}[${i}]: the ${b.type} block ${b.id} changes references, numbers, switches or the number of items of ${source}; translate only the text`);
    });
  }
  return errors;
}

const isInvalidOutput = (e: unknown) => (e instanceof RetryableError || e instanceof PermanentError) && e.message === "invalid_output";
const isRetryable = (e: unknown) => e instanceof RetryableError || (e instanceof IntegrationError && e.retryable);
function rawJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function proposePage(ctx: JobCtx, input: ProposePageInput): Promise<ProposePageResult> {
  const req = await readRequest(ctx, input.editRequestId);
  if (!req) return { outcome: "skipped", reason: "request_missing" };
  if (req.resultVersionId) return { outcome: "skipped", reason: "already_proposed" };
  if (!(ACTIVE as readonly string[]).includes(req.status)) return { outcome: "skipped", reason: `request_${req.status}` };

  const [page] = await ctx.tx.select().from(pages).where(eq(pages.id, req.pageId));
  if (!page) return { outcome: "skipped", reason: "page_missing" };
  if (page.status === "archived") return failRequest(ctx, req, "page_archived", null);

  const baseRow = req.baseVersionId ? await getVersionRow(ctx.tx, req.baseVersionId) : null;
  const base: VersionContent | null = baseRow ? versionContent(baseRow) : null;
  const translate = req.kind === "translate";
  // A translation fills only locales the base lacks (the base may have gained some since the request).
  const targetLocales = LOCALES.filter((l) => req.locales.includes(l) && !(translate && base?.locales.includes(l)));
  const source = translate && base ? translationSource(base.locales) : null;
  if (translate && (!base || !source || !targetLocales.length)) return failRequest(ctx, req, "invalid_output", "nothing_to_translate");
  const settings = await getSiteSettings(ctx.tx);
  const refs = await loadProposalRefs(ctx, page.id);
  const prompt = buildProposalPrompt({
    page: { kind: page.kind, legalKey: page.legalKey ?? null, sessionId: page.sessionId ?? null, slug: page.slug },
    base,
    instruction: req.instruction,
    locales: targetLocales.length ? targetLocales : (base?.locales ?? ["nl-BE"]),
    refs,
    brandVoice: settings.brand_voice ?? "",
    kind: req.kind,
    ...(source ? { sourceLocale: source } : {}),
  });
  const known = { productIds: refs.products.map((p) => p.id), sessionIds: refs.sessions.map((s) => s.id), formSlugs: refs.forms.map((f) => f.slug), pageIds: [...refs.pages.map((p) => p.id), page.id] };
  const pageFacts = { kind: page.kind, legalKey: page.legalKey ?? null, sessionId: page.sessionId ?? null };

  let messages = prompt.messages;
  let lastErrors: string[] = [];
  let lastAiRequestId: string | null = null;
  for (let round = 0; round < 2; round++) {
    let text: string;
    let parsed: unknown;
    try {
      // `fieldsSent` lists personal-data fields (PL-53); a proposal sends none (rule 42).
      const res = await callClaude(ctx, { feature: "site.propose_page", model: "opus", system: prompt.system, messages, fieldsSent: [], outputSchema: ProposalOutput, maxTokens: 16000 });
      text = res.text;
      // The raw answer, so keys `ProposalOutput` strips (kind, legal key, session) are still checked.
      parsed = rawJson(res.text) ?? res.parsed;
      lastAiRequestId = res.aiRequestId;
    } catch (error) {
      if (isInvalidOutput(error)) {
        lastErrors = ["The answer did not match the output schema (invalid JSON, unknown block type or missing fields)."];
        messages = buildRepairMessages(prompt.messages, null, lastErrors);
        continue;
      }
      if (error instanceof PermanentError && error.message === "budget") return failRequest(ctx, req, "budget_exceeded", null);
      if (error instanceof PermanentError && error.message.startsWith("refusal")) return failRequest(ctx, req, "invalid_output", error.message);
      if (isRetryable(error)) {
        if (ctx.job.attempt < PROPOSE_MAX_ATTEMPTS) throw error;
        return failRequest(ctx, req, "ai_unavailable", errorText(error));
      }
      return failRequest(ctx, req, "ai_unavailable", errorText(error));
    }

    const candidate = translate && base ? mergeTranslation(base, parsed, targetLocales) : parsed;
    const checked = validateProposal(base, candidate, pageFacts, { targetLocales, known });
    const structure = checked.ok && translate && source ? translationErrors(checked.content, source, targetLocales) : [];
    if (!checked.ok || structure.length) {
      lastErrors = checked.ok ? structure : checked.errors;
      messages = buildRepairMessages(prompt.messages, text, lastErrors);
      continue;
    }

    const locked = await lockActive(ctx, req);
    if (!locked) return { outcome: "skipped", reason: "request_closed" };
    if (locked.page.status === "archived") return failRequest(ctx, req, "page_archived", null, lastAiRequestId);
    const version = await allocateVersion(ctx.tx, req.pageId);
    const [inserted] = await ctx.tx
      .insert(pageVersions)
      .values({
        pageId: req.pageId,
        version,
        state: "proposed",
        ...contentColumns(checked.content),
        basedOnVersionId: req.baseVersionId ?? null,
        createdBy: "claude",
        createdByUserId: req.requestedByUserId,
        editRequestId: req.id,
        proposedByAiRequestId: lastAiRequestId,
      })
      .returning({ id: pageVersions.id });
    await ctx.tx
      .update(pageEditRequests)
      .set({ status: "succeeded", resultVersionId: inserted!.id, aiRequestId: lastAiRequestId, errorCode: null, errorMessage: null, finishedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(pageEditRequests.id, req.id));
    await ctx.audit({ action: "site.proposal.create", entityType: "page", entityId: req.pageId, newValue: { editRequestId: req.id, versionId: inserted!.id, version, created_by: "claude", repaired: round > 0 } });
    return { outcome: "proposed", versionId: inserted!.id, repaired: round > 0 };
  }
  return failRequest(ctx, req, "invalid_output", lastErrors.join("; "), lastAiRequestId);
}

/** A dead job always leaves the request `failed` (`ai_unavailable`), so the page lock never sticks. */
export async function onProposePageDead(ctx: JobCtx, input: ProposePageInput, error: { message: string; permanent: boolean }): Promise<void> {
  await ctx.tx
    .update(pageEditRequests)
    .set({ status: "failed", errorCode: "ai_unavailable", errorMessage: error.message.slice(0, 1000), finishedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(pageEditRequests.id, input.editRequestId), inArray(pageEditRequests.status, [...ACTIVE])));
}
