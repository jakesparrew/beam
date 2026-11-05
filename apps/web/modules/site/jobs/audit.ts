/**
 * `site.audit_content` (R4, site spec sections 4 and 5, decision 22; site-P10): the weekly content
 * and SEO audit, scheduled every Monday at 07:10 Europe/Brussels (`schedules.ts`). Idempotency key
 * `schedule:site.audit_content:<YYYY-MM-DDTHH:mm>`; one `site_audit_reports` row per Brussels week
 * (`week_on` = that Monday, unique, insert on conflict do nothing), so a double run or a second
 * firing in the same week writes nothing new and calls Claude no more.
 *
 * Every published page (at most `AUDIT_MAX_PAGES`, by slug) gets:
 * - deterministic findings: every publish check its live version fails today (broken references:
 *   inactive products, unpublished forms or linked pages, missing media or sessions, SEO lengths),
 *   and an `info` finding per locale the page lacks (the "Translate missing locales" hint);
 * - one `callClaude(ctx, { feature: 'site.audit_content', model: 'haiku' })` pass over a text
 *   digest of its live content for missing or weak SEO texts, titles and excerpts.
 *
 * No personal data: the digest drops testimonial authors and masks email addresses and phone
 * numbers; `fieldsSent` is empty (the feature allows no fields); every finding is rebuilt from
 * known page ids and locales, a code from `AUDIT_AI_CODES` (else `other`) and a message with the
 * same masking applied (and the page's testimonial names removed), at most 300 characters.
 *
 * A budget refusal (`PermanentError('budget')`) ends the run without a report and without throwing,
 * so the job neither retries nor dies; next week's run tries again. An invalid or refused answer
 * skips that page's Claude findings. A provider 5xx, 429 or timeout retries the job (3 attempts);
 * on the last attempt the page is skipped and the report is still written.
 */
import { z } from "zod";
import type { DbOrTx } from "@beam/db";
import { pages, pageVersions, siteAuditReports } from "@beam/db/schema";
import { PermanentError, RetryableError } from "@beam/core/errors";
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import type { Block, SiteAuditFinding, VersionContent } from "@beam/core/site";
import { IntegrationError } from "@beam/integrations/_shared";
import { callClaude } from "@/lib/ai";
import { and, desc, eq, getAppDb, inArray, isNotNull } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { checkContent } from "../server/refs";
import { versionContent, type PageRow } from "../server/versions";

export const AuditContentInput = z.object({}).passthrough();
export type AuditContentInput = z.infer<typeof AuditContentInput>;

/** `maxAttempts` of the `site.audit_content` registration in `jobs.ts`. */
export const AUDIT_MAX_ATTEMPTS = 3;
/** Pages reviewed per run (one Claude call each). */
export const AUDIT_MAX_PAGES = 60;
/** Findings kept per page from Claude's answer. */
export const AUDIT_MAX_AI_FINDINGS = 8;
export const AUDIT_MESSAGE_MAX = 300;

/** Codes Claude may use; anything else is stored as `other`. */
export const AUDIT_AI_CODES = ["seo_title_weak", "seo_description_weak", "title_weak", "excerpt_weak", "content_thin", "cta_missing", "translation_mismatch", "other"] as const;
export type AuditAiCode = (typeof AUDIT_AI_CODES)[number];
/** The deterministic code for a locale the page lacks. */
export const AUDIT_LOCALE_MISSING = "locale_missing";

export const AuditOutput = z.object({
  issues: z
    .array(z.object({ locale: z.enum(LOCALES), severity: z.enum(["info", "warn"]), code: z.string().max(60), message: z.string().max(2000) }))
    .max(40),
});
export type AuditOutput = z.infer<typeof AuditOutput>;

export type AuditContentResult =
  | { outcome: "reported"; weekOn: string; findings: number; pages: number; skippedPages: number }
  | { outcome: "skipped"; weekOn: string; reason: "already_reported" | "budget_exceeded" };

// ---------------------------------------------------------------------------------------------
// Week and masking helpers
// ---------------------------------------------------------------------------------------------

