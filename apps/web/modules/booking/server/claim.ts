/**
 * The waitlist service (booking spec 3.7, R40-R49) and the seat claim (R43, R44): joins and
 * rejoins with duplicate signals, offers with single-use claim tokens, customer withdraw and
 * decline, the staff waitlist operations and `claimSeatRow`. Every change goes through
 * `transition()` of `@beam/core/booking`, so no actor ever changes a `confirmed` entry
 * (`ProtectedSeatError`). Used by `../actions/waitlist.ts`, `../jobs/waitlist.ts` and
 * `../queries/waitlist.ts`; other modules use `../api.ts`.
 */
import { randomUUID } from "node:crypto";
import type { DbOrTx, Tx } from "@beam/db";
import { bookings, orderLines, orders, persons, sessions, users, waitlistEntries } from "@beam/db/schema";
import {
  AlreadyBookedError,
  BookingConflictError,
  ProtectedSeatError,
  bookingTransition,
  claimToken,
  computeAvailability,
  deriveClaimKey,
  deriveIpSalt,
  duplicateSignals,
  hashIp,
  hashToken,
  normaliseEmail,
  offerExpiry,
  queuePosition,
  transition,
  type ActorKind,
  type BookingRules,
  type DupCandidate,
  type WaitlistLike,
  type WaitlistQueue,
  type WaitlistState,
} from "@beam/core/booking";
import { URL_SEGMENT, formatDateTime, pick, type Locale } from "@beam/core/i18n";
import { createVerificationToken } from "@/lib/auth";
import { MAGIC_LINK_MINUTES } from "@/lib/auth-config";
import { AppError, NotFoundError, actorHasPermission, and, eq, gt, inArray, ne, or, sql, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { createOrder } from "@/modules/commerce/api";
import { checkCredits, consumeCredits } from "@/modules/credits/api";
import { sendTransactional } from "@/modules/email/api";
import { hasValidSubmission } from "@/modules/forms/api";
import { getCurrentLegalVersion, hasAcceptedCurrentTerms, recordTermsAcceptance } from "@/modules/site/api";
import { LIVE_STATUSES, PROVISIONAL_RESERVATION_MS, lockSession, mapCreditError, readAvailabilityRow, viewerFor, type BookingRow, type SessionRow } from "./book";
import { HEALTH_DECLARATION_FORM } from "./declarations";
import { recordBookingFact } from "./facts";
import { linkOrderLines } from "./order-hooks";
import { qrAttachment, renderCheckinQr } from "./qr";
import { hasEverAcceptedTerms } from "./terms";

export type EntryRow = typeof waitlistEntries.$inferSelect;

/** The database's own check (`offers_count <= 5`). */
export const MAX_OFFERS_PER_ENTRY = 5;

const appUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;

/** The claim-token key (R43): HKDF of `AUTH_SECRET`, info `beam-claim-v1`. */
export function claimKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return deriveClaimKey(secret);
}

/** The plain token of an entry's current offer (recomputed, never stored). */
export function currentClaimToken(entry: Pick<EntryRow, "id" | "offersCount">): string {
  return claimToken(claimKey(), entry.id, entry.offersCount);
}

/** The emailed claim link: the GET route, which only redirects (R44, edge case 9). */
export function claimUrl(token: string): string {
  return appUrl(`/api/public/claim/${token}`);
}

/** The state-machine actor of a context (public and webhook paths count as system). */
export function waitlistActor(ctx: Ctx): ActorKind {
  const kind = ctx.actor.kind;
  return kind === "public" || kind === "webhook" ? "system" : kind;
}

export function toLike(e: EntryRow): WaitlistLike {
  return {
    id: e.id,
    personId: e.personId,
    queue: e.queue,
    state: e.state,
    joinedAt: e.joinedAt,
    offersCount: e.offersCount,
    rejoinCount: e.rejoinCount,
    isFlaggedDuplicate: e.isFlaggedDuplicate,
    endedReason: e.endedReason,
  };
}

/** `select ... for update` of one entry. */
export async function lockEntry(tx: DbOrTx, entryId: string): Promise<EntryRow> {
  const [row] = await tx.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId)).for("update");
  if (!row) throw new NotFoundError("waitlist_entry_not_found");
  return row;
}

/** The entry with its session, both locked (session first, R10). */
export async function lockEntryAndSession(tx: DbOrTx, entryId: string): Promise<{ entry: EntryRow; session: SessionRow }> {
  const [peek] = await tx.select({ sessionId: waitlistEntries.sessionId }).from(waitlistEntries).where(eq(waitlistEntries.id, entryId));
  if (!peek) throw new NotFoundError("waitlist_entry_not_found");
  const session = await lockSession(tx, peek.sessionId);
  return { entry: await lockEntry(tx, entryId), session };
}

