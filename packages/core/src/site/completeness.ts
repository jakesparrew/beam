/**
 * Publish checks (rules 5, 6 and 33, section 8 "publish-time completeness"). `checkPublishable`
 * is pure: the caller loads the reference facts (`RefFacts`) for `collectRefs(version)` and passes
 * them in. Any issue blocks publishing; the editor shows the same list while editing.
 */
import { LOCALES, type Locale, type LocalizedText } from "../i18n";
import { BlockList, MAX_BLOCKS, type Block, type BlocksByLocale } from "./blocks";
import type { Link } from "./links";
import { pathIssue } from "./paths";
import { richDocToPlainText } from "./rich-text";
import { EXCERPT_KINDS, type LegalKey, type PageKind, type PageSeo, type PageStatus } from "./types";

export const TITLE_MAX = 120;
export const SEO_TITLE_MIN = 1;
export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MIN = 50;
export const SEO_DESCRIPTION_MAX = 170;

/** The content of one page version (what is diffed, checked and proposed). */
export type VersionContent = {
  title: LocalizedText;
  paths: Partial<Record<Locale, string>>;
  blocks: BlocksByLocale;
  seo: Partial<Record<Locale, PageSeo>>;
  excerpt?: LocalizedText | null;
  coverMediaId?: string | null;
  locales: Locale[];
  isMaterialChange?: boolean;
};

export type PublishIssueCode =
  | "locales_empty"
  | "title_missing"
  | "title_too_long"
  | "path_missing"
  | "path_invalid"
  | "path_reserved"
  | "path_home_only"
  | "path_taken"
  | "seo_title_length"
  | "seo_description_length"
  | "blocks_empty"
  | "blocks_too_many"
  | "block_invalid"
  | "legal_meta_not_legal"
  | "media_missing"
  | "alt_missing"
  | "excerpt_missing"
  | "form_unavailable"
  | "form_locale_missing"
  | "product_missing"
  | "product_inactive"
  | "session_missing"
  | "event_session_missing"
  | "webinar_unavailable"
  | "link_target_unavailable"
  | "legal_name_missing";

export const PUBLISH_ISSUE_CODES: readonly PublishIssueCode[] = [
  "locales_empty",
  "title_missing",
  "title_too_long",
  "path_missing",
  "path_invalid",
  "path_reserved",
  "path_home_only",
  "path_taken",
  "seo_title_length",
  "seo_description_length",
  "blocks_empty",
  "blocks_too_many",
  "block_invalid",
  "legal_meta_not_legal",
  "media_missing",
  "alt_missing",
  "excerpt_missing",
  "form_unavailable",
  "form_locale_missing",
  "product_missing",
  "product_inactive",
  "session_missing",
  "event_session_missing",
  "webinar_unavailable",
  "link_target_unavailable",
  "legal_name_missing",
];

export type PublishIssue = { locale?: Locale; blockId?: string; code: PublishIssueCode | (string & {}); message: string };

/** Facts about everything a version references; a missing key means "does not exist". */
export type RefFacts = {
  page: { id: string; kind: PageKind; legalKey: LegalKey | null; sessionId: string | null };
  media: Record<string, { alt: LocalizedText; isDecorative: boolean }>;
  /** Published forms by slug (`forms.getPublishedFormMeta`); absent or null = not published. */
  forms: Record<string, { locales: Locale[] } | null>;
  products: Record<string, { isActive: boolean }>;
  sessions: Record<string, { kind: string }>;
  /** Link targets: published pages, or archived pages that have a redirect. */
  pages: Record<string, { status: PageStatus; hasRedirect: boolean }>;
  /** Published webinars (R2, `webinar.listPublicWebinars`). */
  webinars: Record<string, true>;
  /** `<locale>:<path>` -> the id of the other page whose live route holds it. */
  takenPaths: Record<string, string>;
  /** `settings.company.legal_name` (rule 33). */
  legalName: string | null;
};

export type CollectedRefs = { mediaIds: string[]; formSlugs: string[]; productIds: string[]; sessionIds: string[]; pageIds: string[]; webinarIds: string[] };

const present = (s: string | null | undefined) => typeof s === "string" && s.trim().length > 0;

function linkPage(link: Link | undefined): string | null {
  return link?.kind === "page" ? link.pageId : null;
}

/** Media ids one block references. */
export function blockMediaIds(b: Block): string[] {
  switch (b.type) {
    case "hero":
      return b.mediaId ? [b.mediaId] : [];
    case "image":
    case "image_text":
    case "map":
      return [b.mediaId];
    case "card_grid":
      return b.cards.flatMap((c) => (c.mediaId ? [c.mediaId] : []));
    case "video":
      return [b.posterMediaId];
    default:
      return [];
  }
}