/** The Monday (`YYYY-MM-DD`) of the Europe/Brussels week that contains `at`. */
export function auditWeekOn(at: Date): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  // Calendar arithmetic on the date itself (noon UTC), not on a wall-clock instant.
  const day = new Date(`${ymd}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-like runs: an optional +, then at least 8 digits with spaces, dots, slashes or dashes.
const PHONE = /\+?\d[\d\s./()-]{6,}\d/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Masks email addresses, phone numbers and the given names (case-insensitive). */
export function maskPersonalData(text: string, names: readonly string[] = []): string {
  const isDate = (m: string) => /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./]\d{1,2}[./]\d{4}$/.test(m.trim());
  let out = text.replace(EMAIL, "[email]").replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 8 && !isDate(m) ? "[phone]" : m));
  for (const n of names) if (n.trim().length >= 3) out = out.replace(new RegExp(escapeRe(n.trim()), "gi"), "[name]");
  return out;
}

// ---------------------------------------------------------------------------------------------
// The page digest sent to Claude (content text only, no personal data)
// ---------------------------------------------------------------------------------------------

const SKIP_KEYS = new Set(["id", "type", "mediaId", "posterMediaId", "productIds", "formSlug", "target", "link", "youtubeId", "imageSide", "linkUrl", "webinarId", "authorName", "authorDetail", "marks", "attrs"]);

function strings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) out.push(value.trim());
  } else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (!SKIP_KEYS.has(k) && k !== "kind") strings(v, out);
}

/** The visible text of a block (button labels, headings, rich text), without people or references. */
export function blockText(block: Block): string {
  const out: string[] = [];
  strings(block, out);
  return out.join(" ").slice(0, 600);
}

/** Testimonial author names of a version (removed from what Claude sees and from its findings). */
export function personNames(content: Pick<VersionContent, "blocks">): string[] {
  const names = new Set<string>();
  for (const l of LOCALES) for (const b of content.blocks[l] ?? []) if (b.type === "testimonial") for (const n of [b.authorName, b.authorDetail]) if (n?.trim()) names.add(n.trim());
  return [...names];
}

export function pageDigest(page: Pick<PageRow, "kind">, content: VersionContent) {
  const names = personNames(content);
  const mask = (s: string | null | undefined) => (s ? maskPersonalData(s, names) : null);
  return {
    kind: page.kind,
    locales: content.locales,
    content: Object.fromEntries(
      content.locales.map((l) => [
        l,
        {
          title: mask(content.title[l]),
          path: content.paths[l] ?? null,
          seoTitle: mask(content.seo[l]?.title),
          seoDescription: mask(content.seo[l]?.description),
          excerpt: mask((content.excerpt as LocalizedText | null)?.[l]),
          blocks: (content.blocks[l] ?? []).map((b) => ({ type: b.type, text: mask(blockText(b)) })),
        },
      ]),
    ),
  };
}

const SYSTEM = `You review pages of the BEAM Vitality Center website (Belgium) for search engines and readers. You receive one published page as JSON: per locale (nl-BE, fr-BE, en) its title, path, SEO title, SEO description, excerpt and the text of its blocks.

Report only real problems, at most ${AUDIT_MAX_AI_FINDINGS}:
- seo_title_weak: SEO title missing, generic, or not about the page (good: 30-60 characters with the main topic).
- seo_description_weak: SEO description missing, generic or not inviting (good: 120-160 characters).
- title_weak: page title unclear.  excerpt_weak: excerpt missing or unclear (posts, events, landing pages).
- content_thin: very little useful text.  cta_missing: no clear next step for the visitor.
- translation_mismatch: a locale says something different from the others, or is in the wrong language.
- other: anything else that clearly hurts the page.

Answer only with JSON: { "issues": [{ "locale", "severity": "info" | "warn", "code", "message" }] }. "message" is one short English suggestion for the staff (at most 200 characters). Never include names, email addresses or phone numbers in a message. An empty list is a good answer for a good page.`;

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

const isInvalidOutput = (e: unknown) => (e instanceof RetryableError || e instanceof PermanentError) && e.message === "invalid_output";
const isRetryable = (e: unknown) => e instanceof RetryableError || (e instanceof IntegrationError && e.retryable);

/** Rebuilds Claude's findings for one page: known locales only, allowed codes, masked short messages. */
export function cleanAiFindings(pageId: string, locales: readonly Locale[], output: AuditOutput, names: readonly string[]): SiteAuditFinding[] {
  const out: SiteAuditFinding[] = [];
  for (const i of output.issues) {
    if (!locales.includes(i.locale)) continue;
    const code: AuditAiCode = (AUDIT_AI_CODES as readonly string[]).includes(i.code) ? (i.code as AuditAiCode) : "other";
    const message = maskPersonalData(i.message.replace(/\s+/g, " ").trim(), names).slice(0, AUDIT_MESSAGE_MAX);
    if (!message) continue;
    out.push({ pageId, locale: i.locale, severity: i.severity, code, message });
    if (out.length >= AUDIT_MAX_AI_FINDINGS) break;
  }
  return out;
}

/** Deterministic findings of a live version: today's publish checks and the locales it lacks. */
async function checkFindings(ctx: JobCtx, page: PageRow, content: VersionContent): Promise<SiteAuditFinding[]> {
  const first = content.locales[0] ?? "nl-BE";
  const issues = await checkContent(ctx.tx, page, content);
  const seen = new Set<string>();
  const out: SiteAuditFinding[] = [];
  for (const i of issues) {
    const locale = i.locale ?? first;
    const key = `${locale}:${i.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pageId: page.id, locale, severity: "warn", code: String(i.code), message: maskPersonalData(i.message).slice(0, AUDIT_MESSAGE_MAX) });
  }
  for (const l of LOCALES) if (!content.locales.includes(l)) out.push({ pageId: page.id, locale: l, severity: "info", code: AUDIT_LOCALE_MISSING, message: `The page has no ${l} version.` });
  return out;
}

