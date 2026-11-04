/**
 * Personalisation of compiled HTML, plain text and subjects (email spec rule 23).
 *
 * `{{token}}` and `{{token|fallback}}`: a missing, null or empty value renders the fallback,
 * else an empty string. Values and fallbacks are HTML-escaped when `escape` is true (HTML
 * parts) and left as they are for plain text and subjects. Module merge fields
 * (`{{webinar.title}}`) whose name is absent from `values` are left untouched, so the
 * merge-field resolver (email-P3) can fill them in a later pass; a merge field present with
 * `null` renders its fallback like a token. A name of neither shape is left as written.
 */
import { escapeHtml, isEmailToken, MERGE_FIELD_PATTERN } from "@beam/core/email";

/** Token and merge-field values for one recipient; `null` or `undefined` means missing. */
export type TokenValues = Readonly<Record<string, string | number | null | undefined>>;

export type PersonaliseOptions = { escape: boolean };

const TOKEN_RE = /\{\{([^{}]*)\}\}/g;

/** Decodes the five entities `escapeHtml()` writes, so a fallback escaped by the compiler is not escaped twice. */
function unescapeHtml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? _m);
}

export function personalise(htmlOrText: string, values: TokenValues, opts: PersonaliseOptions): string {
  return htmlOrText.replace(TOKEN_RE, (raw, inner: string) => {
    const bar = inner.indexOf("|");
    const name = (bar === -1 ? inner : inner.slice(0, bar)).trim();
    const fallback = bar === -1 ? "" : unescapeHtml(inner.slice(bar + 1).trim());
    const isMergeField = MERGE_FIELD_PATTERN.test(name);
    if (!isEmailToken(name) && !isMergeField) return raw;
    if (isMergeField && !Object.prototype.hasOwnProperty.call(values, name)) return raw;
    const value = values[name];
    const text = value === null || value === undefined || value === "" ? fallback : String(value);
    return opts.escape ? escapeHtml(text) : text;
  });
}

/** The token and merge-field names used in a text (for the resolver's `names` argument). */
export function tokenNames(htmlOrText: string): { tokens: string[]; mergeFields: string[] } {
  const tokens = new Set<string>();
  const mergeFields = new Set<string>();
  for (const match of htmlOrText.matchAll(TOKEN_RE)) {
    const inner = match[1] ?? "";
    const bar = inner.indexOf("|");
    const name = (bar === -1 ? inner : inner.slice(0, bar)).trim();
    if (isEmailToken(name)) tokens.add(name);
    else if (MERGE_FIELD_PATTERN.test(name)) mergeFields.add(name);
  }
  return { tokens: [...tokens], mergeFields: [...mergeFields] };
}
