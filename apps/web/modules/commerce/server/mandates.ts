/**
 * Payment mandates on erasure and revocation (commerce spec section 9, ops rule 62, cross-module
 * D35; commerce-P4b).
 *
 * - `revokeMandatesForPerson` (ops' `privacy.erase_external`, step `mandates`): every `valid`
 *   mandate of the person becomes `revoked` locally at once, so no renewal can be charged any more,
 *   and one `commerce.revoke_mandate` job per mandate revokes it at the provider. A second call
 *   finds no valid mandate and returns 0.
 * - `revokeMandateAtProvider` is `commerce.revoke_mandate`; a mandate already revoked or unknown
 *   at the provider succeeds as a no-op.
 * - `eraseProviderCustomer` is `commerce.erase_provider_customer`, enqueued by commerce's erase
 *   handler: it revokes the mandates it is given at the provider and deletes the provider
 *   customer (both no-ops when the provider no longer knows them).
 */
import { mandates } from "@beam/db/schema";
import { nextMandateStatus } from "@beam/core/commerce";
import { IntegrationError } from "@beam/integrations/_shared";
import type { PaymentProvider } from "@beam/integrations/payments";
import { and, asc, eq, NotFoundError, type Ctx, type Tx } from "@/lib/ctx";
import { getIntegrations, type Integrations } from "@/lib/integrations";
import type { JobCtx } from "@/lib/job-runner";

function paymentsClient(ctx: Ctx & { integrations?: Integrations }): PaymentProvider {
  return (ctx.integrations ?? getIntegrations()).payments;
}

/** True for the provider's "not found" (already gone): HTTP 404 or 410. */
function isGone(error: unknown): boolean {
  return error instanceof IntegrationError && (error.statusCode === 404 || error.statusCode === 410);
}

/** api `revokeMandatesForPerson`: marks every valid mandate `revoked` and enqueues one provider revocation each. */
export async function revokeMandatesForPerson(tx: Tx, ctx: Ctx, personId: string): Promise<{ revoked: number }> {
  const rows = await tx
    .select()
    .from(mandates)
    .where(and(eq(mandates.personId, personId), eq(mandates.status, "valid")))
    .orderBy(asc(mandates.createdAt), asc(mandates.id))
    .for("update");
  let revoked = 0;
  for (const m of rows) {
    if (nextMandateStatus(m.status, "revoked") === null) continue;
    await tx.update(mandates).set({ status: "revoked", revokedAt: ctx.now, updatedAt: ctx.now }).where(eq(mandates.id, m.id));
    await ctx.enqueue({ kind: "commerce.revoke_mandate", payload: { mandateId: m.id }, key: `mandate_revoke:${m.id}` });
    revoked++;
  }
  return { revoked };
}

/**
 * `commerce.revoke_mandate` (key `mandate_revoke:<mandate_id>`): `provider.revokeMandate` and the
 * local row `revoked` (already so when `revokeMandatesForPerson` enqueued it).
 */
export async function revokeMandateAtProvider(ctx: JobCtx, input: { mandateId: string }): Promise<{ revoked: true; atProvider: "revoked" | "not_found" }> {
  const [m] = await ctx.tx.select().from(mandates).where(eq(mandates.id, input.mandateId)).for("update");
  if (!m) throw new NotFoundError("mandate_not_found");
  let atProvider: "revoked" | "not_found" = "revoked";
  try {
    await paymentsClient(ctx).revokeMandate({ customerId: m.providerCustomerId, mandateId: m.providerMandateId });
  } catch (error) {
    if (!isGone(error)) throw error;
    atProvider = "not_found";
  }
  if (nextMandateStatus(m.status, "revoked") !== null) {
    await ctx.tx.update(mandates).set({ status: "revoked", revokedAt: m.revokedAt ?? ctx.now, updatedAt: ctx.now }).where(eq(mandates.id, m.id));
  }
  return { revoked: true, atProvider };
}

/**
 * `commerce.erase_provider_customer` (key `mollie_customer:<provider_customer_id>:delete`):
 * revokes the given provider mandates (ids at the provider) and deletes the provider customer.
 * The payload carries the provider ids because the local rows are already anonymised.
 */
export async function eraseProviderCustomer(
  ctx: JobCtx,
  input: { providerCustomerId: string; mandateIds: string[] },
): Promise<{ mandatesRevoked: number; customer: "deleted" | "not_found" }> {
  const provider = paymentsClient(ctx);
  let mandatesRevoked = 0;
  for (const mandateId of input.mandateIds) {
    try {
      await provider.revokeMandate({ customerId: input.providerCustomerId, mandateId });
      mandatesRevoked++;
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  let customer: "deleted" | "not_found" = "deleted";
  try {
    await provider.deleteCustomer(input.providerCustomerId);
  } catch (error) {
    if (!isGone(error)) throw error;
    customer = "not_found";
  }
  return { mandatesRevoked, customer };
}
