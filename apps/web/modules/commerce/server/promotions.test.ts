/**
 * commerce-P3 promotions (rules 13, 17, 18): eligibility for each rule (active, window, channel,
 * crm status, segment, first order, per-person limit, anonymous buyers), the fields locked after
 * first use, code upper-casing and uniqueness, and the per-person limit counting non-released
 * redemptions only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeOrder, makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { promotionRedemptions, promotions } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));
const isInSegment = vi.fn<(db: unknown, segmentId: string, personId: string) => Promise<boolean>>();
vi.mock("@/modules/crm/api", async (importOriginal) => ({ ...(await importOriginal<object>()), isInSegment: (...a: [unknown, string, string]) => isInSegment(...a) }));

const promo = await import("./promotions");
const { eq, setAppDb } = await import("@/lib/ctx");
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
beforeEach(() => {
  isInSegment.mockReset();
  isInSegment.mockResolvedValue(false);
});

const ctx = () => makeCtx(h.db, { actor: staff });
const name = { "nl-BE": "Lentekorting", "fr-BE": "Réduction de printemps", en: "Spring discount" };
const DAY = 86_400_000;
let n = 0;
const code = () => `CODE${Date.now().toString(36).toUpperCase()}${++n}`;

async function create(over: Record<string, unknown> = {}) {
  const input = promo.CreatePromotionInput.parse({ name, kind: "percent", value: 10, startsAt: new Date(Date.now() - DAY), ...over });
  const { promotionId } = await promo.createPromotionRecord(ctx(), input);
  return (await h.db.select().from(promotions).where(eq(promotions.id, promotionId)))[0]!;
}
const eligible = (p: Awaited<ReturnType<typeof create>>, personId: string | null, channel: "portal" | "site" | "pos" = "portal", at = new Date()) =>
  promo.isPromotionEligible(h.db, p, { personId, channel, at });

describe("eligibility (rule 17)", () => {
  it("requires the promotion to be active and inside its window", async () => {
    const person = await makePerson(h.db);
    const live = await create({ code: code() });
    expect(await eligible(live, person.id)).toBe(true);
    expect(await eligible(await create({ code: code(), isActive: false }), person.id)).toBe(false);
    expect(await eligible(await create({ code: code(), startsAt: new Date(Date.now() + DAY) }), person.id)).toBe(false);
    const ended = await create({ code: code(), startsAt: new Date(Date.now() - 3 * DAY), endsAt: new Date(Date.now() - DAY) });
    expect(await eligible(ended, person.id)).toBe(false);
    expect(await eligible(ended, person.id, "portal", new Date(Date.now() - 2 * DAY))).toBe(true);
  });

  it("checks the channel list when set", async () => {
    const person = await makePerson(h.db);
    const p = await create({ code: code(), eligibility: { channels: ["pos"] } });
    expect(await eligible(p, person.id, "pos")).toBe(true);
    expect(await eligible(p, person.id, "portal")).toBe(false);
  });

  it("checks crm's person status, which respects a staff override", async () => {
    const lead = await makePerson(h.db);
    const overridden = await makePerson(h.db, { statusOverride: "member", statusOverrideReason: "Staff decision" });
    const p = await create({ code: code(), eligibility: { statuses: ["member"] } });
    expect(await eligible(p, lead.id)).toBe(false);
    expect(await eligible(p, overridden.id)).toBe(true);
    const forLeads = await create({ code: code(), eligibility: { statuses: ["lead"] } });
    expect(await eligible(forLeads, lead.id)).toBe(true);
  });

  it("asks crm whether the person is in the segment", async () => {
    const person = await makePerson(h.db);
    const segmentId = crypto.randomUUID();
    const p = await create({ code: code(), eligibility: { segmentId } });
    expect(await eligible(p, person.id)).toBe(false);
    isInSegment.mockResolvedValue(true);
    expect(await eligible(p, person.id)).toBe(true);
    expect(isInSegment).toHaveBeenCalledWith(expect.anything(), segmentId, person.id);
  });

  it("first_order_only refuses a person with an earlier paid order", async () => {
    const fresh = await makePerson(h.db);
    const buyer = await makePerson(h.db);
    await makePaidOrder(h.db, { personId: buyer.id });
    const unpaid = await makePerson(h.db);
    await makeOrder(h.db, { personId: unpaid.id, status: "expired" });
    const p = await create({ code: code(), eligibility: { firstOrderOnly: true } });
    expect(await eligible(p, fresh.id)).toBe(true);
    expect(await eligible(p, unpaid.id)).toBe(true);
    expect(await eligible(p, buyer.id)).toBe(false);
  });

  it("lets anonymous buyers use only promotions without segment, status or first-order rules", async () => {
    expect(await eligible(await create({ code: code() }), null)).toBe(true);
    expect(await eligible(await create({ code: code(), eligibility: { channels: ["pos"] } }), null, "pos")).toBe(true);
    expect(await eligible(await create({ code: code(), eligibility: { statuses: ["lead"] } }), null)).toBe(false);
    expect(await eligible(await create({ code: code(), eligibility: { segmentId: crypto.randomUUID() } }), null)).toBe(false);
    expect(await eligible(await create({ code: code(), eligibility: { firstOrderOnly: true } }), null)).toBe(false);
  });

  it("counts only non-released redemptions against max_uses_per_person", async () => {
    const person = await makePerson(h.db);
    const p = await create({ code: code(), maxUsesPerPerson: 2 });
    const redeem = async (status: "reserved" | "confirmed" | "released") => {
      const order = await makeOrder(h.db, { personId: person.id });
      await h.db.insert(promotionRedemptions).values({ promotionId: p.id, orderId: order.id, personId: person.id, status });
    };
    await redeem("released");
    await redeem("released");
    expect(await promo.countPersonRedemptions(h.db, p.id, person.id)).toBe(0);
    expect(await eligible(p, person.id)).toBe(true);
    await redeem("reserved");
    expect(await eligible(p, person.id)).toBe(true);
    await redeem("confirmed");
    expect(await promo.countPersonRedemptions(h.db, p.id, person.id)).toBe(2);
    expect(await eligible(p, person.id)).toBe(false);
    expect(await eligible(p, (await makePerson(h.db)).id)).toBe(true);
  });

  it("loadEligiblePromotions returns live automatic promotions plus the typed code in any state", async () => {
    const person = await makePerson(h.db);
    const auto = await create({ isActive: true, eligibility: { channels: ["site"] } });
    const future = await create({ startsAt: new Date(Date.now() + DAY) });
    const typed = code();
    const inactive = await create({ code: typed, isActive: false });
    const other = await create({ code: code() });
    const list = await promo.loadEligiblePromotions(h.db, { personId: person.id, channel: "site", code: typed.toLowerCase(), at: new Date() });
    const ids = list.map((p) => p.id);
    expect(ids).toContain(auto.id);
    expect(ids).toContain(inactive.id);
    expect(ids).not.toContain(future.id);
    expect(ids).not.toContain(other.id);
    expect(list.find((p) => p.id === auto.id)).toMatchObject({ isEligible: true, code: null, appliesTo: { productIds: [], productKinds: [] } });
    expect(list.find((p) => p.id === inactive.id)).toMatchObject({ isEligible: false, isActive: false, code: typed });
    const portal = await promo.loadEligiblePromotions(h.db, { personId: person.id, channel: "portal", code: null, at: new Date() });
    expect(portal.find((p) => p.id === auto.id)?.isEligible).toBe(false);
  });
});

describe("codes", () => {
  it("are stored upper case and unique", async () => {
    const c = code();
    const p = await create({ code: c.toLowerCase() });
    expect(p.code).toBe(c);
    await expect(create({ code: c.toLowerCase() })).rejects.toMatchObject({ code: "validation", fields: { code: "code_taken" } });
    expect(() => promo.CreatePromotionInput.parse({ name, kind: "percent", value: 10, startsAt: new Date(), code: "ab" })).toThrow();
    expect(() => promo.CreatePromotionInput.parse({ name, kind: "percent", value: 10, startsAt: new Date(), code: "WITH SPACE" })).toThrow();
    expect((await create({ code: "" })).code).toBeNull();
  });

  it("need the name in every locale for a code promotion or an active automatic one", async () => {
    await expect(create({ code: code(), name: { en: "Only English" } })).rejects.toMatchObject({ message: "missing_translation", fields: { name: "nl-BE,fr-BE" } });
    await expect(create({ name: { en: "Only English" } })).rejects.toMatchObject({ fields: { name: "nl-BE,fr-BE" } });
    expect((await create({ name: { en: "Draft" }, isActive: false })).isActive).toBe(false);
  });

  it("validates the value per kind", async () => {
    await expect(create({ code: code(), kind: "percent", value: 150 })).rejects.toMatchObject({ fields: { value: "percent_range" } });
    expect((await create({ code: code(), kind: "fixed", value: 2000 })).value).toBe(2000);
  });
});

describe("locked fields after first use (rule 18)", () => {
  it("refuses kind, value and applies_to changes once used, but allows name, end, limits and active", async () => {
    const p = await create({ code: code(), maxUses: 10 });
    const base = { promotionId: p.id, code: p.code, name, kind: "percent", value: 10, startsAt: p.startsAt, maxUses: 10 };
    // Unused: everything can change.
    await promo.updatePromotionRecord(ctx(), promo.UpdatePromotionInput.parse({ ...base, value: 15 }));
    await h.db.update(promotions).set({ usesCount: 3 }).where(eq(promotions.id, p.id));
    const used = { ...base, value: 15 };
    await expect(promo.updatePromotionRecord(ctx(), promo.UpdatePromotionInput.parse({ ...used, value: 20 }))).rejects.toMatchObject({ code: "conflict", message: "promotion_locked:value" });
    await expect(promo.updatePromotionRecord(ctx(), promo.UpdatePromotionInput.parse({ ...used, kind: "fixed", value: 15 }))).rejects.toMatchObject({ code: "conflict" });
    await expect(
      promo.updatePromotionRecord(ctx(), promo.UpdatePromotionInput.parse({ ...used, appliesTo: { productKinds: ["package"] } })),
    ).rejects.toMatchObject({ message: "promotion_locked:appliesTo" });
    await expect(promo.updatePromotionRecord(ctx(), promo.UpdatePromotionInput.parse({ ...used, maxUses: 2 }))).rejects.toMatchObject({ fields: { maxUses: "below_uses" } });

    const endsAt = new Date(Date.now() + 30 * DAY);
    const renamed = { "nl-BE": "Nieuwe naam", "fr-BE": "Nouveau nom", en: "New name" };
    await promo.updatePromotionRecord(ctx(), promo.UpdatePromotionInput.parse({ ...used, name: renamed, endsAt, maxUses: 3, maxUsesPerPerson: 1, isActive: false }));
    const [after] = await h.db.select().from(promotions).where(eq(promotions.id, p.id));
    expect(after).toMatchObject({ name: renamed, maxUses: 3, maxUsesPerPerson: 1, isActive: false, value: 15, usesCount: 3 });
    expect(after!.endsAt?.getTime()).toBe(endsAt.getTime());
  });
});

