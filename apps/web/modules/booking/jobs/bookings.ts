/**
 * Booking jobs (booking spec 4.5, R18, R33, R60): `bookings.expire_reservations`,
 * `bookings.send_reminders`, `sessions.cancel_bookings`. Registered in `../jobs.ts` (booking-P1)
 * with these names, inputs and signatures. Every handler is idempotent: running it twice with
 * the same payload leaves the same state (`jobs/bookings.test.ts`).
 */
import { z } from "zod";
import { bookings, emailMessages, persons, sessions } from "@beam/db/schema";
import type { BookingRules, SessionKind } from "@beam/core/booking";
import { URL_SEGMENT, formatDateTime, pick } from "@beam/core/i18n";
import { PermanentError, type JobCtx } from "@/lib/job-runner";
import { and, asc, eq, gt, inArray, isNotNull, sql } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { sendTransactional } from "@/modules/email/api";
import { cancelSessionChunk, cancelSessionJobKey, expireReservedRow, expiredReservationIds } from "../server/cancel";
import { qrAttachment, renderCheckinQr } from "../server/qr";

export const ExpireReservationsInput = z.object({});
export const SendRemindersInput = z.object({});
/**
 * R33 chunks of 50 bookings; key `cancel_session:<session_id>:<afterBookingId or start>`.
 * `notify` (default true) carries `cancelSession`'s choice to every chunk.
 */
export const CancelSessionBookingsInput = z.object({ sessionId: z.uuid(), afterBookingId: z.uuid().optional(), notify: z.boolean().default(true) });

/** Rows handled per run (the next run, a minute later, takes the rest). */
const EXPIRE_BATCH = 200;
const REMINDER_BATCH = 500;

const appUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;

/** R18 safety net: cancels `reserved` rows past `reserved_until` whose order is not paid (pay at desk: `ends_at`). */
export async function runExpireReservations(ctx: JobCtx, _input: z.infer<typeof ExpireReservationsInput>): Promise<{ expired: number }> {
  const ids = await expiredReservationIds(ctx.tx, ctx.now, EXPIRE_BATCH);
  let expired = 0;
  for (const id of ids) if (await expireReservedRow(ctx.tx, ctx, id)) expired++;
  return { expired };
}

/** The reminder kinds of R60: day and night (event reminders are automation's `event-registration` sequence). */
const REMINDER_KINDS: ReadonlyArray<Extract<SessionKind, "day" | "night">> = ["day", "night"];

/**
 * R60: per offset `h` of `reminder_hours_before[kind]`, one `booking.booking_reminder` to each
 * `confirmed` day or night booking with `starts_at - h <= now < starts_at`, only when the
 * booking was created before `starts_at - h` (late-entry skip). Key `booking:<id>:reminder:<h>`.
 */
export async function runSendReminders(ctx: JobCtx, _input: z.infer<typeof SendRemindersInput>): Promise<{ sent: number }> {
  const rules: BookingRules = await getSetting(ctx.tx, "booking_rules");
  const now = ctx.now;
  let sent = 0;
  for (const kind of REMINDER_KINDS) {
    for (const h of [...new Set(rules.reminder_hours_before[kind])].sort((a, b) => a - b)) {
      const offset = sql`make_interval(hours => ${h})`;
      const key = sql`'booking:' || ${bookings.id}::text || ':reminder:' || ${String(h)}`;
      const due = await ctx.tx
        .select({ booking: bookings, title: sessions.title, startsAt: sessions.startsAt, email: persons.email, locale: persons.locale })
        .from(bookings)
        .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
        .innerJoin(persons, eq(persons.id, bookings.personId))
        .where(
          and(
            eq(bookings.status, "confirmed"),
            eq(sessions.kind, kind),
            inArray(sessions.status, ["open", "closed"]),
            gt(sessions.startsAt, now),
            sql`${sessions.startsAt} - ${offset} <= ${now.toISOString()}::timestamptz`,
            sql`${bookings.createdAt} < ${sessions.startsAt} - ${offset}`,
            isNotNull(persons.email),
            sql`not exists (select 1 from ${emailMessages} m where m.idempotency_key = ${key})`,
          ),
        )
        .orderBy(asc(sessions.startsAt), asc(bookings.id))
        .limit(REMINDER_BATCH);
      for (const row of due) {
        const locale = row.locale;
        const fileId = await renderCheckinQr(ctx, row.booking);
        await sendTransactional(ctx, {
          template: "booking.booking_reminder",
          personId: row.booking.personId,
          locale,
          data: {
            title: pick(row.title, locale, "session title"),
            date: formatDateTime(row.startsAt, locale, "full"),
            url: appUrl(`/${URL_SEGMENT[locale]}/account/bookings/${row.booking.id}`),
            kind,
          },
          key: `booking:${row.booking.id}:reminder:${h}`,
          attachments: [qrAttachment(fileId)],
        });
        // Derived marker, not a state change: no version bump.
        await ctx.tx.update(bookings).set({ reminderSentAt: now }).where(eq(bookings.id, row.booking.id));
        sent++;
      }
    }
  }
  return { sent };
}

/** R33: cancels the live bookings of a cancelled session in chunks of 50; self-continues. */
export async function runCancelSessionBookings(
  ctx: JobCtx,
  input: z.infer<typeof CancelSessionBookingsInput>,
): Promise<{ cancelledBookings: number; refundsRequested: number; next: string | null }> {
  const [session] = await ctx.tx.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, input.sessionId));
  if (!session) throw new PermanentError(`sessions.cancel_bookings: unknown session ${input.sessionId}`);
  if (session.status !== "cancelled") throw new PermanentError(`sessions.cancel_bookings: session ${input.sessionId} is not cancelled`);
  const chunk = await cancelSessionChunk(ctx.tx, ctx, { sessionId: input.sessionId, afterBookingId: input.afterBookingId, notify: input.notify });
  if (chunk.nextAfterBookingId) {
    await ctx.enqueue({
      kind: "sessions.cancel_bookings",
      payload: { sessionId: input.sessionId, afterBookingId: chunk.nextAfterBookingId, notify: input.notify },
      key: cancelSessionJobKey(input.sessionId, chunk.nextAfterBookingId),
    });
  }
  return { cancelledBookings: chunk.cancelledBookings, refundsRequested: chunk.refundsRequested, next: chunk.nextAfterBookingId };
}
