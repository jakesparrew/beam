/**
 * Block document compiler (email spec rules 12, 18, 21): one HTML and text part per locale and
 * per dynamic variant path, tokens left as placeholders for `personalise()`.
 *
 * A variant path names, for every top-level `dynamic` block in document order, the chosen
 * variant index or `f` (fallback): `"<blockId>:0,<blockId>:f"`; a locale without dynamic
 * blocks has the single path `"default"`. `selectVariant()` picks the path of one recipient:
 * the first variant whose `when` matches (`status` from `v_person_status`, or the latest
 * assessment outcome of a form), else the fallback (rule 18).
 *
 * MJML runs with `validationLevel: 'strict'`; a validation error throws `CompileError` (a
 * `PermanentError`) carrying the MJML messages, which blocks publishing (rule 12). HTML above
 * 102 KB adds an `html_too_large` warning (Gmail clipping, rule 21) and still compiles.
 */
import mjml2html from "mjml";
import { validateDocument, type Block, type BlockDocument, type DynamicBlock } from "@beam/core/email";
import { PermanentError } from "@beam/core/errors";
import { MissingTranslationError, type Locale } from "@beam/core/i18n";
import type { FooterParts } from "../layout/footer";
import { BRAND, type Brand } from "../layout/brand";
import { marketingShell } from "../layout/marketing-shell";
import { checkAccessibility, checkHtmlAccessibility, type Warning } from "./a11y";
import { blocksToMjml, cardRefs, EMPTY_CARDS, type ResolveCards, type ResolvedCards, type VariantChoice } from "./to-mjml";
import { blocksToText } from "./to-text";

export type VariantPath = string;
export const DEFAULT_VARIANT: VariantPath = "default";

/** Gmail clips messages above 102 KB (rule 21). */
export const MAX_HTML_BYTES = 102 * 1024;

export type PersonStatus = "lead" | "customer" | "member";
/** The recipient facts dynamic blocks read: status, and the latest outcome key per form slug. */
export type VariantRecipient = { status: PersonStatus | null; outcomes: Readonly<Record<string, string | null | undefined>> };

export type CompileContext = {
  /** The footer built for the purpose (links usually left as `{{preferences_url}}` tokens). */
  footer: FooterParts;
  brand?: Brand;
  /** Product and event cards, resolved once per compile (rule 19). */
  resolveCards?: ResolveCards;
  subject?: string;
  preheader?: string;
};

export type CompiledVariant = { html: string; text: string };
export type CompileResult = { variants: Record<VariantPath, CompiledVariant>; warnings: Warning[] };

export type MjmlIssue = { line: number; tagName: string; message: string };

/** MJML refused the document (rule 12); `issues` are shown in the editor. */
export class CompileError extends PermanentError {
  override readonly name: string = "CompileError";
  readonly issues: MjmlIssue[];
  constructor(issues: MjmlIssue[]) {
    super(`mjml_invalid: ${issues.map((i) => i.message).join("; ")}`);
    this.issues = issues;
  }
}

function dynamicBlocks(blocks: readonly Block[]): DynamicBlock[] {
  return blocks.filter((b): b is DynamicBlock => b.type === "dynamic");
}

export function encodeVariant(choice: VariantChoice, blocks: readonly Block[]): VariantPath {
  const dyn = dynamicBlocks(blocks);
  if (!dyn.length) return DEFAULT_VARIANT;
  return dyn.map((d) => `${d.id}:${choice[d.id] === undefined || choice[d.id] === "fallback" ? "f" : String(choice[d.id])}`).join(",");
}

export function decodeVariant(path: VariantPath): VariantChoice {
  if (path === DEFAULT_VARIANT || !path) return {};
  const out: Record<string, number | "fallback"> = {};
  for (const part of path.split(",")) {
    const at = part.lastIndexOf(":");
    const id = part.slice(0, at);
    const v = part.slice(at + 1);
    out[id] = v === "f" ? "fallback" : Number(v);
  }
  return out;
}

/** Every variant path of one locale's blocks (the product of each dynamic block's branches). */
export function variantChoices(blocks: readonly Block[]): VariantChoice[] {
  let combos: Record<string, number | "fallback">[] = [{}];
  for (const d of dynamicBlocks(blocks)) {
    const options: (number | "fallback")[] = [...d.variants.map((_v, i) => i), "fallback"];
    combos = combos.flatMap((c) => options.map((o) => ({ ...c, [d.id]: o })));
  }
  return combos;
}

function matches(when: DynamicBlock["variants"][number]["when"], recipient: VariantRecipient): boolean {
  if ("status" in when) return recipient.status === when.status;
  const outcome = recipient.outcomes[when.assessmentOutcome.formSlug];
  return typeof outcome === "string" && when.assessmentOutcome.outcomeKeys.includes(outcome);
}

/** The variant path one recipient receives in `locale` (rule 18). */
export function selectVariant(doc: BlockDocument, locale: Locale, recipient: VariantRecipient): VariantPath {
  const blocks = doc.locales[locale] ?? [];
  const choice: Record<string, number | "fallback"> = {};
  for (const d of dynamicBlocks(blocks)) {
    const index = d.variants.findIndex((v) => matches(v.when, recipient));
    choice[d.id] = index === -1 ? "fallback" : index;
  }
  return encodeVariant(choice, blocks);
}

