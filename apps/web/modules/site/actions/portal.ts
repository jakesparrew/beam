"use server";
/**
 * site server actions, portal (site spec section 4; site-P6): `acceptCurrentTerms`, the
 * "Accept" button of the portal terms banner (rule 35, edge cases 32 and 33). Customers only;
 * the version must still be the live `terms` version, else `conflict` ("newer terms published,
 * reload") and nothing is written. The acceptance goes through `recordTermsAcceptance` with
 * context `portal_prompt`, so a double click shares one idempotency key: one row, one event,
 * both calls answer `ok`. A "use server" file exports async functions only, so the Zod input
 * stays unexported.
 */
import { z } from "zod";
import { action } from "@/lib/action";
import { AppError, ConflictError } from "@/lib/ctx";
import { getCurrentLegalVersion, recordTermsAcceptance } from "../server/legal";

const AcceptCurrentTermsInput = z.object({ versionId: z.string().uuid() });

export const acceptCurrentTerms = action(
  { name: "site.terms.accept", audience: "customer", input: AcceptCurrentTermsInput },
  async (ctx, input): Promise<{ ok: true }> => {
    if (ctx.actor.kind !== "customer") throw new AppError("unauthorized");
    const current = await getCurrentLegalVersion(ctx.tx, "terms");
    if (!current || current.versionId !== input.versionId) throw new ConflictError("newer terms published, reload");
    await recordTermsAcceptance(ctx.tx, ctx, { personId: ctx.actor.personId, versionId: input.versionId, context: "portal_prompt" });
    return { ok: true };
  },
);
