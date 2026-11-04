/**
 * commerce-P3 `getQuote` (rules 7, 8, 13, 17 and 26c): member pricing follows
 * `credits.getMembershipForPerson(...).isMember`, never crm's status override; a guest quotes as
 * `public`; a company quotes `b2b`; a membership line carries `already_member` or
 * `pending_exists` from `credits.canStartMembership(personId, {startsOn})`; person prices and
 * promotion codes reach the pure `quote()`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { companies, personPrices, priceVersions, promotions } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

type Membership = { isMember: boolean; membershipId: string | null; planProductId: string | null; discountPct: number; status: "active" | "past_due" | null; periodEndAt: Date | null; cancelAt: Date | null };
const noMembership: Membership = { isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null };
const getMembershipForPerson = vi.fn<(db: unknown, personId: string) => Promise<Membership>>();
const canStartMembership = vi.fn<(db: unknown, personId: string, opts?: { startsOn?: string }) => Promise<{ ok: true } | { ok: false; reason: "already_member" | "pending_exists" }>>();
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMembershipForPerson: (...a: [unknown, string]) => getMembershipForPerson(...a),
  canStartMembership: (...a: [unknown, string, { startsOn?: string }?]) => canStartMembership(...a),
}));

const { getQuote } = await import("./server/catalogue");
const { setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  getMembershipForPerson.mockReset();
  getMembershipForPerson.mockResolvedValue(noMembership);
  canStartMembership.mockReset();
  canStartMembership.mockResolvedValue({ ok: true });
});

const member = (discountPct = 10): Membership => ({ ...noMembership, isMember: true, membershipId: randomUUID(), discountPct, status: "active" });

async function sessionProduct(publicCents: number, memberCents?: number, b2bCents?: number) {
  const p = await makeProduct(h.db, { kind: "night", priceCents: publicCents });
  if (memberCents !== undefined) await h.db.insert(priceVersions).values({ productId: p.id, version: 1, audience: "member", amountCents: memberCents });
  if (b2bCents !== undefined) await h.db.insert(priceVersions).values({ productId: p.id, version: 1, audience: "b2b", amountCents: b2bCents });
  return p;
}

describe("getQuote member detection (rule 8)", () => {
  it("uses getMembershipForPerson.isMember, not crm's status override", async () => {
    const p = await sessionProduct(9500, 8000);
    const overridden = await makePerson(h.db, { statusOverride: "member", statusOverrideReason: "Staff decision" });
    const q1 = await getQuote(h.db, { personId: overridden.id, items: [{ productId: p.id, quantity: 1 }], channel: "portal" });
    expect(getMembershipForPerson).toHaveBeenCalledWith(expect.anything(), overridden.id);
    expect(q1.totalCents).toBe(9500);
    expect(q1.lines[0]!.trace).toMatchObject({ isMember: false, personStatus: "member", winner: "base" });

    const real = await makePerson(h.db);
    getMembershipForPerson.mockResolvedValue(member());
    const q2 = await getQuote(h.db, { personId: real.id, items: [{ productId: p.id, quantity: 2 }], channel: "portal" });
    expect(q2.lines[0]).toMatchObject({ unitAmountCents: 9500, discountCents: 3000, lineTotalCents: 16000 });
    expect(q2.lines[0]!.trace).toMatchObject({ isMember: true, personStatus: "lead", winner: "member_version" });
  });

  it("applies the membership's discount when the product has no member version or own discount", async () => {
    const p = await sessionProduct(10000);
    const person = await makePerson(h.db);
    getMembershipForPerson.mockResolvedValue(member(10));
    const q = await getQuote(h.db, { personId: person.id, items: [{ productId: p.id, quantity: 1 }], channel: "portal" });
    expect(q.totalCents).toBe(9000);
    expect(q.lines[0]!.trace.winner).toBe("member_discount");
  });
});

describe("getQuote audiences (rule 7)", () => {
  it("quotes a guest as public without asking credits", async () => {
    const p = await sessionProduct(9500, 8000);
    const q = await getQuote(h.db, { personId: null, items: [{ productId: p.id, quantity: 1 }], channel: "site" });
    expect(getMembershipForPerson).not.toHaveBeenCalled();
    expect(q.totalCents).toBe(9500);
    expect(q.lines[0]!.trace).toMatchObject({ audience: "public", isMember: false, personStatus: null });
  });

  it("quotes a company order as b2b", async () => {
    const p = await sessionProduct(9500, undefined, 7500);
    const [company] = await h.db.insert(companies).values({ name: `Quote Co ${randomUUID().slice(0, 6)}` }).returning();
    const q = await getQuote(h.db, { personId: null, companyId: company!.id, items: [{ productId: p.id, quantity: 1 }], channel: "admin" });
    expect(q.lines[0]).toMatchObject({ unitAmountCents: 7500, lineTotalCents: 7500 });
    expect(q.lines[0]!.trace.audience).toBe("b2b");
  });

  it("drops an unknown product with product_unavailable", async () => {
    const q = await getQuote(h.db, { personId: null, items: [{ productId: randomUUID(), quantity: 1 }], channel: "portal" });
    expect(q.lines).toHaveLength(0);
    expect(q.warnings).toEqual([expect.objectContaining({ code: "product_unavailable" })]);
  });
});

describe("getQuote membership lines (rule 26c)", () => {
  it("returns already_member from canStartMembership(personId, {startsOn})", async () => {
    const plan = await makeProduct(h.db, { kind: "membership", priceCents: 8900 });
    const person = await makePerson(h.db);
    canStartMembership.mockResolvedValue({ ok: false, reason: "already_member" });
    const q = await getQuote(h.db, { personId: person.id, items: [{ productId: plan.id, quantity: 1, startOn: "2026-12-01" }], channel: "portal" });
    expect(canStartMembership).toHaveBeenCalledWith(expect.anything(), person.id, { startsOn: "2026-12-01" });
    expect(q.warnings).toContainEqual({ code: "already_member", productId: plan.id });
    expect(q.totalCents).toBe(8900);
  });

  it("returns pending_exists and does not ask for a non-membership basket", async () => {
    const plan = await makeProduct(h.db, { kind: "membership", priceCents: 8900 });
    const other = await sessionProduct(4500);
    const person = await makePerson(h.db);
    await getQuote(h.db, { personId: person.id, items: [{ productId: other.id, quantity: 1 }], channel: "portal" });
    expect(canStartMembership).not.toHaveBeenCalled();
    canStartMembership.mockResolvedValue({ ok: false, reason: "pending_exists" });
    const q = await getQuote(h.db, { personId: person.id, items: [{ productId: plan.id, quantity: 1 }], channel: "portal" });
    expect(q.warnings).toContainEqual({ code: "pending_exists", productId: plan.id });
  });
});

describe("getQuote person prices and promotions", () => {
  it("uses a valid person price and ignores a revoked one", async () => {
    const p = await sessionProduct(9500);
    const person = await makePerson(h.db);
    await h.db.insert(personPrices).values({ personId: person.id, productId: p.id, amountCents: 5000, reason: "Revoked", createdByUserId: staffUserId, revokedAt: new Date() });
    expect((await getQuote(h.db, { personId: person.id, items: [{ productId: p.id, quantity: 1 }], channel: "pos" })).totalCents).toBe(9500);
    await h.db.insert(personPrices).values({ personId: person.id, productId: p.id, amountCents: 6000, reason: "Partner rate", createdByUserId: staffUserId });
    const q = await getQuote(h.db, { personId: person.id, items: [{ productId: p.id, quantity: 1 }], channel: "pos" });
    expect(q.totalCents).toBe(6000);
    expect(q.lines[0]!.trace.winner).toBe("person_price");
  });

  it("applies an eligible code and warns about an unknown one", async () => {
    const p = await sessionProduct(10000);
    const code = `Q${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const name = { "nl-BE": "Korting", "fr-BE": "Réduction", en: "Discount" };
    const [promo] = await h.db
      .insert(promotions)
      .values({ code, name, kind: "percent", value: 20, startsAt: new Date(Date.now() - 86_400_000), createdByUserId: staffUserId })
      .returning();
    const q = await getQuote(h.db, { personId: null, items: [{ productId: p.id, quantity: 1 }], promoCode: code.toLowerCase(), channel: "site" });
    expect(q).toMatchObject({ totalCents: 8000, promotionId: promo!.id, warnings: [] });
    const unknown = await getQuote(h.db, { personId: null, items: [{ productId: p.id, quantity: 1 }], promoCode: "NOSUCHCODE", channel: "site" });
    expect(unknown.totalCents).toBe(10000);
    expect(unknown.warnings).toContainEqual({ code: "promo_unknown" });
  });
});
