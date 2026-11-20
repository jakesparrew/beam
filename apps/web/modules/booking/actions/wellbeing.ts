"use server";
/**
 * booking server actions, area `wellbeing`: a guest saves a check-in (energy, sleep, calm, mood
 * on 1-5 and an optional note) before or after one of their own visits, or once a day. Saving the
 * same moment again updates it. Not audited: it is the guest's own self-reported wellbeing.
 */
import { z } from "zod";
import { brusselsDate } from "@beam/core/booking";
import { ForbiddenError } from "@beam/core/errors";
import { bookings, sessions, wellbeingCheckins } from "@beam/db/schema";
import { action } from "@/lib/action";
import { and, eq, NotFoundError, sql } from "@/lib/ctx";

const Score = z.coerce.number().int().min(1).max(5);

const SaveCheckinInput = z.object({
  moment: z.enum(["before", "after", "daily"]),
  bookingId: z.uuid().optional(),
  energy: Score,
  sleep: Score.optional(),
  calm: Score,
  mood: Score,
  note: z.string().trim().max(500).optional(),
});

export const saveCheckin = action(
  { name: "booking.save_checkin", audience: "customer", input: SaveCheckinInput, audit: false },
  async (ctx, input): Promise<{ id: string }> => {
    if (ctx.actor.kind !== "customer") throw new ForbiddenError("forbidden: customer");
    const personId = ctx.actor.personId;
    let onDate = brusselsDate(ctx.now);
    let bookingId: string | null = null;
    if (input.moment !== "daily") {
      if (!input.bookingId) throw new NotFoundError("booking_not_found");
      const [b] = await ctx.tx
        .select({ id: bookings.id, startsAt: sessions.startsAt })
        .from(bookings)
        .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
        .where(and(eq(bookings.id, input.bookingId), eq(bookings.personId, personId)));
      if (!b) throw new NotFoundError("booking_not_found");
      bookingId = b.id;
      onDate = brusselsDate(b.startsAt);
    }
    const values = {
      personId,
      bookingId,
      moment: input.moment,
      onDate,
      energy: input.energy,
      sleep: input.sleep ?? null,
      calm: input.calm,
      mood: input.mood,
      note: input.note || null,
    };
    const scores = { energy: values.energy, sleep: values.sleep, calm: values.calm, mood: values.mood, note: values.note, updatedAt: ctx.now };
    const [row] =
      bookingId === null
        ? await ctx.tx
            .insert(wellbeingCheckins)
            .values(values)
            .onConflictDoUpdate({ target: [wellbeingCheckins.personId, wellbeingCheckins.onDate], targetWhere: sql`${wellbeingCheckins.moment} = 'daily'`, set: scores })
            .returning({ id: wellbeingCheckins.id })
        : await ctx.tx
            .insert(wellbeingCheckins)
            .values(values)
            .onConflictDoUpdate({ target: [wellbeingCheckins.bookingId, wellbeingCheckins.moment], targetWhere: sql`${wellbeingCheckins.bookingId} is not null`, set: scores })
            .returning({ id: wellbeingCheckins.id });
    return { id: row!.id };
  },
);
