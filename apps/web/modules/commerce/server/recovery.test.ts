/**
 * commerce-P8 abandoned checkout recovery (rules 51 and 52, R2): recovered within 7 days with a
 * matching product; not recovered after 8 days, with other products or by another person;
 * recovery revenue through `v_abandoned_checkouts`; `markCheckoutRecoveryMessage` sets the id only
 * once; a null id is filled from `email.findLatestMessage(db, {personId, templateSlug:
 * 'commerce.checkout_recovery', after})`; the resume token opens one checkout and the checkout is
 * re-quoted on open; the job runs twice with the same state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { activityEvents, checkouts, priceVersions, vAbandonedCheckouts } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const email = { findLatestMessage: vi.fn<(...a: unknown[]) => unknown>() };
vi.mock("@/modules/email/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findLatestMessage: (...a: unknown[]) => email.findLatestMessage(...a),
}));

vi.mock("@/modules/site/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCurrentLegalVersion: () => Promise.resolve(null),
}));

const noMembership = { isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null };
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMembershipForPerson: () => Promise.resolve(noMembership),
  getEuroBalance: () => Promise.resolve({ remainingCents: 0, grants: [] }),
}));

const rec = await import("./recovery");
const { getCheckout } = await import("./checkouts");
const { eq, and } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, runJobTwice, createFakeIntegrations } = await import("@/lib/testing");
const { insertMessages, templateVersion } = await import("@/modules/email/email-p7.fixtures");

const DAY = 24 * 60 * 60_000;
let h: DbHandle;
let versionId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  versionId = (await templateVersion(h.db, "marketing")).versionId;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  email.findLatestMessage.mockReset().mockResolvedValue(null);
});

const now = () => new Date();
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function emailMessage(personId: string): Promise<string> {
  const [id] = await insertMessages(h.db, 1, { templateVersionId: versionId, personId });
  return id!;
}

/** An abandoned checkout of `personId` with `productIds`, abandoned `daysAgo` days ago. */
async function abandoned(personId: string | null, productIds: string[], daysAgo: number, over: Partial<typeof checkouts.$inferInsert> = {}) {
  const at = ago(daysAgo);
  const [row] = await h.db
    .insert(checkouts)
    .values({
      personId,
      email: personId ? null : "guest-p8@example.com",
      channel: "site",
      items: productIds.map((productId) => ({ productId, quantity: 1 })),
      totalCents: 9_000,
      status: "abandoned",
      locale: "nl-BE",
      lastActivityAt: new Date(at.getTime() - 2 * 60 * 60_000),
      expiresAt: new Date(at.getTime() + 29 * DAY),
      abandonedAt: at,
      abandonedReason: "left",
      createdAt: new Date(at.getTime() - 3 * 60 * 60_000),
      ...over,
    })
    .returning();
  return row!;
}

/** A paid order of `personId` with one line per product, paid at `paidAt`. */
async function paidOrder(personId: string, productIds: string[], paidAt: Date, totalCents = 7_500) {
  const order = await makeOrder(h.db, { personId, status: "paid", paidAt, totalCents, subtotalCents: totalCents });
  for (const productId of productIds) await makeOrderLine(h.db, { orderId: order.id, productId, productKind: "item", unitAmountCents: totalCents, lineTotalCents: totalCents });
  return order;
}

async function row(id: string) {
  const [r] = await h.db.select().from(checkouts).where(eq(checkouts.id, id));
  return r!;
}

async function recoveredEvents(checkoutId: string) {
  return h.db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.kind, "checkout.recovered"), eq(activityEvents.dedupeKey, `checkout:${checkoutId}:recovered`)));
}

const attribute = () => rec.attributeRecoveries(makeJobCtx(h.db, "checkouts.mark_abandoned"));

