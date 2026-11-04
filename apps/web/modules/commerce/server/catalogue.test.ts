/**
 * commerce-P3 catalogue (rules 1 to 6): activation needs complete texts and a public price,
 * price versions are numbered per (product, audience) under the product lock and never change,
 * `getProductPrice` falls back to the public version, `listPublicPrices` returns member amounts
 * only when a member version exists, and `getProductCards` renders one locale without fallback.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyCustomSql, createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, personPrices, priceVersions, products } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const cat = await import("./catalogue");
const { createCtx, eq, and, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let staff: ReturnType<typeof staffActor>;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  const user = await makeUser(h.db, { roleKey: "finance" });
  staff = staffActor({ userId: user.id, roleKey: "finance", permissions: ["pricing.write"] });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const ctx = (now?: Date) => makeCtx(h.db, { actor: staff, ...(now ? { now } : {}) });
const full = { "nl-BE": "Dagsessie", "fr-BE": "Séance de jour", en: "Day session" };
let n = 0;
const sku = (p = "CAT") => `${p}-${Date.now().toString(36).toUpperCase()}-${++n}`;

async function newProduct(over: Partial<Parameters<typeof cat.createProductRecord>[1]> = {}) {
  const input = cat.CreateProductInput.parse({ kind: "session", sku: sku(), name: full, ...over });
  return (await cat.createProductRecord(ctx(), input)).productId;
}
const row = async (id: string) => (await h.db.select().from(products).where(eq(products.id, id)))[0]!;
const addPrice = (productId: string, audience: "public" | "member" | "b2b", amountCents: number, extra: { validFromAt?: Date; validToAt?: Date } = {}) =>
  cat.addPriceVersionRecord(ctx(), cat.AddPriceVersionInput.parse({ productId, audience, amountCents, ...extra }));

describe("products", () => {
  it("creates an inactive product with the kind's default VAT, upper-cased SKU and an audit row", async () => {
    const id = await newProduct({ kind: "night", sku: "night-abc-1" });
    const p = await row(id);
    expect(p).toMatchObject({ kind: "night", sku: "NIGHT-ABC-1", isActive: false, vatRatePct: "6.00", creditKind: null });
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "product.created"), eq(auditLog.entityId, id)));
    expect(audits).toHaveLength(1);
  });

  it("refuses a package without credits and a duplicate SKU with field errors", async () => {
    await expect(newProduct({ kind: "package", creditKind: "day" })).rejects.toMatchObject({ code: "validation", fields: { creditUnits: "required", validityDays: "required" } });
    const taken = sku("DUP");
    await newProduct({ sku: taken });
    await expect(newProduct({ sku: taken.toLowerCase() })).rejects.toMatchObject({ code: "validation", fields: { sku: "sku_taken" } });
    await expect(newProduct({ kind: "item" })).rejects.toMatchObject({ fields: { itemCategory: "required" } });
  });

  it("clears columns that do not apply to the kind and fixes vouchers to euro credit at 0 %", async () => {
    const id = await newProduct({ kind: "voucher", isCustomAmount: true, minAmountCents: 2500, maxAmountCents: 50000, creditUnits: 3 });
    expect(await row(id)).toMatchObject({ creditKind: "euro", vatRatePct: "0.00", validityDays: 730, creditUnits: null, isCustomAmount: true });
    await expect(newProduct({ kind: "voucher", vatRatePct: 21 })).rejects.toMatchObject({ fields: { vatRatePct: "voucher_vat_zero" } });
  });
});

describe("activation (rule 1)", () => {
  it("is blocked by a missing locale in the name, and in the description when shop-visible", async () => {
    const id = await newProduct({ name: { "nl-BE": "Alleen Nederlands", en: "English only" } });
    await addPrice(id, "public", 4500);
    await expect(cat.setProductActiveRecord(ctx(), { productId: id, isActive: true })).rejects.toMatchObject({
      code: "validation",
      message: "missing_translation",
      fields: { name: "fr-BE" },
    });
    const shop = await newProduct({ isShopVisible: true, description: { en: "Only English" } });
    await addPrice(shop, "public", 4500);
    await expect(cat.setProductActiveRecord(ctx(), { productId: shop, isActive: true })).rejects.toMatchObject({ fields: { description: "nl-BE,fr-BE" } });
    expect((await row(shop)).isActive).toBe(false);
  });

  it("is blocked without a public price valid now, then succeeds and is audited", async () => {
    const id = await newProduct();
    await expect(cat.setProductActiveRecord(ctx(), { productId: id, isActive: true })).rejects.toMatchObject({ code: "validation", message: "no_price" });
    await addPrice(id, "member", 4000);
    await addPrice(id, "public", 4500, { validFromAt: new Date(Date.now() + 86_400_000) });
    await expect(cat.setProductActiveRecord(ctx(), { productId: id, isActive: true })).rejects.toMatchObject({ message: "no_price" });
    await addPrice(id, "public", 4500);
    expect(await cat.setProductActiveRecord(ctx(), { productId: id, isActive: true })).toEqual({ ok: true });
    expect((await row(id)).isActive).toBe(true);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "product.activated"), eq(auditLog.entityId, id)));
    expect(audits).toHaveLength(1);
  });

  it("lets a custom-amount voucher activate without a price version", async () => {
    const id = await newProduct({ kind: "voucher", isCustomAmount: true, minAmountCents: 2500, maxAmountCents: 50000 });
    await cat.setProductActiveRecord(ctx(), { productId: id, isActive: true });
    expect((await row(id)).isActive).toBe(true);
  });

  it("keeps an active product complete on update", async () => {
    const id = await newProduct();
    await addPrice(id, "public", 4500);
    await cat.setProductActiveRecord(ctx(), { productId: id, isActive: true });
    const p = await row(id);
    const base = { productId: id, sku: p.sku, name: { ...full, en: "" } };
    await expect(cat.updateProductRecord(ctx(), cat.UpdateProductInput.parse(base))).rejects.toMatchObject({ fields: { name: "en" } });
    await cat.updateProductRecord(ctx(), cat.UpdateProductInput.parse({ ...base, name: { ...full, en: "Day session, renamed" } }));
    expect((await row(id)).name).toMatchObject({ en: "Day session, renamed" });
  });
});

describe("price versions (rule 4)", () => {
  it("numbers versions per product and audience without gaps under concurrency", async () => {
    const id = await newProduct();
    const amounts = [4500, 4600, 4700, 4800, 4900];
    const results = await Promise.all(
      amounts.map((amountCents) =>
        h.db.transaction((tx) =>
          cat.addPriceVersionRecord(createCtx({ tx: tx, actor: staff, durableMode: "immediate" }), cat.AddPriceVersionInput.parse({ productId: id, audience: "public", amountCents })),
        ),
      ),
    );
    expect(results.map((r) => r.version).sort()).toEqual([1, 2, 3, 4, 5]);
    expect((await addPrice(id, "member", 4000)).version).toBe(1);
    expect((await addPrice(id, "public", 5000)).version).toBe(6);
  });

  it("is append-only: the trigger rejects update and delete", async () => {
    await applyCustomSql(h, { files: ["0002_append_only.sql"] });
    const id = await newProduct();
    const { priceVersionId } = await addPrice(id, "public", 4500);
    await expect(h.db.update(priceVersions).set({ amountCents: 1 }).where(eq(priceVersions.id, priceVersionId))).rejects.toThrow();
    await expect(h.db.delete(priceVersions).where(eq(priceVersions.id, priceVersionId))).rejects.toThrow();
  });

  it("picks the highest version whose window contains `at`, and a time-limited price falls back after it ends (rule 5)", async () => {
    const id = await newProduct();
    const t0 = new Date(Date.now() - 10 * 86_400_000);
    await addPrice(id, "public", 4500, { validFromAt: t0 });
    const until = new Date(Date.now() + 5 * 86_400_000);
    const promo = await addPrice(id, "public", 3900, { validFromAt: new Date(Date.now() - 86_400_000), validToAt: until });
    expect(await cat.getProductPrice(h.db, id, "public")).toEqual({ priceVersionId: promo.priceVersionId, amountCents: 3900 });
    expect((await cat.getProductPrice(h.db, id, "public", new Date(until.getTime() + 1000)))?.amountCents).toBe(4500);
    expect((await cat.getProductPrice(h.db, id, "public", new Date(t0.getTime() + 1000)))?.amountCents).toBe(4500);
    expect(await cat.getProductPrice(h.db, id, "public", new Date(t0.getTime() - 1000))).toBeNull();
    // No member or b2b version: the public version is used for that audience.
    expect((await cat.getProductPrice(h.db, id, "member"))?.amountCents).toBe(3900);
    await addPrice(id, "b2b", 3700);
    expect((await cat.getProductPrice(h.db, id, "b2b"))?.amountCents).toBe(3700);
  });
});

describe("person prices (rule 6)", () => {
  it("sets and revokes a person price, keeping the row as history", async () => {
    const person = await makePerson(h.db);
    const id = await newProduct();
    const { personPriceId } = await cat.setPersonPriceRecord(ctx(), cat.SetPersonPriceInput.parse({ personId: person.id, productId: id, amountCents: 3000, reason: "Loyal customer" }));
    await cat.revokePersonPriceRecord(ctx(), { personPriceId });
    await cat.revokePersonPriceRecord(ctx(), { personPriceId });
    const [pp] = await h.db.select().from(personPrices).where(eq(personPrices.id, personPriceId));
    expect(pp!.revokedAt).not.toBeNull();
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.entityId, personPriceId));
    expect(audits.map((a) => a.action).sort()).toEqual(["person_price.revoked", "person_price.set"]);
  });
});

describe("listPublicPrices and getProductCards", () => {
  it("returns member amounts only when a member version exists", async () => {
    const plain = await newProduct();
    await addPrice(plain, "public", 4500);
    const withMember = await newProduct({ kind: "package", creditKind: "day", creditUnits: 5, validityDays: 180 });
    await addPrice(withMember, "public", 20000);
    await addPrice(withMember, "member", 18000);
    const noPrice = await newProduct();
    const list = await cat.listPublicPrices(h.db, { productIds: [plain, withMember, noPrice], at: new Date() });
    expect(list.map((p) => p.productId).sort()).toEqual([plain, withMember].sort());
    expect(list.find((p) => p.productId === plain)).toMatchObject({ publicAmountCents: 4500, memberAmountCents: null, isActive: false, vatRatePct: 21 });
    expect(list.find((p) => p.productId === withMember)).toMatchObject({ publicAmountCents: 20000, memberAmountCents: 18000, creditUnits: 5, creditKind: "day", validityDays: 180 });
    expect(await cat.listPublicPrices(h.db, { productIds: [], at: new Date() })).toEqual([]);
  });

  it("renders cards in the requested locale and order, active products only", async () => {
    const a = await newProduct({ name: { "nl-BE": "Nacht NL", "fr-BE": "Nuit FR", en: "Night EN" } });
    const b = await newProduct();
    const inactive = await newProduct();
    for (const id of [a, b, inactive]) await addPrice(id, "public", 9500);
    await addPrice(b, "member", 8500);
    for (const id of [a, b]) await cat.setProductActiveRecord(ctx(), { productId: id, isActive: true });
    const fr = await cat.getProductCards(h.db, [b, inactive, a], "fr-BE");
    expect(fr.map((c) => c.productId)).toEqual([b, a]);
    expect(fr[1]).toMatchObject({ name: "Nuit FR", priceCents: 9500, memberPriceCents: null, imageUrl: null });
    expect(fr[0]).toMatchObject({ name: "Séance de jour", memberPriceCents: 8500 });
    expect(fr[1]!.url).toMatch(/\/fr\/account\/shop\/CAT-/);
    const nl = await cat.getProductCards(h.db, [a], "nl-BE");
    expect(nl[0]).toMatchObject({ name: "Nacht NL" });
    expect(nl[0]!.url).toMatch(/\/nl\/account\/shop\//);
  });
});