/** Page ids one block links to. */
export function blockPageIds(b: Block): string[] {
  const ids: (string | null)[] = [];
  if (b.type === "hero") ids.push(linkPage(b.cta?.link));
  if (b.type === "cta") ids.push(linkPage(b.button.link));
  if (b.type === "card_grid") for (const c of b.cards) ids.push(linkPage(c.link));
  return ids.filter((x): x is string => !!x);
}

/** Every visible text of a block, for the legal-name check, diffs and review warnings. */
export function blockTexts(b: Block): string[] {
  switch (b.type) {
    case "hero":
      return [b.heading, b.subheading ?? "", b.cta?.label ?? ""];
    case "rich_text":
      return [richDocToPlainText(b.doc)];
    case "image":
      return [b.caption ?? ""];
    case "image_text":
      return [richDocToPlainText(b.doc)];
    case "cta":
      return [b.heading, b.text ?? "", b.button.label];
    case "card_grid":
      return [b.heading ?? "", ...b.cards.flatMap((c) => [c.heading, c.text])];
    case "faq":
      return [b.heading ?? "", ...b.items.flatMap((i) => [i.question, richDocToPlainText(i.answer)])];
    case "pricing_table":
    case "events_list":
    case "posts_list":
      return [b.heading ?? ""];
    case "booking_cta":
      return [b.label];
    case "video":
      return [b.title];
    case "testimonial":
      return [b.quote, b.authorName, b.authorDetail ?? ""];
    default:
      return [];
  }
}

const uniq = (xs: Iterable<string>) => [...new Set(xs)];

/** Every reference of a version across all its locales. */
export function collectRefs(version: Pick<VersionContent, "blocks" | "coverMediaId" | "seo">): CollectedRefs {
  const media = new Set<string>();
  const forms = new Set<string>();
  const products = new Set<string>();
  const sessions = new Set<string>();
  const pages = new Set<string>();
  const webinars = new Set<string>();
  if (version.coverMediaId) media.add(version.coverMediaId);
  for (const l of LOCALES) {
    const og = version.seo?.[l]?.ogImageMediaId;
    if (og) media.add(og);
    for (const b of version.blocks?.[l] ?? []) {
      for (const m of blockMediaIds(b)) media.add(m);
      for (const p of blockPageIds(b)) pages.add(p);
      if (b.type === "form_embed") forms.add(b.formSlug);
      if (b.type === "pricing_table") for (const p of b.productIds) products.add(p);
      if (b.type === "booking_cta" && b.target.kind === "buy_product") products.add(b.target.productId);
      if (b.type === "booking_cta" && b.target.kind === "session") sessions.add(b.target.sessionId);
      if (b.type === "webinar_signup") webinars.add(b.webinarId);
    }
  }
  return {
    mediaIds: uniq(media),
    formSlugs: uniq(forms),
    productIds: uniq(products),
    sessionIds: uniq(sessions),
    pageIds: uniq(pages),
    webinarIds: uniq(webinars),
  };
}

