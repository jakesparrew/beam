/**
 * `defineTemplate()`: the transactional template contract (email rule 15a, cross-module D1/D6).
 *
 * Each module declares its code-backed templates in `packages/email/src/templates/<m>/index.ts`
 * as `export const templates = [defineTemplate({ name, component, props, slots, attachments?,
 * loadProps? })]`; `pnpm gen:indexes` collects them into `TEMPLATE_REGISTRY`, keyed `<m>.<name>`,
 * where `<name>` is the file basename with `-` replaced by `_`. Written by platform-P3 with
 * email's final signature; email-P2 extended it with `sample` (the props the registry test and
 * the admin preview render; optional so Wave 0 templates keep compiling) and with
 * `registryProblems()`, the same key checks `pnpm gen:indexes` applies.
 */
import type { ReactElement } from "react";
import type { z } from "zod";
import type { Locale } from "@beam/core/i18n";

/** A catalogue key of the owning module, `<m>.email.<name>.<slot>`. */
export type MessageKey = string;

/** The resolved copy slots a component receives (`subject`, `preheader`, `heading`, `body`, `cta`, ...). */
export type CopySlots = Readonly<Record<string, string>>;

export type TemplateComponentProps<P extends z.ZodTypeAny> = z.infer<P> & { copy: CopySlots; locale: Locale };

export type TemplateAttachment = { filename: string; content: Uint8Array; contentType: string };

export type LoadPropsArgs = { personId: string; locale: Locale; context: Record<string, string>; stepKey: string | null };

/**
 * A template definition. Handlers use method syntax, so an implementation may annotate a
 * narrower `tx` type (the email package cannot import the database).
 */
export interface TemplateDef<P extends z.ZodTypeAny = z.ZodTypeAny> {
  /** snake_case, `^[a-z][a-z0-9_]{1,60}$`; the registry key is `<folder>.<name>`. */
  name: string;
  component(props: TemplateComponentProps<P>): ReactElement;
  /** Zod schema of the `data` passed to `sendTransactional`. */
  props: P;
  /** Sample props for previews and `define.test.ts`; must pass `props`. */
  sample?: z.infer<P>;
  /** Editable copy slots and their default catalogue keys; `subject` is required. */
  slots: Readonly<Record<string, MessageKey>>;
  /** Attachments built at send time (for example a webinar `.ics`). */
  attachments?(props: z.infer<P>, locale: Locale): Promise<TemplateAttachment[]>;
  /** Builds the props from ids for automation steps, which have no `data` (email rule 39a). */
  loadProps?(tx: unknown, args: LoadPropsArgs): Promise<z.infer<P>>;
}

export const TEMPLATE_NAME_PATTERN = /^[a-z][a-z0-9_]{1,60}$/;

/** The identity function that types a template and checks its name and slots. */
export function defineTemplate<P extends z.ZodTypeAny>(def: TemplateDef<P>): TemplateDef<P> {
  if (!TEMPLATE_NAME_PATTERN.test(def.name)) {
    throw new Error(`template name "${def.name}" must match ${String(TEMPLATE_NAME_PATTERN)}`);
  }
  if (!def.slots.subject) throw new Error(`template "${def.name}" needs a subject slot`);
  if (def.sample !== undefined && !def.props.safeParse(def.sample).success) {
    throw new Error(`template "${def.name}": \`sample\` does not pass its props schema`);
  }
  return def;
}

/** `magic_link` -> `magic-link`: the file basename a template name must have. */
export function templateFileBasename(name: string): string {
  return name.replace(/_/g, "-");
}

/** One registry entry as the generator sees it: its folder, the component file basename and the declared name. */
export type RegistryEntryRef = { folder: string; file: string; name: string };

/**
 * The problems `pnpm gen:indexes` reports for template registrations (email rule 15a): a slash
 * in the name, a name outside `TEMPLATE_NAME_PATTERN` (kebab-case included), a name whose kebab
 * form is not the file basename (one file is one key) and a duplicate `<folder>.<name>` key.
 */
export function registryProblems(entries: readonly RegistryEntryRef[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, RegistryEntryRef>();
  for (const e of entries) {
    const key = `${e.folder}.${e.name}`;
    if (e.name.includes("/")) {
      problems.push(`${key}: the name must not contain a slash; the key is <folder>.<name>`);
      continue;
    }
    if (!TEMPLATE_NAME_PATTERN.test(e.name)) {
      problems.push(`${key}: the name must be snake_case (${String(TEMPLATE_NAME_PATTERN)})`);
      continue;
    }
    const basename = e.file.replace(/^.*\//, "").replace(/\.(tsx|ts|jsx|js)$/, "");
    if (templateFileBasename(e.name) !== basename) {
      problems.push(`${key}: the name does not match its file "${basename}" (expected ${templateFileBasename(e.name)}.tsx)`);
      continue;
    }
    const other = seen.get(key);
    if (other) problems.push(`${key}: duplicate key (files ${other.file} and ${e.file})`);
    else seen.set(key, e);
  }
  return problems;
}
