/**
 * Client-safe label helpers of finance's back-office components: `{param}` filling and the
 * text of an action error (a `finance.errors.*` message when known, else the generic one).
 */
export type FinanceLabels = Record<string, string>;

/** `{name}` placeholders filled from `params` (client-safe; the catalogue's ICU subset used here). */
export function fillLabel(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** The message of an action error: a `finance.errors.*` text when the key is known, else the generic one. */
export function actionErrorText(labels: FinanceLabels, error: { code: string; message: string; fields?: Record<string, string> }): string {
  const fromKey = (key: string | undefined) => (key?.startsWith("finance.errors.") ? labels[`errors.${key.slice("finance.errors.".length)}`] : undefined);
  if (error.code === "forbidden") return labels["common.forbidden"] ?? error.message;
  const own = fromKey(error.message);
  if (own) return own;
  for (const v of Object.values(error.fields ?? {})) {
    const t = fromKey(v);
    if (t) return t;
  }
  return labels["common.error"] ?? error.message;
}
