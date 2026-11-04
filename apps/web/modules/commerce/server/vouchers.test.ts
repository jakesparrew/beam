/**
 * commerce-P6 vouchers (rules 45 to 47a, edge cases 19 and 20): redemption calls `grantCredits`
 * with source `voucher` and key `grant:voucher:<id>` and stores `credit_grant_id`; a future
 * `deliverOn` sends with `sendAt`; a voucher redeems once under concurrency; failed codes are rate
 * limited by IP and by person; an expired voucher is refused; `commerce.expire_vouchers` expires
 * vouchers and writes `voucher.expiring` once.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, emailMessages, vouchers } from "@beam/db/schema";
import { deriveVoucherCode, hashVoucherCode, voucherCodeLast4 } from "@beam/core/commerce";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const grantSpy = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/credits/api", async (importOriginal) => {
  const original = await importOriginal<{ grantCredits: (...a: unknown[]) => unknown }>();
  return {
    ...original,
    grantCredits: (...a: unknown[]) => {
      grantSpy(...a);
      return original.grantCredits(...a);
    },
  };
});

const SECRET = "test-voucher-secret";
process.env.VOUCHER_CODE_SECRET = SECRET;

const { redeemVoucher, issueVoucherEmail, expireVouchers, deliveryInstant } = await import("./vouchers");
const { createCtx, eq, and, flushDurableWrites } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  grantSpy.mockClear();
});

const DAY = 86_400_000;

/** An active voucher of a paid voucher order, with its code. */
async function activeVoucher(over: Partial<typeof vouchers.$inferInsert> = {}) {
  const buyer = await makePerson(h.db);
  const product = await makeProduct(h.db, { kind: "voucher" });
  const { lines } = await makePaidOrder(h.db, { personId: buyer.id, lines: [{ productId: product.id, productKind: "voucher", unitAmountCents: 5000, vatRatePct: "0.00" }] });
  const id = randomUUID();
  const code = await deriveVoucherCode(SECRET, id);
  const [row] = await h.db
    .insert(vouchers)
    .values({
      id,
      orderLineId: lines[0]!.id,
      amountCents: 5000,
      purchaserPersonId: buyer.id,
      status: "active",
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 730 * DAY),
      codeHash: await hashVoucherCode(code),
      codeLast4: voucherCodeLast4(code),
      ...over,
    })
    .returning();
  return { voucher: row!, code, buyer };
}

type Ctx = ReturnType<typeof createCtx>;

/** One attempt in its own transaction, like the action: durable writes flushed after commit or rollback. */
async function attempt<T>(fn: (tx: Tx, ctx: Ctx) => Promise<T>, ip = "203.0.113.7"): Promise<T> {
  let ctx: Ctx | undefined;
  try {
    return await h.db.transaction((tx) => {
      ctx = createCtx({ tx, actor: { kind: "public" }, ip });
      return fn(tx, ctx);
    });
  } finally {
    if (ctx) await flushDurableWrites(h.db, ctx);
  }
}

