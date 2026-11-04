/**
 * Labels of finance's back-office screens (finance spec section 8): the `finance.admin.*` tree
 * flattened to `group.key` (for example `overview.title`) plus `errors.<key>` from
 * `finance.errors.*`, in the staff user's locale. Server code builds them; client components get
 * the plain strings and fill `{param}` placeholders with `fillLabel` (`./text`).
 */
import { messagesFor, type Locale } from "@beam/core/i18n";

import type { FinanceLabels } from "./text";

export type { FinanceLabels };

function flatten(node: unknown, prefix: string, out: FinanceLabels): void {
  if (typeof node === "string") {
    out[prefix] = node;
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
}

/** `finance.admin.<groups>` (all groups when omitted) and every `finance.errors.*` key. */
export function financeLabels(locale: Locale, groups?: readonly string[]): FinanceLabels {
  const tree = ((messagesFor(locale, ["finance"]).finance ?? {}) as Record<string, unknown>) ?? {};
  const admin = (tree.admin ?? {}) as Record<string, unknown>;
  const out: FinanceLabels = {};
  for (const [group, node] of Object.entries(admin)) if (!groups || groups.includes(group)) flatten(node, group, out);
  flatten(tree.errors ?? {}, "errors", out);
  return out;
}
