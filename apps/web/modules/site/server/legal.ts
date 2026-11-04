/**
 * Legal versions and terms acceptance (site rules 33-35, 61-62, 67; api.ts section 4; site-P5).
 * The live version of a legal page is the `current_version_id` of its published page; its
 * "Version n" is the published ordinal from `v_legal_versions`. Acceptances are append-only rows
 * of `terms_acceptances`, idempotent on their key, and every read by person runs over
 * `crm.resolvePersonIds` (the person and every person merged into it).
 */
import { unstable_cache } from "next/cache";
import type { DbOrTx, Tx } from "@beam/db";
import { pageRoutes, pages, pageVersions, termsAcceptances, vLegalVersions } from "@beam/db/schema";
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { localePath, richDocToPlainText, type Block, type LegalKey, type TermsContext } from "@beam/core/site";
import { and, desc, eq, getAppDb, inArray, NotFoundError, ValidationError, type Ctx } from "@/lib/ctx";
import { absoluteUrl, canonicalOrigin } from "./urls";

export type CurrentLegalVersion = {
  versionId: string;
  /** Published ordinal from `v_legal_versions` ("Version n"). */
  version: number;
  publishedAt: Date;
  /** The live version's `is_material_change`. */
  requiresReacceptance: boolean;
  /** `richDocToPlainText` of the live blocks per live locale (crm's reception print and declarations). */
  text: LocalizedText;
  urlByLocale: Partial<Record<Locale, string>>;
};

export type RecordTermsAcceptanceInput = {
  personId: string;
  versionId: string;
  context: TermsContext;
  refType?: "order" | "booking" | "user";
  refId?: string;
  ip?: string | null;
};

export type LegalLinks = { privacy: string | null; terms: string | null; cookies: string | null; accessibility: string | null };

/** `terms:<person_id>:<page_version_id>:<context>:<ref_id|none>` (site spec section 2). */
export function termsIdempotencyKey(input: Pick<RecordTermsAcceptanceInput, "personId" | "versionId" | "context" | "refId">): string {
  return `terms:${input.personId}:${input.versionId}:${input.context}:${input.refId ?? "none"}`;
}

/** Plain text of a block list: headings and paragraphs, blank-line separated. */
export function blocksToPlainText(blocks: readonly Block[] | null | undefined): string {
  const parts: string[] = [];
  const push = (...texts: (string | null | undefined)[]) => {
    for (const t of texts) if (t && t.trim()) parts.push(t.trim());
  };
  for (const b of blocks ?? []) {
    switch (b.type) {
      case "hero":
        push(b.heading, b.subheading);
        break;
      case "rich_text":
        push(richDocToPlainText(b.doc));
        break;
      case "image_text":
        push(richDocToPlainText(b.doc));
        break;
      case "cta":
        push(b.heading, b.text);
        break;
      case "card_grid":
        push(b.heading);
        for (const c of b.cards) push(c.heading, c.text);
        break;
      case "faq":
        push(b.heading);
        for (const item of b.items) push(item.question, richDocToPlainText(item.answer));
        break;
      default:
        break;
    }
  }
  return parts.join("\n\n");
}

/** The live (published page, current version) row of a legal key, with its ordinal. */
async function liveLegalRow(db: DbOrTx, key: LegalKey) {
  const [row] = await db
    .select({
      pageId: pages.id,
      versionId: vLegalVersions.versionId,
      ordinal: vLegalVersions.ordinal,
      publishedAt: vLegalVersions.publishedAt,
      isMaterialChange: vLegalVersions.isMaterialChange,
    })
    .from(vLegalVersions)
    .innerJoin(pages, eq(pages.currentVersionId, vLegalVersions.versionId))
    .where(and(eq(vLegalVersions.legalKey, key), eq(pages.status, "published"), eq(pages.legalKey, key)))
    .limit(1);
  return row ?? null;
}

/** Live paths of a page per locale (`page_routes`). */
async function routesOf(db: DbOrTx, pageId: string): Promise<Partial<Record<Locale, string>>> {
  const rows = await db.select({ locale: pageRoutes.locale, path: pageRoutes.path }).from(pageRoutes).where(eq(pageRoutes.pageId, pageId));
  const out: Partial<Record<Locale, string>> = {};
  for (const r of rows) out[r.locale] = r.path;
  return out;
}

/** The live version of a legal page, or null when none is published. */
export async function getCurrentLegalVersion(db: DbOrTx, key: LegalKey): Promise<CurrentLegalVersion | null> {
  const live = await liveLegalRow(db, key);
  if (!live) return null;
  const [version] = await db
    .select({ locales: pageVersions.locales, blocks: pageVersions.blocks })
    .from(pageVersions)
    .where(eq(pageVersions.id, live.versionId));
  const locales = (version?.locales ?? []).filter((l): l is Locale => (LOCALES as readonly string[]).includes(l));
  const blocks: Partial<Record<Locale, Block[]>> = version?.blocks ?? {};
  const text: LocalizedText = {};
  for (const l of locales) text[l] = blocksToPlainText(blocks[l]);
  const routes = await routesOf(db, live.pageId);
  const urlByLocale: Partial<Record<Locale, string>> = {};
  if (Object.keys(routes).length > 0) {
    const origin = await canonicalOrigin(db);
    for (const l of LOCALES) {
      const path = routes[l];
      if (path !== undefined) urlByLocale[l] = absoluteUrl(origin, localePath(l, path));
    }
  }
  return {
    versionId: live.versionId,
    version: Number(live.ordinal),
    publishedAt: new Date(live.publishedAt),
    requiresReacceptance: live.isMaterialChange,
    text,
    urlByLocale,
  };
}

