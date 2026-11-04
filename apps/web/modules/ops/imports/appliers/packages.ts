/**
 * Applier for kind `packages`: opening package balances (ops spec rule 48). Each row creates one
 * `import` grant through credits' `importGrant` with `idempotencyKey = import:<import_id>:row:<n>`
 * (credits stores it as `grant:import:...`; ops never adds the prefix), `units = units_remaining`
 * (net of future bookings, which import without consuming credit), `expires_at` at the end of
 * the Brussels day of `expires_on`. The product is the row's `product_sku` or `options.productId`;
 * the credit kind the product's, else `options.creditKind`.
 */
import type { Tx } from "@beam/db";
import { products } from "@beam/db/schema";
import type { ImportMapping } from "@beam/core/ops";
import { eq } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { importGrant } from "@/modules/credits/api";
import { assertNotErased, cell, endOfBrusselsDay, parseDateCell, parseIntCell, requireEmail, resolvePersonByEmail, RowError, writeExternalId, type ImportRow, type RowOutcome } from "../apply";

export type ImportProduct = { id: string; sku: string; kind: string; creditKind: "day" | "night" | "euro" | null };

/** The product of a packages or memberships row: by SKU (upper-cased) or the mapping's `productId`. */
export async function productOf(tx: Tx, row: ImportRow, mapping: ImportMapping): Promise<ImportProduct> {
  const sku = cell(row, "product_sku")?.toUpperCase().replace(/\s+/g, "-") ?? null;
  const cols = { id: products.id, sku: products.sku, kind: products.kind, creditKind: products.creditKind };
  const [product] = sku
    ? await tx.select(cols).from(products).where(eq(products.sku, sku)).limit(1)
    : mapping.options.productId
      ? await tx.select(cols).from(products).where(eq(products.id, mapping.options.productId)).limit(1)
      : [];
  if (!product) throw new RowError("unknown_product");
  return product;
}

/** The import key of a row (rule 48), without the `grant:` prefix credits adds. */
export const grantKeyOf = (row: Pick<ImportRow, "importId" | "rowNumber">) => `import:${row.importId}:row:${row.rowNumber}`;

export async function applyPackageRow(tx: Tx, ctx: JobCtx, row: ImportRow, opts: { dryRun: boolean; mapping: ImportMapping }): Promise<RowOutcome> {
  const email = requireEmail(row);
  await assertNotErased(tx, email);
  const product = await productOf(tx, row, opts.mapping);
  if (product.kind === "membership") throw new RowError("unknown_product");
  const creditKind = product.creditKind ?? opts.mapping.options.creditKind ?? null;
  if (!creditKind) throw new RowError("unknown_product");
  const units = parseIntCell(cell(row, "units_remaining"), { min: 0 });
  if (units === null) throw new RowError("invalid_number");
  const expiresOn = parseDateCell(cell(row, "expires_on"), opts.mapping.options.dateFormat);
  if (!expiresOn) throw new RowError("invalid_date");
  const originalUnits = parseIntCell(cell(row, "units_original"), { min: 0 }) ?? undefined;
  const unitValueCents = parseIntCell(cell(row, "unit_value_cents"), { min: 0 }) ?? undefined;
  if (units === 0) return { status: "skipped", message: "zero_units", entityType: "grant" };

  const { personId } = await resolvePersonByEmail(tx, ctx, row, email, opts);
  if (opts.dryRun) return { status: "imported", entityType: "grant", ...(personId ? { personId } : {}) };
  const legacyId = cell(row, "external_id")?.slice(0, 200);
  const { grantId, created } = await importGrant(tx, ctx, {
    personId: personId!,
    productId: product.id,
    creditKind,
    units,
    expiresAt: endOfBrusselsDay(expiresOn),
    idempotencyKey: grantKeyOf(row),
    ...(originalUnits !== undefined ? { originalUnits } : {}),
    ...(unitValueCents !== undefined ? { unitValueCents } : {}),
    ...(legacyId ? { legacyId } : {}),
  });
  await writeExternalId(tx, row, "grant", grantId);
  return { status: created ? "imported" : "skipped", ...(created ? {} : { message: "existing" }), personId: personId!, entityType: "grant", entityId: grantId };
}