describe("recovery attribution (rule 51)", () => {
  it("recovers a checkout when the same person pays an order with one of its products within 7 days", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const b = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const c = await abandoned(person.id, [a.id, b.id], 3);
    const paidAt = ago(1.5);
    const order = await paidOrder(person.id, [b.id], paidAt);

    const out = await attribute();
    expect(out.recovered).toBeGreaterThanOrEqual(1);
    expect(await row(c.id)).toMatchObject({ recoveredOrderId: order.id, recoveredAt: paidAt, status: "abandoned" });
    const events = await recoveredEvents(c.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ personId: person.id, data: { checkout_id: c.id, order_id: order.id } });
  });

  it("reports the recovering order's total as recovery revenue", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const c = await abandoned(person.id, [a.id], 2);
    const order = await paidOrder(person.id, [a.id], ago(1), 12_345);
    await attribute();
    const [view] = await h.db.select().from(vAbandonedCheckouts).where(eq(vAbandonedCheckouts.checkoutId, c.id));
    expect(view).toMatchObject({ recoveredOrderId: order.id, recoveredRevenueCents: 12_345, valueCents: 9_000 });
  });

  it("takes the first paid order when several match", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const c = await abandoned(person.id, [a.id], 5);
    await paidOrder(person.id, [a.id], ago(1));
    const first = await paidOrder(person.id, [a.id], ago(4));
    await attribute();
    expect((await row(c.id)).recoveredOrderId).toBe(first.id);
  });

  it("is not recovered by an order paid more than 7 days after abandonment", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const c = await abandoned(person.id, [a.id], 8.5);
    await paidOrder(person.id, [a.id], ago(0.4)); // 8.1 days after abandoned_at
    await attribute();
    expect(await row(c.id)).toMatchObject({ recoveredOrderId: null, recoveredAt: null });
    expect(await recoveredEvents(c.id)).toHaveLength(0);
  });

  it("is not recovered by an order with other products, by another person or by an order paid before abandonment", async () => {
    const person = await makePerson(h.db);
    const other = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const b = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const c = await abandoned(person.id, [a.id], 2);
    await paidOrder(person.id, [b.id], ago(1));
    await paidOrder(other.id, [a.id], ago(1));
    await paidOrder(person.id, [a.id], ago(2.5));
    await makeOrder(h.db, { personId: person.id, status: "pending_payment" }).then((o) => makeOrderLine(h.db, { orderId: o.id, productId: a.id, productKind: "item" }));
    await attribute();
    expect(await row(c.id)).toMatchObject({ recoveredOrderId: null });
  });

  it("fills a null recovery_message_id from email.findLatestMessage after abandoned_at", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const c = await abandoned(person.id, [a.id], 2);
    await paidOrder(person.id, [a.id], ago(1));
    const messageId = await emailMessage(person.id);
    email.findLatestMessage.mockImplementation((_db: unknown, input: unknown) =>
      Promise.resolve((input as { personId: string }).personId === person.id ? { emailMessageId: messageId, status: "delivered", sentAt: ago(1.9), clickedAt: null } : null),
    );
    await attribute();
    expect(email.findLatestMessage).toHaveBeenCalledWith(expect.anything(), { personId: person.id, templateSlug: "commerce.checkout_recovery", after: c.abandonedAt });
    expect(await row(c.id)).toMatchObject({ recoveryMessageId: messageId });
  });

  it("keeps a recovery_message_id the automation already stored", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const stored = await emailMessage(person.id);
    const c = await abandoned(person.id, [a.id], 2, { recoveryMessageId: stored });
    await paidOrder(person.id, [a.id], ago(1));
    email.findLatestMessage.mockResolvedValue({ emailMessageId: await emailMessage(person.id), status: "delivered", sentAt: null, clickedAt: null });
    await attribute();
    expect(await row(c.id)).toMatchObject({ recoveryMessageId: stored });
  });

  it("runs twice through checkouts.mark_abandoned with the same state (double-run)", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const c = await abandoned(person.id, [a.id], 1);
    const order = await paidOrder(person.id, [a.id], ago(0.5));
    const { first, second } = await runJobTwice(h.db, "checkouts.mark_abandoned", {});
    expect((first as { recovered: number }).recovered).toBeGreaterThanOrEqual(1);
    expect(second).toMatchObject({ recovered: 0 });
    expect((await row(c.id)).recoveredOrderId).toBe(order.id);
    expect(await recoveredEvents(c.id)).toHaveLength(1);
  });
});

describe("markCheckoutRecoveryMessage (rule 51, A-31a)", () => {
  it("sets the recovery message only once", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "item", priceCents: 4_500 });
    const c = await abandoned(person.id, [a.id], 0.1);
    const firstId = await emailMessage(person.id);
    const secondId = await emailMessage(person.id);
    await h.db.transaction((tx) => rec.markCheckoutRecoveryMessage(tx, { checkoutId: c.id, emailMessageId: firstId }));
    await h.db.transaction((tx) => rec.markCheckoutRecoveryMessage(tx, { checkoutId: c.id, emailMessageId: secondId }));
    expect((await row(c.id)).recoveryMessageId).toBe(firstId);
  });
});

