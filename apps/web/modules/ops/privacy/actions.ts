"use server";
/**
 * ops server actions, area `privacy` (ops spec 4.1, rules 58-67; ops-P5): createPrivacyRequest,
 * verifyPrivacyRequest, runPrivacyRequestNow, cancelPrivacyRequest, completeRectification,
 * liftRestriction (staff) and requestMyPrivacyAction, cancelMyErasure (the customer's portal).
 * Each goes through `action()` with its Zod input from `@beam/core/ops`; the state machine and
 * its audit rows live in `./orchestrator` (`audit: false` here, the handlers audit by name).
 */
import { ForbiddenError } from "@beam/core/errors";
import {
  CancelMyErasureInput,
  CancelPrivacyRequestInput,
  CompleteRectificationInput,
  CreatePrivacyRequestInput,
  ERASE_CONFIRM_WORDS,
  LiftRestrictionInput,
  RequestMyPrivacyActionInput,
  RunPrivacyRequestNowInput,
  VerifyPrivacyRequestInput,
  type PrivacyKind,
} from "@beam/core/ops";
import { action } from "@/lib/action";
import { RateLimitedError, ValidationError, type Ctx, type Permission } from "@/lib/ctx";
import { rateLimit } from "@/lib/rate-limit";
import {
  cancelOwnErasure,
  cancelRequest,
  completeRectification as completeRectificationOf,
  createRequest,
  liftRestriction as liftRestrictionOf,
  runNow,
  verifyRequest,
} from "./orchestrator";

/** Ops section 7: who may create a request of each kind. */
const CREATE_PERMISSION: Record<PrivacyKind, Permission> = {
  export: "persons.export",
  erase: "persons.erase",
  restrict: "persons.erase",
  object: "persons.erase",
  rectify: "persons.write",
};

/** Rule 59 (portal): at most 5 requests per person per day. */
const PORTAL_DAILY_LIMIT = 5;

function customerPersonId(ctx: Ctx): string {
  if (ctx.actor.kind !== "customer") throw new ForbiddenError("forbidden: customer");
  return ctx.actor.personId;
}

/** Staff create a request for a person (`received`; verified with `verifyPrivacyRequest`). */
export const createPrivacyRequest = action(
  { name: "ops.privacy_create", audience: "staff", input: CreatePrivacyRequestInput, audit: false },
  async (ctx, input): Promise<{ requestId: string }> => {
    ctx.require(CREATE_PERMISSION[input.kind as PrivacyKind]);
    const row = await createRequest(ctx, { personId: input.personId, kind: input.kind, requestedBy: "staff", verificationNote: input.verificationNote, rectifyFields: input.rectifyFields });
    return { requestId: row.id };
  },
);

/** `received` → `verified` with a note; an erasure's warnings must be acknowledged (rule 61). */
export const verifyPrivacyRequest = action(
  { name: "ops.privacy_verify", audience: "staff", permission: "privacy.run", input: VerifyPrivacyRequestInput, audit: false },
  async (ctx, input): Promise<{ scheduledForAt?: string }> => {
    const row = await verifyRequest(ctx, input);
    return row.scheduledForAt ? { scheduledForAt: row.scheduledForAt.toISOString() } : {};
  },
);

/** Starts a verified erasure now, or reruns a failed export or erasure. */
export const runPrivacyRequestNow = action(
  { name: "ops.privacy_run_now", audience: "staff", permission: "privacy.run", input: RunPrivacyRequestNowInput, audit: false },
  (ctx, input) => runNow(ctx, input.requestId),
);

export const cancelPrivacyRequest = action(
  { name: "ops.privacy_cancel", audience: "staff", permission: "privacy.run", input: CancelPrivacyRequestInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    await cancelRequest(ctx, input);
    return { ok: true };
  },
);

/** Rule 67: staff applied the correction on the person page; finance resyncs. */
export const completeRectification = action(
  { name: "ops.privacy_complete_rectify", audience: "staff", permission: "privacy.run", input: CompleteRectificationInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    await completeRectificationOf(ctx, input.requestId);
    return { ok: true };
  },
);

/** Rule 65: lifting deletes the restriction row and clears the flag; consent is never re-granted. */
export const liftRestriction = action(
  { name: "ops.privacy_lift_restriction", audience: "staff", permission: "privacy.run", input: LiftRestrictionInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    await liftRestrictionOf(ctx, input);
    return { ok: true };
  },
);

/**
 * The customer's own request from `/[locale]/account/privacy` (rule 59), verified by the signed-in
 * session: export starts, erase is scheduled 24 hours later (typed confirm word of the locale),
 * restrict and object apply at once, rectify waits for staff.
 */
export const requestMyPrivacyAction = action(
  { name: "ops.portal_privacy_request", audience: "customer", input: RequestMyPrivacyActionInput, audit: false },
  async (ctx, input): Promise<{ requestId: string }> => {
    const personId = customerPersonId(ctx);
    if (input.kind === "erase" && (input.confirmWord ?? "").trim() !== ERASE_CONFIRM_WORDS[ctx.locale]) {
      throw new ValidationError("wrong_confirm_word", { confirmWord: "wrong_word" });
    }
    if (input.kind === "rectify" && !input.rectifyFields?.length) throw new ValidationError("rectify_fields_required", { rectifyFields: "required" });
    const verdict = await rateLimit(ctx.tx, { key: `privacy_portal:${personId}`, limit: PORTAL_DAILY_LIMIT, windowSeconds: 86_400 }, ctx.now);
    if (!verdict.ok) throw new RateLimitedError(verdict.retryAfterSeconds);
    const row = await createRequest(ctx, { personId, kind: input.kind, requestedBy: "customer", rectifyFields: input.rectifyFields });
    return { requestId: row.id };
  },
);

/** The customer cancels their own erasure before `scheduled_for_at`. */
export const cancelMyErasure = action(
  { name: "ops.portal_privacy_cancel", audience: "customer", input: CancelMyErasureInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    await cancelOwnErasure(ctx, { requestId: input.requestId, personId: customerPersonId(ctx) });
    return { ok: true };
  },
);
