/**
 * booking jobs (booking spec 4.5). Facade read by `pnpm gen:indexes`: every `kind` is a literal.
 * The handlers live in the area files `jobs/{schedule,bookings,attendance,waitlist}.ts`, which
 * the later booking packages implement (P2, P3b, P4, P5); this file only registers them. The
 * architecture's names `sessions.*` and `waitlist.expire_offers` are kept (decision 9).
 */
import { defineJob } from "@/lib/job-runner";
import { MarkNoShowsInput, runMarkNoShows } from "./jobs/attendance";
import {
  CancelSessionBookingsInput,
  ExpireReservationsInput,
  SendRemindersInput,
  runCancelSessionBookings,
  runExpireReservations,
  runSendReminders,
} from "./jobs/bookings";
import { MaterialiseInput, RegenerateDateInput, RegenerateTemplateInput, runMaterialise, runRegenerateDate, runRegenerateTemplate } from "./jobs/schedule";
import { ExpireOffersInput, OfferNextInput, runExpireOffers, runOfferNext } from "./jobs/waitlist";

export * from "./jobs/schedule";
export * from "./jobs/bookings";
export * from "./jobs/attendance";
export * from "./jobs/waitlist";

export const jobs = [
  defineJob({ kind: "sessions.materialise", lane: "bulk", input: MaterialiseInput, maxAttempts: 6, run: runMaterialise }),
  defineJob({ kind: "sessions.cancel_bookings", lane: "fast", input: CancelSessionBookingsInput, maxAttempts: 6, run: runCancelSessionBookings }),
  defineJob({ kind: "sessions.regenerate_template", lane: "fast", input: RegenerateTemplateInput, maxAttempts: 6, run: runRegenerateTemplate }),
  defineJob({ kind: "sessions.regenerate_date", lane: "fast", input: RegenerateDateInput, maxAttempts: 6, run: runRegenerateDate }),
  defineJob({ kind: "bookings.expire_reservations", lane: "fast", input: ExpireReservationsInput, maxAttempts: 3, run: runExpireReservations }),
  defineJob({ kind: "bookings.mark_no_shows", lane: "fast", input: MarkNoShowsInput, maxAttempts: 6, run: runMarkNoShows }),
  defineJob({ kind: "bookings.send_reminders", lane: "fast", input: SendRemindersInput, maxAttempts: 6, run: runSendReminders }),
  defineJob({ kind: "waitlist.expire_offers", lane: "fast", input: ExpireOffersInput, maxAttempts: 6, run: runExpireOffers }),
  defineJob({ kind: "waitlist.offer_next", lane: "fast", priority: 1, input: OfferNextInput, maxAttempts: 6, run: runOfferNext }),
];
