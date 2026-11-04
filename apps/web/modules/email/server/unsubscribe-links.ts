/**
 * crm's links of one email message (email spec rules 2, 53, 55; decisions 22, 23, 55). Pure over
 * crm's pure `buildPreferenceUrls(linkToken, locale)`: the message's own link token (rule 53)
 * goes into crm's one-click POST URL, its preference-centre URL and its confirm-unsubscribe URL.
 *
 * - Marketing messages (campaigns, marketing automation steps, D54 registry sends) carry
 *   `List-Unsubscribe: <oneClickPostUrl>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 *   (RFC 8058, https only, no mailto), and the footer links "Manage preferences" and
 *   "Unsubscribe from <category>".
 * - Transactional messages carry neither header and only the "Manage email preferences" link;
 *   crm opens the centre without a pre-selected purpose because `resolveLinkToken` returns
 *   `purpose = null` for them.
 *
 * This module has no unsubscribe logic of its own (rule 54): crm's routes decide what a token
 * does. The values here feed `buildOutgoingEmail()` (headers), `buildFooter()` (footer links)
 * and `personalise()` (the `{{preferences_url}}` and `{{unsubscribe_url}}` tokens).
 */
import type { Locale } from "@beam/core/i18n";
import { LIST_UNSUBSCRIBE_POST } from "@beam/email";
import { buildPreferenceUrls } from "@/modules/crm/api";

export type UnsubscribeLinkKind = "marketing" | "transactional";

export type UnsubscribeLinksInput = { linkToken: string; kind: UnsubscribeLinkKind; locale: Locale };

export type UnsubscribeLinks = {
  /** crm's one-click POST URL, the target of `List-Unsubscribe` (marketing only). */
  listUnsubscribe: string | null;
  /** crm's confirm-unsubscribe page, the footer's "Unsubscribe from <category>" (marketing only). */
  unsubscribeUrl: string | null;
  /** crm's token preference centre, in the footer of every message. */
  preferencesUrl: string;
};

/** The crm links of a message, built from that message's link token. */
export function unsubscribeLinksFor(input: UnsubscribeLinksInput): UnsubscribeLinks {
  const urls = buildPreferenceUrls(input.linkToken, input.locale);
  if (input.kind === "marketing") {
    return { listUnsubscribe: urls.oneClickPostUrl, unsubscribeUrl: urls.unsubscribeUrl, preferencesUrl: urls.preferencesUrl };
  }
  return { listUnsubscribe: null, unsubscribeUrl: null, preferencesUrl: urls.preferencesUrl };
}

/** The RFC 8058 header pair of a marketing message; empty for transactional links. */
export function unsubscribeHeaders(links: UnsubscribeLinks): Record<string, string> {
  if (!links.listUnsubscribe) return {};
  return { "List-Unsubscribe": `<${links.listUnsubscribe}>`, "List-Unsubscribe-Post": LIST_UNSUBSCRIBE_POST };
}

/** `buildOutgoingEmail()`'s `listUnsubscribe` option (null for transactional links). */
export function listUnsubscribeOption(links: UnsubscribeLinks): { oneClickPostUrl: string } | null {
  return links.listUnsubscribe ? { oneClickPostUrl: links.listUnsubscribe } : null;
}

/** `buildFooter()`'s `preferenceUrls`: the transactional footer only uses `preferencesUrl`. */
export function footerPreferenceUrls(links: UnsubscribeLinks): { preferencesUrl: string; unsubscribeUrl: string | null } {
  return { preferencesUrl: links.preferencesUrl, unsubscribeUrl: links.unsubscribeUrl };
}

/** The values of the tokens `{{preferences_url}}` and `{{unsubscribe_url}}` (null uses the token's fallback). */
export function linkTokenValues(links: UnsubscribeLinks): { preferences_url: string; unsubscribe_url: string | null } {
  return { preferences_url: links.preferencesUrl, unsubscribe_url: links.unsubscribeUrl };
}
