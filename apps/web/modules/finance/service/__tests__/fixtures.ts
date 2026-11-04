/**
 * Shared fixtures of the finance-P2 service tests: a PGlite database with the production guard
 * trigger, contexts, orders through commerce's factories, payments and refunds, and job-registry
 * stubs for the finance job kinds whose handlers land in finance-P3 and finance-P4.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db, DbHandle, Tx } from "@beam/db";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine, makePaidOrder, type LineOverrides, type OrderInsert } from "@beam/db/testing/commerce-factories";
import { activityEvents, invoices, invoiceSequences, jobs, payments, refunds } from "@beam/db/schema";
import { INVOICES_GUARD_TRIGGER_SQL, type InvoiceRecord } from "@beam/core/finance";
import { and, asc, createCtx, eq, type Actor, type Ctx } from "@/lib/ctx";
import { makeCtx } from "@/lib/testing";

/** The finance job kinds the service enqueues; stubbed in the registry until their package lands. */
export const FINANCE_JOB_KINDS = ["finance.render_pdf", "billit.push_payment", "billit.push_customer"] as const;

/** `vi.mock('@/registry/jobs.generated', ...)` helper: adds stub definitions for missing finance kinds. */
export function withFinanceJobStubs<M extends { JOB_BY_KIND: Record<string, unknown> }>(mod: M): M {
  const added: Record<string, unknown> = {};
  for (const kind of FINANCE_JOB_KINDS) {
    if (!mod.JOB_BY_KIND[kind]) added[kind] = { kind, lane: "fast", priority: 5, input: z.object({}).passthrough(), run: () => Promise.resolve(null) };
  }
  return { ...mod, JOB_BY_KIND: { ...mod.JOB_BY_KIND, ...added } };
}

export async function setupDb(): Promise<DbHandle> {
  const h = await createTestDb();
  await (h.db as unknown as { $client: { exec(text: string): Promise<unknown> } }).$client.exec(INVOICES_GUARD_TRIGGER_SQL);
  return h;
}

export const SYSTEM: Actor = { kind: "system", jobId: "" };
export const NOW = new Date("2026-11-04T10:00:00Z");

export function ctxAt(db: Db, now: Date = NOW, actor: Actor = SYSTEM): Ctx {
  return makeCtx(db, { actor, now });
}

/** A context whose `tx` is a real transaction (for rollback tests). */
export function txCtx(tx: Tx, now: Date = NOW, actor: Actor = SYSTEM): Ctx {
  return createCtx({ tx, actor, now, durableMode: "immediate" });
}

export const asTx = (db: Db) => db as unknown as Tx;

/** A paid portal order of a new person with `lines` (default one item at 45.00, 21 %). */
export async function paidOrder(db: Db, lines?: Omit<LineOverrides, "orderId">[], order: Partial<OrderInsert> = {}) {
  const personId = order.personId ?? (await makePerson(db)).id;
  return makePaidOrder(db, { personId, ...(lines ? { lines } : {}), order });
}

/** A paid payment of an order. */
export async function payment(
  db: Db,
  orderId: string,
  overrides: Partial<typeof payments.$inferInsert> = {},
): Promise<typeof payments.$inferSelect> {
  const [row] = await db
    .insert(payments)
    .values({
      orderId,
      provider: "mollie",
      method: "bancontact",
      status: "paid",
      amountCents: 4_500,
      providerPaymentId: `tr_${randomUUID().slice(0, 10)}`,
      paidAt: NOW,
      ...overrides,
    })
    .returning();
  return row!;
}

/** A refund of a payment (commerce's row; finance only reads it). */
export async function refund(
  db: Db,
  p: { id: string; orderId: string },
  amountCents: number,
  overrides: Partial<typeof refunds.$inferInsert> = {},
): Promise<typeof refunds.$inferSelect> {
  const user = await makeUser(db);
  const [row] = await db
    .insert(refunds)
    .values({ paymentId: p.id, orderId: p.orderId, amountCents, reason: "Customer request", lines: [], creditAction: "none", createdByUserId: user.id, ...overrides })
    .returning();
  return row!;
}

export async function invoiceRow(db: Db, id: string): Promise<InvoiceRecord> {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  return row as InvoiceRecord;
}

export async function lastNumber(db: Db, kind: "invoice" | "credit_note", year: number): Promise<number | null> {
  const [row] = await db
    .select({ n: invoiceSequences.lastNumber })
    .from(invoiceSequences)
    .where(and(eq(invoiceSequences.kind, kind), eq(invoiceSequences.year, year)));
  return row?.n ?? null;
}

export async function eventsOf(db: Db, kind: string) {
  return db.select().from(activityEvents).where(eq(activityEvents.kind, kind as never)).orderBy(asc(activityEvents.id));
}

export async function jobByKey(db: Db, key: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, key));
  return row ?? null;
}

export { makeOrder, makeOrderLine, makePerson };
