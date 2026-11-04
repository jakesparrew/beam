/**
 * commerce-P3 seeds: the `defaults` profile writes the two settings rows without overwriting a
 * staff change; the demo catalogue creates the products of runbook 6.3 (all activatable: complete
 * texts and a public price, the custom voucher excepted), the two-version price history of the
 * 10-day package and both promotions, and a second run creates nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { priceVersions, products, promotions, settings } from "@beam/db/schema";
import { COMMERCE_SETTINGS_DEFAULTS, CommerceSettings, PaymentProviderByChannel } from "@beam/core/commerce";
import { missingLocales, type LocalizedText } from "@beam/core/i18n";
import { DEMO_SKUS, seed, seedCommerceCatalogue } from "@beam/db/seed/commerce";
import { asc, eq } from "@/lib/ctx";
import { getProductPrice } from "./server/catalogue";

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("commerce defaults seed", () => {
  it("writes valid settings rows once and keeps a changed value", async () => {
    await seed.run(h.db, {});
    const [row] = await h.db.select().from(settings).where(eq(settings.key, "commerce"));
    expect(CommerceSettings.parse(row!.value)).toEqual(COMMERCE_SETTINGS_DEFAULTS);
    const [providers] = await h.db.select().from(settings).where(eq(settings.key, "payment_provider_by_channel"));
    expect(PaymentProviderByChannel.parse(providers!.value)).toMatchObject({ portal: "mollie", pos: "mollie" });
    await h.db.update(settings).set({ value: { ...COMMERCE_SETTINGS_DEFAULTS, order_expiry_minutes: 45 } }).where(eq(settings.key, "commerce"));
    await seed.run(h.db, {});
    const [after] = await h.db.select().from(settings).where(eq(settings.key, "commerce"));
    expect((after!.value as { order_expiry_minutes: number }).order_expiry_minutes).toBe(45);
  });
});

describe("commerce demo catalogue", () => {
  it("creates the catalogue, price history and promotions idempotently", async () => {
    const now = new Date("2026-11-04T23:00:00.000Z");
    const staff = await makeUser(h.db, { roleKey: "owner" });
    const first = await seedCommerceCatalogue(h.db, { now, staffUserId: staff.id });
    expect(Object.keys(first.productIds).sort()).toEqual(Object.values(DEMO_SKUS).sort());
    expect(first.created).toBeGreaterThan(9);

    const rows = await h.db.select().from(products);
    for (const p of rows.filter((r) => Object.values(DEMO_SKUS).includes(r.sku as never))) {
      expect(p.isActive, p.sku).toBe(true);
      expect(missingLocales(p.name as LocalizedText), p.sku).toEqual([]);
      expect(missingLocales(p.description as LocalizedText), p.sku).toEqual([]);
      if (!p.isCustomAmount) expect(await getProductPrice(h.db, p.id, "public", now), p.sku).not.toBeNull();
    }

    const tenDays = first.productIds[DEMO_SKUS.package10Days]!;
    const versions = await h.db.select().from(priceVersions).where(eq(priceVersions.productId, tenDays)).orderBy(asc(priceVersions.version));
    expect(versions.map((v) => v.amountCents)).toEqual([36_000, 38_000]);
    expect((await getProductPrice(h.db, tenDays, "public", now))?.amountCents).toBe(38_000);
    expect((await getProductPrice(h.db, tenDays, "public", new Date("2026-09-15T10:00:00Z")))?.amountCents).toBe(36_000);

    const welcome = (await h.db.select().from(promotions).where(eq(promotions.code, "WELKOM10")))[0]!;
    expect(welcome).toMatchObject({ kind: "percent", value: 10, maxUsesPerPerson: 1, eligibility: { first_order_only: true } });
    const winter = (await h.db.select().from(promotions).where(eq(promotions.id, first.promotionIds["NIGHTS-WINTER"]!)))[0]!;
    expect(winter).toMatchObject({ code: null, kind: "fixed", value: 2_000, appliesTo: { product_ids: [first.productIds[DEMO_SKUS.package2Nights]] } });

    const second = await seedCommerceCatalogue(h.db, { now, staffUserId: staff.id });
    expect(second.created).toBe(0);
    expect(second.productIds).toEqual(first.productIds);
    expect(second.promotionIds).toEqual(first.promotionIds);
  });
});
