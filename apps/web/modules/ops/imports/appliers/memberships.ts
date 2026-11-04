/**
 * Applier for kind `memberships` (ops spec rule 49): credits' `importMembership` with the row's
 * product (kind `membership`), `current_period_end_at` at the end of the Brussels day of
 * `period_end_on`, status `active` unless the file says `cancelled` or `expired`, and no mandate;
 * credits then sends its payment-link renewal flow. Same key form as packages.
 */
import type { Tx } from "@beam/db";
import type { ImportMapping } from "@beam/core/ops";
import type { JobCtx } from "@/lib/job-runner";
import { importMembership } from "@/modules/credits/api";
import { assertNotErased, cell, endOfBrusselsDay, parseDateCell, requireEmail, resolvePersonByEmail, RowError, startOfBrusselsDay, writeExternalId, type ImportRow, type RowOutcome } from "../apply";
import { grantKeyOf, productOf } from "./packages";

const STATUSES: Record<string, "active" | "cancelled" | "expired"> = {
  active: "active",
  actief: "active",
  actif: "active",
  running: "active",
  cancelled: "cancelled",
  canceled: "cancelled",
  geannuleerd: "cancelled",
  annulé: "cancelled",
  expired: "expired",
  verlopen: "expired",
  expiré: "expired",
};

export async function applyMembershipRow(tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }): Promise<RowOutcome> {
  const email = requireEmail(row);
  await assertNotErased(tx, email);
  const product = await productOf(tx, row, opts.mapping);
  if (product.kind !== "membership") throw new RowError("unknown_product");
  const fmt = opts.mapping.options.dateFormat;
  const periodEndOn = parseDateCell(cell(row, "period_end_on"), fmt);
  if (!periodEndOn) throw new RowError("invalid_date");
  const startedOn = parseDateCell(cell(row, "started_on"), fmt);
  const statusText = cell(row, "status")?.toLowerCase() ?? "active";
  const status = STATUSES[statusText];
  if (!status) throw new RowError("invalid_status");

  const { personId } = await resolvePersonByEmail(tx, ctx, row, email, opts);
  if (opts.dryRun) return { status: "imported", entityType: "membership", ...(personId ? { personId } : {}) };
  const { membershipId, created } = await importMembership(tx, ctx, {
    personId: personId!,
    productId: product.id,
    periodEndAt: endOfBrusselsDay(periodEndOn),
    idempotencyKey: grantKeyOf(row),
    status,
    mandateId: null,
    ...(startedOn ? { startedAt: startOfBrusselsDay(startedOn) } : {}),
  });
  await writeExternalId(tx, row, "membership", membershipId);
  return { status: created ? "imported" : "skipped", ...(created ? {} : { message: "existing" }), personId: personId!, entityType: "membership", entityId: membershipId };
}
