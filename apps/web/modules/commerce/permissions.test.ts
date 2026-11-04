/**
 * commerce-P3 action permissions (spec section 7): every catalogue, price and promotion action
 * needs `pricing.write`; staff with only `commerce.sell` (sales, reception) are refused with
 * `forbidden` before anything is written, a customer session is `unauthorized`, and with
 * `pricing.write` the same calls succeed.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { products, roles } from "@beam/db/schema";
import { permissions } from "./permissions";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.33" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");

let handle: DbHandle;

async function asStaff(perms: string[]) {
  const user = await makeUser(handle.db, { roleKey: "sales" });
  await handle.db.update(roles).set({ permissions: perms }).where(eq(roles.key, "sales"));
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: "sales", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function asCustomer() {
  const user = await makeUser(handle.db, { audience: "customer" });
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => jar.clear());

const forbidden = { ok: false, error: { code: "forbidden" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };
const name = { "nl-BE": "Testproduct", "fr-BE": "Produit test", en: "Test product" };
const sku = () => `PERM-${randomUUID().slice(0, 8).toUpperCase()}`;

type Call = [label: string, run: () => Promise<unknown>];

async function calls(): Promise<Call[]> {
  const product = await makeProduct(handle.db, { kind: "night", priceCents: 9500 });
  const person = await makePerson(handle.db);
  return [
    ["createProduct", () => actions.createProduct({ kind: "night", sku: sku(), name })],
    ["updateProduct", () => actions.updateProduct({ productId: product.id, sku: product.sku, name })],
    ["setProductActive", () => actions.setProductActive({ productId: product.id, isActive: false })],
    ["addPriceVersion", () => actions.addPriceVersion({ productId: product.id, audience: "member", amountCents: 9000 })],
    ["setPersonPrice", () => actions.setPersonPrice({ personId: person.id, productId: product.id, amountCents: 8000, reason: "Partner rate" })],
    ["revokePersonPrice", () => actions.revokePersonPrice({ personPriceId: randomUUID() })],
    ["createPromotion", () => actions.createPromotion({ code: `P${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`, name, kind: "percent", value: 10, startsAt: new Date().toISOString() })],
    ["updatePromotion", () => actions.updatePromotion({ promotionId: randomUUID(), name, kind: "percent", value: 10, startsAt: new Date().toISOString() })],
    ["findPricePersons", () => actions.findPricePersons({ q: "test" })],
  ];
}

describe("commerce declares its permissions", () => {
  it("lists commerce.sell, commerce.refund and pricing.write", () => {
    expect([...permissions].sort()).toEqual(expect.arrayContaining(["commerce.refund", "commerce.sell", "pricing.write"]));
  });
});

describe("pricing.write actions", () => {
  it("refuses each action without pricing.write, before writing", async () => {
    const list = await calls();
    const before = (await handle.db.select({ id: products.id }).from(products)).length;
    await asStaff(["commerce.sell", "commerce.refund", "persons.read"]);
    for (const [label, run] of list) expect(await run(), label).toMatchObject(forbidden);
    expect((await handle.db.select({ id: products.id }).from(products)).length).toBe(before);
  });

  it("answers unauthorized for a customer and for no session", async () => {
    const list = await calls();
    await asCustomer();
    for (const [label, run] of list) expect(await run(), label).toMatchObject(unauthorized);
    jar.clear();
    for (const [label, run] of list) expect(await run(), label).toMatchObject(unauthorized);
  });

  it("lets staff with pricing.write through", async () => {
    await asStaff(["pricing.write"]);
    const created = await actions.createProduct({ kind: "night", sku: sku(), name });
    expect(created).toMatchObject({ ok: true });
    const productId = (created as { ok: true; data: { productId: string } }).data.productId;
    expect(await actions.addPriceVersion({ productId, audience: "public", amountCents: 9500 })).toMatchObject({ ok: true, data: { version: 1 } });
    expect(await actions.setProductActive({ productId, isActive: true })).toMatchObject({ ok: true });
    expect(await actions.revokePersonPrice({ personPriceId: randomUUID() })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