type WaitlistFactKind =
  | "waitlist.joined"
  | "waitlist.flagged"
  | "waitlist.requeued"
  | "waitlist.offered"
  | "waitlist.confirmed"
  | "waitlist.expired"
  | "waitlist.released"
  | "waitlist.withdrawn";

/** R61: one waitlist fact, dedupe `waitlist:<entry_id>:<suffix>:<offers_count>:<rejoin_count>[:<qualifier>]`. */
export async function recordWaitlistFact(
  ctx: Ctx,
  kind: WaitlistFactKind,
  entry: Pick<EntryRow, "id" | "personId" | "queue" | "offersCount" | "rejoinCount">,
  session: Pick<SessionRow, "id" | "kind" | "eventCategory" | "startsAt">,
  extra: Record<string, unknown> & { qualifier?: string } = {},
): Promise<void> {
  const { qualifier, ...more } = extra;
  await ctx.recordEvent({
    kind,
    personId: entry.personId,
    data: {
      session_id: session.id,
      session_kind: session.kind,
      event_category: session.eventCategory,
      starts_at: session.startsAt,
      paid_with: null,
      is_guest: false,
      guest_of_person_id: null,
      owner_person_id: entry.personId,
      is_first_booking: false,
      is_first_visit: false,
      queue: entry.queue,
      ...more,
    },
    ref: { type: "waitlist_entry", id: entry.id },
    dedupeKey: `waitlist:${entry.id}:${kind.slice("waitlist.".length)}:${entry.offersCount}:${entry.rejoinCount}${qualifier ? `:${qualifier}` : ""}`,
  });
}

/** Sends one waitlist email when the person has an address (walk-ins have none). */
async function sendWaitlistEmail(
  ctx: Ctx,
  template: "booking.waitlist_joined" | "booking.seat_offered" | "booking.offer_expired" | "booking.seat_claimed",
  personId: string,
  session: Pick<SessionRow, "id" | "title" | "startsAt">,
  key: string,
  data: (locale: Locale) => Record<string, unknown>,
  attachments?: { fileId: string; filename: string; inline: true }[],
): Promise<boolean> {
  const [person] = await ctx.tx.select({ email: persons.email, locale: persons.locale }).from(persons).where(eq(persons.id, personId));
  if (!person?.email) return false;
  const locale = person.locale;
  await sendTransactional(ctx, {
    template,
    personId,
    locale,
    data: { title: pick(session.title, locale, "session title"), date: formatDateTime(session.startsAt, locale, "full"), ...data(locale) },
    key,
    ...(attachments ? { attachments } : {}),
  });
  return true;
}

/** R34: freed capacity goes to the waitlist (`waitlist:<session_id>:offer_next:<trigger>`). */
export async function enqueueOfferNext(ctx: Ctx, sessionId: string, trigger: string): Promise<void> {
  await ctx.enqueue({ kind: "waitlist.offer_next", payload: { sessionId, trigger }, key: `waitlist:${sessionId}:offer_next:${trigger}` });
}

/** Writes a state change after `transition()` allowed it. */
async function setEntry(ctx: Ctx, entryId: string, values: Partial<typeof waitlistEntries.$inferInsert>): Promise<EntryRow> {
  const [row] = await ctx.tx
    .update(waitlistEntries)
    .set({ ...values, updatedAt: ctx.now })
    .where(eq(waitlistEntries.id, entryId))
    .returning();
  return row!;
}

/**
 * Ends an entry (`expired`, `released` or `withdrawn`) with `ended_reason`, writes its fact and,
 * for a freed live offer, enqueues `waitlist.offer_next`. Throws for a `confirmed` entry.
 */
