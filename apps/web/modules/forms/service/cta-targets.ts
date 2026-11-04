/**
 * Result CTA targets (forms spec section 4 "CTA targets", rule P7, edge case 17, decision 38).
 * `checkCtaTargets` lists the broken CTAs of a definition (publish check of forms-P5 and the
 * nightly `forms.check_cta_targets`); `resolveCtaTarget` gives the redirect of the `go` route,
 * falling back to the ending's first `url` CTA or the locale home with `fallback = true`.
 * `webinar` targets arrive in R2 (forms-P8): until then they are always `missing_webinar`.
 */
import type { DbOrTx } from "@beam/db";
import { forms, formVersions, products, sessions, sessionTemplates, type FormCtaWarningJson } from "@beam/db/schema";
import { FormDefinition as FormDefinitionSchema, type Cta, type FormDefinition, type PublishIssue } from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { and, eq, inArray, isNotNull } from "@/lib/ctx";
import { getEventPageUrl } from "@/modules/site/api";
import { appOrigin, localeSegment } from "./tokens";

export type CtaWarning = FormCtaWarningJson;
type Reason = CtaWarning["reason"];

/** Why a CTA's target is unusable now, or null when it is fine (`url` CTAs never break). */
export async function ctaProblem(db: DbOrTx, cta: Cta, now: Date = new Date()): Promise<Reason | null> {
  switch (cta.kind) {
    case "booking":
    case "experience": {
      if (!cta.sessionTemplateId) return "inactive_template";
      const [t] = await db.select({ a: sessionTemplates.isActive }).from(sessionTemplates).where(eq(sessionTemplates.id, cta.sessionTemplateId));
      return t?.a ? null : "inactive_template";
    }
    case "event": {
      if (!cta.sessionId) return "past_session";
      const [s] = await db.select({ status: sessions.status, startsAt: sessions.startsAt }).from(sessions).where(eq(sessions.id, cta.sessionId));
      return s && s.status === "open" && s.startsAt.getTime() > now.getTime() ? null : "past_session";
    }
    case "product": {
      if (!cta.productId) return "inactive_product";
      const [p] = await db.select({ a: products.isActive }).from(products).where(eq(products.id, cta.productId));
      return p?.a ? null : "inactive_product";
    }
    case "webinar":
      return "missing_webinar";
    case "url":
      return null;
  }
}

/** P7 and the nightly check: every broken CTA of every ending. */
export async function checkCtaTargets(db: DbOrTx, def: FormDefinition, now: Date = new Date()): Promise<CtaWarning[]> {
  const out: CtaWarning[] = [];
  for (const e of def.endings) {
    for (const c of e.ctas) {
      const reason = await ctaProblem(db, c, now);
      if (reason) out.push({ endingKey: e.key, ctaKey: c.key, reason });
    }
  }
  return out;
}

/** The warnings as blocking publish issues (P7). */
export function ctaIssues(warnings: readonly CtaWarning[]): PublishIssue[] {
  return warnings.map((w) => ({
    level: "error" as const,
    code: "cta_target_missing" as const,
    path: `endings.${w.endingKey}.ctas.${w.ctaKey}`,
    message: `CTA target is not usable: ${w.reason}`,
  }));
}

/** `utm_source=beam_form&utm_medium=result&utm_campaign=<slug>` appended to an https URL. */
export function withResultUtm(url: string, slug: string | undefined): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    u.searchParams.set("utm_source", "beam_form");
    u.searchParams.set("utm_medium", "result");
    if (slug) u.searchParams.set("utm_campaign", slug);
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * The redirect target of a CTA. Internal targets (booking, experience, event, product) are
 * absolute BEAM URLs; the `go` route appends `pt=<identity token>` to them (ID7). A broken
 * target falls back to `opts.fallbackUrl` (the ending's first `url` CTA) or the locale home.
 */
export async function resolveCtaTarget(
  db: DbOrTx,
  cta: Cta,
  locale: Locale,
  opts: { formSlug?: string; fallbackUrl?: string; now?: Date } = {},
): Promise<{ url: string; fallback: boolean }> {
  const origin = appOrigin();
  const seg = localeSegment(locale);
  const fallback = (): { url: string; fallback: boolean } => {
    const u = opts.fallbackUrl ? withResultUtm(opts.fallbackUrl, opts.formSlug) : null;
    return { url: u ?? `${origin}/${seg}`, fallback: true };
  };
  if (await ctaProblem(db, cta, opts.now)) return fallback();
  switch (cta.kind) {
    case "booking":
    case "experience":
      return { url: `${origin}/${seg}/account/book?template=${encodeURIComponent(cta.sessionTemplateId!)}`, fallback: false };
    case "event": {
      const page = await getEventPageUrl(db, cta.sessionId!, locale);
      return { url: page ?? `${origin}/${seg}/account/book/${cta.sessionId!}`, fallback: false };
    }
    case "product":
      return { url: `${origin}/${seg}/account/shop?product=${encodeURIComponent(cta.productId!)}`, fallback: false };
    case "url": {
      const u = cta.url ? withResultUtm(cta.url, opts.formSlug) : null;
      return u ? { url: u, fallback: false } : fallback();
    }
    default:
      return fallback();
  }
}

/** True for targets on the BEAM origin (they receive `pt`). */
export function isInternalCta(cta: Cta): boolean {
  return cta.kind !== "url" && cta.kind !== "webinar";
}

/** `forms.check_cta_targets`: overwrites `forms.cta_warnings` of every published form; returns the forms checked. */
export async function refreshCtaWarnings(db: DbOrTx, now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ formId: forms.id, definition: formVersions.definition, warnings: forms.ctaWarnings })
    .from(forms)
    .innerJoin(formVersions, eq(formVersions.id, forms.currentVersionId))
    .where(and(inArray(forms.status, ["published", "archived"]), isNotNull(forms.currentVersionId)));
  for (const r of rows) {
    const parsed = FormDefinitionSchema.safeParse(r.definition);
    const warnings = parsed.success ? await checkCtaTargets(db, parsed.data, now) : [];
    if (JSON.stringify(warnings) === JSON.stringify(r.warnings ?? [])) continue;
    await db.update(forms).set({ ctaWarnings: warnings, updatedAt: now }).where(eq(forms.id, r.formId));
  }
  return rows.length;
}
