/**
 * The sending context of one message (email spec rules 1, 2, 4, 53): settings, the legal footer
 * and crm's link URLs.
 *
 * - `loadSendSettings(tx)`: `email_config`, `email_footer` and `company`.
 * - `legalLinksFor(locale)`: `site.getLegalLinks(locale)`; while site's implementation has not
 *   landed (its stub throws `NotImplementedError`) the footer carries no legal links rather than
 *   failing every email.
 * - `footerFor(...)`: `buildFooter()` for the message's purpose (or `transactional`), with the
 *   consent date of the purpose for marketing. A transactional footer that cannot be built
 *   because `settings.company` is incomplete (go-live data not entered yet) is left out with a
 *   reported warning, so a magic link never fails on missing company data; a marketing message
 *   fails permanently (`footer_incomplete`, rule 5 keeps such content from being published).
 */
import type { DbOrTx } from "@beam/db";
import { persons, vConsentCurrent, vMarketingReachability } from "@beam/db/schema";
import { NotImplementedError, PermanentError } from "@beam/core/errors";
import type { BlockedReason, MarketingPurpose } from "@beam/core/email";
import type { Locale } from "@beam/core/i18n";
import { buildFooter, type FooterCompany, type FooterParts, type LegalLinks } from "@beam/email";
import { and, eq, sql } from "@/lib/ctx";
import { reportMessage } from "@/lib/logger";
import { getSetting } from "@/lib/settings";
import { getLegalLinks } from "@/modules/site/api";
import type { EmailConfig, EmailFooterSetting } from "../config";

export type SendSettings = { config: EmailConfig; footer: EmailFooterSetting; company: FooterCompany };

export async function loadSendSettings(tx: DbOrTx): Promise<SendSettings> {
  const [config, footer, company] = await Promise.all([getSetting(tx, "email_config"), getSetting(tx, "email_footer"), getSetting(tx, "company")]);
  return { config: config, footer: footer, company: company as unknown as FooterCompany };
}

export async function legalLinksFor(locale: Locale): Promise<LegalLinks> {
  try {
    return await getLegalLinks(locale);
  } catch (error) {
    if (error instanceof NotImplementedError) return { privacy: null, terms: null };
    throw error;
  }
}

/** The `recorded_at` of the person's current consent record for `purpose` (the footer's `{date}`). */
export async function consentDateOf(tx: DbOrTx, personId: string | null, purpose: MarketingPurpose): Promise<Date | null> {
  if (!personId) return null;
  const [row] = await tx
    .select({ recordedAt: vConsentCurrent.recordedAt, status: vConsentCurrent.status })
    .from(vConsentCurrent)
    .where(and(eq(vConsentCurrent.personId, personId), sql`${vConsentCurrent.purpose}::text = ${purpose}`));
  return row?.status === "granted" ? row.recordedAt : null;
}

export async function footerFor(
  tx: DbOrTx,
  input: {
    settings: SendSettings;
    locale: Locale;
    purpose: MarketingPurpose | "transactional";
    personId: string | null;
    preferenceUrls: { preferencesUrl: string; unsubscribeUrl: string } | null;
  },
): Promise<FooterParts | null> {
  const legalLinks = await legalLinksFor(input.locale);
  const consentDate = input.purpose === "transactional" ? null : await consentDateOf(tx, input.personId, input.purpose);
  try {
    return buildFooter({
      company: input.settings.company,
      footerSettings: input.settings.footer,
      legalLinks,
      purpose: input.purpose,
      consentDate,
      preferenceUrls: input.preferenceUrls,
      locale: input.locale,
    });
  } catch (error) {
    const incomplete = error instanceof PermanentError && error.message.startsWith("footer_incomplete");
    if (incomplete && input.purpose === "transactional") {
      reportMessage(`email footer left out: ${error.message}`, { tags: { module: "email" } });
      return null;
    }
    throw error;
  }
}

export type Reachability = { isReachable: boolean; blockedReason: BlockedReason | null };

/**
 * `v_marketing_reachability` for one person and purpose. A person without a row (merged into
 * another, or unknown) is unreachable; the reason then mirrors the person row.
 */
export async function getReachability(tx: DbOrTx, personId: string, purpose: MarketingPurpose): Promise<Reachability> {
  const [row] = await tx
    .select({ isReachable: vMarketingReachability.isReachable, blockedReason: vMarketingReachability.blockedReason })
    .from(vMarketingReachability)
    .where(and(eq(vMarketingReachability.personId, personId), eq(vMarketingReachability.purpose, purpose)));
  if (row) return { isReachable: row.isReachable, blockedReason: row.blockedReason ?? null };
  const [p] = await tx.select({ erasedAt: persons.erasedAt, email: persons.email }).from(persons).where(eq(persons.id, personId));
  return { isReachable: false, blockedReason: !p || p.erasedAt ? "erased" : !p.email ? "no_email" : "suppressed" };
}

/** The sender of a domain (rule 1). */
export function senderFor(settings: SendSettings, domain: "mail.beam.be" | "news.beam.be"): { from: string; replyTo: string } {
  return {
    from: domain === "news.beam.be" ? settings.config.senders.marketing : settings.config.senders.transactional,
    replyTo: settings.config.senders.reply_to,
  };
}
