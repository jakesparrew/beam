/**
 * Waitlist jobs (booking spec 4.5, R42, R44, R45, R47): `waitlist.expire_offers` and
 * `waitlist.offer_next`. Registered in `../jobs.ts` (booking-P1); booking-P5 implements the
 * handlers; booking-P7 adds the lead-window release (R24, R24b), the lead requeue (R26) and the
 * `booking.lead_window_open` offer email. No job ever changes a `confirmed` entry: every change
 * goes through `transition()`, which throws `ProtectedSeatError`, and every select reads only
 * `waiting` or `offered` rows. Both handlers are idempotent on state: a second run with the same
 * payload finds nothing left to do.
 */
import { z } from "zod";
import { jobs as jobsTable, persons, sessions, vPersonStatus, vSessionAvailability, waitlistEntries } from "@beam/db/schema";
import { BookingConflictError, claimToken, hashToken, nextOfferCandidates, offerExpiry, transition, type BookingRules, type LeadPhase } from "@beam/core/booking";
import { formatDateTime, pick } from "@beam/core/i18n";
import { and, eq, gt, inArray, lte, or, sql, type Ctx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { getSetting } from "@/lib/settings";
import { sendTransactional } from "@/modules/email/api";
import { lockSession, readAvailabilityRow, type SessionRow } from "../server/book";
import {
  MAX_OFFERS_PER_ENTRY,
  claimKey,
  claimUrl,
  endEntry,
  enqueueOfferNext,
  expireOffer,
  expireUnpaidClaims,
  lockEntryAndSession,
  offerEntry,
  recordWaitlistFact,
  toLike,
  waitlistActor,
  type EntryRow,
} from "../server/claim";

export const ExpireOffersInput = z.object({});
/** Key `waitlist:<session_id>:offer_next:<trigger>` (booking id, entry id, hold id, `release:<phase>` or `<minute>`). */
export const OfferNextInput = z.object({ sessionId: z.uuid(), trigger: z.string().min(1).optional() });

/** Rows handled per run of each step (the next minute continues). */
export const EXPIRE_BATCH = 200;

export type OfferNextResult = { offered: string[]; onScreenOnly: string[]; skipped: "not_open" | "started" | "no_capacity" | "cutoff" | null };

/** Lead phases after the window end; the R24b release runs carry the trigger `release:<phase>`. */
const RELEASE_PHASES = ["customer_release", "public"] as const satisfies readonly LeadPhase[];

/**
 * R24: an offer to a `customer` queue entry of a Lead Magnet at window end (phase
 * `customer_release`, or a `release:<phase>` run) uses `booking.lead_window_open`; every other
 * offer uses `booking.seat_offered` (booking-P5's `offerEntry`).
 */
function isLeadReleaseOffer(session: SessionRow, entry: EntryRow, phase: LeadPhase, trigger: string | undefined): boolean {
  return session.isLeadMagnet && entry.queue === "customer" && (phase === "customer_release" || !!trigger?.startsWith("release:"));
}

/**
 * `offerEntry` with the `booking.lead_window_open` email (R24): the same state change, claim
 * token, `waitlist.offered` fact, expiry and message key `waitlist:<entry_id>:offer:<offers_count>`.
 * Returns null when the cut-off leaves less than `min_claim_minutes`.
 */
async function offerLeadRelease(ctx: Ctx, entry: EntryRow, session: SessionRow, rules: BookingRules): Promise<{ entry: EntryRow; offerExpiresAt: Date; emailed: boolean } | null> {
  const expiresAt = offerExpiry(ctx.now, session.startsAt, session.claimWindowMinutes, rules);
  if (!expiresAt) return null;
  const next = transition(toLike(entry), "offered", waitlistActor(ctx));
  if (next.offersCount > MAX_OFFERS_PER_ENTRY) throw new BookingConflictError("invalid_transition", { reason: "max_offers" });
  const token = claimToken(claimKey(), entry.id, next.offersCount);
  const [row] = await ctx.tx
    .update(waitlistEntries)
    .set({
      state: "offered",
      offersCount: next.offersCount,
      offeredAt: ctx.now,
      offerExpiresAt: expiresAt,
      claimTokenHash: hashToken(token),
      bookingId: null,
      endedReason: null,
      updatedAt: ctx.now,
    })
    .where(eq(waitlistEntries.id, entry.id))
    .returning();
  const offered = row!;
  await recordWaitlistFact(ctx, "waitlist.offered", offered, session, { offer_expires_at: expiresAt, offers_count: offered.offersCount });
  const [person] = await ctx.tx.select({ email: persons.email, locale: persons.locale }).from(persons).where(eq(persons.id, entry.personId));
  if (!person?.email) return { entry: offered, offerExpiresAt: expiresAt, emailed: false };
  const locale = person.locale;
  await sendTransactional(ctx, {
    template: "booking.lead_window_open",
    personId: entry.personId,
    locale,
    data: {
      title: pick(session.title, locale, "session title"),
      date: formatDateTime(session.startsAt, locale, "full"),
      expiresAt: formatDateTime(expiresAt, locale, "full"),
      url: claimUrl(token),
    },
    key: `waitlist:${entry.id}:offer:${offered.offersCount}`,
  });
  return { entry: offered, offerExpiresAt: expiresAt, emailed: true };
}

/**
 * R42 under the session lock: while places are free and an eligible entry waits (unflagged,
 * fewer than `max_offers_per_person_per_session` offers), offer the next one in queue order.
 * Lead Magnets fill the lead pool from the `lead` queue first, then the general pool in the
 * phase's order (R24, R25: only the `customer` queue in `customer_release`; customer, lead,
 * public after public release). Claimed entries whose booking lapsed are expired first (R44).
 * Walk-ins without an email are offered on screen only.
 */
export async function offerNextForSession(ctx: Ctx, sessionId: string, trigger?: string): Promise<OfferNextResult> {
  const result: OfferNextResult = { offered: [], onScreenOnly: [], skipped: null };
  await expireUnpaidClaims(ctx, sessionId);
  const session = await lockSession(ctx.tx, sessionId);
  if (session.status !== "open" || session.webinarId) return { ...result, skipped: "not_open" };
  if (session.startsAt.getTime() <= ctx.now.getTime()) return { ...result, skipped: "started" };
  const rules: BookingRules = await getSetting(ctx.tx, "booking_rules");
  const row = await readAvailabilityRow(ctx.tx, session);
  const phase = session.isLeadMagnet ? row.leadPhase : "none";
  const entries = await ctx.tx
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.sessionId, session.id), eq(waitlistEntries.state, "waiting")))
    .for("update");
  const pools: Array<{ pool: "lead" | "general"; free: number }> = session.isLeadMagnet
    ? [
        { pool: "lead", free: row.leadReservedRemaining },
        { pool: "general", free: row.availableGeneral },
      ]
    : [{ pool: "general", free: row.availableTotal }];
  if (pools.every((p) => p.free <= 0)) return { ...result, skipped: "no_capacity" };

  const taken = new Set<string>();
  for (const { pool, free } of pools) {
    const left = entries.filter((e) => !taken.has(e.id)).map(toLike);
    const candidates = nextOfferCandidates(left, phase, pool, Math.max(0, free), { rules });
    for (const c of candidates) {
      const entry = entries.find((e) => e.id === c.id)!;
      const offered = isLeadReleaseOffer(session, entry, phase, trigger) ? await offerLeadRelease(ctx, entry, session, rules) : await offerEntry(ctx, entry, session, rules);
      if (!offered) return { ...result, skipped: "cutoff" };
      taken.add(entry.id);
      result.offered.push(entry.id);
      if (!offered.emailed) result.onScreenOnly.push(entry.id);
    }
  }
  return result;
}

