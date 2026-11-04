/**
 * site queries, portal (site spec section 4, rules 35, 47 and 48; site-P6): `getAccountHome` and
 * `getTermsBannerState`, both uncached (the portal is `private, no-store`).
 *
 * Every read filters on the actor's person id and the ids merged into it (`crm.resolvePersonIds`),
 * so a merged-away person's bookings, offers, credits and membership still show for the winner.
 * Each card of the home loads independently as a `Result<T>`: a module api that throws makes only
 * its card `{ ok: false }` ("Temporarily unavailable"), reported to Sentry; the page still renders.
 */
import type { DbOrTx } from "@beam/db";
import { vLegalVersions } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { and, eq, getAppDb } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { listOpenOffersForPerson, listUpcomingBookingsForPerson } from "@/modules/booking/api";
import { getMembershipSummary, getPersonCreditSummary } from "@/modules/credits/api";
import { getCurrentLegalVersion, hasAcceptedCurrentTerms } from "../server/legal";

/** One card's data, or a failure that the card shows as "Temporarily unavailable". */
export type Result<T> = { ok: true; data: T } | { ok: false };

/** An upcoming booking of the person or a guest booking the person made (booking's row shape). */
export type PortalBookingRow = Awaited<ReturnType<typeof listUpcomingBookingsForPerson>>[number];
/** Balance of one credit kind (`credits.getPersonCreditSummary().byKind`). */
export type PortalBalanceRow = Awaited<ReturnType<typeof getPersonCreditSummary>>["byKind"][number];
export type MembershipSummary = NonNullable<Awaited<ReturnType<typeof getMembershipSummary>>>;
/** An open waitlist offer (`booking.listOpenOffersForPerson`). */
export type WaitlistOffer = Awaited<ReturnType<typeof listOpenOffersForPerson>>[number];

export type AccountHome = {
  firstName: string | null;
  bookings: Result<PortalBookingRow[]>;
  balances: Result<PortalBalanceRow[]>;
  membership: Result<MembershipSummary | null>;
  offers: Result<WaitlistOffer[]>;
};

/** At most this many upcoming bookings on the home (rule 47). */
export const HOME_BOOKINGS_LIMIT = 5;

async function card<T>(name: string, load: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    reportError(error, { tags: { module: "site", step: "account_home", card: name } });
    return { ok: false };
  }
}

/** The person and every person merged into it; just the person when crm cannot answer. */
async function personIdsOf(db: DbOrTx, personId: string): Promise<string[]> {
  try {
    // Loaded on use: crm's api imports site's barrel, so a static import is a cycle (as in server/legal.ts).
    const { resolvePersonIds } = await import("@/modules/crm/api");
    const ids = await resolvePersonIds(db, personId);
    return ids.length > 0 ? ids : [personId];
  } catch (error) {
    reportError(error, { tags: { module: "site", step: "account_home", card: "person_ids" } });
    return [personId];
  }
}

async function firstNameOf(db: DbOrTx, personId: string): Promise<string | null> {
  try {
    const { getPerson } = await import("@/modules/crm/api");
    return (await getPerson(db, personId))?.firstName?.trim() || null;
  } catch (error) {
    reportError(error, { tags: { module: "site", step: "account_home", card: "first_name" } });
    return null;
  }
}

/** The next upcoming bookings over all ids (own and guest bookings made by the person), earliest first. */
export async function homeBookingsOf(db: DbOrTx, ids: readonly string[], limit: number = HOME_BOOKINGS_LIMIT): Promise<PortalBookingRow[]> {
  const byId = new Map<string, PortalBookingRow>();
  for (const id of ids) {
    for (const row of await listUpcomingBookingsForPerson(db, id, limit)) byId.set(row.bookingId, row);
  }
  return [...byId.values()]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.bookingId.localeCompare(b.bookingId))
    .slice(0, limit);
}