export async function auditContent(ctx: JobCtx, _input: AuditContentInput): Promise<AuditContentResult> {
  const weekOn = auditWeekOn(ctx.now);
  const [existing] = await ctx.tx.select({ id: siteAuditReports.id }).from(siteAuditReports).where(eq(siteAuditReports.weekOn, weekOn));
  if (existing) return { outcome: "skipped", weekOn, reason: "already_reported" };

  const rows = await ctx.tx
    .select({ page: pages, version: pageVersions })
    .from(pages)
    .innerJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(and(eq(pages.status, "published"), isNotNull(pages.currentVersionId)))
    .orderBy(pages.slug)
    .limit(AUDIT_MAX_PAGES);

  const findings: SiteAuditFinding[] = [];
  let aiRequestId: string | null = null;
  let skippedPages = 0;
  for (const { page, version } of rows) {
    const content = versionContent(version);
    findings.push(...(await checkFindings(ctx, page, content)));
    const names = personNames(content);
    try {
      const res = await callClaude(ctx, {
        feature: "site.audit_content",
        model: "haiku",
        system: SYSTEM,
        messages: [{ role: "user", content: `Page (JSON):\n${JSON.stringify(pageDigest(page, content))}` }],
        // The feature allows no personal-data fields (PL-53); the digest holds none.
        fieldsSent: [],
        outputSchema: AuditOutput,
        maxTokens: 2000,
      });
      aiRequestId ??= res.aiRequestId;
      findings.push(...cleanAiFindings(page.id, content.locales, res.parsed, names));
    } catch (error) {
      if (error instanceof PermanentError && error.message === "budget") return { outcome: "skipped", weekOn, reason: "budget_exceeded" };
      if (isRetryable(error) && !isInvalidOutput(error) && ctx.job.attempt < AUDIT_MAX_ATTEMPTS) throw error;
      skippedPages += 1;
    }
  }

  const inserted = await ctx.tx.insert(siteAuditReports).values({ weekOn, findings, aiRequestId }).onConflictDoNothing().returning({ id: siteAuditReports.id });
  if (!inserted.length) return { outcome: "skipped", weekOn, reason: "already_reported" };
  await ctx.audit({ action: "site.audit.report", entityType: "site_audit_report", entityId: inserted[0]!.id, newValue: { weekOn, findings: findings.length, pages: rows.length, skippedPages } });
  return { outcome: "reported", weekOn, findings: findings.length, pages: rows.length, skippedPages };
}

// ---------------------------------------------------------------------------------------------
// The latest report for `/admin/site` (read by `ui/admin/content-issues.tsx`)
// ---------------------------------------------------------------------------------------------

export type AuditReportView = {
  weekOn: string;
  createdAt: string;
  findings: (SiteAuditFinding & { title: string })[];
};

/** The newest audit report with each finding's page title in `locale` (findings of deleted pages dropped). */
export async function getLatestAuditReport(locale: Locale, db?: DbOrTx): Promise<AuditReportView | null> {
  const d = db ?? (await getAppDb());
  const [report] = await d.select().from(siteAuditReports).orderBy(desc(siteAuditReports.weekOn)).limit(1);
  if (!report) return null;
  const ids = [...new Set((report.findings ?? []).map((f) => f.pageId))];
  const titles = ids.length
    ? await d.select({ id: pages.id, slug: pages.slug, status: pages.status, title: pageVersions.title }).from(pages).leftJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId)).where(inArray(pages.id, ids))
    : [];
  const byId = new Map(titles.filter((t) => t.status !== "archived").map((t) => [t.id, t.title?.[locale] || t.title?.["nl-BE"] || t.slug]));
  return {
    weekOn: report.weekOn,
    createdAt: report.createdAt.toISOString(),
    findings: (report.findings ?? []).filter((f) => byId.has(f.pageId)).map((f) => ({ ...f, title: byId.get(f.pageId)! })),
  };
}