/** R42 job: `waitlist.offer_next { sessionId, trigger? }`. */
export function runOfferNext(ctx: JobCtx, input: z.infer<typeof OfferNextInput>): Promise<OfferNextResult> {
  return offerNextForSession(ctx, input.sessionId, input.trigger);
}

/**
 * R26 (booking-P7): `waiting` entries in the `lead` queue of future sessions whose person is no
 * longer a lead (`v_person_status.status` customer or member, so a staff override counts) move to
 * the `customer` queue, keeping `joined_at`, in one set-based update; each moved entry writes
 * `waitlist.requeued` (`from = 'lead'`, `to = 'customer'`, `reason = 'status_changed'`). Offered
 * and confirmed entries never move; a customer corrected back to lead never moves back.
 */
export async function requeueFormerLeads(ctx: Ctx): Promise<string[]> {
  const movable = ctx.tx
    .select({ id: waitlistEntries.id })
    .from(waitlistEntries)
    .innerJoin(vPersonStatus, eq(vPersonStatus.personId, waitlistEntries.personId))
    .innerJoin(sessions, eq(sessions.id, waitlistEntries.sessionId))
    .where(
      and(
        eq(waitlistEntries.state, "waiting"),
        eq(waitlistEntries.queue, "lead"),
        inArray(vPersonStatus.status, ["customer", "member"]),
        gt(sessions.startsAt, ctx.now),
      ),
    )
    .orderBy(waitlistEntries.id)
    .limit(EXPIRE_BATCH);
  const moved = await ctx.tx
    .update(waitlistEntries)
    .set({ queue: "customer", updatedAt: ctx.now })
    .where(and(inArray(waitlistEntries.id, movable), eq(waitlistEntries.state, "waiting"), eq(waitlistEntries.queue, "lead")))
    .returning();
  if (!moved.length) return [];
  const sessionRows = await ctx.tx
    .select()
    .from(sessions)
    .where(inArray(sessions.id, [...new Set(moved.map((m) => m.sessionId))]));
  const byId = new Map(sessionRows.map((s) => [s.id, s]));
  for (const entry of moved) {
    await recordWaitlistFact(ctx, "waitlist.requeued", entry, byId.get(entry.sessionId)!, {
      from: "lead",
      to: "customer",
      reason: "status_changed",
      qualifier: "customer:status_changed",
    });
  }
  return moved.map((m) => m.id);
}

