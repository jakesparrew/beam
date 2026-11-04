"use server";
/**
 * booking server actions, area `waitlist` (booking spec 4.2, R40-R49), booking-P5: the customer
 * `joinWaitlist`, `withdrawFromWaitlist` and `declineOffer`; the staff `booking.waitlist_*`
 * actions (`waitlist.manage`, each audited with its action name, blueprint 56); and the public
 * `claimSeat` with `requestClaimSignIn`. The handlers live in `../server/claim.ts`. A "use server"
 * file exports async functions only, so the Zod inputs stay unexported.
 */
import { z } from "zod";
import { ForbiddenError } from "@beam/core/errors";
import { URL_SEGMENT, isLocale } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { ValidationError } from "@/lib/ctx";
import {
  claimSeatRow,
  declineOfferRow,
  joinWaitlistRow,
  moveEntryRow,
  offerSeatManuallyRow,
  releaseEntryRow,
  reviewFlagRow,
  sendClaimSignInLink,
  withdrawEntryRow,
  type JoinWaitlistResult,
} from "../server/claim";

const Queue = z.enum(["lead", "customer", "public"]);
const Token = z.string().trim().min(20).max(200);
const entryAudit = { entityType: "waitlist_entry", entityId: (i: { entryId: string }) => i.entryId } as const;

const JoinInput = z.object({ sessionId: z.uuid(), acceptTerms: z.boolean().optional() });

/** R40, R48, R62: the signed-in customer joins (or rejoins once) a full session's waiting list. */
export const joinWaitlist = action(
  { name: "booking.join_waitlist", audience: "customer", input: JoinInput },
  async (ctx, input): Promise<Omit<JoinWaitlistResult, "isFlagged">> => {
    if (ctx.actor.kind !== "customer") throw new ForbiddenError("forbidden: customer");
    const { isFlagged: _flag, ...out } = await joinWaitlistRow(ctx.tx, ctx, { ...input, personId: ctx.actor.personId, by: "customer" });
    return out;
  },
);

const EntryInput = z.object({ entryId: z.uuid() });

/** R46: the customer leaves the waiting list. */
export const withdrawFromWaitlist = action({ name: "booking.withdraw_waitlist", audience: "customer", input: EntryInput }, async (ctx, input) =>
  withdrawEntryRow(ctx.tx, ctx, input),
);

const DeclineInput = z.union([z.object({ entryId: z.uuid() }), z.object({ token: Token })]);

/**
 * R46 "I can't come": by entry id from the portal (own entries only) or by the claim token from
 * the public claim page (the token proves the offer).
 */
export const declineOffer = action(
  { name: "booking.decline_offer", audience: "public", input: DeclineInput, rateLimit: (_i, { ip }) => ({ route: "api", ip }) },
  async (ctx, input) => declineOfferRow(ctx.tx, ctx, input),
);

const ClaimInput = z.object({ token: Token, payWith: z.enum(["credit", "order"]).optional() });

/**
 * R44: claims the offered seat (public; the token proves the person). Credit and free claims are
 * confirmed at once; an order claim needs the entry person's portal session (`unauthorized`
 * `sign_in_required` otherwise) and redirects to commerce's pay page.
 */
export const claimSeat = action(
  { name: "booking.claim_seat", audience: "public", input: ClaimInput, rateLimit: (_i, { ip }) => ({ route: "api", ip }) },
  async (ctx, input): Promise<{ kind: "confirmed"; bookingId: string; redirectTo: string } | { kind: "checkout"; orderId: string; redirectTo: string }> => {
    const result = await claimSeatRow(ctx.tx, ctx, input);
    if ("bookingId" in result) {
      const seg = URL_SEGMENT[isLocale(ctx.locale) ? ctx.locale : "nl-BE"];
      return { kind: "confirmed", bookingId: result.bookingId, redirectTo: `/${seg}/account/bookings/${result.bookingId}` };
    }
    return { kind: "checkout", orderId: result.orderId, redirectTo: result.redirectTo };
  },
);

/** R44 "Sign in to pay": platform's magic link to the entry person's email, back to the claim page. */
export const requestClaimSignIn = action(
  { name: "booking.request_claim_sign_in", audience: "public", input: z.object({ token: Token }), audit: false, rateLimit: (_i, { ip }) => ({ route: "api", ip }) },
  async (ctx, input) => sendClaimSignInLink(ctx.tx, ctx, input),
);

// ---------------------------------------------------------------------------
// Staff (`waitlist.manage`), audited as `booking.waitlist_<verb>` (R49)
// ---------------------------------------------------------------------------

const AddInput = z.object({ sessionId: z.uuid(), personId: z.uuid(), queue: Queue.optional() });

export const addToWaitlist = action(
  {
    name: "booking.waitlist_add",
    audience: "staff",
    permission: "waitlist.manage",
    input: AddInput,
    audit: { entityType: "waitlist_entry", entityId: (_i, o: { entryId: string }) => o.entryId, personId: (i) => i.personId },
  },
  async (ctx, input): Promise<{ entryId: string }> => {
    const out = await joinWaitlistRow(ctx.tx, ctx, { ...input, by: "staff" });
    return { entryId: out.entryId };
  },
);

const OfferInput = z.object({ entryId: z.uuid(), claimWindowMinutes: z.number().int().min(10).max(2880).optional() });

export const offerSeatManually = action(
  { name: "booking.waitlist_offer", audience: "staff", permission: "waitlist.manage", input: OfferInput, audit: entryAudit },
  async (ctx, input) => offerSeatManuallyRow(ctx.tx, ctx, input),
);

const MoveInput = z.object({ entryId: z.uuid(), queue: Queue.optional(), joinedAt: z.coerce.date().optional() });

export const moveWaitlistEntry = action(
  { name: "booking.waitlist_move", audience: "staff", permission: "waitlist.manage", input: MoveInput, audit: entryAudit },
  async (ctx, input) => {
    if (!input.queue && !input.joinedAt) throw new ValidationError("nothing_to_change", { queue: "required" });
    return moveEntryRow(ctx.tx, ctx, input);
  },
);

const ReleaseInput = z.object({ entryId: z.uuid(), reason: z.string().trim().min(1).max(500) });

export const releaseWaitlistEntry = action(
  { name: "booking.waitlist_release", audience: "staff", permission: "waitlist.manage", input: ReleaseInput, audit: entryAudit },
  async (ctx, input) => releaseEntryRow(ctx.tx, ctx, input),
);

const ReviewInput = z.object({ entryId: z.uuid(), decision: z.enum(["clear", "withdraw"]), note: z.string().trim().min(1).max(500) });

export const reviewWaitlistFlag = action(
  { name: "booking.waitlist_review_flag", audience: "staff", permission: "waitlist.manage", input: ReviewInput, audit: entryAudit },
  async (ctx, input) => reviewFlagRow(ctx.tx, ctx, input),
);
