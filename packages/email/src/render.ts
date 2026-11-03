/**
 * `renderEmail()`, Wave 0 shape: `renderEmail(component, { locale })` returning
 * `{ html, text, subject }` (platform-P3). `component` is a registry entry (`TemplateDef`)
 * rendered with `props`, or an already built React element with an explicit `subject`.
 * Copy slots are resolved from the owning module's catalogue in `locale`; a missing slot throws
 * `MissingTranslationError` (a `PermanentError`), never another language (architecture section 5).
 * Invalid props throw `PermanentError('invalid_props')`. email-P2 widens the input and keeps
 * this overload.
 */
import { createElement, isValidElement, type ReactElement } from "react";
import { render } from "@react-email/render";
import { PermanentError } from "@beam/core/errors";
import { MissingMessageError, MissingTranslationError, t, type Locale } from "@beam/core/i18n";
import type { CopySlots, TemplateDef } from "./templates/define";

export type RenderedEmail = { html: string; text: string; subject: string };

export type RenderTemplateOptions = {
  locale: Locale;
  /** The `data` of `sendTransactional`, validated against the template's `props` schema. */
  props?: unknown;
  /** Edited copy (a published `email_template_versions` row) overriding catalogue defaults per slot. */
  copy?: Readonly<Record<string, string | undefined>>;
};

export type RenderElementOptions = { locale: Locale; subject: string };

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

/** Resolves every slot of a template in one locale. Throws `MissingTranslationError` for a missing one. */
export function resolveCopy(
  template: Pick<TemplateDef, "name" | "slots">,
  locale: Locale,
  props: unknown,
  overrides: RenderTemplateOptions["copy"] = {},
): CopySlots {
  const params = copyParams(props);
  const copy: Record<string, string> = {};
  for (const [slot, key] of Object.entries(template.slots)) {
    const edited = overrides?.[slot];
    if (typeof edited === "string" && edited.trim()) {
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

async function toParts(element: ReactElement, subject: string): Promise<RenderedEmail> {
  const html = await render(element);
  const text = (await render(element, { plainText: true })).trim();
  return { html, text, subject };
}

export function renderEmail(component: TemplateDef, options: RenderTemplateOptions): Promise<RenderedEmail>;
export function renderEmail(component: ReactElement, options: RenderElementOptions): Promise<RenderedEmail>;
export async function renderEmail(
  component: TemplateDef | ReactElement,
  options: RenderTemplateOptions | RenderElementOptions,
): Promise<RenderedEmail> {
  if (isValidElement(component)) {
    const subject = (options as RenderElementOptions).subject;
    if (!subject?.trim()) throw new PermanentError("missing_subject");
    return toParts(component, subject);
  }
  const template = component;
  const { locale, props, copy: overrides } = options as RenderTemplateOptions;
  const parsed = template.props.safeParse(props ?? {});
  if (!parsed.success) {
    throw new PermanentError(`invalid_props: ${template.name}: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`);
  }
  const copy = resolveCopy(template, locale, parsed.data, overrides);
  const componentProps: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>), copy, locale };
  const Component = (p: Record<string, unknown>): ReactElement => template.component(p as never);
  const element = createElement(Component, componentProps);
  return toParts(element, copy.subject ?? "");
}