/**
 * R24b (booking-P7): every open future Lead Magnet whose `lead_window_end_at` or
 * `opens_for_public_at` lies in the last 24 hours gets `waitlist.offer_next` with the trigger
 * `release:<phase>` (key `waitlist:<session_id>:offer_next:release:<phase>`). The unique job key
 * makes the per-minute repetition a no-op; `offer_next` only offers what capacity allows.
 */
export async function enqueueLeadReleases(ctx: Ctx): Promise<Array<{ sessionId: string; phase: string }>> {
  const since = new Date(ctx.now.getTime() - 24 * 3_600_000);
  const due = await ctx.tx
    .select({ sessionId: sessions.id, phase: vSessionAvailability.leadPhase })
    .from(sessions)
    .innerJoin(vSessionAvailability, eq(vSessionAvailability.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.isLeadMagnet, true),
        eq(sessions.status, "open"),
        gt(sessions.startsAt, ctx.now),
        sql`${sessions.webinarId} is null`,
        inArray(vSessionAvailability.leadPhase, [...RELEASE_PHASES]),
        or(
          and(gt(sessions.leadWindowEndAt, since), lte(sessions.leadWindowEndAt, ctx.now)),
          and(gt(vSessionAvailability.opensForPublicAt, since), lte(vSessionAvailability.opensForPublicAt, ctx.now)),
        ),
      ),
    )
    .orderBy(sessions.id)
    .limit(EXPIRE_BATCH);
  for (const d of due) await enqueueOfferNext(ctx, d.sessionId, `release:${d.phase}`);
  return due;
}

export type ExpireOffersResult = { released: number; expired: number; unpaid: number; requeued: number; leadReleases: string[]; reEnqueued: string[] };

