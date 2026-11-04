/**
 * Terms and house rules on the first booking (booking spec R62). A customer who has never
 * accepted any `terms` version must send `acceptTerms: true`; the acceptance is recorded through
 * `site.recordTermsAcceptance` in the booking transaction (context `booking`). A later material
 * change shows site's non-blocking banner and never blocks a booking, so a person who accepted
 * any version passes. Staff bookings record nothing (the caller skips this check).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { termsAcceptances } from "@beam/db/schema";
import { TermsRequiredError } from "@beam/core/booking";
import { and, eq, sql, type Ctx } from "@/lib/ctx";
import { getCurrentLegalVersion, hasAcceptedCurrentTerms, recordTermsAcceptance } from "@/modules/site/api";

export type TermsRef = { type: "booking"; id: string };

export type TermsOutcome = { recorded: boolean; versionId: string | null };

/**
 * True when the person accepted any `terms` version. Site's api has no "ever accepted" function
 * yet (requested from site); this read-only check keeps R62's "a material change never blocks".
 */
export async function hasEverAcceptedTerms(db: DbOrTx, personId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(termsAcceptances)
    .where(and(eq(termsAcceptances.personId, personId), eq(termsAcceptances.legalKey, "terms")));
  return Number(row?.n ?? 0) > 0;
}

/**
 * R62: passes when the person accepted terms before (any version, or the current one through
 * merges) or when no terms page is published; records the acceptance when `acceptTerms` is true;
 * otherwise throws `TermsRequiredError` (`conflict`, reason `terms_required`).
 */
export async function ensureTermsAccepted(
  tx: Tx,
  ctx: Ctx,
  personId: string,
  acceptTerms: boolean | undefined,
  ref: TermsRef,
): Promise<TermsOutcome> {
  if (await hasEverAcceptedTerms(tx, personId)) return { recorded: false, versionId: null };
  if (await hasAcceptedCurrentTerms(tx, personId)) return { recorded: false, versionId: null };
  const current = await getCurrentLegalVersion(tx, "terms");
  if (!current) return { recorded: false, versionId: null };
  if (acceptTerms !== true) throw new TermsRequiredError({ versionId: current.versionId });
  await recordTermsAcceptance(tx, ctx, {
    personId,
    versionId: current.versionId,
    context: "booking",
    refType: ref.type,
    refId: ref.id,
    ip: ctx.ip,
  });
  return { recorded: true, versionId: current.versionId };
}
