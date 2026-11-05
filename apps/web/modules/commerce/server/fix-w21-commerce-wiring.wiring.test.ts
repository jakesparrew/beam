/**
 * fix-w21-commerce-wiring: the cross-module wiring of commerce.
 * - A recorded refund calls credits' `onOrderRefundedForReferrals` once per refund row (credits-P9).
 * - A system refund (`refundOrderLine` from a job) writes `created_by_user_id` null.
 * - `quickRefundLines` spreads the refund dialog's amount over the lines (finance-P6 dialog).
 * - `setPersonPriceRecord` records `person_price.set` on the person's timeline.
 * - `payment_provider_by_channel` refuses Stripe or Viva without their keys (commerce-P2).
 * - `@beam/core/commerce` exports the Lightspeed parser; nav has `/admin/pos/lightspeed`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, emailMessages, payments, refunds, vouchers } from "@beam/db/schema";
import type { RefundPlan } from "@beam/core/commerce";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const onOrderRefundedForReferrals = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getGrantUsage: () => Promise.resolve({ grants: [] }),
  onOrderRefundedForReferrals: (...a: unknown[]) => onOrderRefundedForReferrals(...a),
}));
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getInvoiceForOrder: () => Promise.resolve(null),
}));

const { issueRefund, refundOrderLine, quickRefundLines } = await import("./refunds");
const { setPersonPriceRecord } = await import("./catalogue");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;
const NOW = new Date("2026-11-04T10:00:00.000Z");

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  onOrderRefundedForReferrals.mockReset().mockResolvedValue(undefined);
});

function asStaff<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>, permissions = ["commerce.refund", "commerce.sell", "invoices.issue", "pricing.write"]): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: staffActor({ userId: staffUserId, permissions }), durableMode: "immediate", now: NOW })));
}

async function paidOrder(personId: string, lines: Parameters<typeof makePaidOrder>[1]["lines"], pays: Array<{ provider: "mollie" | "cash"; amountCents: number }>) {
  const { order, lines: rows } = await makePaidOrder(h.db, { personId, lines, order: { paidAt: new Date("2026-11-01T10:00:00Z") } });
  for (const p of pays) {
    await h.db.insert(payments).values({
      orderId: order.id,
      provider: p.provider,
      status: "paid",
      amountCents: p.amountCents,
      paidAt: order.paidAt,
      providerPaymentId: p.provider === "mollie" ? `tr_${randomUUID().replace(/-/g, "").slice(0, 10)}` : null,
    });
  }
  return { order, lines: rows };
}

describe("refunds and referral commissions (credits-P9)", () => {
  it("calls onOrderRefundedForReferrals in the refund transaction for every refund row", async () => {
    const person = await makePerson(h.db);
    const { order, lines } = await paidOrder(person.id, [{ unitAmountCents: 3000 }], [
      { provider: "cash", amountCents: 1000 },
      { provider: "mollie", amountCents: 2000 },
    ]);
    const out = await asStaff((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "customer request", kind: "refund" }));
    expect(out.refundIds).toHaveLength(2);
    expect(onOrderRefundedForReferrals).toHaveBeenCalledTimes(2);
    for (const refundId of out.refundIds) {
      expect(onOrderRefundedForReferrals).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: order.id, refundId });
    }
    const rows = await h.db.select().from(refunds).where(eq(refunds.orderId, order.id));
    expect(rows.every((r) => r.createdByUserId === staffUserId)).toBe(true);
  });

  it("rolls the refund back when the referral hook fails", async () => {
    const person = await makePerson(h.db);
    const { order, lines } = await paidOrder(person.id, [{ unitAmountCents: 1500 }], [{ provider: "cash", amountCents: 1500 }]);
    onOrderRefundedForReferrals.mockRejectedValueOnce(new Error("boom"));
    await expect(asStaff((tx, ctx) => issueRefund(tx, ctx, { orderId: order.id, lines: [{ orderLineId: lines[0]!.id, quantity: 1 }], reason: "customer request", kind: "refund" }))).rejects.toThrow("boom");
    expect(await h.db.select().from(refunds).where(eq(refunds.orderId, order.id))).toHaveLength(0);
  });

  it("writes a system refund (refundOrderLine from a job) with created_by_user_id null and still calls the hook", async () => {
    const person = await makePerson(h.db);
    const { order, lines } = await paidOrder(person.id, [{ unitAmountCents: 2500 }], [{ provider: "mollie", amountCents: 2500 }]);
    const out = await h.db.transaction((tx) =>
      refundOrderLine(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate", now: NOW }), { orderLineId: lines[0]!.id, reason: "session_cancelled" }),
    );
    expect(out.amountCents).toBe(2500);
    const [row] = await h.db.select().from(refunds).where(eq(refunds.orderId, order.id));
    expect(row).toMatchObject({ createdByUserId: null, amountCents: 2500, reason: "session_cancelled" });
    expect(onOrderRefundedForReferrals).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: order.id, refundId: row!.id });
  });
});

describe("quickRefundLines (the order screen's refund dialog)", () => {
  const plan = (max: number) => ({ lines: [{ maxAmountCents: max }] }) as unknown as RefundPlan;
  const preview = {
    lines: [
      { line: { id: "a" }, left: 2, plan: plan(4000) },
      { line: { id: "b" }, left: 1, plan: plan(0) },
      { line: { id: "c" }, left: 1, plan: plan(1500) },
    ],
  };

  it("takes the lines in order up to what each can still refund, with their whole quantity", () => {
    expect(quickRefundLines(preview, 2250)).toEqual([{ orderLineId: "a", quantity: 2, amountCents: 2250 }]);
    expect(quickRefundLines(preview, 5000)).toEqual([
      { orderLineId: "a", quantity: 2, amountCents: 4000 },
      { orderLineId: "c", quantity: 1, amountCents: 1000 },
    ]);
    expect(quickRefundLines(preview, 5500)).toHaveLength(2);
  });

  it("refuses zero, fractions of a cent and more than the order can refund", () => {
    expect(quickRefundLines(preview, 0)).toBeNull();
    expect(quickRefundLines(preview, 12.5)).toBeNull();
    expect(quickRefundLines(preview, 5501)).toBeNull();
    expect(quickRefundLines({ lines: [] }, 100)).toBeNull();
  });
});

describe("setPersonPriceRecord", () => {
  it("records person_price.set on the person's timeline", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "package", priceCents: 10_000 });
    const { personPriceId } = await asStaff((_tx, ctx) => setPersonPriceRecord(ctx, { personId: person.id, productId: product.id, amountCents: 8000, reason: "loyal customer" }));
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "person_price.set"), eq(activityEvents.personId, person.id)));
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ product_id: product.id });
    expect(events[0]!.refId).toBe(personPriceId);
  });
});

describe("payment_provider_by_channel settings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const value = { portal: "mollie", site: "mollie", admin: "mollie", pos: "mollie", link: "mollie", recurring: "mollie" } as const;

  it("refuses Stripe for a channel in real payments mode without its keys, and accepts Mollie", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { PaymentProviderByChannelSetting, settings } = await import("../config");
    expect(settings.find((s) => s.key === "payment_provider_by_channel")!.schema).toBe(PaymentProviderByChannelSetting);
    expect(PaymentProviderByChannelSetting.safeParse(value).success).toBe(true);
    const r = PaymentProviderByChannelSetting.safeParse({ ...value, site: "stripe" });
    expect(r.success).toBe(false);
    expect(r.error!.issues).toEqual([expect.objectContaining({ path: ["site"], message: "provider_not_configured" })]);
  });

  it("accepts any provider in fake payments mode", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("INTEGRATIONS", "fake");
    const { PaymentProviderByChannelSetting } = await import("../config");
    expect(PaymentProviderByChannelSetting.safeParse({ ...value, site: "stripe", pos: "viva" }).success).toBe(true);
  });
});

describe("email message references", () => {
  it("a deleted email message leaves the voucher with a null email_message_id (set null)", async () => {
    const person = await makePerson(h.db);
    const { lines } = await paidOrder(person.id, [{ productKind: "voucher", unitAmountCents: 5000 }], []);
    const [message] = await h.db.insert(emailMessages).values({ kind: "transactional", locale: "nl-BE", idempotencyKey: `test:${randomUUID()}` }).returning();
    const [voucher] = await h.db.insert(vouchers).values({ orderLineId: lines[0]!.id, amountCents: 5000, status: "active", expiresAt: new Date("2028-11-01"), emailMessageId: message!.id }).returning();
    await h.db.delete(emailMessages).where(eq(emailMessages.id, message!.id));
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, voucher!.id)))[0]!.emailMessageId).toBeNull();
  });
});

describe("exports and navigation", () => {
  it("exports the Lightspeed parser from @beam/core/commerce", async () => {
    const core = await import("@beam/core/commerce");
    expect(typeof core.parseLightspeedCsv).toBe("function");
    expect(typeof core.businessDayRange).toBe("function");
  });

  it("has a nav entry for /admin/pos/lightspeed with a catalogue label", async () => {
    const { nav } = await import("../nav");
    const entry = nav.find((n) => n.href === "/admin/pos/lightspeed");
    expect(entry).toMatchObject({ key: "commerce.lightspeed", permission: "commerce.sell", labelKey: "commerce.nav.lightspeed" });
    const { t } = await import("@beam/core/i18n");
    for (const locale of ["nl-BE", "fr-BE", "en"] as const) expect(t.has(locale, "commerce.nav.lightspeed")).toBe(true);
  });
});
