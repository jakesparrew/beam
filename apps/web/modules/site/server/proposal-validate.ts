/**
 * Validation of Claude's page proposal (site rules 43-44, edge cases 7-8; site-P4). The output must
 * parse as `ProposalOutput` and may not change the page kind, legal key or linked session, nor drop
 * a locale of the base version. Blocks it keeps or changes keep their ids; a base id may not be
 * reused for a block of another type. `legal_meta` stays on legal pages, the home page keeps the
 * empty path, and every reference must come from the base content or the reference lists Claude
 * was given (a media id only from the base). Any error counts as invalid output (one repair round).
 */
import { LOCALES, type Locale } from "@beam/core/i18n";
import { checkProposal, collectRefs, proposalLocales, proposalToVersionContent, type LegalKey, type PageKind, type VersionContent } from "@beam/core/site";

export type ProposalPage = { kind: PageKind; legalKey: LegalKey | null; sessionId: string | null };

/** The ids and slugs a proposal may reference beyond those of the base content. */
export type KnownRefs = { productIds?: Iterable<string>; sessionIds?: Iterable<string>; formSlugs?: Iterable<string>; pageIds?: Iterable<string>; webinarIds?: Iterable<string> };

export type ProposalContent = VersionContent & { changeSummary: string | null };

export type ValidateOptions = {
  /** Locales of the request, used as the required locales when there is no base version. */
  targetLocales?: readonly Locale[];
  /** Reference lists sent with the prompt; omitted means references are not checked. */
  known?: KnownRefs;
};

const FORBIDDEN_KEYS: { keys: string[]; field: keyof ProposalPage }[] = [
  { keys: ["kind", "pageKind"], field: "kind" },
  { keys: ["legalKey", "legal_key"], field: "legalKey" },
  { keys: ["sessionId", "session_id"], field: "sessionId" },
];

function pageFieldErrors(raw: unknown, page: ProposalPage): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const { keys, field } of FORBIDDEN_KEYS) {
    for (const k of keys) {
      if (!(k in obj)) continue;
      const value = obj[k] ?? null;
      if (value !== (page[field] ?? null)) errors.push(`${k}: the proposal may not change the page ${field === "kind" ? "kind" : field === "legalKey" ? "legal key" : "session"}`);
    }
  }
  return errors;
}

export function validateProposal(
  base: VersionContent | null,
  output: unknown,
  page: ProposalPage,
  opts: ValidateOptions = {},
): { ok: true; content: ProposalContent } | { ok: false; errors: string[] } {
  const errors = pageFieldErrors(output, page);
  const required = base?.locales?.length ? base.locales : [];
  const checked = checkProposal(output, { locales: required });
  if (!checked.ok) return { ok: false, errors: [...errors, ...checked.problems.map((p) => (p.code === "locale_removed" ? `locales: the proposal removes ${p.locale}` : p.message))] };
  const out = checked.output;

  const filled = proposalLocales(out);
  if (!filled.length) errors.push("blocks: the proposal fills no locale");
  if (!base) for (const l of opts.targetLocales ?? []) if (!filled.includes(l)) errors.push(`locales: the proposal does not fill ${l}`);

  // Block ids: a kept id keeps its type (rule 44).
  const baseTypes = new Map<string, string>();
  for (const l of LOCALES) for (const b of base?.blocks?.[l] ?? []) baseTypes.set(b.id, b.type);
  for (const l of LOCALES) {
    for (const b of out.blocks[l] ?? []) {
      const was = baseTypes.get(b.id);
      if (was && was !== b.type) errors.push(`blocks.${l}: id ${b.id} belongs to a ${was} block and may not be reused for ${b.type}`);
      if (b.type === "legal_meta" && page.kind !== "legal") errors.push(`blocks.${l}: legal_meta is allowed only on legal pages`);
    }
  }

  // Paths: the home page keeps '', other pages never take it (rule 9).
  for (const l of filled) {
    const path = out.paths[l];
    if (page.kind === "home" && path !== undefined && path !== "") errors.push(`paths.${l}: the home page path is ""`);
    if (page.kind !== "home" && path === "") errors.push(`paths.${l}: only the home page may use the empty path`);
  }

  // References: only from the base content or the lists Claude was given.
  if (opts.known) {
    const own = base ? collectRefs(base) : { mediaIds: [], formSlugs: [], productIds: [], sessionIds: [], pageIds: [], webinarIds: [] };
    const next = collectRefs({ blocks: out.blocks, seo: out.seo, coverMediaId: base?.coverMediaId ?? null });
    const allowed = (a: string[], b?: Iterable<string>) => new Set([...a, ...(b ?? [])]);
    const checks: [string, string[], Set<string>][] = [
      ["media", next.mediaIds, allowed(own.mediaIds)],
      ["product", next.productIds, allowed(own.productIds, opts.known.productIds)],
      ["session", next.sessionIds, allowed(own.sessionIds, opts.known.sessionIds)],
      ["form", next.formSlugs, allowed(own.formSlugs, opts.known.formSlugs)],
      ["page", next.pageIds, allowed(own.pageIds, opts.known.pageIds)],
      ["webinar", next.webinarIds, allowed(own.webinarIds, opts.known.webinarIds)],
    ];
    for (const [what, ids, ok] of checks) for (const id of ids) if (!ok.has(id)) errors.push(`references: unknown ${what} ${id}`);
  }

  if (errors.length) return { ok: false, errors };
  const content = proposalToVersionContent(out, { locales: base?.locales ?? [], coverMediaId: base?.coverMediaId ?? null, isMaterialChange: base?.isMaterialChange ?? false });
  return {
    ok: true,
    content: { ...content, excerpt: out.excerpt ?? base?.excerpt ?? null, changeSummary: out.changeSummary.trim() || null },
  };
}
