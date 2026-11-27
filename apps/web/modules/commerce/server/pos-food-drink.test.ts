/**
 * The till's food and drinks (owner decision November 2026: BEAM's own till replaces Lightspeed):
 * migration 0068 adds the item categories `food` and `drink`; the "Eten & drinken" tab lists them
 * and the "Artikelen" tab no longer does; they sell anonymously with their own VAT rate (food on
 * site 12 %, drinks 21 %). The live buyer search returns the member flag and the credits left.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import type { DbHandle, Tx } from "@beam/db";
import { orderLines } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: () => Promise.resolve({ status: "issued", invoiceId: randomUUID(), number: "BEAM-2026-000001" }),
}));

const { posSell, posTabProducts, findPosBuyers } = await import("./pos");
const { createCtx, eq } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const asStaff = <T,>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>) =>
  h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: staffActor({ userId: staffUserId, permissions: ["commerce.sell"] }), durableMode: "immediate" })));

describe("till food and drinks", () => {
  it("lists food and drinks on their own tab and sells them anonymously at their VAT rate", async () => {
    const soup = await makeProduct(h.db, { kind: "item", itemCategory: "food", vatRatePct: "12.00", priceCents: 850 });
    const coffee = await makeProduct(h.db, { kind: "item", itemCategory: "drink", vatRatePct: "21.00", priceCents: 300 });
    const towel = await makeProduct(h.db, { kind: "item", itemCategory: "merchandise", priceCents: 1500 });
    const hidden = await makeProduct(h.db, { kind: "item", itemCategory: "drink", isPosVisible: false });
    const pkg = await makeProduct(h.db, { kind: "package" });
    const all = [soup, coffee, towel, hidden, pkg];

    expect(posTabProducts(all, "food").map((p) => p.id)).toEqual([soup.id, coffee.id]);
    expect(posTabProducts(all, "item").map((p) => p.id)).toEqual([towel.id]);
    expect(posTabProducts(all, "package").map((p) => p.id)).toEqual([pkg.id]);

    const out = await asStaff((tx, ctx) =>
      posSell(tx, ctx, { items: [{ productId: soup.id, quantity: 1 }, { productId: coffee.id, quantity: 2 }], method: "cash", cashReceivedCents: 1500, clientKey: randomUUID() }),
    );
    expect(out.status).toBe("paid");
    const lines = await h.db.select().from(orderLines).where(eq(orderLines.orderId, out.orderId));
    expect(lines.map((l) => [l.productId, Number(l.vatRatePct), l.lineTotalCents]).sort()).toEqual(
      [[soup.id, 12, 850], [coffee.id, 21, 600]].sort(),
    );
  });

  it("finds buyers from two characters with their credits left", async () => {
    const person = await makePerson(h.db, { firstName: "Zelda", lastName: "Quintens" });
    expect(await findPosBuyers(h.db, "Z")).toEqual([]);
    const [match] = await findPosBuyers(h.db, "Quintens");
    expect(match).toMatchObject({ id: person.id, isMember: false, dayUnits: 0, nightUnits: 0 });
  });
});
