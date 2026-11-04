/**
 * commerce test factories (fix-w05-schema-1): every factory row passes the commerce checks, a
 * portal order carries the one terms version of the database and session lines get a session.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../client";
import { orderLines } from "../schema/commerce";
import { pages, pageVersions } from "../schema/site";
import { createTestDb, makePerson, makeProduct } from "../testing";
import { ensureTermsVersion, makeOrder, makeOrderLine, makePaidOrder } from "./commerce-factories";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

describe("ensureTermsVersion", () => {
  it("creates the published legal terms page once and reuses it", async () => {
    const first = await ensureTermsVersion(h.db);
    const second = await ensureTermsVersion(h.db);
    expect(second.id).toBe(first.id);
    expect(first.state).toBe("published");
    const legal = await h.db.select().from(pages).where(eq(pages.legalKey, "terms"));
    expect(legal).toHaveLength(1);
    expect(legal[0]).toMatchObject({ kind: "legal", status: "published", currentVersionId: first.id });
  });

  it("uses the latest version of a terms page without a current version", async () => {
    let foundId = "";
    let v2Id = "";
    // Rolled back so the other tests keep the first terms page.
    await h.db
      .transaction(async (tx) => {
        await tx.update(pages).set({ status: "archived" }).where(eq(pages.legalKey, "terms"));
        const [page] = await tx
          .insert(pages)
          .values({ kind: "legal", legalKey: "terms", slug: "terms-v2" })
          .returning();
        await tx.insert(pageVersions).values({ pageId: page!.id, version: 1, state: "draft" });
        const [v2] = await tx
          .insert(pageVersions)
          .values({ pageId: page!.id, version: 2, state: "published", publishedAt: new Date() })
          .returning();
        v2Id = v2!.id;
        foundId = (await ensureTermsVersion(tx)).id;
        tx.rollback();
      })
      .catch((e: unknown) => { if (v2Id === "") throw e; });
    expect(foundId).toBe(v2Id);
    expect(v2Id).not.toBe("");
  });
});

describe("makeOrder", () => {
  it("defaults to an admin order of a new person without terms", async () => {
    const order = await makeOrder(h.db);
    expect(order).toMatchObject({ channel: "admin", status: "pending_payment", termsVersionId: null });
    expect(order.personId).not.toBeNull();
    expect(order.totalCents).toBe(order.subtotalCents - order.discountCents);
  });

  it("gives a paid portal, site or link order the terms version and paid_at", async () => {
    const terms = await ensureTermsVersion(h.db);
    for (const channel of ["portal", "site", "link"] as const) {
      const order = await makeOrder(h.db, { channel, status: "paid" });
      expect(order.termsVersionId).toBe(terms.id);
      expect(order.paidAt).toBeInstanceOf(Date);
    }
  });

  it("leaves a draft portal order, a pos order and an admin order without terms", async () => {
    expect((await makeOrder(h.db, { channel: "portal", status: "draft" })).termsVersionId).toBeNull();
    const pos = await makeOrder(h.db, { channel: "pos", status: "paid" });
    expect(pos).toMatchObject({ termsVersionId: null, personId: null });
    expect((await makeOrder(h.db, { channel: "admin", status: "paid" })).termsVersionId).toBeNull();
  });
});

describe("makeOrderLine", () => {
  it("numbers lines per order and copies sku and description from the product", async () => {
    const order = await makeOrder(h.db);
    const product = await makeProduct(h.db, { kind: "item" });
    const a = await makeOrderLine(h.db, { orderId: order.id, productId: product.id, quantity: 2 });
    const b = await makeOrderLine(h.db, { orderId: order.id });
    expect(a).toMatchObject({ lineNo: 1, sku: product.sku, productKind: "item", lineTotalCents: 9_000 });
    expect(a.description).toEqual(product.name);
    expect(b.lineNo).toBe(2);
  });

  it("gives session, night and ticket lines a session with quantity 1", async () => {
    for (const productKind of ["session", "night", "ticket"] as const) {
      const line = await makeOrderLine(h.db, { productKind });
      expect(line.sessionId).not.toBeNull();
      expect(line.quantity).toBe(1);
    }
  });
});

describe("makePaidOrder", () => {
  it("sums the lines into a paid portal order with the terms version", async () => {
    const person = await makePerson(h.db);
    const { order, lines } = await makePaidOrder(h.db, {
      personId: person.id,
      lines: [{ productKind: "package", unitAmountCents: 10_000, quantity: 3 }, { productKind: "session" }],
    });
    expect(order).toMatchObject({ personId: person.id, channel: "portal", status: "paid", totalCents: 34_500 });
    expect(order.termsVersionId).toBe((await ensureTermsVersion(h.db)).id);
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2]);
    const stored = await h.db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
    expect(stored).toHaveLength(2);
  });

  it("takes order overrides such as the channel and paid_at", async () => {
    const person = await makePerson(h.db);
    const paidAt = new Date("2026-09-04T10:00:00Z");
    const { order } = await makePaidOrder(h.db, { personId: person.id, order: { channel: "admin", paidAt } });
    expect(order).toMatchObject({ channel: "admin", termsVersionId: null, paidAt });
  });
});