/** Runs every publish check for every locale in `version.locales`; an empty list means publishable. */
export function checkPublishable(version: VersionContent, refs: RefFacts): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const add = (code: PublishIssueCode, message: string, locale?: Locale, blockId?: string) =>
    issues.push({ ...(locale ? { locale } : {}), ...(blockId ? { blockId } : {}), code, message });
  const { page } = refs;
  const locales = LOCALES.filter((l) => version.locales.includes(l));
  if (!locales.length) add("locales_empty", "The version has no locale");

  if (page.kind === "event") {
    if (!page.sessionId) add("event_session_missing", "The event page is not linked to a session");
    else if (refs.sessions[page.sessionId]?.kind !== "event") add("event_session_missing", "The linked session does not exist or is not an event");
  }

  const checkMedia = (mediaId: string, locale: Locale, blockId?: string) => {
    const m = refs.media[mediaId];
    if (!m) return add("media_missing", `Image ${mediaId} does not exist`, locale, blockId);
    if (!m.isDecorative && !present(m.alt[locale])) add("alt_missing", `Image ${mediaId} has no alt text in ${locale}`, locale, blockId);
  };

  for (const l of locales) {
    const title = version.title?.[l];
    if (!present(title)) add("title_missing", `Title missing in ${l}`, l);
    else if (title!.trim().length > TITLE_MAX) add("title_too_long", `Title longer than ${TITLE_MAX} characters in ${l}`, l);

    const path = version.paths?.[l];
    const pIssue = pathIssue(path, page.kind);
    if (pIssue) add(pIssue, `Path "${path ?? ""}" is not valid in ${l}`, l);
    else {
      const owner = refs.takenPaths[`${l}:${path}`];
      if (owner && owner !== page.id) add("path_taken", `Path "${path}" is already used by page ${owner} in ${l}`, l);
    }

    const seo = version.seo?.[l];
    const seoTitle = seo?.title?.trim() ?? "";
    const seoDesc = seo?.description?.trim() ?? "";
    if (seoTitle.length < SEO_TITLE_MIN || seoTitle.length > SEO_TITLE_MAX)
      add("seo_title_length", `SEO title must be ${SEO_TITLE_MIN}-${SEO_TITLE_MAX} characters in ${l}`, l);
    if (seoDesc.length < SEO_DESCRIPTION_MIN || seoDesc.length > SEO_DESCRIPTION_MAX)
      add("seo_description_length", `SEO description must be ${SEO_DESCRIPTION_MIN}-${SEO_DESCRIPTION_MAX} characters in ${l}`, l);
    if (seo?.ogImageMediaId) checkMedia(seo.ogImageMediaId, l);

    if (EXCERPT_KINDS.includes(page.kind) && !present(version.excerpt?.[l])) add("excerpt_missing", `Excerpt missing in ${l}`, l);
    if (version.coverMediaId) checkMedia(version.coverMediaId, l);

    const raw = version.blocks?.[l] ?? [];
    if (raw.length === 0) add("blocks_empty", `No blocks in ${l}`, l);
    if (raw.length > MAX_BLOCKS) add("blocks_too_many", `More than ${MAX_BLOCKS} blocks in ${l}`, l);
    const parsed = BlockList.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const index = typeof issue.path[0] === "number" ? issue.path[0] : -1;
        const blockId = (raw[index] as { id?: unknown } | undefined)?.id;
        add("block_invalid", `${issue.path.map(String).join(".")}: ${issue.message}`, l, typeof blockId === "string" ? blockId : undefined);
      }
      continue;
    }

    for (const b of raw) {
      for (const m of blockMediaIds(b)) checkMedia(m, l, b.id);
      for (const p of blockPageIds(b)) {
        const target = refs.pages[p];
        if (!target || (target.status !== "published" && !(target.status === "archived" && target.hasRedirect)))
          add("link_target_unavailable", `Linked page ${p} is not published`, l, b.id);
      }
      if (b.type === "legal_meta" && page.kind !== "legal") add("legal_meta_not_legal", "The legal meta block is allowed on legal pages only", l, b.id);
      if (b.type === "form_embed") {
        const form = refs.forms[b.formSlug];
        if (!form) add("form_unavailable", `Form "${b.formSlug}" is not published`, l, b.id);
        else if (!form.locales.includes(l)) add("form_locale_missing", `Form "${b.formSlug}" is not available in ${l}`, l, b.id);
      }
      const productIds = b.type === "pricing_table" ? b.productIds : b.type === "booking_cta" && b.target.kind === "buy_product" ? [b.target.productId] : [];
      for (const id of productIds) {
        const p = refs.products[id];
        if (!p) add("product_missing", `Product ${id} does not exist`, l, b.id);
        else if (!p.isActive) add("product_inactive", `Product ${id} is not active`, l, b.id);
      }
      if (b.type === "booking_cta" && b.target.kind === "session" && refs.sessions[b.target.sessionId]?.kind !== "event")
        add("session_missing", `Session ${b.target.sessionId} is not an existing event`, l, b.id);
      if (b.type === "webinar_signup" && !refs.webinars[b.webinarId]) add("webinar_unavailable", `Webinar ${b.webinarId} is not published`, l, b.id);
    }

    if (page.legalKey === "privacy_notice") {
      const name = refs.legalName?.trim();
      const text = raw.flatMap(blockTexts).join("\n");
      if (!name || !text.includes(name)) add("legal_name_missing", `The privacy notice must name ${name || "the controller's legal name"} in ${l}`, l);
    }
  }
  return issues;
}

/** Per-locale completeness badge for the editor tabs. */
export function issuesByLocale(issues: readonly PublishIssue[]): Partial<Record<Locale, number>> {
  const out: Partial<Record<Locale, number>> = {};
  for (const i of issues) if (i.locale) out[i.locale] = (out[i.locale] ?? 0) + 1;
  return out;
}
