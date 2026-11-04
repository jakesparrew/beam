/**
 * booking queries, area `waitlist` (booking spec 4.3, 5.1-5.3), booking-P5: `listWaitlist`
 * (staff, `waitlist.manage`), `listMyWaitlist` (customer, scoped to the person the page passes
 * from `requireCustomer`) and the public `getClaimOffer` (the token proves the offer; no personal
 * data beyond the first name). Other modules never import this file (they use `../api.ts`).
 */
import type { DbOrTx } from "@beam/db";
import { bookings, persons, sessions, waitlistEntries } from "@beam/db/schema";
import { queuePosition, type WaitlistQueue, type WaitlistState } from "@beam/core/booking";
import type { LocalizedText } from "@beam/core/i18n";
import { requirePermission } from "@/lib/auth";
import { and, asc, eq, gt, inArray, sql, type SQL } from "@/lib/ctx";
import { checkCredits } from "@/modules/credits/api";
import { currentClaimToken, entryByToken, toLike } from "../server/claim";

const PAGE = 100;

export type StaffWaitlistRow = {
  entryId: string;
  sessionId: string;
  sessionTitle: LocalizedText;
  startsAt: Date;
  personId: string;
  personName: string;
  hasEmail: boolean;
  queue: WaitlistQueue;
  state: WaitlistState;
  joinedAt: Date;
  offerExpiresAt: Date | null;
  offersCount: number;
  isFlagged: boolean;
  /** `same_phone:<id>,...` (R48), for staff review. */
  flagReason: string | null;
  bookingId: string | null;
  endedReason: string | null;
};

/**
 * `/admin/waitlist` and the session tab: entries of future sessions (or of one session), ordered
 * by session, queue and `joined_at`; `flaggedOnly` keeps the entries waiting for a flag review.
 * Keyset on `(starts_at, session_id, joined_at, id)` is not needed at this size: 100 per page.
 */
export async function listWaitlist(
  db: DbOrTx,
  input: { sessionId?: string; state?: WaitlistState; flaggedOnly?: boolean; offset?: number; now?: Date } = {},
): Promise<{ rows: StaffWaitlistRow[]; hasMore: boolean }> {
  await requirePermission("waitlist.manage");
  return listWaitlistRows(db, input);
}

/** `listWaitlist` without the permission check (tests and server code that checked it already). */
export async function listWaitlistRows(
  db: DbOrTx,
  input: { sessionId?: string; state?: WaitlistState; flaggedOnly?: boolean; offset?: number; now?: Date } = {},
): Promise<{ rows: StaffWaitlistRow[]; hasMore: boolean }> {
  const where: SQL[] = [];
  if (input.sessionId) where.push(eq(waitlistEntries.sessionId, input.sessionId));
  else where.push(gt(sessions.startsAt, input.now ?? new Date()));
  if (input.state) where.push(eq(waitlistEntries.state, input.state));
  if (input.flaggedOnly) where.push(and(eq(waitlistEntries.isFlaggedDuplicate, true), eq(waitlistEntries.state, "waiting"))!);
  const rows = await db
    .select({
      entryId: waitlistEntries.id,
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      startsAt: sessions.startsAt,
      personId: persons.id,
      firstName: persons.firstName,
      lastName: persons.lastName,
      email: persons.email,
      queue: waitlistEntries.queue,
      state: waitlistEntries.state,
      joinedAt: waitlistEntries.joinedAt,
      offerExpiresAt: waitlistEntries.offerExpiresAt,
      offersCount: waitlistEntries.offersCount,
      isFlagged: waitlistEntries.isFlaggedDuplicate,
      flagReason: waitlistEntries.flagReason,
      bookingId: waitlistEntries.bookingId,
      endedReason: waitlistEntries.endedReason,
    })
    .from(waitlistEntries)
    .innerJoin(sessions, eq(sessions.id, waitlistEntries.sessionId))
    .innerJoin(persons, eq(persons.id, waitlistEntries.personId))
    .where(and(...where))
    .orderBy(
      asc(sessions.startsAt),
      asc(sessions.id),
      sql`case ${waitlistEntries.queue} when 'lead' then 0 when 'customer' then 1 else 2 end`,
      asc(waitlistEntries.joinedAt),
      asc(waitlistEntries.id),
    )
    .limit(PAGE + 1)
    .offset(input.offset ?? 0);
  return {
    hasMore: rows.length > PAGE,
    rows: rows.slice(0, PAGE).map(({ firstName, lastName, email, ...r }) => ({
      ...r,
      personName: [firstName, lastName].filter(Boolean).join(" ").trim() || "-",
      hasEmail: !!email,
    })),
  };
}