describe("resume links (getCheckoutRecoveryProps, /checkout/resume/[token])", () => {
  it("creates the resume token once and returns the same URL, items, total and locale", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "package", priceCents: 4_500 });
    const c = await abandoned(person.id, [a.id], 0.1, { locale: "fr-BE" });
    const first = await h.db.transaction((tx) => rec.getCheckoutRecoveryProps(tx, c.id));
    const hash = (await row(c.id)).resumeTokenHash;
    const second = await h.db.transaction((tx) => rec.getCheckoutRecoveryProps(tx, c.id));
    expect(second.resumeUrl).toBe(first.resumeUrl);
    expect((await row(c.id)).resumeTokenHash).toBe(hash);
    expect(first.resumeUrl).toMatch(/\/fr\/checkout\/resume\/[A-Za-z0-9_-]{43}$/);
    expect(first).toMatchObject({ totalCents: 9_000, locale: "fr-BE" });
    expect(first.items.map((i) => i.productId)).toEqual([a.id]);
    const token = first.resumeUrl.split("/").pop()!;
    expect(hash).toBe(rec.hashResumeToken(token));
    expect(hash).not.toContain(token);
  });

  it("opens exactly the one checkout of its token", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "package", priceCents: 4_500 });
    const c1 = await abandoned(person.id, [a.id], 0.1);
    const c2 = await abandoned(person.id, [a.id], 0.1);
    const t1 = (await h.db.transaction((tx) => rec.getCheckoutRecoveryProps(tx, c1.id))).resumeUrl.split("/").pop()!;
    const t2 = (await h.db.transaction((tx) => rec.getCheckoutRecoveryProps(tx, c2.id))).resumeUrl.split("/").pop()!;
    expect(t1).not.toBe(t2);
    expect(await rec.findCheckoutByResumeToken(h.db, t1)).toMatchObject({ checkoutId: c1.id, channel: "site", status: "abandoned", isOpen: true });
    expect((await rec.findCheckoutByResumeToken(h.db, t2))?.checkoutId).toBe(c2.id);
    expect(await rec.findCheckoutByResumeToken(h.db, rec.resumeTokenFor(c1.id).replace(/.$/, (ch) => (ch === "A" ? "B" : "A")))).toBeNull();
    expect(await rec.findCheckoutByResumeToken(h.db, "not-a-token")).toBeNull();
    expect(rec.resumeContinuePath({ checkoutId: c1.id, channel: "site" }, "nl-BE")).toBe(`/nl/checkout?checkout=${c1.id}`);
    expect(rec.resumeContinuePath({ checkoutId: c1.id, channel: "portal" }, "en")).toBe(`/en/account/checkout?checkout=${c1.id}`);
  });

  it("refuses a completed or expired checkout as not open", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "package", priceCents: 4_500 });
    const done = await abandoned(person.id, [a.id], 0.1, { status: "completed", completedAt: now() });
    const old = await abandoned(person.id, [a.id], 0.1, { expiresAt: ago(0.01) });
    const tDone = (await h.db.transaction((tx) => rec.getCheckoutRecoveryProps(tx, done.id))).resumeUrl.split("/").pop()!;
    const tOld = (await h.db.transaction((tx) => rec.getCheckoutRecoveryProps(tx, old.id))).resumeUrl.split("/").pop()!;
    expect(await rec.findCheckoutByResumeToken(h.db, tDone)).toMatchObject({ status: "completed", isOpen: false });
    expect(await rec.findCheckoutByResumeToken(h.db, tOld)).toMatchObject({ isOpen: false });
  });

  it("re-quotes the checkout on open: a price changed since the last save shows the new total", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "package", priceCents: 4_500 });
    const c = await abandoned(person.id, [a.id], 0.1, { totalCents: 4_500 });
    const token = (await h.db.transaction((tx) => rec.getCheckoutRecoveryProps(tx, c.id))).resumeUrl.split("/").pop()!;
    await h.db.insert(priceVersions).values({ productId: a.id, version: 2, audience: "public", amountCents: 5_000, validFromAt: ago(0.05) });

    const target = await rec.findCheckoutByResumeToken(h.db, token);
    expect(target?.checkoutId).toBe(c.id);
    // The page opens the checkout for this browser only (the token proves it), never as the person.
    const view = await getCheckout(h.db, target!.checkoutId, { personId: null, checkoutIds: [target!.checkoutId] }, "nl-BE");
    expect(view).toMatchObject({ checkoutId: c.id, status: "abandoned", priceChanged: true, isGuest: true });
    expect(view!.quote.totalCents).toBe(5_000);
  });
});
