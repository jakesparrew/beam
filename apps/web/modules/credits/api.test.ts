import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { creditEntries, creditGrants, orderLines, orders } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct, type ProductRow } from "@beam/db/testing";
import { NotImplementedError } from "@beam/core/errors";
import { computeExpiresAt } from "@beam/core/credits";
import { asc, eq } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import {
  activateMembership,
  checkCredits,
  consumeCredits,
  getCreditLiabilityAsOf,
  getEuroBalance,
  getGrantUsage,
  getMembershipForPerson,
  getPersonCreditSummary,
  grantCredits,
  importGrant,
  InsufficientCreditsError,
  releaseCredits,
  resolveReferralCode,
  revokeGrantRemainder,
  SharingNotAllowedError,
} from "./api";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const NOW = new Date();
const DAY = 86_400_000;
const ctx = (now = NOW) => makeCtx(h.db, { now });
const tx = () => h.db as unknown as Tx;
const grantsOfLine = (lineId: string) => h.db.select().from(creditGrants).where(eq(creditGrants.orderLineId, lineId)).orderBy(asc(creditGrants.lineUnitIndex));
const firstEntry = async (grantId: string) => (await h.db.select().from(creditEntries).where(eq(creditEntries.grantId, grantId)))[0]!;

async function makeLine(personId: string, product: ProductRow, quantity: number, lineTotalCents: number) {
  const [order] = await h.db
    .insert(orders)
    .values({ personId, channel: "admin", subtotalCents: lineTotalCents, vatCents: 0, totalCents: lineTotalCents, locale: "nl-BE", clientKey: randomUUID() })
    .returning();
  const [line] = await h.db
    .insert(orderLines)
    .values({
      orderId: order!.id,
      lineNo: 1,
      productId: product.id,
      productKind: product.kind,
      sku: product.sku,
      description: product.name,
      quantity,
      unitAmountCents: Math.round(lineTotalCents / quantity),
      lineTotalCents,
      vatRatePct: product.vatRatePct,
      vatCents: 0,
      pricingTrace: {},
    })
    .returning();
  return line!;
}

