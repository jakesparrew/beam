/**
 * commerce-P9 partner referral codes (R3, `promotions.partner_company_id`): a code can name a
 * crm partner company; an automatic offer or a non-partner company is refused; the partner is
 * locked after the first use; the code is eligible only while the company is a partner; an
 * update that leaves the field out keeps the partner.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { companies, promotions } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const promo = await import("./promotions");
const { eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, staffActor } = await import("@/lib/testing");
const { upsertCompany } = await import("@/modules/crm/api");

let h: DbHandle;
let staff: ReturnType<typeof staffActor>;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  const user = await makeUser(h.db, { roleKey: "sales" });
  staff = staffActor({ userId: user.id, roleKey: "sales", permissions: ["pricing.write"] });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const ctx = () => makeCtx(h.db, { actor: staff });
const name = { "nl-BE": "Partnerkorting", "fr-BE": "Remise partenaire", en: "Partner discount" };
let n = 0;
const code = () => `PART${Date.now().toString(36).toUpperCase()}${++n}`;

async function company(isPartner: boolean): Promise<string> {
  const { companyId } = await upsertCompany(h.db as never, makeCtx(h.db), { name: `Wellness partner ${++n}`, isPartner });
  return companyId;
}

async function create(over: Record<string, unknown>) {
  const input = promo.CreatePromotionInput.parse({ name, kind: "percent", value: 15, startsAt: new Date(Date.now() - 86_400_000), ...over });
  const { promotionId } = await promo.createPromotionRecord(ctx(), input);
  return (await h.db.select().from(promotions).where(eq(promotions.id, promotionId)))[0]!;
}

const baseFields = (p: typeof promotions.$inferSelect) => ({
  promotionId: p.id,
  code: p.code,
  name: p.name,
  kind: p.kind,
  value: p.value,
  startsAt: p.startsAt,
  endsAt: p.endsAt,
  isActive: p.isActive,
});

describe("partner referral codes", () => {
  it("stores the partner of a code promotion", async () => {
    const partnerId = await company(true);
    const p = await create({ code: code(), partnerCompanyId: partnerId });
    expect(p.partnerCompanyId).toBe(partnerId);
  });

  it("refuses a company that is not a partner and an automatic offer with a partner", async () => {
    await expect(create({ code: code(), partnerCompanyId: await company(false) })).rejects.toMatchObject({ code: "validation", fields: { partnerCompanyId: "not_partner" } });
    await expect(create({ partnerCompanyId: await company(true) })).rejects.toMatchObject({ code: "validation", fields: { partnerCompanyId: "partner_needs_code" } });
  });

  it("keeps the partner when an update leaves the field out and locks it after the first use", async () => {
    const partnerId = await company(true);
    const p = await create({ code: code(), partnerCompanyId: partnerId });
    const kept = promo.UpdatePromotionInput.parse({ ...baseFields(p), endsAt: new Date(Date.now() + 86_400_000) });
    await promo.updatePromotionRecord(ctx(), kept);
    expect((await h.db.select().from(promotions).where(eq(promotions.id, p.id)))[0]!.partnerCompanyId).toBe(partnerId);

    const other = await company(true);
    await promo.updatePromotionRecord(ctx(), promo.UpdatePromotionInput.parse({ ...baseFields(p), partnerCompanyId: other }));
    expect((await h.db.select().from(promotions).where(eq(promotions.id, p.id)))[0]!.partnerCompanyId).toBe(other);

    await h.db.update(promotions).set({ usesCount: 1 }).where(eq(promotions.id, p.id));
    const used = (await h.db.select().from(promotions).where(eq(promotions.id, p.id)))[0]!;
    await expect(promo.updatePromotionRecord(ctx(), promo.UpdatePromotionInput.parse({ ...baseFields(used), partnerCompanyId: partnerId }))).rejects.toMatchObject({
      code: "conflict",
      message: "promotion_locked:partnerCompanyId",
    });
    expect(promo.lockedFieldChanges(used, promo.promotionColumns(promo.UpdatePromotionInput.parse({ ...baseFields(used), partnerCompanyId: null })))).toEqual(["partnerCompanyId"]);
  });

  it("refuses clearing the code of a partner promotion", async () => {
    const p = await create({ code: code(), partnerCompanyId: await company(true) });
    await expect(promo.updatePromotionRecord(ctx(), promo.UpdatePromotionInput.parse({ ...baseFields(p), code: "" }))).rejects.toMatchObject({ fields: { partnerCompanyId: "partner_needs_code" } });
  });

  it("is eligible only while the company is still a partner", async () => {
    const person = await makePerson(h.db);
    const partnerId = await company(true);
    const p = await create({ code: code(), partnerCompanyId: partnerId });
    const at = new Date();
    expect(await promo.isPromotionEligible(h.db, p, { personId: person.id, channel: "site", at })).toBe(true);
    expect(await promo.isPromotionEligible(h.db, p, { personId: null, channel: "site", at })).toBe(true);
    await h.db.update(companies).set({ isPartner: false }).where(eq(companies.id, partnerId));
    expect(await promo.isPromotionEligible(h.db, p, { personId: person.id, channel: "site", at })).toBe(false);
    const loaded = await promo.loadEligiblePromotions(h.db, { personId: person.id, channel: "site", code: p.code, at });
    expect(loaded.find((x) => x.id === p.id)?.isEligible).toBe(false);
  });
});