/** Idempotent on `terms:<person>:<version>:<context>:<ref_id|none>`; writes event `site.terms_accepted` once. */
export async function recordTermsAcceptance(tx: Tx, ctx: Ctx, input: RecordTermsAcceptanceInput): Promise<{ acceptanceId: string; created: boolean }> {
  if (input.refId && !input.refType) throw new ValidationError("validation", { refType: "required with refId" });
  const [version] = await tx
    .select({ legalKey: vLegalVersions.legalKey, ordinal: vLegalVersions.ordinal })
    .from(vLegalVersions)
    .where(eq(vLegalVersions.versionId, input.versionId));
  if (!version) throw new NotFoundError("legal_version_not_found");
  const key = termsIdempotencyKey(input);
  const [inserted] = await tx
    .insert(termsAcceptances)
    .values({
      personId: input.personId,
      pageVersionId: input.versionId,
      legalKey: version.legalKey,
      context: input.context,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      ip: input.ip === undefined ? ctx.ip : input.ip,
      idempotencyKey: key,
      acceptedAt: ctx.now,
    })
    .onConflictDoNothing({ target: termsAcceptances.idempotencyKey })
    .returning({ id: termsAcceptances.id });
  if (!inserted) {
    const [existing] = await tx.select({ id: termsAcceptances.id }).from(termsAcceptances).where(eq(termsAcceptances.idempotencyKey, key));
    return { acceptanceId: existing!.id, created: false };
  }
  await ctx.recordEvent({
    kind: "site.terms_accepted",
    personId: input.personId,
    occurredAt: ctx.now,
    ref: { type: "page_version", id: input.versionId },
    data: { legal_key: version.legalKey, context: input.context, version_ordinal: Number(version.ordinal) },
    dedupeKey: key,
  });
  return { acceptanceId: inserted.id, created: true };
}

/**
 * Over `crm.resolvePersonIds`: true when the person's latest `terms` acceptance is for a version
 * at or after the latest material terms version (any accepted version when none is material);
 * false when no terms version is published or the person never accepted.
 */
export async function hasAcceptedCurrentTerms(db: DbOrTx, personId: string): Promise<boolean> {
  if (!(await liveLegalRow(db, "terms"))) return false;
  const versions = await db
    .select({ versionId: vLegalVersions.versionId, ordinal: vLegalVersions.ordinal, isMaterialChange: vLegalVersions.isMaterialChange })
    .from(vLegalVersions)
    .where(eq(vLegalVersions.legalKey, "terms"));
  const ordinalOf = new Map(versions.map((v) => [v.versionId, Number(v.ordinal)]));
  const latestMaterial = versions.filter((v) => v.isMaterialChange).reduce((max, v) => Math.max(max, Number(v.ordinal)), 0);
  // Loaded on use: crm's api imports this module's barrel (declarations), so a static import is a cycle.
  const { resolvePersonIds } = await import("@/modules/crm/api");
  const ids = await resolvePersonIds(db, personId);
  if (ids.length === 0) return false;
  const accepted = await db
    .select({ versionId: termsAcceptances.pageVersionId })
    .from(termsAcceptances)
    .where(and(inArray(termsAcceptances.personId, ids), eq(termsAcceptances.legalKey, "terms")))
    .orderBy(desc(termsAcceptances.acceptedAt));
  const best = accepted.reduce((max, a) => Math.max(max, ordinalOf.get(a.versionId) ?? 0), 0);
  return best > 0 && best >= latestMaterial;
}

const LINK_KEYS: Record<keyof LegalLinks, LegalKey> = {
  privacy: "privacy_notice",
  terms: "terms",
  cookies: "cookie_notice",
  accessibility: "accessibility_statement",
};

/** Absolute URLs of the live legal pages in `locale` (null when a page is not live in that locale). */
export async function loadLegalLinks(db: DbOrTx, locale: Locale): Promise<LegalLinks> {
  const rows = await db
    .select({ legalKey: pages.legalKey, path: pageRoutes.path })
    .from(pages)
    .innerJoin(pageRoutes, and(eq(pageRoutes.pageId, pages.id), eq(pageRoutes.locale, locale)))
    .where(and(eq(pages.status, "published"), inArray(pages.legalKey, Object.values(LINK_KEYS))));
  const pathOf = new Map(rows.map((r) => [r.legalKey, r.path]));
  const origin = rows.length > 0 ? await canonicalOrigin(db) : "";
  const url = (key: LegalKey): string | null => {
    const path = pathOf.get(key);
    return path === undefined ? null : absoluteUrl(origin, localePath(locale, path));
  };
  return { privacy: url("privacy_notice"), terms: url("terms"), cookies: url("cookie_notice"), accessibility: url("accessibility_statement") };
}

/** Absolute URLs for email footers and checkout (cached with the route tags; recomputed outside Next). */
export async function getLegalLinks(locale: Locale): Promise<LegalLinks> {
  const load = async () => loadLegalLinks(await getAppDb(), locale);
  const cached = unstable_cache(load, ["site:getLegalLinks", locale], { tags: ["site:routes", "site:pages", "site:settings"] });
  try {
    return await cached();
  } catch (error) {
    if (/incrementalCache missing|static generation store missing/i.test(String((error as Error)?.message ?? error))) return load();
    throw error;
  }
}