export type MyWaitlistRow = {
  entryId: string;
  sessionId: string;
  title: LocalizedText;
  startsAt: Date;
  queue: WaitlistQueue;
  state: WaitlistState;
  /** 1-based, only when the session shows positions (R27). */
  position: number | null;
  offerExpiresAt: Date | null;
  /** `/claim/<token>` of a live offer (the token is recomputed, never stored). */
  claimToken: string | null;
  bookingId: string | null;
  canRejoin: boolean;
};

/** `/[locale]/account/waitlist`: the person's entries of sessions that have not started. */
export async function listMyWaitlist(db: DbOrTx, personId: string, now: Date = new Date()): Promise<MyWaitlistRow[]> {
  const mine = await db
    .select({ entry: waitlistEntries, title: sessions.title, startsAt: sessions.startsAt, showPosition: sessions.isWaitlistPositionVisible })
    .from(waitlistEntries)
    .innerJoin(sessions, eq(sessions.id, waitlistEntries.sessionId))
    .where(and(eq(waitlistEntries.personId, personId), gt(sessions.startsAt, now)))
    .orderBy(asc(sessions.startsAt));
  const withPositions = mine.filter((m) => m.showPosition && m.entry.state === "waiting").map((m) => m.entry.sessionId);
  const peers = withPositions.length
    ? await db.select().from(waitlistEntries).where(and(inArray(waitlistEntries.sessionId, withPositions), eq(waitlistEntries.state, "waiting")))
    : [];
  return mine.map(({ entry, title, startsAt, showPosition }) => {
    const live = entry.state === "offered" && !entry.bookingId && !!entry.offerExpiresAt && entry.offerExpiresAt.getTime() > now.getTime();
    return {
      entryId: entry.id,
      sessionId: entry.sessionId,
      title,
      startsAt,
      queue: entry.queue,
      state: entry.state,
      position: showPosition ? queuePosition(toLike(entry), peers.filter((p) => p.sessionId === entry.sessionId).map(toLike)) : null,
      offerExpiresAt: entry.state === "offered" ? entry.offerExpiresAt : null,
      claimToken: live || (entry.state === "offered" && entry.bookingId) ? currentClaimToken(entry) : null,
      bookingId: entry.bookingId,
      canRejoin:
        (entry.state === "expired" || entry.state === "released" || entry.state === "withdrawn") &&
        entry.rejoinCount === 0 &&
        !["session_started", "session_cancelled", "flag_withdrawn"].includes(entry.endedReason ?? ""),
    };
  });
}

export type ClaimOffer = {
  entryId: string;
  sessionId: string;
  title: LocalizedText;
  startsAt: Date;
  offerExpiresAt: Date | null;
  firstName: string | null;
  personId: string;
  /** `live` = claimable now; `claimed` = a booking exists; `expired` covers ended and superseded offers. */
  state: "live" | "claimed" | "expired" | "session_cancelled" | "session_closed";
  bookingId: string | null;
  /** The payment hint (R44): credits when the person has them, free, or pay on the next page. */
  payment: "credit" | "free" | "order";
};

/** `/[locale]/claim/[token]`: the offer behind a token, or null for an unknown or superseded token. */
export async function getClaimOffer(db: DbOrTx, token: string, now: Date = new Date()): Promise<ClaimOffer | null> {
  const entry = await entryByToken(db, token);
  if (!entry) return null;
  const [s] = await db.select().from(sessions).where(eq(sessions.id, entry.sessionId));
  const [p] = await db.select({ firstName: persons.firstName }).from(persons).where(eq(persons.id, entry.personId));
  if (!s) return null;
  let bookingLive = false;
  if (entry.bookingId) {
    const [b] = await db.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, entry.bookingId));
    bookingLive = !!b && ["reserved", "confirmed", "attended", "no_show"].includes(b.status);
  }
  let state: ClaimOffer["state"];
  if (bookingLive) state = "claimed";
  else if (s.status === "cancelled") state = "session_cancelled";
  else if (entry.state !== "offered" || !entry.offerExpiresAt || entry.offerExpiresAt.getTime() <= now.getTime() || s.startsAt.getTime() <= now.getTime()) state = "expired";
  else if (s.status === "closed") state = "session_closed";
  else state = "live";

  let payment: ClaimOffer["payment"] = "order";
  if (!s.productId && (s.creditKind === null || s.creditCost === 0)) payment = "free";
  else if (s.creditKind && s.creditCost > 0 && state === "live") {
    const check = await checkCredits(db, { personId: entry.personId, beneficiaryPersonId: entry.personId, kind: s.creditKind, units: s.creditCost, validAt: s.startsAt }).catch(() => null);
    if (check?.ok) payment = "credit";
  }
  return {
    entryId: entry.id,
    sessionId: s.id,
    title: s.title,
    startsAt: s.startsAt,
    offerExpiresAt: entry.offerExpiresAt,
    firstName: p?.firstName?.trim() || null,
    personId: entry.personId,
    state,
    bookingId: bookingLive ? entry.bookingId : null,
    payment,
  };
}