export async function endEntry(
  ctx: Ctx,
  entry: EntryRow,
  session: SessionRow,
  to: Extract<WaitlistState, "expired" | "released" | "withdrawn">,
  endedReason: string,
): Promise<EntryRow> {
  transition(toLike(entry), to, waitlistActor(ctx));
  const row = await setEntry(ctx, entry.id, { state: to, endedReason });
  await recordWaitlistFact(ctx, `waitlist.${to}`, entry, session, { ended_reason: endedReason });
  const freedOffer = entry.state === "offered";
  if (freedOffer && session.status !== "cancelled" && session.startsAt.getTime() > ctx.now.getTime()) {
    await enqueueOfferNext(ctx, session.id, `${entry.id}:${entry.offersCount}`);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Offers (R42, R43)
// ---------------------------------------------------------------------------

/**
 * Offers a seat to one `waiting` entry under the caller's session lock: `offered`,
 * `offers_count + 1`, `offer_expires_at = least(now + claim window, start - cut-off)`, a new
 * claim token (its hash stored), `waitlist.offered` and `booking.seat_offered` with key
 * `waitlist:<entry_id>:offer:<offers_count>` when the person has an email (else staff phone
 * them). Returns null when the cut-off leaves less than `min_claim_minutes`.
 */
export async function offerEntry(
  ctx: Ctx,
  entry: EntryRow,
  session: SessionRow,
  rules: BookingRules,
  opts: { claimWindowMinutes?: number } = {},
): Promise<{ entry: EntryRow; offerExpiresAt: Date; emailed: boolean } | null> {
  const expiresAt = offerExpiry(ctx.now, session.startsAt, opts.claimWindowMinutes ?? session.claimWindowMinutes, rules);
  if (!expiresAt) return null;
  const next = transition(toLike(entry), "offered", waitlistActor(ctx));
  if (next.offersCount > MAX_OFFERS_PER_ENTRY) throw new BookingConflictError("invalid_transition", { reason: "max_offers" });
  const token = claimToken(claimKey(), entry.id, next.offersCount);
  const row = await setEntry(ctx, entry.id, {
    state: "offered",
    offersCount: next.offersCount,
    offeredAt: ctx.now,
    offerExpiresAt: expiresAt,
    claimTokenHash: hashToken(token),
    bookingId: null,
    endedReason: null,
  });
  await recordWaitlistFact(ctx, "waitlist.offered", row, session, { offer_expires_at: expiresAt, offers_count: row.offersCount });
  const emailed = await sendWaitlistEmail(ctx, "booking.seat_offered", entry.personId, session, `waitlist:${entry.id}:offer:${row.offersCount}`, (locale) => ({
    expiresAt: formatDateTime(expiresAt, locale, "full"),
    url: claimUrl(token),
  }));
  return { entry: row, offerExpiresAt: expiresAt, emailed };
}

/** R45: an unclaimed offer past `offer_expires_at` becomes `expired` (`offer_timeout`, `booking.offer_expired`). */
export async function expireOffer(ctx: Ctx, entry: EntryRow, session: SessionRow): Promise<EntryRow> {
  const row = await endEntry(ctx, entry, session, "expired", "offer_timeout");
  await sendWaitlistEmail(ctx, "booking.offer_expired", entry.personId, session, `waitlist:${entry.id}:expired:${entry.offersCount}`, (locale) => ({
    url: appUrl(`/${URL_SEGMENT[locale]}/account/book/${session.id}`),
  }));
  return row;
}

/**
 * R44: an `offered` entry whose claimed booking is no longer live (the reservation lapsed or the
 * order ended unpaid) becomes `expired` with `payment_not_completed`. `expireReservedRow` does
 * this in the expiring transaction; this sweep catches the other release paths.
 */
export async function expireUnpaidClaims(ctx: Ctx, sessionId?: string): Promise<string[]> {
  const rows = await ctx.tx
    .select({ id: waitlistEntries.id })
    .from(waitlistEntries)
    .innerJoin(bookings, eq(bookings.id, waitlistEntries.bookingId))
    .where(
      and(
        eq(waitlistEntries.state, "offered"),
        inArray(bookings.status, ["cancelled", "late_cancelled"]),
        sessionId ? eq(waitlistEntries.sessionId, sessionId) : undefined,
      ),
    )
    .orderBy(waitlistEntries.id)
    .limit(200);
  const done: string[] = [];
  for (const { id } of rows) {
    const { entry, session } = await lockEntryAndSession(ctx.tx, id);
    if (entry.state !== "offered" || !entry.bookingId) continue;
    await endEntry(ctx, entry, session, "expired", "payment_not_completed");
    done.push(id);
  }
  return done;
}

// ---------------------------------------------------------------------------
// Joining (R40, R48, R62)
// ---------------------------------------------------------------------------

export type JoinWaitlistInput = {
  sessionId: string;
  personId: string;
  by: "customer" | "staff";
  /** Staff: the queue to put the person in (default: the queue of their status). */
  queue?: WaitlistQueue;
  acceptTerms?: boolean;
};

export type JoinWaitlistResult = { entryId: string; queue: WaitlistQueue; position?: number; isFlagged: boolean };

/** R62 for a join: as `ensureTermsAccepted`, recorded without a booking ref (context `booking`). */
async function ensureJoinTerms(tx: Tx, ctx: Ctx, personId: string, acceptTerms: boolean | undefined): Promise<void> {
  if (await hasEverAcceptedTerms(tx, personId)) return;
  if (await hasAcceptedCurrentTerms(tx, personId)) return;
  const current = await getCurrentLegalVersion(tx, "terms");
  if (!current) return;
  if (acceptTerms !== true) throw new BookingConflictError("terms_required", { versionId: current.versionId });
  await recordTermsAcceptance(tx, ctx, { personId, versionId: current.versionId, context: "booking", ip: ctx.ip });
}

/** The R7/R15/R64 refusal for an `Availability.reason` that does not allow a join. */
function refuseJoin(reason: string): never {
  switch (reason) {
    case "webinar":
      throw new BookingConflictError("webinar_session");
    case "member_only":
      throw new BookingConflictError("member_only");
    case "closed":
    case "cancelled":
      throw new BookingConflictError("session_closed");
    case "ok":
      // Places are free: book instead of waiting (R40 "full for them").
      throw new BookingConflictError("invalid_transition", { reason: "session_not_full" });
    default:
      throw new BookingConflictError("outside_window");
  }
}

/** R48: the duplicate signals of a join against the session's other entries and live bookings. */
async function joinSignals(tx: DbOrTx, sessionId: string, candidate: DupCandidate): Promise<string[]> {
  const entries = await tx
    .select({
      id: waitlistEntries.id,
      personId: waitlistEntries.personId,
      emailNormalised: waitlistEntries.emailNormalised,
      joinIpHash: waitlistEntries.joinIpHash,
      joinedAt: waitlistEntries.joinedAt,
      queue: waitlistEntries.queue,
      phone: persons.phone,
      lastName: persons.lastName,
      birthOn: persons.birthOn,
    })
    .from(waitlistEntries)
    .innerJoin(persons, eq(persons.id, waitlistEntries.personId))
    .where(and(eq(waitlistEntries.sessionId, sessionId), ne(waitlistEntries.personId, candidate.personId)));
  const live = await tx
    .select({
      id: bookings.id,
      personId: bookings.personId,
      createdAt: bookings.createdAt,
      email: persons.email,
      phone: persons.phone,
      lastName: persons.lastName,
      birthOn: persons.birthOn,
    })
    .from(bookings)
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(and(eq(bookings.sessionId, sessionId), inArray(bookings.status, [...LIVE_STATUSES]), ne(bookings.personId, candidate.personId)));
  const others: DupCandidate[] = [
    ...entries.map((e) => ({ ...e, birthOn: e.birthOn ?? null })),
    ...live.map((b) => ({
      id: b.id,
      personId: b.personId,
      emailNormalised: b.email ? normaliseEmail(b.email) : null,
      phone: b.phone,
      lastName: b.lastName,
      birthOn: b.birthOn ?? null,
      joinIpHash: null,
      joinedAt: b.createdAt,
      queue: null,
    })),
  ];
  return duplicateSignals(candidate, others);
}

/**
 * R40: joins (or rejoins once) the session's waitlist. A customer needs an open, not started,
 * eligible session that is full for them, no live booking and no live entry; staff
 * (`waitlist.manage`) may add a person to any open future session (member-only needs
 * `bookings.override`). Duplicate signals flag the entry (R48); a flagged entry waits but gets no
 * offer until staff review it.
 */
export async function joinWaitlistRow(tx: Tx, ctx: Ctx, input: JoinWaitlistInput): Promise<JoinWaitlistResult> {
  const session = await lockSession(tx, input.sessionId);
  const rules: BookingRules = await getSetting(tx, "booking_rules");
  const staff = input.by === "staff";
  if (session.webinarId) throw new BookingConflictError("webinar_session");
  if (session.status !== "open") throw new BookingConflictError("session_closed");
  if (session.startsAt.getTime() <= ctx.now.getTime()) throw new BookingConflictError("outside_window");

  const viewer = await viewerFor(tx, session, input.personId);
  const availability = computeAvailability(await readAvailabilityRow(tx, session), viewer, ctx.now, rules);
  let queue: WaitlistQueue;
  if (staff) {
    if (session.isMemberOnly && !viewer.isMember && !actorHasPermission(ctx.actor, "bookings.override")) throw new BookingConflictError("member_only");
    queue = input.queue ?? availability.queue ?? "public";
  } else {
    if (!availability.canJoinWaitlist) refuseJoin(availability.reason);
    queue = availability.queue ?? "public";
  }

  const [booked] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), eq(bookings.personId, input.personId), inArray(bookings.status, [...LIVE_STATUSES])));
  if (booked) throw new AlreadyBookedError();

  const [existing] = await tx
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.sessionId, session.id), eq(waitlistEntries.personId, input.personId)))
    .for("update");
  if (existing && (existing.state === "waiting" || existing.state === "offered")) throw new BookingConflictError("already_waiting");
  if (existing?.state === "confirmed") throw new ProtectedSeatError({ entryId: existing.id });
  const rejoined = existing ? transition(toLike(existing), "waiting", waitlistActor(ctx)) : null;

  if (!staff) await ensureJoinTerms(tx, ctx, input.personId, input.acceptTerms);

  const [person] = await tx
    .select({ email: persons.email, phone: persons.phone, lastName: persons.lastName, birthOn: persons.birthOn })
    .from(persons)
    .where(eq(persons.id, input.personId));
  if (!person) throw new NotFoundError("person_not_found");
  const emailNormalised = person.email ? normaliseEmail(person.email) : null;
  // R48: the IP signal needs `ctx.ip`; without it (staff, null IP) it is skipped.
  const joinIpHash = staff || !ctx.ip ? null : hashIp(ctx.ip, deriveIpSalt(process.env.AUTH_SECRET ?? ""));
  const id = existing?.id ?? randomUUID();
  const signals = await joinSignals(tx, session.id, {
    id,
    personId: input.personId,
    emailNormalised,
    phone: person.phone,
    lastName: person.lastName,
    birthOn: person.birthOn ?? null,
    joinIpHash,
    joinedAt: ctx.now,
    queue,
  });
  const flag = {
    isFlaggedDuplicate: signals.length > 0,
    flagReason: signals.length ? signals.join(",") : null,
    flagReviewedByUserId: null,
    flagReviewedAt: null,
    emailNormalised,
    joinIpHash,
  };

  let entry: EntryRow;
  if (existing && rejoined) {
    entry = await setEntry(ctx, existing.id, {
      ...flag,
      state: "waiting",
      queue,
      joinedAt: ctx.now,
      rejoinCount: rejoined.rejoinCount,
      endedReason: null,
      offeredAt: null,
      offerExpiresAt: null,
      claimTokenHash: null,
      bookingId: null,
    });
  } else {
    const [row] = await tx
      .insert(waitlistEntries)
      .values({ id, sessionId: session.id, personId: input.personId, queue, state: "waiting", joinedAt: ctx.now, ...flag })
      .returning();
    entry = row!;
  }

  await recordWaitlistFact(ctx, "waitlist.joined", entry, session, { by: input.by });
  if (signals.length) await recordWaitlistFact(ctx, "waitlist.flagged", entry, session, { signals });
  await sendWaitlistEmail(ctx, "booking.waitlist_joined", entry.personId, session, `waitlist:${entry.id}:joined:${entry.rejoinCount}`, (locale) => ({
    url: appUrl(`/${URL_SEGMENT[locale]}/account/waitlist`),
  }));
  // Staff may add a person while places are free: the next offer run looks at once.
  if (staff) await enqueueOfferNext(ctx, session.id, `${entry.id}:joined:${entry.rejoinCount}`);

  let position: number | undefined;
  if (session.isWaitlistPositionVisible) {
    const all = await tx.select().from(waitlistEntries).where(eq(waitlistEntries.sessionId, session.id));
    position = queuePosition(toLike(entry), all.map(toLike)) ?? undefined;
  }
  return { entryId: entry.id, queue: entry.queue, isFlagged: entry.isFlaggedDuplicate, ...(position !== undefined ? { position } : {}) };
}

