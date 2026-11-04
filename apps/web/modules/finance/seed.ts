/**
 * finance's demo seed (runbook 6.3, finance-P6), run by `apps/web/scripts/seed-demo.ts` in `after`
 * order. Facade read by `pnpm gen:indexes`.
 *
 * The seed customer (`customer2@example.com`, `platform.person.customer2`, who has a portal
 * account; `customer1` is kept clean for the platform spec) gets three paid invoices, one open
 * bank-transfer invoice (due in 12 days) and one credit note, so the portal invoice list and
 * detail have something to show. Orders and payments are written here until commerce's order
 * seeds exist; the documents go through finance's own `issueInvoice` and `issueCreditNote`, so
 * numbers, snapshots, VAT and the `finance.render_pdf` jobs are the real ones. Idempotent: a
 * person who already has a document is skipped.
 */
import { randomUUID } from "node:crypto";
import type { DbOrTx, Tx } from "@beam/db";
import { invoices, orderLines, orders, payments, persons, products } from "@beam/db/schema";
import { DEMO_SKUS } from "@beam/db/seed/commerce";
import { createCtx, eq, inArray, type Ctx } from "@/lib/ctx";
import type { SeedCtx } from "@/scripts/seed-demo";
import { issueCreditNote } from "./service/issue-credit-note";
import { issueInvoice } from "./service/issue-invoice";

type LineSpec = { sku: string; unitCents: number; quantity: number };

/** The demo documents of runbook 6.3 for the seed customer. */
const PAID_ORDERS: { method: string; lines: LineSpec[] }[] = [
  { method: "bancontact", lines: [{ sku: DEMO_SKUS.package5Days, unitCents: 20_000, quantity: 1 }] },
  { method: "creditcard", lines: [{ sku: DEMO_SKUS.package2Nights, unitCents: 18_000, quantity: 1 }] },
  { method: "bancontact", lines: [{ sku: DEMO_SKUS.waterBottle, unitCents: 1_900, quantity: 2 }] },
];
const OPEN_ORDER: LineSpec[] = [{ sku: DEMO_SKUS.package10Days, unitCents: 38_000, quantity: 1 }];

const vatOf = (gross: number, rate: number) => Math.round((gross * rate) / (100 + rate));

async function createOrder(db: DbOrTx, personId: string, locale: string, specs: LineSpec[], status: "paid" | "pending_payment", now: Date) {
  const rows = await db.select().from(products).where(inArray(products.sku, specs.map((s) => s.sku)));
  const bySku = new Map(rows.map((p) => [p.sku, p]));
  if (specs.some((s) => !bySku.has(s.sku))) return null;
  const lineValues = specs.map((s, i) => {
    const p = bySku.get(s.sku)!;
    const total = s.unitCents * s.quantity;
    const rate = Number(p.vatRatePct);
    return { lineNo: i + 1, productId: p.id, productKind: p.kind, sku: p.sku, description: p.name, quantity: s.quantity, unitAmountCents: s.unitCents, lineTotalCents: total, vatRatePct: p.vatRatePct, vatCents: vatOf(total, rate), pricingTrace: {} };
  });
  const total = lineValues.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const vat = lineValues.reduce((sum, l) => sum + l.vatCents, 0);
  const [order] = await db
    .insert(orders)
    .values({ channel: "admin", status, personId, subtotalCents: total, vatCents: vat, totalCents: total, locale, clientKey: randomUUID(), ...(status === "paid" ? { paidAt: now } : {}) })
    .returning();
  const lines = await db
    .insert(orderLines)
    .values(lineValues.map((l) => ({ ...l, orderId: order!.id })))
    .returning();
  return { order: order!, lines };
}

export async function runFinanceDemoSeed(s: Pick<SeedCtx, "db" | "now" | "ids"> & { ctx?: Ctx }): Promise<{ created: number; skipped: number }> {
  const personId = s.ids.get("platform.person.customer2");
  if (!personId) return { created: 0, skipped: 1 };
  const [person] = await s.db.select({ id: persons.id, locale: persons.locale }).from(persons).where(eq(persons.id, personId));
  if (!person) return { created: 0, skipped: 1 };
  const existing = await s.db.select({ id: invoices.id }).from(invoices).where(eq(invoices.personId, personId)).limit(1);
  if (existing.length) return { created: 0, skipped: 1 };

  const tx = s.db as Tx;
  const ctx = s.ctx ?? createCtx({ tx, actor: { kind: "system", jobId: "" }, now: s.now, durableMode: "immediate" });
  let created = 0;
  let creditTarget: { invoiceId: string; orderLineId: string } | null = null;

  for (const spec of PAID_ORDERS) {
    const made = await createOrder(s.db, personId, person.locale, spec.lines, "paid", s.now);
    if (!made) continue;
    const [payment] = await s.db
      .insert(payments)
      .values({ orderId: made.order.id, provider: "mollie", method: spec.method, status: "paid", amountCents: made.order.totalCents, providerPaymentId: `tr_demo${randomUUID().slice(0, 8)}`, paidAt: s.now })
      .returning({ id: payments.id });
    const r = await issueInvoice(tx, ctx, { orderId: made.order.id, paymentId: payment!.id, paidAt: s.now, settledVia: "provider" });
    if (r.status === "skipped") continue;
    created++;
    s.ids.set(`finance.invoice.${r.number}`, r.invoiceId);
    if (spec.lines[0]!.quantity > 1) creditTarget = { invoiceId: r.invoiceId, orderLineId: made.lines[0]!.id };
  }

  const open = await createOrder(s.db, personId, person.locale, OPEN_ORDER, "pending_payment", s.now);
  if (open) {
    const due = new Date(s.now.getTime() + 12 * 86_400_000).toISOString().slice(0, 10);
    const r = await issueInvoice(tx, ctx, { orderId: open.order.id, status: "open", dueOn: due });
    if (r.status !== "skipped") {
      created++;
      s.ids.set(`finance.invoice.${r.number}`, r.invoiceId);
    }
  }

  if (creditTarget) {
    const cn = await issueCreditNote(tx, ctx, {
      invoiceId: creditTarget.invoiceId,
      reason: "Damaged bottle, one of two credited",
      noRefund: true,
      lines: [{ orderLineId: creditTarget.orderLineId, quantity: 1 }],
    });
    created++;
    s.ids.set(`finance.invoice.${cn.number}`, cn.creditNoteId);
  }
  return { created, skipped: 0 };
}

export const seed = { after: ["booking"], run: (s: SeedCtx) => runFinanceDemoSeed(s) };
