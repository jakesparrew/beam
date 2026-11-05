/**
 * `renderEmail()` (email spec rules 3, 4, 23, 41; section 8 "Send-time").
 *
 * Three call shapes:
 * - `renderEmail(input: RenderInput)` (email-P2): `{ source: 'code', template, ... }` renders a
 *   registry template with its props, copy (edited copy beats the catalogue default) and the
 *   legal footer; `{ source: 'blocks', ... }` renders a block-backed version from its
 *   precompiled `html_by_locale` / `text_by_locale` (or compiles the document) for the
 *   recipient's variant. Both personalise with `values` and return the links of the HTML.
 * - Wave 0 (platform-P3), kept: `renderEmail(template, { locale, props, copy? })` and
 *   `renderEmail(element, { locale, subject })`.
 *
 * A missing locale or copy slot throws `MissingTranslationError` (a `PermanentError`), never
 * another language. Invalid props throw `PermanentError('invalid_props')`; a message without a
 * text part throws `PermanentError('missing_text_part')`.
 */
import { createElement, isValidElement, type ReactElement } from "react";
import { render } from "@react-email/render";
import type { BlockDocument } from "@beam/core/email";
import { PermanentError } from "@beam/core/errors";
import { MissingMessageError, MissingTranslationError, t, type Locale, type LocalizedText } from "@beam/core/i18n";
import { compileMarketing, DEFAULT_VARIANT, selectVariant, type VariantPath, type VariantRecipient } from "./blocks/compile";
import { personalise, type TokenValues } from "./blocks/personalise";
import type { ResolveCards, ResolveWebinars } from "./blocks/to-mjml";
import { EmailFooterContext } from "./layout";
import type { Brand } from "./layout/brand";
import type { FooterParts } from "./layout/footer";
import type { CopySlots, TemplateDef } from "./templates/define";

export type RenderedEmail = { html: string; text: string; subject: string; links: string[] };

/** Edited copy per slot: a plain string, or a `LocalizedText` from `email_template_versions.copy`. */
export type CopyOverrides = Readonly<Record<string, string | LocalizedText | undefined>>;

export type RenderTemplateOptions = {
  locale: Locale;
  /** The `data` of `sendTransactional`, validated against the template's `props` schema. */
  props?: unknown;
  /** Edited copy (a published `email_template_versions` row) overriding catalogue defaults per slot. */
  copy?: CopyOverrides;
  /** The legal footer (`buildFooter()`); without it the Wave 0 footer line is rendered. */
  footer?: FooterParts | null;
  /** Token and merge-field values; without them placeholders stay for a later pass. */
  values?: TokenValues;
};

export type RenderElementOptions = { locale: Locale; subject: string };

export type CodeRenderInput = { source: "code"; template: TemplateDef } & RenderTemplateOptions;

export type BlocksRenderInput = {
  source: "blocks";
  locale: Locale;
  subject: LocalizedText;
  preheader?: LocalizedText | null;
  /** The block document; compiled on the fly when `compiled` lacks the locale (preview, test send). */
  document?: BlockDocument | null;
  /** `html_by_locale` and `text_by_locale` of the published version. */
  compiled?: { htmlByLocale: Readonly<Record<string, Readonly<Record<string, string>>>>; textByLocale: Readonly<Record<string, Readonly<Record<string, string>>>> } | null;
  /** The variant path; otherwise chosen from `recipient` (or the fallback path). */
  variant?: VariantPath;
  recipient?: VariantRecipient;
  /** Used when compiling on the fly. */
  footer?: FooterParts | null;
  brand?: Brand;
  resolveCards?: ResolveCards;
  /** R2: webinar cards when compiling on the fly (`webinar.getWebinarCards` bound to the transaction). */
  webinars?: ResolveWebinars;
  values?: TokenValues;
};

export type RenderInput = CodeRenderInput | BlocksRenderInput;

/** Primitive props become ICU params of the copy (`{expiresMinutes}`, `{change}`, `{period}`). */
function copyParams(props: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (props && typeof props === "object") {
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") out[k] = v;
    }
  }
  return out;
}

/** `{name}` placeholders of edited copy (the editor stores plain text with simple tokens). */
function interpolate(text: string, params: Record<string, string | number>): string {
  return text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

function editedCopy(value: string | LocalizedText | undefined, locale: Locale): string | null {
  const text = typeof value === "string" ? value : value?.[locale];
  return typeof text === "string" && text.trim() ? text : null;
}

/** Resolves every slot of a template in one locale. Throws `MissingTranslationError` for a missing one. */
export function resolveCopy(template: Pick<TemplateDef, "name" | "slots">, locale: Locale, props: unknown, overrides: CopyOverrides = {}): CopySlots {
  const params = copyParams(props);
  const copy: Record<string, string> = {};
  for (const [slot, key] of Object.entries(template.slots)) {
    const edited = editedCopy(overrides?.[slot], locale);
    if (edited) {
      copy[slot] = interpolate(edited, params);
      continue;
    }
    try {
      const value = t(locale, key, params);
      if (!value.trim() || value.startsWith("⟦")) throw new MissingMessageError(locale, key);
      copy[slot] = value;
    } catch (error) {
      if (error instanceof MissingMessageError) throw new MissingTranslationError([locale], `template ${template.name} slot ${slot}`);
      throw error;
    }
  }
  return copy;
}

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? _m);
}