// ---------------------------------------------------------------------------
// Customer and staff changes (R46, R49)
// ---------------------------------------------------------------------------

/** The customer's own entry (a foreign id reads as not found). */
async function ownEntry(tx: Tx, ctx: Ctx, entryId: string): Promise<{ entry: EntryRow; session: SessionRow }> {
  const locked = await lockEntryAndSession(tx, entryId);
  if (ctx.actor.kind !== "customer" || locked.entry.personId !== ctx.actor.personId) throw new NotFoundError("waitlist_entry_not_found");
  return locked;
}

/** R46: the customer leaves the queue (`waiting` or `offered` -> `withdrawn`, reason `customer`). */
export async function withdrawEntryRow(tx: Tx, ctx: Ctx, input: { entryId: string }): Promise<{ state: WaitlistState }> {
  const { entry, session } = await ownEntry(tx, ctx, input.entryId);
  if (entry.state === "withdrawn") return { state: "withdrawn" };
  if (entry.state === "offered" && entry.bookingId) throw new BookingConflictError("invalid_transition", { reason: "claimed" });
  const row = await endEntry(ctx, entry, session, "withdrawn", "customer");
  return { state: row.state };
}

/** R46: "I can't come": an `offered` entry becomes `released` (`declined`), by entry id or claim token. */
export async function declineOfferRow(tx: Tx, ctx: Ctx, input: { entryId: string } | { token: string }): Promise<{ state: WaitlistState }> {
  let locked: { entry: EntryRow; session: SessionRow };
  if ("token" in input) {
    const [peek] = await tx.select({ id: waitlistEntries.id }).from(waitlistEntries).where(eq(waitlistEntries.claimTokenHash, hashToken(input.token)));
    if (!peek) throw new BookingConflictError("outside_window", { claim: "invalid" });
    locked = await lockEntryAndSession(tx, peek.id);
  } else locked = await ownEntry(tx, ctx, input.entryId);
  const { entry, session } = locked;
  if (entry.state === "released" && entry.endedReason === "declined") return { state: "released" };
  if (entry.state === "confirmed") throw new ProtectedSeatError({ entryId: entry.id });
  if (entry.state !== "offered") throw new BookingConflictError("outside_window");
  if (entry.bookingId) throw new BookingConflictError("invalid_transition", { reason: "claimed" });
  const row = await endEntry(ctx, entry, session, "released", "declined");
  return { state: row.state };
}

