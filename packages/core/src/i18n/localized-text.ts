import { z } from "zod";
import { MissingTranslationError } from "../errors";
import { LOCALES, type Locale } from "./locales";

export { MissingTranslationError };

/** A content field in up to three locales. Drafts may be partial; publishing calls `assertComplete`. */
export type LocalizedText = Partial<Record<Locale, string>>;

export const LocalizedTextSchema = z
  .object({ "nl-BE": z.string().optional(), "fr-BE": z.string().optional(), en: z.string().optional() })
  .strict();

/** A value that is empty after trimming counts as missing (PL-64). */
function present(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** The locales of `locales` (default: all three) that `text` lacks, in `LOCALES` order. */
export function missingLocales(text: LocalizedText | null | undefined, locales: readonly Locale[] = LOCALES): Locale[] {
  return LOCALES.filter((l) => locales.includes(l) && !present(text?.[l]));
}

export function isComplete(text: LocalizedText | null | undefined, locales: readonly Locale[] = LOCALES): boolean {
  return missingLocales(text, locales).length === 0;
}

/** Throws `MissingTranslationError { missing }` unless every locale in `locales` has a non-blank value. */
export function assertComplete(
  text: LocalizedText | null | undefined,
  locales: readonly Locale[] = LOCALES,
  what = "text",
): asserts text is LocalizedText {
  const missing = missingLocales(text, locales);
  if (missing.length) throw new MissingTranslationError(missing, what);
}

/** The value for one locale, or throws `MissingTranslationError`. Never falls back to another locale. */
export function pick(text: LocalizedText | null | undefined, locale: Locale, what = "text"): string {
  const value = text?.[locale];
  if (!present(value)) throw new MissingTranslationError([locale], what);
  return value as string;
}

/** A Zod schema for a `LocalizedText` that must be complete in `locales` (publish-time validation). */
export function completeLocalizedText(locales: readonly Locale[] = LOCALES) {
  return LocalizedTextSchema.superRefine((value, ctx) => {
    for (const l of missingLocales(value, locales)) {
      ctx.addIssue({ code: "custom", path: [l], message: `missing ${l}` });
    }
  });
}
