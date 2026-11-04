/**
 * Reconciliation of opening balances (ops spec rule 48, ops-P4). Per credit kind and product:
 * rows, units in the file, units granted and the difference; plus every row whose person's
 * post-import balance in credits' `v_credit_grant_balances` (active grants of that credit kind)
 * differs from the file's units for that person, so a grant that existed before the import shows
 * up as a mismatch. In a dry run "granted" means the rows that would be granted and the balance is
 * the current balance plus those units. Memberships reconcile rows against imported memberships
 * and their period end. Row numbers only; BEAM signs the result off (`signOffReconciliation`).
 */
import type { DbOrTx } from "@beam/db";
import { creditGrants, importRows, imports, memberships, products, vCreditGrantBalances } from "@beam/db/schema";
import { and, asc, eq, inArray } from "@/lib/ctx";
import { endOfBrusselsDay, parseDateCell, RowError } from "./apply";

export type ReconciliationLine = {
  creditKind: string | null;
  productId: string | null;
  productSku: string | null;
  rows: number;
  unitsInFile: number;
  unitsGranted: number;
  difference: number;
};

export type Reconciliation = {
  kind: "packages" | "memberships";
  mode: "dry" | "run";
  lines: ReconciliationLine[];
  totals: { rows: number; unitsInFile: number; unitsGranted: number; difference: number };
  mismatches: { row: number; creditKind: string | null; expected: number; balance: number }[];
  signOffNote?: string;
};

const MISMATCH_CAP = 500;

function units(value: string | null | undefined): number {
  if (!value) return 0;
  const s = String(value).replace(/\s/g, "");
  return /^\d+$/.test(s) ? Number(s) : 0;
}

type Loaded = {
  mode: "dry" | "run";
  productId: string | null;
  productCreditKind: "day" | "night" | "euro" | null;
  creditKindOption: "day" | "night" | "euro" | null;
  dateFormat: "iso" | "dd/mm/yyyy" | "mm/dd/yyyy";
  rows: { rowNumber: number; data: Record<string, string | null>; status: string; personId: string | null; entityId: string | null }[];
  bySku: Map<string, { id: string; sku: string; creditKind: "day" | "night" | "euro" | null }>;
};

async function load(tx: DbOrTx, importId: string): Promise<Loaded> {
  const [imp] = await tx.select({ status: imports.status, mapping: imports.mapping }).from(imports).where(eq(imports.id, importId));
  if (!imp) throw new RowError("import_not_found");
  const mode: "dry" | "run" = imp.status === "dry_run" || imp.status === "uploaded" ? "dry" : "run";
  const options = ("options" in imp.mapping ? imp.mapping.options : null) ?? null;
  const raw = await tx
    .select({ rowNumber: importRows.rowNumber, data: importRows.data, status: importRows.status, dryRunStatus: importRows.dryRunStatus, personId: importRows.personId, entityId: importRows.entityId })
    .from(importRows)
    .where(eq(importRows.importId, importId))
    .orderBy(asc(importRows.rowNumber));
  const skus = [...new Set(raw.map((r) => r.data.product_sku?.trim().toUpperCase().replace(/\s+/g, "-")).filter((s): s is string => !!s))];
  const found = skus.length ? await tx.select({ id: products.id, sku: products.sku, creditKind: products.creditKind }).from(products).where(inArray(products.sku, skus)) : [];
  let productCreditKind: Loaded["productCreditKind"] = null;
  if (options?.productId) {
    const [p] = await tx.select({ creditKind: products.creditKind }).from(products).where(eq(products.id, options.productId));
    productCreditKind = p?.creditKind ?? null;
  }
  return {
    mode,
    productId: options?.productId ?? null,
    productCreditKind,
    creditKindOption: options?.creditKind ?? null,
    dateFormat: options?.dateFormat ?? "iso",
    rows: raw.map((r) => ({ rowNumber: r.rowNumber, data: r.data, status: (mode === "dry" ? r.dryRunStatus : r.status) ?? "pending", personId: r.personId, entityId: r.entityId })),
    bySku: new Map(found.map((p) => [p.sku, p])),
  };
}

function totalsOf(lines: ReconciliationLine[]): Reconciliation["totals"] {
  const t = lines.reduce((a, l) => ({ rows: a.rows + l.rows, unitsInFile: a.unitsInFile + l.unitsInFile, unitsGranted: a.unitsGranted + l.unitsGranted }), { rows: 0, unitsInFile: 0, unitsGranted: 0 });
  return { ...t, difference: t.unitsInFile - t.unitsGranted };
}