/** R49 staff: offer a seat now; needs a free place unless the actor holds `bookings.override`. */
export async function offerSeatManuallyRow(tx: Tx, ctx: Ctx, input: { entryId: string; claimWindowMinutes?: number }): Promise<{ offerExpiresAt: Date }> {
  const { entry, session } = await lockEntryAndSession(tx, input.entryId);
  if (entry.state === "confirmed") throw new ProtectedSeatError({ entryId: entry.id });
  if (session.status !== "open") throw new BookingConflictError("session_closed");
  const rules: BookingRules = await getSetting(tx, "booking_rules");
  const availability = await readAvailabilityRow(tx, session);
  if (availability.availableTotal < 1 && !actorHasPermission(ctx.actor, "bookings.override")) throw new BookingConflictError("session_full");
  const offered = await offerEntry(ctx, entry, session, rules, input.claimWindowMinutes ? { claimWindowMinutes: input.claimWindowMinutes } : {});
  if (!offered) throw new BookingConflictError("outside_window", { reason: "offer_cutoff" });
  return { offerExpiresAt: offered.offerExpiresAt };
}

/** R49 staff: another queue and/or another `joined_at` (reorder). */
export async function moveEntryRow(tx: Tx, ctx: Ctx, input: { entryId: string; queue?: WaitlistQueue; joinedAt?: Date }): Promise<{ entryId: string }> {
  const { entry, session } = await lockEntryAndSession(tx, input.entryId);
  if (entry.state === "confirmed") throw new ProtectedSeatError({ entryId: entry.id });
  const queue = input.queue ?? entry.queue;
  const joinedAt = input.joinedAt ?? entry.joinedAt;
  const row = await setEntry(ctx, entry.id, { queue, joinedAt });
  await recordWaitlistFact(ctx, "waitlist.requeued", row, session, {
    from: entry.queue,
    to: queue,
    reason: "staff",
    qualifier: `${queue}:${joinedAt.toISOString().slice(0, 16)}`,
  });
  return { entryId: entry.id };
}

