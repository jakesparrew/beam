/**
 * `resolveLinkToken()` (email spec rule 53): crm's unsubscribe and preference routes resolve the
 * per-message link token here. Reads only `email_messages` (sha256 of the token on the unique
 * `link_token_hash` index) and `persons.erased_at`; never writes. `purpose` is null for
 * transactional messages and for automation messages of transactional templates; test sends,
 * unknown tokens and rows gone through retention or erasure resolve to null.
 */
import type { DbOrTx } from "@beam/db";
import { emailMessages, persons } from "@beam/db/schema";
import { hashLinkToken, isLinkTokenShape, type MarketingPurpose } from "@beam/core/email";
import { isLocale, type Locale } from "@beam/core/i18n";
import { and, eq, ne } from "@/lib/ctx";

export type ResolvedLinkToken = { emailMessageId: string; personId: string; purpose: MarketingPurpose | null; locale: Locale; sentAt: Date };

export async function resolveLinkToken(db: DbOrTx, token: string): Promise<ResolvedLinkToken | null> {
  if (!isLinkTokenShape(token)) return null;
  const [row] = await db
    .select({
      id: emailMessages.id,
      personId: emailMessages.personId,
      purpose: emailMessages.purpose,
      locale: emailMessages.locale,
      sentAt: emailMessages.sentAt,
      queuedAt: emailMessages.queuedAt,
      erasedAt: persons.erasedAt,
    })
    .from(emailMessages)
    .leftJoin(persons, eq(persons.id, emailMessages.personId))
    .where(and(eq(emailMessages.linkTokenHash, hashLinkToken(token)), ne(emailMessages.kind, "test")));
  if (!row?.personId || row.erasedAt || !isLocale(row.locale)) return null;
  return { emailMessageId: row.id, personId: row.personId, purpose: row.purpose ?? null, locale: row.locale, sentAt: row.sentAt ?? row.queuedAt };
}