/** Rule 48: the reconciliation of a `packages` import (exposed for the finalise job and tests). */
export async function reconcilePackages(tx: DbOrTx, importId: string): Promise<Reconciliation> {
  const l = await load(tx, importId);
  const grantIds = l.mode === "run" ? l.rows.filter((r) => r.entityId && (r.status === "imported" || r.status === "skipped")).map((r) => r.entityId!) : [];
  const granted = grantIds.length ? await tx.select({ id: creditGrants.id, units: creditGrants.unitsGranted }).from(creditGrants).where(inArray(creditGrants.id, grantIds)) : [];
  const grantedUnits = new Map(granted.map((g) => [g.id, g.units]));

  const lines = new Map<string, ReconciliationLine>();
  const expected = new Map<string, { kind: string; personId: string; units: number; rows: number[] }>();
  for (const r of l.rows) {
    const sku = r.data.product_sku?.trim().toUpperCase().replace(/\s+/g, "-") ?? null;
    const product = sku ? l.bySku.get(sku) : null;
    const creditKind = product?.creditKind ?? (sku ? null : l.productCreditKind) ?? l.creditKindOption;
    const productId = product?.id ?? (sku ? null : l.productId);
    const key = `${creditKind ?? "-"}|${productId ?? sku ?? "-"}`;
    const line = lines.get(key) ?? { creditKind, productId, productSku: product?.sku ?? sku, rows: 0, unitsInFile: 0, unitsGranted: 0, difference: 0 };
    const fileUnits = units(r.data.units_remaining);
    line.rows += 1;
    line.unitsInFile += fileUnits;
    const counted = r.status === "imported" || (l.mode === "run" && r.status === "skipped" && !!r.entityId);
    if (counted) line.unitsGranted += l.mode === "run" ? (grantedUnits.get(r.entityId ?? "") ?? 0) : fileUnits;
    line.difference = line.unitsInFile - line.unitsGranted;
    lines.set(key, line);
    if (counted && r.personId && creditKind) {
      const pk = `${r.personId}|${creditKind}`;
      const e = expected.get(pk) ?? { kind: creditKind, personId: r.personId, units: 0, rows: [] };
      e.units += fileUnits;
      e.rows.push(r.rowNumber);
      expected.set(pk, e);
    }
  }

  const mismatches: Reconciliation["mismatches"] = [];
  const personIds = [...new Set([...expected.values()].map((e) => e.personId))];
  const balances = new Map<string, number>();
  for (let i = 0; i < personIds.length; i += 1000) {
    const slice = personIds.slice(i, i + 1000);
    const rows = await tx
      .select({ personId: vCreditGrantBalances.personId, creditKind: vCreditGrantBalances.creditKind, remaining: vCreditGrantBalances.remainingUnits })
      .from(vCreditGrantBalances)
      .where(and(inArray(vCreditGrantBalances.personId, slice), eq(vCreditGrantBalances.status, "active")));
    for (const b of rows) balances.set(`${b.personId}|${b.creditKind}`, (balances.get(`${b.personId}|${b.creditKind}`) ?? 0) + Number(b.remaining));
  }
  for (const [pk, e] of expected) {
    const current = balances.get(pk) ?? 0;
    const balance = l.mode === "run" ? current : current + e.units;
    if (balance === e.units) continue;
    for (const row of e.rows) if (mismatches.length < MISMATCH_CAP) mismatches.push({ row, creditKind: e.kind, expected: e.units, balance });
  }
  mismatches.sort((a, b) => a.row - b.row);
  const list = [...lines.values()].sort((a, b) => `${a.creditKind}${a.productSku}`.localeCompare(`${b.creditKind}${b.productSku}`));
  return { kind: "packages", mode: l.mode, lines: list, totals: totalsOf(list), mismatches };
}

/** Memberships: rows per product against imported memberships; a period end that differs from the file is a mismatch. */
export async function reconcileMemberships(tx: DbOrTx, importId: string): Promise<Reconciliation> {
  const l = await load(tx, importId);
  const ids = l.mode === "run" ? l.rows.filter((r) => r.entityId).map((r) => r.entityId!) : [];
  const found = ids.length ? await tx.select({ id: memberships.id, end: memberships.currentPeriodEndAt }).from(memberships).where(inArray(memberships.id, ids)) : [];
  const endOf = new Map(found.map((m) => [m.id, m.end]));
  const lines = new Map<string, ReconciliationLine>();
  const mismatches: Reconciliation["mismatches"] = [];
  for (const r of l.rows) {
    const sku = r.data.product_sku?.trim().toUpperCase().replace(/\s+/g, "-") ?? null;
    const product = sku ? l.bySku.get(sku) : null;
    const key = product?.id ?? sku ?? "-";
    const line = lines.get(key) ?? { creditKind: null, productId: product?.id ?? null, productSku: product?.sku ?? sku, rows: 0, unitsInFile: 0, unitsGranted: 0, difference: 0 };
    line.rows += 1;
    line.unitsInFile += 1;
    const counted = r.status === "imported" || (l.mode === "run" && r.status === "skipped" && !!r.entityId);
    if (counted) line.unitsGranted += 1;
    line.difference = line.unitsInFile - line.unitsGranted;
    lines.set(key, line);
    if (l.mode === "run" && counted && r.entityId) {
      let fileEnd: number | null = null;
      try {
        const d = parseDateCell(r.data.period_end_on ?? null, l.dateFormat);
        fileEnd = d ? endOfBrusselsDay(d).getTime() : null;
      } catch {
        fileEnd = null;
      }
      const stored = endOf.get(r.entityId)?.getTime() ?? null;
      if (fileEnd !== null && stored !== null && Math.abs(stored - fileEnd) > 86_400_000 && mismatches.length < MISMATCH_CAP) mismatches.push({ row: r.rowNumber, creditKind: null, expected: 1, balance: 0 });
    }
  }
  const list = [...lines.values()];
  return { kind: "memberships", mode: l.mode, lines: list, totals: totalsOf(list), mismatches };
}