/** R49 staff: release a waiting or offered entry (`released`, reason `staff`). */
export async function releaseEntryRow(tx: Tx, ctx: Ctx, input: { entryId: string }): Promise<{ state: WaitlistState }> {
  const { entry, session } = await lockEntryAndSession(tx, input.entryId);
  if (entry.state === "confirmed") throw new ProtectedSeatError({ entryId: entry.id });
  if (entry.state === "released") return { state: "released" };
  if (entry.state === "offered" && entry.bookingId) throw new BookingConflictError("invalid_transition", { reason: "claimed" });
  const row = await endEntry(ctx, entry, session, "released", "staff");
  return { state: row.state };
}

/** R48, R49 staff: clear a duplicate flag (the entry gets offers again) or withdraw it (`flag_withdrawn`). */
export async function reviewFlagRow(
  tx: Tx,
  ctx: Ctx,
  input: { entryId: string; decision: "clear" | "withdraw" },
): Promise<{ state: WaitlistState; isFlagged: boolean }> {
  const { entry, session } = await lockEntryAndSession(tx, input.entryId);
  if (entry.state === "confirmed") throw new ProtectedSeatError({ entryId: entry.id });
  const reviewer = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
  if (input.decision === "clear") {
    const row = await setEntry(ctx, entry.id, { isFlaggedDuplicate: false, flagReviewedByUserId: reviewer, flagReviewedAt: ctx.now });
    if (row.state === "waiting") await enqueueOfferNext(ctx, session.id, `${entry.id}:flag_cleared:${entry.rejoinCount}`);
    return { state: row.state, isFlagged: false };
  }
  await setEntry(ctx, entry.id, { flagReviewedByUserId: reviewer, flagReviewedAt: ctx.now });
  const row = await endEntry(ctx, entry, session, "withdrawn", "flag_withdrawn");
  return { state: row.state, isFlagged: row.isFlaggedDuplicate };
}

// ---------------------------------------------------------------------------
// The claim (R43, R44)
// ---------------------------------------------------------------------------

export type ClaimResult = { bookingId: string } | { orderId: string; redirectTo: string };

/** A paid claim needs the entry person's portal session (R44); nothing changes until then. */
export class SignInRequiredError extends AppError {
  override readonly name: string = "SignInRequiredError";
  constructor() {
    super("unauthorized", "sign_in_required");
  }
}

/** The entry of a claim token (no lock), or null for an unknown or superseded token. */
export async function entryByToken(db: DbOrTx, token: string): Promise<EntryRow | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db.select().from(waitlistEntries).where(eq(waitlistEntries.claimTokenHash, hashToken(token)));
  return row ?? null;
}

/** The order of a reserved booking (null when the row has no line yet). */
async function orderOfBooking(tx: DbOrTx, bookingId: string): Promise<string | null> {
  const [row] = await tx
    .select({ orderId: orders.id })
    .from(bookings)
    .innerJoin(orderLines, eq(orderLines.id, bookings.orderLineId))
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(bookings.id, bookingId));
  return row?.orderId ?? null;
}

