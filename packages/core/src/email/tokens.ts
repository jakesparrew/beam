/**
 * Personalisation tokens (email spec rules 13, 23 and 24). Pure.
 *
 * Syntax `{{token}}` or `{{token|fallback}}`; module merge fields use a dotted name
 * `{{<module>.<field>}}` declared in `apps/web/modules/<m>/merge-fields.ts`. A missing value
 * without fallback renders an empty string; values are HTML-escaped. `EMAIL_TOKENS` holds no
 * `SENSITIVE_COLUMNS` member and no special-category key (unit test).
 */

export const EMAIL_TOKENS = [
  "first_name",
  "last_name",
  "full_name",
  "status",
  "credits_remaining",
  "next_booking_at",
  "membership_period_end_on",
  "portal_url",
  "preferences_url",
  "unsubscribe_url",
] as const;

export type TokenKey = (typeof EMAIL_TOKENS)[number];

export function isEmailToken(name: string): name is TokenKey {
  return (EMAIL_TOKENS as readonly string[]).includes(name);
}

/** `name` of a module merge field: `<module>.<field>`, both snake_case. */
export const MERGE_FIELD_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const TOKEN_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const TOKEN_RE = /\{\{([^{}]*)\}\}/g;

export type TokenUse = {
  /** The whole match, `{{first_name|friend}}`. */
  raw: string;
  /** Trimmed name, `first_name` or `webinar.title`. */
  name: string;
  /** Plain-text fallback in the text's locale, or `null` without `|`. */
  fallback: string | null;
  /** `token` = an `EMAIL_TOKENS` member; `merge_field` = dotted name; `invalid` = neither shape. */
  kind: "token" | "merge_field" | "invalid";
  start: number;
  end: number;
};

/** Every `{{...}}` in `text`, in order. */
export function parseTokens(text: string): TokenUse[] {
  const uses: TokenUse[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const inner = match[1] ?? "";
    const bar = inner.indexOf("|");
    const name = (bar === -1 ? inner : inner.slice(0, bar)).trim();
    const fallback = bar === -1 ? null : inner.slice(bar + 1).trim();
    const kind: TokenUse["kind"] = isEmailToken(name) ? "token" : MERGE_FIELD_PATTERN.test(name) ? "merge_field" : "invalid";
    const start = match.index ?? 0;
    uses.push({ raw: match[0], name, fallback, kind, start, end: start + match[0].length });
  }
  return uses;
}

/**
 * Names in `text` that are neither an `EMAIL_TOKENS` member nor a registered merge field
 * (rule 13: an unknown token blocks publishing). Unique, in order of first use.
 */
export function unknownTokens(text: string, mergeFields: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const use of parseTokens(text)) {
    const known = use.kind === "token" || (use.kind === "merge_field" && mergeFields.includes(use.name));
    if (!known && !out.includes(use.name)) out.push(use.name);
  }
  return out;
}

/** True when `name` has a valid token or merge-field shape (not necessarily registered). */
export function isTokenName(name: string): boolean {
  return TOKEN_NAME_PATTERN.test(name) || MERGE_FIELD_PATTERN.test(name);
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Replaces every token of `text`. `resolve` returns the value or null/undefined when missing;
 * a missing value renders the fallback, else an empty string. Values and fallbacks are
 * HTML-escaped unless `escape` is false (plain-text parts and subjects).
 */
export function renderTokens(
  text: string,
  resolve: (name: string) => string | null | undefined,
  options: { escape?: boolean } = {},
): string {
  const escape = options.escape ?? true;
  return text.replace(TOKEN_RE, (_m, inner: string) => {
    const bar = inner.indexOf("|");
    const name = (bar === -1 ? inner : inner.slice(0, bar)).trim();
    const fallback = bar === -1 ? "" : inner.slice(bar + 1).trim();
    const value = resolve(name);
    const out = value === null || value === undefined || value === "" ? fallback : value;
    return escape ? escapeHtml(out) : out;
  });
}
