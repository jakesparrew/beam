/**
 * Waitlist jobs (booking spec 4.5, R42, R44, R45, R47): `waitlist.expire_offers` and
 * `waitlist.offer_next`. Registered in `../jobs.ts` (booking-P1); booking-P5 implements the
 * handlers; booking-P7 adds the lead-window release (R24b) and the lead requeue (R26). No job
 * ever changes a `confirmed` entry: every change goes through `transition()`, which throws
 * `ProtectedSeatError`, and every select reads only `waiting` or `offered` rows. Both handlers
 * are idempotent on state: a second run with the same payload finds nothing left to do.
 */
import { z } from "zod";
import { jobs as jobsTable, sessions, vSessionAvailability, waitlistEntries } from "@beam/db/schema";
import { nextOfferCandidates, type BookingRules } from "@beam/core/booking";
import { and, eq, gt, inArray, lte, sql, type Ctx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { getSetting } from "@/lib/settings";
import { lockSession, readAvailabilityRow } from "../server/book";
import { endEntry, enqueueOfferNext, expireOffer, expireUnpaidClaims, lockEntryAndSession, offerEntry, toLike } from "../server/claim";

export const ExpireOffersInput = z.object({});
/** Key `waitlist:<session_id>:offer_next:<trigger>` (booking id, entry id, hold id, `release:<phase>` or `<minute>`). */
export const OfferNextInput = z.object({ sessionId: z.uuid(), trigger: z.string().min(1).optional() });

/** Rows handled per run of each step (the next minute continues). */
export const EXPIRE_BATCH = 200;

export type OfferNextResult = { offered: string[]; onScreenOnly: string[]; skipped: "not_open" | "started" | "no_capacity" | "cutoff" | null };

/**
 * R42 under the session lock: while places are free and an eligible entry waits (unflagged,
 * fewer than `max_offers_per_person_per_session` offers), offer the next one in queue order.
 * Claimed entries whose booking lapsed are expired first (R44). Walk-ins without an email are
 * offered on screen only.
 */
export async function offerNextForSession(ctx: Ctx, sessionId: string): Promise<OfferNextResult> {
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
      const offered = await offerEntry(ctx, entry, session, rules);
      if (!offered) return { ...result, skipped: "cutoff" };
      taken.add(entry.id);
      result.offered.push(entry.id);
      if (!offered.emailed) result.onScreenOnly.push(entry.id);
    }
  }
  return result;
}

/** R42 job: `waitlist.offer_next { sessionId }`. */
export function runOfferNext(ctx: JobCtx, input: z.infer<typeof OfferNextInput>): Promise<OfferNextResult> {
  return offerNextForSession(ctx, input.sessionId);
}

export type ExpireOffersResult = { released: number; expired: number; unpaid: number; reEnqueued: string[] };

/**
 * R45, R47, R44 and the edge case 23 safety net, every minute:
 * 1. sessions that started: their `waiting` and unclaimed `offered` entries become `released`
 *    (`session_started`);
 * 2. unclaimed offers past `offer_expires_at` become `expired` (`offer_timeout`, email), and
 *    `waitlist.offer_next` is enqueued for their session;
 * 3. claimed offers whose booking is no longer live become `expired` (`payment_not_completed`);
 * 4. every open future session with free places and an unflagged waiting entry but no pending
 *    `offer_next` job gets one (key `waitlist:<session_id>:offer_next:<minute>`).
 */
export async function runExpireOffers(ctx: JobCtx, _input: z.infer<typeof ExpireOffersInput>): Promise<ExpireOffersResult> {
  const out: ExpireOffersResult = { released: 0, expired: 0, unpaid: 0, reEnqueued: [] };
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

  // 4. Edge case 23: re-enqueue `offer_next` where it is missing.
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