/** Edge case: a second POST with the same token returns the booking (or checkout) of the first. */
async function existingClaim(tx: DbOrTx, entry: EntryRow, locale: Locale): Promise<ClaimResult | null> {
  if (!entry.bookingId) return null;
  const [b] = await tx.select({ id: bookings.id, status: bookings.status }).from(bookings).where(eq(bookings.id, entry.bookingId));
  if (!b) return null;
  if (b.status === "confirmed" || b.status === "attended" || b.status === "no_show") return { bookingId: b.id };
  if (b.status === "reserved") {
    const orderId = await orderOfBooking(tx, b.id);
    if (orderId) return { orderId, redirectTo: `/${URL_SEGMENT[locale]}/account/checkout/${orderId}` };
  }
  return null;
}

/** How the claimed seat is paid: credits when the person has them, free when free, else an order (R44). */
async function claimPayment(tx: DbOrTx, session: SessionRow, personId: string, payWith: "credit" | "order" | undefined): Promise<"credit" | "order" | "free"> {
  const free = !session.productId && (session.creditKind === null || session.creditCost === 0);
  if (free) return "free";
  if (session.creditKind && session.creditCost > 0 && payWith !== "order") {
    const check = await checkCredits(tx, { personId, beneficiaryPersonId: personId, kind: session.creditKind, units: session.creditCost, validAt: session.startsAt });
    if (check.ok) return "credit";
    if (payWith === "credit" || !session.productId) throw new BookingConflictError("insufficient_credits");
  }
  if (session.productId) return "order";
  throw new BookingConflictError("insufficient_credits");
}

/**
 * R44: claims the offered seat of `token` for the entry's person (never for the clicker, edge
 * case 10), under the session lock. Credit and free claims are `confirmed` at once and the entry
 * `confirmed`; an order claim (which needs the person's portal session, else
 * `SignInRequiredError`) inserts a `reserved` row with an order and sets `booking_id`, so the
 * seat counts as booked; `confirmBookingsForOrder` confirms both, a lapse expires the entry with
 * `payment_not_completed`. A second call returns the same booking or checkout. Expired and
 * superseded tokens are refused (`outside_window`), a closed session with `session_closed`.
 */
export async function claimSeatRow(tx: Tx, ctx: Ctx, input: { token: string; payWith?: "credit" | "order" }): Promise<ClaimResult> {
  const peek = await entryByToken(tx, input.token);
  if (!peek) throw new BookingConflictError("outside_window", { claim: "invalid" });
  const { entry, session } = await lockEntryAndSession(tx, peek.id);
  if (entry.claimTokenHash !== hashToken(input.token)) throw new BookingConflictError("outside_window", { claim: "superseded" });
  const [person] = await tx.select({ locale: persons.locale }).from(persons).where(eq(persons.id, entry.personId));
  const locale = person?.locale ?? ctx.locale;

  const repeat = await existingClaim(tx, entry, locale);
  if (repeat) return repeat;
  if (entry.state !== "offered" || !entry.offerExpiresAt || entry.offerExpiresAt.getTime() <= ctx.now.getTime()) {
    throw new BookingConflictError("outside_window", { claim: "expired" });
  }
  if (session.status !== "open") throw new BookingConflictError("session_closed");
  if (session.startsAt.getTime() <= ctx.now.getTime()) throw new BookingConflictError("outside_window");
  if (session.isMemberOnly && !(await viewerFor(tx, session, entry.personId)).isMember) throw new BookingConflictError("member_only");
  const [live] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), eq(bookings.personId, entry.personId), inArray(bookings.status, [...LIVE_STATUSES])));
  if (live) throw new AlreadyBookedError();

  const rules: BookingRules = await getSetting(tx, "booking_rules");
  if (rules.require_health_declaration && (session.kind === "day" || session.kind === "night")) {
    const health = await hasValidSubmission(tx, { personId: entry.personId, formSlug: HEALTH_DECLARATION_FORM });
    if (!health.valid) throw new BookingConflictError("health_declaration_required");
  }

  const paidWith = await claimPayment(tx, session, entry.personId, input.payWith);
  if (paidWith === "order" && !(ctx.actor.kind === "customer" && ctx.actor.personId === entry.personId)) throw new SignInRequiredError();

  // The live offer held this seat, so no capacity re-check: the booking takes the offer's place.
  const status = paidWith === "order" ? "reserved" : "confirmed";
  bookingTransition(null, status, waitlistActor(ctx));
  let booking: BookingRow;
  try {
    const [row] = await tx
      .insert(bookings)
      .values({
        sessionId: session.id,
        personId: entry.personId,
        status,
        paidWith,
        bookedByPersonId: entry.personId,
        source: "waitlist",
        reservedUntil: status === "reserved" ? new Date(ctx.now.getTime() + PROVISIONAL_RESERVATION_MS) : null,
      })
      .returning();
    booking = row!;
  } catch (error) {
    const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
    if (e?.code === "23505" || e?.cause?.code === "23505") throw new AlreadyBookedError();
    throw error;
  }

  if (paidWith === "credit") {
    try {
      await consumeCredits(tx, ctx, {
        personId: entry.personId,
        beneficiaryPersonId: entry.personId,
        kind: session.creditKind!,
        units: session.creditCost,
        ref: { type: "booking", id: booking.id },
        validAt: session.startsAt,
      });
    } catch (error) {
      throw mapCreditError(error);
    }
  }

  let orderId: string | null = null;
  if (paidWith === "order") {
    const order = await createOrder(tx, ctx, {
      personId: entry.personId,
      channel: "portal",
      items: [{ productId: session.productId!, quantity: 1, sessionId: session.id, bookingIds: [booking.id] }],
      promoCode: null,
      clientKey: randomUUID(),
      locale,
    });
    orderId = order.orderId;
    const [linked] = await linkOrderLines(tx, [booking], order.lineIds);
    booking = { ...booking, orderLineId: linked!.orderLineId, reservedUntil: linked!.reservedUntil };
  }

  const claimed = status === "confirmed" ? transition(toLike(entry), "confirmed", waitlistActor(ctx)) : null;
  await setEntry(ctx, entry.id, claimed ? { bookingId: booking.id, state: "confirmed" } : { bookingId: booking.id });
  await recordBookingFact(ctx, status === "reserved" ? "booking.reserved" : "booking.confirmed", booking, { by: "customer", queue: entry.queue });
  if (claimed) {
    await recordWaitlistFact(ctx, "waitlist.confirmed", entry, session, { booking_id: booking.id, paid_with: paidWith });
    const fileId = await renderCheckinQr(ctx, booking);
    await sendWaitlistEmail(
      ctx,
      "booking.seat_claimed",
      entry.personId,
      session,
      `booking:${booking.id}:confirmed`,
      (l) => ({ url: appUrl(`/${URL_SEGMENT[l]}/account/bookings/${booking.id}`) }),
      [qrAttachment(fileId)],
    );
    return { bookingId: booking.id };
  }
  return { orderId: orderId!, redirectTo: `/${URL_SEGMENT[locale]}/account/checkout/${orderId}` };
}

