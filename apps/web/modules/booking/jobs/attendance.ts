/**
 * Attendance jobs (booking spec 4.5, R37, R39): `bookings.mark_no_shows`. Registered in
 * `../jobs.ts` (booking-P1); booking-P4 implements the handler here (booking-P8 adds
 * `booking.event_ended`) and keeps its name, input and signature. Until then it is a no-op.
 */
import { z } from "zod";
import type { JobCtx } from "@/lib/job-runner";

export const MarkNoShowsInput = z.object({});

/** R37: marks confirmed rows of ended sessions `no_show` when `no_show.auto_mark`. */
export function runMarkNoShows(_ctx: JobCtx, _input: z.infer<typeof MarkNoShowsInput>): Promise<unknown> {
  return Promise.resolve({ implemented: false });
}
