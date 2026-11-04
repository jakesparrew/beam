/**
 * Booking jobs (booking spec 4.5, R18, R33, R60): `bookings.expire_reservations`,
 * `bookings.send_reminders`, `sessions.cancel_bookings`. Registered in `../jobs.ts` (booking-P1);
 * booking-P3b implements the handlers here and keeps their names, inputs and signatures. Until
 * then each handler is a no-op, so a scheduled run never dies.
 */
import { z } from "zod";
import type { JobCtx } from "@/lib/job-runner";

export const ExpireReservationsInput = z.object({});
export const SendRemindersInput = z.object({});
/** R33 chunks of 50 bookings; key `cancel_session:<session_id>:<afterBookingId or start>`. */
export const CancelSessionBookingsInput = z.object({ sessionId: z.uuid(), afterBookingId: z.uuid().optional() });

const notYet = (): Promise<{ implemented: false }> => Promise.resolve({ implemented: false });

/** R18 safety net: cancels `reserved` rows past `reserved_until` whose order is not paid. */
export function runExpireReservations(_ctx: JobCtx, _input: z.infer<typeof ExpireReservationsInput>): Promise<unknown> {
  return notYet();
}

/** R60: day and night reminders per offset, with the late-entry skip. */
export function runSendReminders(_ctx: JobCtx, _input: z.infer<typeof SendRemindersInput>): Promise<unknown> {
  return notYet();
}

/** R33: cancels the live bookings of a cancelled session in chunks of 50; self-continues. */
export function runCancelSessionBookings(_ctx: JobCtx, _input: z.infer<typeof CancelSessionBookingsInput>): Promise<unknown> {
  return notYet();
}