/** Offers that are live right now (`offered`, not expired, not claimed) of one person. */
export async function openOffersOf(db: DbOrTx, personId: string, now: Date = new Date()) {
  return db
    .select({ entryId: waitlistEntries.id, sessionId: sessions.id, title: sessions.title, startsAt: sessions.startsAt, offerExpiresAt: waitlistEntries.offerExpiresAt })
    .from(waitlistEntries)
    .innerJoin(sessions, eq(sessions.id, waitlistEntries.sessionId))
    .where(
      and(
        eq(waitlistEntries.personId, personId),
        eq(waitlistEntries.state, "offered"),
        gt(waitlistEntries.offerExpiresAt, now),
        sql`${waitlistEntries.bookingId} is null`,
        or(eq(sessions.status, "open"), eq(sessions.status, "closed")),
      ),
    )
    .orderBy(waitlistEntries.offerExpiresAt);
}

/**
 * R44 "Sign in to pay": platform's magic link (`platform.magic_link`, the same token store and
 * verify page as `requestMagicLink`) to the entry person's own email, with the callback
 * `/<locale>/claim/<token>`. Always answers `{ sent: true }` (no address is revealed); a person
 * without an email, a staff address or an unknown token gets nothing.
 */
export async function sendClaimSignInLink(tx: Tx, ctx: Ctx, input: { token: string }): Promise<{ sent: true }> {
  const entry = await entryByToken(tx, input.token);
  if (!entry || entry.state !== "offered") return { sent: true };
  const [person] = await tx.select({ email: persons.email, locale: persons.locale }).from(persons).where(eq(persons.id, entry.personId));
  if (!person?.email) return { sent: true };
  const email = person.email.trim().toLowerCase();
  const [user] = await tx.select({ audience: users.audience, status: users.status }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (user && (user.audience === "staff" || user.status !== "active")) return { sent: true };
  const seg = URL_SEGMENT[person.locale];
  const { token, hashed } = await createVerificationToken(tx, email, MAGIC_LINK_MINUTES * 60_000, ctx.now);
  const params = new URLSearchParams({ token, email, callbackUrl: `/${seg}/claim/${input.token}` });
  await sendTransactional(ctx, {
    template: "platform.magic_link",
    to: email,
    personId: entry.personId,
    locale: person.locale,
    data: { url: appUrl(`/${seg}/account/login/verify?${params.toString()}`), expiresMinutes: MAGIC_LINK_MINUTES },
    key: `magic_link:${hashed}`,
  });
  return { sent: true };
}