describe("redeemVoucher (rule 45)", () => {
  it("grants euro credit with source voucher and stores the grant id", async () => {
    const { voucher, code } = await activeVoucher();
    const redeemer = await makePerson(h.db);
    const out = await attempt((tx, ctx) => redeemVoucher(tx, ctx, { code: code.toLowerCase(), personId: redeemer.id }));
    expect(out.amountCents).toBe(5000);
    expect(grantSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      personId: redeemer.id,
      kind: "euro",
      units: 5000,
      source: "voucher",
      orderLineId: voucher.orderLineId,
      voucherId: voucher.id,
      unitValueCents: 1,
      expiresAt: voucher.expiresAt,
      key: `grant:voucher:${voucher.id}`,
    });
    const [after] = await h.db.select().from(vouchers).where(eq(vouchers.id, voucher.id));
    expect(after).toMatchObject({ status: "redeemed", redeemedByPersonId: redeemer.id, creditGrantId: out.grantId });
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "voucher.redeemed"), eq(activityEvents.personId, redeemer.id)));
    expect(events).toHaveLength(1);
  });

  it("redeems once when two requests race", async () => {
    const { code } = await activeVoucher();
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    const results = await Promise.allSettled([
      attempt((tx, ctx) => redeemVoucher(tx, ctx, { code, personId: a.id }), "203.0.113.20"),
      attempt((tx, ctx) => redeemVoucher(tx, ctx, { code, personId: b.id }), "203.0.113.21"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ message: "voucher_used" });
    expect(grantSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses an expired voucher", async () => {
    const { code } = await activeVoucher({ expiresAt: new Date(Date.now() - DAY) });
    const p = await makePerson(h.db);
    await expect(attempt((tx, ctx) => redeemVoucher(tx, ctx, { code, personId: p.id }))).rejects.toMatchObject({ message: "voucher_expired" });
  });

  it("blocks after five failed codes per IP and per person; a success does not count", async () => {
    const p = await makePerson(h.db);
    const ip = "198.51.100.9";
    for (let i = 0; i < 5; i++) {
      await expect(attempt((tx, ctx) => redeemVoucher(tx, ctx, { code: "BEAM-0000-0000-0000", personId: p.id }), ip)).rejects.toMatchObject({ message: "voucher_invalid" });
    }
    const { code } = await activeVoucher();
    // Blocked for the IP (another person) and for the person (another IP), even with a valid code.
    const other = await makePerson(h.db);
    await expect(attempt((tx, ctx) => redeemVoucher(tx, ctx, { code, personId: other.id }), ip)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(attempt((tx, ctx) => redeemVoucher(tx, ctx, { code, personId: p.id }), "198.51.100.10")).rejects.toMatchObject({ code: "rate_limited" });
    // A fresh IP and person still redeem, and a success adds no count.
    const fresh = await makePerson(h.db);
    await attempt((tx, ctx) => redeemVoucher(tx, ctx, { code, personId: fresh.id }), "198.51.100.11");
  });
});

describe("commerce.issue_voucher_email (rule 45a)", () => {
  it("sends with sendAt 09:00 Brussels for a future delivery date and stores the message id", async () => {
    const day = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const { voucher } = await activeVoucher({ recipientName: "Alex", recipientEmail: "alex@example.com", deliverOn: day });
    const out = await h.db.transaction((tx) => issueVoucherEmail(createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate" }), { voucherId: voucher.id, n: 0 }));
    expect("emailMessageId" in out && out.sendAt?.toISOString()).toBe(deliveryInstant(day).toISOString());
    const [message] = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `voucher:${voucher.id}:email:0`));
    expect(message).toMatchObject({ toEmail: "alex@example.com" });
    expect(message!.sendAt?.toISOString()).toBe(deliveryInstant(day).toISOString());
    expect(message!.attachments).toEqual([{ fileId: expect.any(String) as unknown, filename: "BEAM-gift-voucher.pdf" }]);
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, voucher.id)))[0]!.emailMessageId).toBe(message!.id);
  });
});

describe("commerce.expire_vouchers (rule 47a)", () => {
  it("expires vouchers past their date and writes voucher.expiring once", async () => {
    const { voucher: old, buyer: oldBuyer } = await activeVoucher({ expiresAt: new Date(Date.now() - 60_000) });
    const { voucher: soon, buyer } = await activeVoucher({ expiresAt: new Date(Date.now() + 10 * DAY) });
    const run = () => h.db.transaction((tx) => expireVouchers(createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate" })));
    const first = await run();
    expect(first.expired).toBeGreaterThanOrEqual(1);
    await run();
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, old.id)))[0]!.status).toBe("expired");
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, soon.id)))[0]!.status).toBe("active");
    const expiring = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "voucher.expiring"), eq(activityEvents.personId, buyer.id)));
    expect(expiring).toHaveLength(1);
    expect(expiring[0]!.data).toEqual({ voucher_id: soon.id, days: 30 });
    const expired = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "voucher.expired"), eq(activityEvents.personId, oldBuyer.id)));
    expect(expired).toHaveLength(1);
  });
});
