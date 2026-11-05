"use server";
/**
 * booking server actions, area `lead` (booking spec 4.2, 3.4, R20-R27; booking-P7, R2 behind
 * `ff_booking_lead_priority`): `configureLeadMagnet` turns an event into a Lead Magnet (or back)
 * with its lead-reserved seats (a number, or a percentage of the capacity rounded down), the lead
 * window as Europe/Brussels wall-clock times (converted DST-safe), the release rule, the optional
 * public release time, the claim window and whether waiting customers see their queue position.
 * Staff with `bookings.override`; audited by the `action()` wrapper. A "use server" file exports
 * async functions only, so the Zod input stays unexported.
 */
import { z } from "zod";
import { sessions } from "@beam/db/schema";
import { InvalidTransitionError, LEAD_RELEASE_RULES, localDateTimeToUtc } from "@beam/core/booking";
import { ForbiddenError } from "@beam/core/errors";
import { action } from "@/lib/action";
import { ValidationError, eq } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { lockSession } from "../server/book";

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/);

const ConfigureLeadMagnetInput = z.object({
  sessionId: z.uuid(),
  isLeadMagnet: z.boolean(),
  leadReservedSeats: z.number().int().min(0).max(100_000).optional(),
  leadReservedPct: z.number().min(0).max(100).optional(),
  leadWindowStartLocal: localDateTime.optional(),
  leadWindowEndLocal: localDateTime.optional(),
  releaseRule: z.enum(LEAD_RELEASE_RULES).default("customers_then_public"),
  publicReleaseLocal: localDateTime.nullish(),
  claimWindowMinutes: z.number().int().min(10).max(2880).default(120),
  isWaitlistPositionVisible: z.boolean().default(false),
});

type Input = z.infer<typeof ConfigureLeadMagnetInput>;

/** A Brussels wall-clock input as an instant; a time that does not parse is a field error. */
function instant(local: string, field: string): Date {
  try {
    const d = localDateTimeToUtc(local);
    if (Number.isNaN(d.getTime())) throw new RangeError(local);
    return d;
  } catch {
    throw new ValidationError("invalid_local_time", { [field]: "invalid" });
  }
}

/** R20-R27 settings of one session, validated (edge case 26: no window in the past or reversed). */
function leadColumns(input: Input, session: { capacitySeats: number | null; capacityBeds: number | null; startsAt: Date }, now: Date) {
  const capacity = session.capacityBeds ?? session.capacitySeats ?? 0;
  const base = { claimWindowMinutes: input.claimWindowMinutes, isWaitlistPositionVisible: input.isWaitlistPositionVisible, leadReleaseRule: input.releaseRule };
  if (!input.isLeadMagnet) return { ...base, isLeadMagnet: false, leadReservedSeats: 0 };

  if ((input.leadReservedSeats === undefined) === (input.leadReservedPct === undefined)) {
    throw new ValidationError("lead_seats_required", { leadReservedSeats: "one_of_seats_or_pct" });
  }
  // Rounded down, so a percentage never reserves more seats than it says.
  const seats = input.leadReservedSeats ?? Math.floor((capacity * input.leadReservedPct!) / 100 + 1e-9);
  if (seats > capacity) throw new ValidationError("lead_seats_above_capacity", { leadReservedSeats: "above_capacity" });

  if (!input.leadWindowStartLocal) throw new ValidationError("lead_window_required", { leadWindowStartLocal: "required" });
  if (!input.leadWindowEndLocal) throw new ValidationError("lead_window_required", { leadWindowEndLocal: "required" });
  const start = instant(input.leadWindowStartLocal, "leadWindowStartLocal");
  const end = instant(input.leadWindowEndLocal, "leadWindowEndLocal");
  if (end.getTime() <= start.getTime()) throw new ValidationError("lead_window_reversed", { leadWindowEndLocal: "before_start" });
  if (end.getTime() <= now.getTime()) throw new ValidationError("lead_window_past", { leadWindowEndLocal: "in_past" });
  if (end.getTime() > session.startsAt.getTime()) throw new ValidationError("lead_window_after_start", { leadWindowEndLocal: "after_session_start" });

  let publicReleaseAt: Date | null = null;
  if (input.publicReleaseLocal) {
    publicReleaseAt = instant(input.publicReleaseLocal, "publicReleaseLocal");
    if (publicReleaseAt.getTime() < end.getTime()) throw new ValidationError("public_release_before_window_end", { publicReleaseLocal: "before_window_end" });
    if (publicReleaseAt.getTime() > session.startsAt.getTime()) throw new ValidationError("public_release_after_start", { publicReleaseLocal: "after_session_start" });
  }
  return { ...base, isLeadMagnet: true, leadReservedSeats: seats, leadWindowStartAt: start, leadWindowEndAt: end, publicReleaseAt };
}

/** R20-R27 (`booking.configure_lead_magnet`): configures the Lead Magnet access of an event. */
export const configureLeadMagnet = action(
  {
    name: "booking.configure_lead_magnet",
    audience: "staff",
    permission: "bookings.override",
    input: ConfigureLeadMagnetInput,
    audit: { entityType: "session", entityId: (i) => i.sessionId },
  },
  async (ctx, input): Promise<{ sessionId: string }> => {
    if (!(await flag("ff_booking_lead_priority", ctx.actor))) throw new ForbiddenError("forbidden: ff_booking_lead_priority");
    const session = await lockSession(ctx.tx, input.sessionId);
    if (session.status === "cancelled") throw new InvalidTransitionError("cancelled", "cancelled", { entity: "session", reason: "cancelled_session_is_read_only" });
    if (session.webinarId) throw new ValidationError("webinar_session", { sessionId: "webinar_session" });
    if (input.isLeadMagnet && session.kind !== "event") throw new ValidationError("lead_magnet_needs_event", { sessionId: "not_an_event" });
    if (input.isLeadMagnet && session.startsAt.getTime() <= ctx.now.getTime()) throw new ValidationError("session_started", { sessionId: "started" });
    const values = leadColumns(input, session, ctx.now);
    await ctx.tx
      .update(sessions)
      .set({ ...values, updatedAt: ctx.now })
      .where(eq(sessions.id, session.id));
    return { sessionId: session.id };
  },
);
