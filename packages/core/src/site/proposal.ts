/**
 * Claude's page proposal (rules 42-44): the output of `site.propose_page` must parse as
 * `ProposalOutput`; one repair round is allowed. `checkProposal` applies rule 44: a proposal may
 * not drop a locale of the base version (kind, legal key and session are not part of the output,
 * so it cannot change them).
 */
import { z } from "zod";
import { LOCALES, LocalizedTextSchema, type Locale } from "../i18n";
import { BlocksByLocale } from "./blocks";
import type { VersionContent } from "./completeness";

export const SeoSchema = z
  .object({
    title: z.string().max(200),
    description: z.string().max(400),
    ogImageMediaId: z.string().uuid().optional(),
    noindex: z.boolean().optional(),
  })
  .strict();

export const PathsSchema = z.object({ "nl-BE": z.string().max(200).optional(), "fr-BE": z.string().max(200).optional(), en: z.string().max(200).optional() }).strict();
export const SeoByLocale = z.object({ "nl-BE": SeoSchema.optional(), "fr-BE": SeoSchema.optional(), en: SeoSchema.optional() }).strict();

export const ProposalOutput = z.object({
  title: LocalizedTextSchema,
  paths: PathsSchema,
  blocks: BlocksByLocale,
  seo: SeoByLocale,
  excerpt: LocalizedTextSchema.optional(),
  changeSummary: z.string().max(500),
});
export type ProposalOutput = z.infer<typeof ProposalOutput>;

export type ProposalProblem = { code: "invalid_output" | "locale_removed"; message: string; locale?: Locale };

/** The locales a proposal fills (title or blocks present). */
export function proposalLocales(output: Pick<ProposalOutput, "title" | "blocks">): Locale[] {
  return LOCALES.filter((l) => (output.title[l] ?? "").trim().length > 0 || (output.blocks[l]?.length ?? 0) > 0);
}

/** Parses raw model output and applies rule 44 against the base version's locales. */
export function checkProposal(raw: unknown, base: { locales: readonly Locale[] }): { ok: true; output: ProposalOutput } | { ok: false; problems: ProposalProblem[] } {
  const parsed = ProposalOutput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 20).map((i) => ({ code: "invalid_output", message: `${i.path.map(String).join(".")}: ${i.message}` })) };
  }
  const filled = proposalLocales(parsed.data);
  const problems: ProposalProblem[] = base.locales
    .filter((l) => !filled.includes(l))
    .map((l) => ({ code: "locale_removed" as const, locale: l, message: `The proposal removes ${l}` }));
  return problems.length ? { ok: false, problems } : { ok: true, output: parsed.data };
}

/** The version content a proposal becomes (its locales are the base locales plus filled ones). */
export function proposalToVersionContent(output: ProposalOutput, base: { locales: readonly Locale[]; coverMediaId?: string | null; isMaterialChange?: boolean }): VersionContent {
  const filled = proposalLocales(output);
  const locales = LOCALES.filter((l) => base.locales.includes(l) || filled.includes(l));
  return {
    title: output.title,
    paths: output.paths,
    blocks: output.blocks,
    seo: output.seo,
    excerpt: output.excerpt ?? null,
    coverMediaId: base.coverMediaId ?? null,
    locales,
    isMaterialChange: base.isMaterialChange ?? false,
  };
}
