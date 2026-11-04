/**
 * Waitlist state machine and offer selection (booking spec 3.7, R40-R47, R24-R25). Pure.
 * A `confirmed` entry is terminal and protected: no actor, least of all `system`, changes it.
 */
import { BookingConflictError, InvalidTransitionError, ProtectedSeatError } from "./errors";
import { DEFAULT_BOOKING_RULES, type BookingRules } from "./rules";
import type { ActorKind, LeadPhase, WaitlistQueue, WaitlistState } from "./types";

export type WaitlistLike = {
  id: string;
  personId: string;
  queue: WaitlistQueue;
  state: WaitlistState;
  joinedAt: Date;
  offersCount: number;
  rejoinCount: number;
  isFlaggedDuplicate: boolean;
  /** A `WaitlistEndedReason`; typed as text like the column. */
  endedReason: string | null;
};

/** R41: allowed waitlist transitions (`expired | released | withdrawn -> waiting` is the rejoin). */
export const WAITLIST_TRANSITIONS: Readonly<Record<WaitlistState, readonly WaitlistState[]>> = {
  waiting: ["offered", "withdrawn", "released"],
  offered: ["confirmed", "expired", "released", "withdrawn"],
  expired: ["waiting"],
  released: ["waiting"],
  withdrawn: ["waiting"],
  confirmed: [],
};

/** R40: entries ended for these reasons can never rejoin. */
export const NO_REJOIN_REASONS: readonly string[] = ["session_started", "session_cancelled", "flag_withdrawn"];

/** At most one rejoin per entry (R40). */
export const MAX_REJOINS = 1;

/**
 * Moves an entry to `to` and returns the updated entry. Throws `ProtectedSeatError` for any
 * change of a `confirmed` entry, `InvalidTransitionError` for a pair outside R41 or a rejoin
 * after `session_started`, `session_cancelled` or `flag_withdrawn`, and `conflict`
 * `already_waiting` for a second rejoin. An offer counts `offers_count + 1`; a rejoin counts
 * `rejoin_count + 1` and resets the flag and the ended reason (the flag is re-evaluated, R48).
 */
export function transition(entry: WaitlistLike, to: WaitlistState, actor: ActorKind): WaitlistLike {
  if (entry.state === "confirmed") throw new ProtectedSeatError({ entryId: entry.id, actor });
  if (!WAITLIST_TRANSITIONS[entry.state].includes(to)) {
    throw new InvalidTransitionError(entry.state, to, { entity: "waitlist_entry", entryId: entry.id, actor });
  }
  if (to === "waiting") {
    if (entry.endedReason && NO_REJOIN_REASONS.includes(entry.endedReason)) {
      throw new InvalidTransitionError(entry.state, to, { entity: "waitlist_entry", entryId: entry.id, endedReason: entry.endedReason });
    }
    if (entry.rejoinCount >= MAX_REJOINS) throw new BookingConflictError("already_waiting", { entryId: entry.id });
    return { ...entry, state: "waiting", rejoinCount: entry.rejoinCount + 1, isFlaggedDuplicate: false, endedReason: null };
  }
  if (to === "offered") return { ...entry, state: "offered", offersCount: entry.offersCount + 1 };
  return { ...entry, state: to };
}

const byJoined = (a: WaitlistLike, b: WaitlistLike) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.id.localeCompare(b.id);
const QUEUE_ORDER_PUBLIC: readonly WaitlistQueue[] = ["customer", "lead", "public"];

/**
 * R42 with R24-R25: the next `limit` entries to offer a seat from `pool`. Only `waiting`,
 * unflagged entries whose person has had fewer than `max_offers_per_person_per_session` offers
 * qualify. Lead pool: the `lead` queue (only while lead seats exist, phases `lead` to `public`).
 * General pool: every queue by `joined_at` before and during the lead window; only the `customer`
 * queue in `customer_release`; customer, then lead, then public queue after public release.
 */
export function nextOfferCandidates(
  entries: WaitlistLike[],
  phase: LeadPhase,
  pool: "lead" | "general",
  limit: number,
  opts: { maxOffersPerPerson?: number; rules?: BookingRules } = {},
): WaitlistLike[] {
  if (limit <= 0) return [];
  const maxOffers = opts.maxOffersPerPerson ?? (opts.rules ?? DEFAULT_BOOKING_RULES).waitlist.max_offers_per_person_per_session;
  const eligible = entries.filter((e) => e.state === "waiting" && !e.isFlaggedDuplicate && e.offersCount < maxOffers);

  let ordered: WaitlistLike[];
  if (pool === "lead") {
    ordered = phase === "none" || phase === "pre" ? [] : eligible.filter((e) => e.queue === "lead").sort(byJoined);
  } else if (phase === "customer_release") {
    ordered = eligible.filter((e) => e.queue === "customer").sort(byJoined);
  } else if (phase === "public") {
    ordered = QUEUE_ORDER_PUBLIC.flatMap((q) => eligible.filter((e) => e.queue === q).sort(byJoined));
  } else {
    ordered = [...eligible].sort(byJoined);
  }
  return ordered.slice(0, limit);
}

/**
 * R42: `least(now + claim window, starts_at - offer_cutoff_minutes_before_start)`, or null when
 * that leaves less than `min_claim_minutes` (no offer is made).
 */
export function offerExpiry(now: Date, startsAt: Date, claimWindowMinutes: number, rules: BookingRules): Date | null {
  const byWindow = now.getTime() + claimWindowMinutes * 60_000;
  const byCutoff = startsAt.getTime() - rules.waitlist.offer_cutoff_minutes_before_start * 60_000;
  const expires = Math.min(byWindow, byCutoff);
  if (expires < now.getTime() + rules.waitlist.min_claim_minutes * 60_000) return null;
  return new Date(expires);
}

/** The 1-based position of an entry within its own queue (R27), or null when not waiting. */
export function queuePosition(entry: WaitlistLike, entries: WaitlistLike[]): number | null {
  if (entry.state !== "waiting") return null;
  const queue = entries.filter((e) => e.state === "waiting" && e.queue === entry.queue).sort(byJoined);
  const i = queue.findIndex((e) => e.id === entry.id);
  return i < 0 ? null : i + 1;
}
