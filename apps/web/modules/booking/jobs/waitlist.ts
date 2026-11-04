/**
 * Waitlist jobs (booking spec 4.5, R24b, R26, R42, R45, R47): `waitlist.expire_offers` and
 * `waitlist.offer_next`. Registered in `../jobs.ts` (booking-P1); booking-P5 implements the
 * handlers here (booking-P7 adds the lead release) and keeps their names, inputs and signatures.
 * Until then each handler is a no-op, so a scheduled run never dies. No job ever changes a
 * `confirmed` entry (`transition()` in `@beam/core/booking` throws `ProtectedSeatError`).
 */
import { z } from "zod";
import type { JobCtx } from "@/lib/job-runner";

export const ExpireOffersInput = z.object({});
/** Key `waitlist:<session_id>:offer_next:<trigger>` (booking id, entry id, hold id, `release:<phase>` or `<minute>`). */
export const OfferNextInput = z.object({ sessionId: z.uuid(), trigger: z.string().min(1).optional() });

const notYet = (): Promise<{ implemented: false }> => Promise.resolve({ implemented: false });

/** R45, R47, R26, R24b: expires offers, releases started sessions, requeues, re-enqueues offers. */
export function runExpireOffers(_ctx: JobCtx, _input: z.infer<typeof ExpireOffersInput>): Promise<unknown> {
  return notYet();
}

/** R42: offers free seats to the next eligible entries under the session lock. */
export function runOfferNext(_ctx: JobCtx, _input: z.infer<typeof OfferNextInput>): Promise<unknown> {
  return notYet();
}