/** The absolute `http(s)` link targets of an HTML part, unique, in document order (click tracking indexes). */
export function extractLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\shref\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const href = decodeEntities((m[2] ?? m[3] ?? "").trim());
    if (/^https?:\/\//i.test(href) && !out.includes(href)) out.push(href);
  }
  return out;
}

function finish(parts: { subject: string; html: string; text: string }, values: TokenValues | undefined): RenderedEmail {
  const subject = values ? personalise(parts.subject, values, { escape: false }) : parts.subject;
  const html = values ? personalise(parts.html, values, { escape: true }) : parts.html;
  const text = (values ? personalise(parts.text, values, { escape: false }) : parts.text).trim();
  if (!html.trim()) throw new PermanentError("missing_html_part");
  if (!text) throw new PermanentError("missing_text_part");
  return { subject: subject.trim(), html, text, links: extractLinks(html) };
}

async function elementParts(element: ReactElement, footer: FooterParts | null | undefined): Promise<{ html: string; text: string }> {
  if (!footer) {
    const html = await render(element);
    const text = (await render(element, { plainText: true })).trim();
    return { html, text };
  }
  const html = await EmailFooterContext.run(footer, () => render(element));
  const body = (await EmailFooterContext.run("none", () => render(element, { plainText: true }))).trim();
  return { html, text: [body, footer.text].filter((p) => p.trim()).join("\n\n----------------------------------------\n\n") };
}

async function renderCode(template: TemplateDef, options: RenderTemplateOptions): Promise<RenderedEmail> {
  const { locale, props, copy: overrides } = options;
  const parsed = template.props.safeParse(props ?? {});
  if (!parsed.success) {
    throw new PermanentError(`invalid_props: ${template.name}: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`);
  }
  const copy = resolveCopy(template, locale, parsed.data, overrides);
  const componentProps: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>), copy, locale };
  const Component = (p: Record<string, unknown>): ReactElement => template.component(p as never);
  const parts = await elementParts(createElement(Component, componentProps), options.footer);
  return finish({ subject: copy.subject ?? "", ...parts }, options.values);
}

async function renderBlocks(input: BlocksRenderInput): Promise<RenderedEmail> {
  const { locale } = input;
  const subjectText = input.subject?.[locale];
  if (!subjectText?.trim()) throw new MissingTranslationError([locale], "subject");
  const preheader = input.preheader?.[locale]?.trim() || undefined;

  const pickVariant = (available: readonly string[]): string => {
    let path = input.variant;
    if (!path && input.document && input.recipient) path = selectVariant(input.document, locale, input.recipient);
    if (!path) path = available.includes(DEFAULT_VARIANT) ? DEFAULT_VARIANT : (available.find((p) => p.split(",").every((x) => x.endsWith(":f"))) ?? available[0]);
    if (!path || !available.includes(path)) throw new PermanentError(`variant_missing: ${path ?? "(none)"} in ${locale}`);
    return path;
  };

  const html = input.compiled?.htmlByLocale?.[locale];
  const text = input.compiled?.textByLocale?.[locale];
  if (html && text) {
    const path = pickVariant(Object.keys(html));
    return finish({ subject: subjectText, html: html[path] ?? "", text: text[path] ?? "" }, input.values);
  }
  if (!input.document?.locales?.[locale]?.length) throw new MissingTranslationError([locale], "document");
  if (!input.footer) throw new PermanentError("footer_missing");
  const compiled = await compileMarketing(input.document, locale, {
    footer: input.footer,
    subject: subjectText,
    ...(preheader ? { preheader } : {}),
    ...(input.brand ? { brand: input.brand } : {}),
    ...(input.resolveCards ? { resolveCards: input.resolveCards } : {}),
    ...(input.webinars ? { webinars: input.webinars } : {}),
  });
  const path = pickVariant(Object.keys(compiled.variants));
  const variant = compiled.variants[path];
  return finish({ subject: subjectText, html: variant?.html ?? "", text: variant?.text ?? "" }, input.values);
}

function isRenderInput(value: unknown): value is RenderInput {
  return !!value && typeof value === "object" && "source" in value && ((value as RenderInput).source === "code" || (value as RenderInput).source === "blocks");
}

export function renderEmail(input: RenderInput): Promise<RenderedEmail>;
export function renderEmail(component: TemplateDef, options: RenderTemplateOptions): Promise<RenderedEmail>;
export function renderEmail(component: ReactElement, options: RenderElementOptions): Promise<RenderedEmail>;
export async function renderEmail(
  component: RenderInput | TemplateDef | ReactElement,
  options?: RenderTemplateOptions | RenderElementOptions,
): Promise<RenderedEmail> {
  if (isValidElement(component)) {
    const subject = (options as RenderElementOptions | undefined)?.subject;
    if (!subject?.trim()) throw new PermanentError("missing_subject");
    const parts = await elementParts(component, null);
    return finish({ subject, ...parts }, undefined);
  }
  if (isRenderInput(component)) {
    if (component.source === "blocks") return renderBlocks(component);
    const { template, ...rest } = component;
    return renderCode(template, rest);
  }
  if (!options) throw new PermanentError("missing_render_options");
  return renderCode(component, options);
}