describe("grantCredits (commerce paid and redemption transactions)", () => {
  it("a 3-quantity package line called twice yields three grants with units, unit value, expiry, VAT and sharing", async () => {
    const personId = (await makePerson(h.db)).id;
    const product = await makeProduct(h.db, { kind: "package", creditUnits: 10, validityDays: 180, isSharingAllowed: true, maxGuestUsesPerMonth: 3 });
    const line = await makeLine(personId, product, 3, 3 * 13_500);
    const expiresAt = computeExpiresAt(NOW, 180)!;
    const call = (n: number) =>
      grantCredits(tx(), ctx(), {
        personId,
        kind: "day",
        units: 10,
        source: "purchase",
        productId: product.id,
        orderLineId: line.id,
        lineUnitIndex: n,
        unitValueCents: 1_350,
        vatRatePct: 21,
        startsAt: NOW,
        expiresAt,
        key: `grant:order_line:${line.id}:${n}`,
      });
    const first = [await call(1), await call(2), await call(3)];
    const second = [await call(1), await call(2), await call(3)];
    expect(first.every((r) => r.created)).toBe(true);
    expect(second).toEqual(first.map((r) => ({ grantId: r.grantId, created: false })));
    const rows = await grantsOfLine(line.id);
    expect(rows).toHaveLength(3);
    for (const [i, g] of rows.entries()) {
      expect(g).toMatchObject({
        personId,
        lineUnitIndex: i + 1,
        creditKind: "day",
        unitsGranted: 10,
        unitValueCents: 1_350,
        vatRatePct: "21.00",
        vatTreatment: "single_purpose",
        source: "purchase",
        status: "active",
        expiresAt,
        sharing: { mode: "guests", max_guest_uses_per_month: 3, allowed_person_ids: [] },
      });
      expect(await firstEntry(g.id)).toMatchObject({ kind: "grant", quantity: 10, refType: "order_line", refId: line.id, idempotencyKey: `grant:order_line:${line.id}:${i + 1}` });
    }
    const usage = await getGrantUsage(h.db, line.id);
    expect(usage.grants.map((g) => [g.unitsGranted, g.usedUnits, g.remainingUnits, g.status, g.unitValueCents])).toEqual([
      [10, 0, 10, "active", 1_350],
      [10, 0, 10, "active", 1_350],
      [10, 0, 10, "active", 1_350],
    ]);
    await consumeCredits(tx(), ctx(), { personId, beneficiaryPersonId: personId, kind: "day", units: 4, ref: { type: "booking", id: randomUUID() } });
    // Same expiry and start: allocation takes the lowest id, so one package carries the use.
    expect((await getGrantUsage(h.db, line.id)).grants.map((g) => g.usedUnits).sort()).toEqual([0, 0, 4]);
  });

  it("a voucher redemption called twice yields one multi_purpose euro grant owned by the redeemer", async () => {
    const buyer = (await makePerson(h.db)).id;
    const redeemer = (await makePerson(h.db)).id;
    const product = await makeProduct(h.db, { kind: "voucher" });
    const line = await makeLine(buyer, product, 1, 5_000);
    const voucherId = randomUUID();
    const input = {
      personId: redeemer,
      kind: "euro" as const,
      units: 5_000,
      source: "voucher" as const,
      productId: product.id,
      orderLineId: line.id,
      voucherId,
      unitValueCents: 1,
      expiresAt: new Date(NOW.getTime() + 730 * DAY),
      key: `grant:voucher:${voucherId}`,
    };
    const a = await grantCredits(tx(), ctx(), input);
    expect(await grantCredits(tx(), ctx(), input)).toEqual({ grantId: a.grantId, created: false });
    const [g] = await h.db.select().from(creditGrants).where(eq(creditGrants.voucherId, voucherId));
    expect(g).toMatchObject({ personId: redeemer, creditKind: "euro", unitValueCents: 1, vatTreatment: "multi_purpose", source: "voucher", sharing: { mode: "none" } });
    expect(await firstEntry(a.grantId)).toMatchObject({ refType: "voucher", refId: voucherId });
    expect(await getEuroBalance(h.db, redeemer)).toEqual({ remainingCents: 5_000, grants: [{ grantId: a.grantId, remainingCents: 5_000, expiresAt: input.expiresAt }] });
  });

  it("refuses a purchase grant on a voucher order line", async () => {
    const personId = (await makePerson(h.db)).id;
    const line = await makeLine(personId, await makeProduct(h.db, { kind: "voucher" }), 1, 2_500);
    await expect(
      grantCredits(tx(), ctx(), { personId, kind: "day", units: 5, source: "purchase", orderLineId: line.id, lineUnitIndex: 1, expiresAt: null, key: `grant:order_line:${line.id}:1` }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(await grantsOfLine(line.id)).toEqual([]);
  });

  it("a package with a future startsAt is visible but not usable before that date", async () => {
    const personId = (await makePerson(h.db)).id;
    const product = await makeProduct(h.db, { kind: "package", creditUnits: 5 });
    const line = await makeLine(personId, product, 1, 9_000);
    const startsAt = new Date(NOW.getTime() + 20 * DAY);
    await grantCredits(tx(), ctx(), {
      personId,
      kind: "day",
      units: 5,
      source: "purchase",
      orderLineId: line.id,
      lineUnitIndex: 1,
      unitValueCents: 1_800,
      vatRatePct: 21,
      startsAt,
      expiresAt: computeExpiresAt(startsAt, 90),
      key: `grant:order_line:${line.id}:1`,
    });
    const tooEarly = { personId, beneficiaryPersonId: personId, kind: "day" as const, units: 1 };
    expect(await checkCredits(h.db, { ...tooEarly, validAt: new Date(NOW.getTime() + 5 * DAY) })).toEqual({ ok: false, reason: "insufficient", available: 0 });
    await expect(consumeCredits(tx(), ctx(), { ...tooEarly, ref: { type: "booking", id: randomUUID() }, validAt: new Date(NOW.getTime() + 5 * DAY) })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await checkCredits(h.db, { ...tooEarly, validAt: new Date(NOW.getTime() + 21 * DAY) })).toMatchObject({ ok: true });
    expect((await getPersonCreditSummary(h.db, personId)).byKind).toEqual([]);
  });

  it("a partial euro refund restore called twice yields one multi_purpose grant; a full release returns every consume", async () => {
    const personId = (await makePerson(h.db)).id;
    const refundId = randomUUID();
    const restore = { personId, kind: "euro" as const, units: 700, source: "manual" as const, refundId, vatRatePct: null, expiresAt: null, key: `grant:refund:${refundId}`, reason: "partial_refund" };
    const a = await grantCredits(tx(), ctx(), restore);
    expect(await grantCredits(tx(), ctx(), restore)).toEqual({ grantId: a.grantId, created: false });
    const [g] = await h.db.select().from(creditGrants).where(eq(creditGrants.id, a.grantId));
    expect(g).toMatchObject({ vatTreatment: "multi_purpose", unitValueCents: 1, vatRatePct: null, expiresAt: null, sharing: { mode: "none" }, data: { refund_id: refundId } });
    expect(await firstEntry(a.grantId)).toMatchObject({ kind: "grant", refType: "refund", refId: refundId, reason: "partial_refund" });

    const other = await grantCredits(tx(), ctx(), { personId, kind: "euro", units: 1_000, source: "bonus", expiresAt: new Date(NOW.getTime() + 30 * DAY), key: `grant:staff:${randomUUID()}` });
    const order = { type: "order" as const, id: randomUUID() };
    const spent = await consumeCredits(tx(), ctx(), { personId, beneficiaryPersonId: personId, kind: "euro", units: 1_500, ref: order });
    expect(spent.entries.map((e) => [e.grantId, e.quantity])).toEqual([
      [other.grantId, -1_000],
      [a.grantId, -500],
    ]);
    expect(await releaseCredits(tx(), ctx(), { ref: order, reason: "refund" })).toEqual({ releasedUnits: 1_500 });
    expect((await getEuroBalance(h.db, personId)).remainingCents).toBe(1_700);
  });

  it("importGrant twice yields one grant with the import key, fixed validity and original units", async () => {
    const personId = (await makePerson(h.db)).id;
    const importId = randomUUID();
    const input = { personId, productId: null, creditKind: "day" as const, units: 4, expiresAt: new Date(NOW.getTime() + 60 * DAY), idempotencyKey: `import:${importId}:row:7`, originalUnits: 10, unitValueCents: 1_200, legacyId: "L-77" };
    const a = await importGrant(tx(), ctx(), input);
    expect(await importGrant(tx(), ctx(), input)).toEqual({ grantId: a.grantId, created: false });
    const [g] = await h.db.select().from(creditGrants).where(eq(creditGrants.personId, personId));
    expect(g).toMatchObject({ source: "import", validityRule: "fixed", vatTreatment: "single_purpose", unitsGranted: 4, unitValueCents: 1_200, data: { original_units: 10, legacy_id: "L-77", import_id: importId } });
    expect(await firstEntry(a.grantId)).toMatchObject({ idempotencyKey: `grant:import:${importId}:row:7`, refType: "import", refId: importId });
    const summary = await getPersonCreditSummary(h.db, personId);
    expect(summary).toMatchObject({ byKind: [{ kind: "day", remainingUnits: 4 }], membership: null, status: "customer", derivedStatus: "customer" });
  });

  it("checkCredits reports sharing refusals without writing", async () => {
    const personId = (await makePerson(h.db)).id;
    const guest = (await makePerson(h.db)).id;
    await importGrant(tx(), ctx(), { personId, productId: null, creditKind: "night", units: 2, expiresAt: null, idempotencyKey: `import:${randomUUID()}:row:1` });
    expect(await checkCredits(h.db, { personId, beneficiaryPersonId: guest, kind: "night", units: 1, validAt: NOW })).toMatchObject({ ok: false, reason: "not_shareable" });
    await expect(consumeCredits(tx(), ctx(), { personId, beneficiaryPersonId: guest, kind: "night", units: 1, ref: { type: "booking", id: randomUUID() } })).rejects.toBeInstanceOf(SharingNotAllowedError);
  });
});

describe("liability and refunds", () => {
  it("getCreditLiabilityAsOf gives the closing liability of last month", async () => {
    const may = new Date("2020-05-10T10:00:00Z");
    const june = new Date("2020-06-03T10:00:00Z");
    const endOfMay = new Date("2020-05-31T21:59:59.999Z");
    const personId = (await makePerson(h.db)).id;
    const product = await makeProduct(h.db, { kind: "package", creditUnits: 10 });
    const line = await makeLine(personId, product, 1, 15_000);
    await grantCredits(tx(), ctx(may), { personId, kind: "day", units: 10, source: "purchase", orderLineId: line.id, lineUnitIndex: 1, unitValueCents: 1_500, vatRatePct: 21, expiresAt: new Date("2021-05-10T21:59:59.999Z"), key: `grant:order_line:${line.id}:1` });
    await consumeCredits(tx(), ctx(new Date("2020-05-20T10:00:00Z")), { personId, beneficiaryPersonId: personId, kind: "day", units: 3, ref: { type: "booking", id: randomUUID() }, validAt: new Date("2020-05-21T10:00:00Z") });
    await consumeCredits(tx(), ctx(june), { personId, beneficiaryPersonId: personId, kind: "day", units: 2, ref: { type: "booking", id: randomUUID() }, validAt: june });
    expect(await getCreditLiabilityAsOf(h.db, endOfMay)).toEqual([{ kind: "day", vatTreatment: "single_purpose", vatRatePct: 21, remainingUnits: 7, remainingValueCents: 10_500 }]);
    expect(await getCreditLiabilityAsOf(h.db, new Date("2020-06-30T21:59:59.999Z"))).toEqual([{ kind: "day", vatTreatment: "single_purpose", vatRatePct: 21, remainingUnits: 5, remainingValueCents: 7_500 }]);
    expect(await getCreditLiabilityAsOf(h.db, new Date("2020-04-30T21:59:59.999Z"))).toEqual([]);
    const refunded = await revokeGrantRemainder(tx(), ctx(june), { orderLineId: line.id, reason: "refund" });
    expect(refunded.revokedUnits).toBe(5);
  });
});

describe("functions of later packages", () => {
  it("membership functions still throw NotImplementedError; referral hooks are inert", async () => {
    await expect(getMembershipForPerson(h.db, randomUUID())).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      activateMembership(tx(), ctx(), { personId: randomUUID(), productId: randomUUID(), orderId: randomUUID(), priceVersionId: randomUUID(), mandateId: null, startsAt: NOW }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    expect(await resolveReferralCode(h.db, "ABCDEF")).toBeNull();
  });
});