/**
 * R45, R47, R44, R26, R24b and the edge case 23 safety net, every minute:
 * 1. sessions that started: their `waiting` and unclaimed `offered` entries become `released`
 *    (`session_started`);
 * 2. unclaimed offers past `offer_expires_at` become `expired` (`offer_timeout`, email), and
 *    `waitlist.offer_next` is enqueued for their session;
 * 3. claimed offers whose booking is no longer live become `expired` (`payment_not_completed`);
 * 4. waiting leads who became customers move to the `customer` queue (R26);
 * 5. Lead Magnets at window end or public release get their `release:<phase>` offer run (R24b);
 * 6. every open future session with free places and an unflagged waiting entry but no pending
 *    `offer_next` job gets one (key `waitlist:<session_id>:offer_next:<minute>`).
 */
export async function runExpireOffers(ctx: JobCtx, _input: z.infer<typeof ExpireOffersInput>): Promise<ExpireOffersResult> {
  const out: ExpireOffersResult = { released: 0, expired: 0, unpaid: 0, requeued: 0, leadReleases: [], reEnqueued: [] };
  const tx = ctx.tx;

  // 1. R47: release at start.
  const started = await tx
    .select({ id: waitlistEntries.id })
    .from(waitlistEntries)
    .innerJoin(sessions, eq(sessions.id, waitlistEntries.sessionId))
    .where(
      and(
        lte(sessions.startsAt, ctx.now),
        inArray(waitlistEntries.state, ["waiting", "offered"]),
        sql`${waitlistEntries.bookingId} is null`,
      ),
    )
    .orderBy(waitlistEntries.id)
    .limit(EXPIRE_BATCH);
  for (const { id } of started) {
    const { entry, session } = await lockEntryAndSession(tx, id);
    if ((entry.state !== "waiting" && entry.state !== "offered") || entry.bookingId) continue;
    await endEntry(ctx, entry, session, "released", "session_started");
    out.released++;
  }

  // 2. R45: expire unclaimed offers.
  const due = await tx
    .select({ id: waitlistEntries.id })
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.state, "offered"), lte(waitlistEntries.offerExpiresAt, ctx.now), sql`${waitlistEntries.bookingId} is null`))
    .orderBy(waitlistEntries.offerExpiresAt, waitlistEntries.id)
    .limit(EXPIRE_BATCH);
  for (const { id } of due) {
    const { entry, session } = await lockEntryAndSession(tx, id);
    if (entry.state !== "offered" || entry.bookingId || !entry.offerExpiresAt || entry.offerExpiresAt.getTime() > ctx.now.getTime()) continue;
    await expireOffer(ctx, entry, session);
    out.expired++;
  }

  // 3. R44: claims whose reservation lapsed.
  out.unpaid = (await expireUnpaidClaims(ctx)).length;

  // 4. R26: former leads move to the customer queue.
  out.requeued = (await requeueFormerLeads(ctx)).length;

  // 5. R24b: window-end and public-release offer runs.
  out.leadReleases = (await enqueueLeadReleases(ctx)).map((d) => d.sessionId);

  // 6. Edge case 23: re-enqueue `offer_next` where it is missing.
  const candidates = await tx
    .selectDistinct({ sessionId: waitlistEntries.sessionId })
    .from(waitlistEntries)
    .innerJoin(sessions, eq(sessions.id, waitlistEntries.sessionId))
    .innerJoin(vSessionAvailability, eq(vSessionAvailability.sessionId, sessions.id))
    .where(
      and(
        eq(waitlistEntries.state, "waiting"),
        eq(waitlistEntries.isFlaggedDuplicate, false),
        eq(sessions.status, "open"),
        gt(sessions.startsAt, ctx.now),
        sql`${sessions.webinarId} is null`,
        gt(vSessionAvailability.availableTotal, 0),
      ),
    )
    .limit(EXPIRE_BATCH);
  const minute = ctx.now.toISOString().slice(0, 16);
  for (const { sessionId } of candidates) {
    const [pending] = await tx
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.kind, "waitlist.offer_next"),
          inArray(jobsTable.status, ["pending", "running", "failed"]),
          sql`${jobsTable.payload}->>'sessionId' = ${sessionId}`,
        ),
      )
      .limit(1);
    if (pending) continue;
    await enqueueOfferNext(ctx, sessionId, minute);
    out.reEnqueued.push(sessionId);
  }
  return out;
}