/** Runs MJML strictly; validation errors become a `CompileError`. */
export async function mjmlToHtml(source: string): Promise<string> {
  try {
    const result = await mjml2html(source, { validationLevel: "strict", keepComments: false });
    if (result.errors.length) throw new CompileError(result.errors.map((e) => ({ line: e.line, tagName: e.tagName, message: e.formattedMessage ?? e.message })));
    return result.html;
  } catch (error) {
    if (error instanceof CompileError) throw error;
    const errs = (error as { errors?: { line: number; tagName: string; message: string; formattedMessage?: string }[] }).errors;
    if (Array.isArray(errs) && errs.length) {
      throw new CompileError(errs.map((e) => ({ line: e.line, tagName: e.tagName, message: e.formattedMessage ?? e.message })));
    }
    throw new CompileError([{ line: 0, tagName: "mjml", message: error instanceof Error ? error.message : String(error) }]);
  }
}

/**
 * Compiles one locale of a block document into every variant (rule 12). Throws
 * `MissingTranslationError` when the locale has no blocks, `PermanentError('invalid_document')`
 * for a document that fails `validateDocument`, and `CompileError` for MJML errors.
 */
export async function compileMarketing(doc: BlockDocument, locale: Locale, ctx: CompileContext): Promise<CompileResult> {
  const valid = validateDocument(doc);
  if (!valid.ok) throw new PermanentError(`invalid_document: ${valid.issues.map((i) => i.message).join("; ")}`);
  const blocks = doc.locales[locale];
  if (!blocks || !blocks.length) throw new MissingTranslationError([locale], "document");
  const brand = ctx.brand ?? BRAND;
  const cards: ResolvedCards = ctx.resolveCards ? await ctx.resolveCards(cardRefs([blocks])) : EMPTY_CARDS;

  const warnings: Warning[] = [...checkAccessibility(doc, locale, brand)];
  const cardWarnings = new Map<string, Warning>();
  const variants: Record<VariantPath, CompiledVariant> = {};
  for (const choice of variantChoices(blocks)) {
    const path = encodeVariant(choice, blocks);
    const local: Warning[] = [];
    const body = blocksToMjml(blocks, { locale, brand, cards, choice, warnings: local });
    for (const w of local) cardWarnings.set(`${w.code}:${w.blockId ?? ""}`, w);
    const source = marketingShell({ locale, brand, body, footerHtml: ctx.footer.html, ...(ctx.subject ? { title: ctx.subject } : {}), ...(ctx.preheader ? { preheader: ctx.preheader } : {}) });
    const html = await mjmlToHtml(source);
    const bodyText = blocksToText(blocks, { locale, cards, choice });
    const text = [bodyText, ctx.footer.text].filter((p) => p.trim()).join("\n\n----------------------------------------\n\n");
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_HTML_BYTES) warnings.push({ code: "html_too_large", locale, variant: path, detail: `${Math.round(bytes / 1024)} KB` });
    for (const w of checkHtmlAccessibility(html, locale)) {
      if (!warnings.some((x) => x.code === w.code)) warnings.push(w);
    }
    variants[path] = { html, text };
  }
  warnings.push(...cardWarnings.values());
  return { variants, warnings };
}

/** Compiles every locale present in the document (publish, rule 12): `html_by_locale` and `text_by_locale`. */
export async function compileDocument(
  doc: BlockDocument,
  locales: readonly Locale[],
  ctx: Omit<CompileContext, "footer" | "subject" | "preheader"> & {
    footerFor: (locale: Locale) => FooterParts;
    subject?: Partial<Record<Locale, string>>;
    preheader?: Partial<Record<Locale, string>>;
  },
): Promise<{ htmlByLocale: Record<string, Record<VariantPath, string>>; textByLocale: Record<string, Record<VariantPath, string>>; warnings: Warning[] }> {
  const htmlByLocale: Record<string, Record<VariantPath, string>> = {};
  const textByLocale: Record<string, Record<VariantPath, string>> = {};
  const warnings: Warning[] = [];
  for (const locale of locales) {
    const subject = ctx.subject?.[locale];
    const preheader = ctx.preheader?.[locale];
    const result = await compileMarketing(doc, locale, {
      footer: ctx.footerFor(locale),
      ...(ctx.brand ? { brand: ctx.brand } : {}),
      ...(ctx.resolveCards ? { resolveCards: ctx.resolveCards } : {}),
      ...(subject ? { subject } : {}),
      ...(preheader ? { preheader } : {}),
    });
    htmlByLocale[locale] = Object.fromEntries(Object.entries(result.variants).map(([k, v]) => [k, v.html]));
    textByLocale[locale] = Object.fromEntries(Object.entries(result.variants).map(([k, v]) => [k, v.text]));
    warnings.push(...result.warnings);
  }
  return { htmlByLocale, textByLocale, warnings };
}