/** Balances per credit kind summed over all ids, with the nearest expiry; kinds with nothing left are left out. */
export async function homeBalancesOf(db: DbOrTx, ids: readonly string[]): Promise<PortalBalanceRow[]> {
  const order = new Map<string, number>([
    ["day", 0],
    ["night", 1],
    ["euro", 2],
  ]);
  const byKind = new Map<string, PortalBalanceRow>();
  for (const id of ids) {
    const summary = await getPersonCreditSummary(db, id);
    for (const row of summary.byKind) {
      const prev = byKind.get(row.kind);
      if (!prev) {
        byKind.set(row.kind, { ...row });
        continue;
      }
      const expiries = [prev.nextExpiresAt, row.nextExpiresAt].filter((d): d is Date => d instanceof Date);
      byKind.set(row.kind, {
        kind: row.kind,
        remainingUnits: prev.remainingUnits + row.remainingUnits,
        nextExpiresAt: expiries.length > 0 ? new Date(Math.min(...expiries.map((d) => d.getTime()))) : null,
      });
    }
  }
  return [...byKind.values()].filter((r) => r.remainingUnits > 0).sort((a, b) => (order.get(a.kind) ?? 9) - (order.get(b.kind) ?? 9));
}

/** The first membership found, the winner's before a merged-away person's. */
export async function homeMembershipOf(db: DbOrTx, ids: readonly string[]): Promise<MembershipSummary | null> {
  for (const id of ids) {
    const summary = await getMembershipSummary(db, id);
    if (summary) return summary;
  }
  return null;
}

/** Open waitlist offers over all ids, the soonest to expire first. */
export async function homeOffersOf(db: DbOrTx, ids: readonly string[]): Promise<WaitlistOffer[]> {
  const byId = new Map<string, WaitlistOffer>();
  for (const id of ids) for (const row of await listOpenOffersForPerson(db, id)) byId.set(row.entryId, row);
  return [...byId.values()].sort((a, b) => a.offerExpiresAt.getTime() - b.offerExpiresAt.getTime());
}

/**
 * The account home of the signed-in customer (rule 47). `locale` is the URL locale; the cards
 * carry localized texts for every locale and the page picks it. Each card fails independently.
 */
export async function getAccountHome(personId: string, _locale: Locale, db?: DbOrTx): Promise<AccountHome> {
  const conn = db ?? (await getAppDb());
  const ids = await personIdsOf(conn, personId);
  const firstName = await firstNameOf(conn, personId);
  const bookings = await card("bookings", () => homeBookingsOf(conn, ids));
  const balances = await card("balances", () => homeBalancesOf(conn, ids));
  const membership = await card("membership", () => homeMembershipOf(conn, ids));
  const offers = await card("offers", () => homeOffersOf(conn, ids));
  return { firstName, bookings, balances, membership, offers };
}

export type TermsBannerState =
  | { show: false }
  | {
      show: true;
      /** The live terms version the "Accept" button sends. */
      versionId: string;
      /** "Version n". */
      version: number;
      /** Absolute URL of the live terms per locale ("Read the new terms"). */
      urlByLocale: Partial<Record<Locale, string>>;
    };

/**
 * Rule 35: the banner shows once a terms version with `is_material_change` was published and the
 * person (over `crm.resolvePersonIds`) has not accepted that version or a later one. No banner
 * while no terms are live or no material version exists.
 */
export async function getTermsBannerState(personId: string, db?: DbOrTx): Promise<TermsBannerState> {
  const conn = db ?? (await getAppDb());
  const current = await getCurrentLegalVersion(conn, "terms");
  if (!current) return { show: false };
  const [material] = await conn
    .select({ versionId: vLegalVersions.versionId })
    .from(vLegalVersions)
    .where(and(eq(vLegalVersions.legalKey, "terms"), eq(vLegalVersions.isMaterialChange, true)))
    .limit(1);
  if (!material) return { show: false };
  if (await hasAcceptedCurrentTerms(conn, personId)) return { show: false };
  return { show: true, versionId: current.versionId, version: current.version, urlByLocale: current.urlByLocale };
}
