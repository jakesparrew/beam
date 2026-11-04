/**
 * credits views (credits-P1): balances, customer totals, commercial status, liability, euro
 * voucher redemptions and monthly movements, on a fresh PGlite database.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, DbOrTx } from "../client";
import { orderLines, orders, type productsKind } from "./commerce";
import { persons } from "./crm";
import {
  vCreditGrantBalances,
  vCreditLiability,
  vCreditMovementsMonthly,
  vEuroVoucherRedemptions,
  vPersonCredits,
  vPersonStatus,
} from "./credits.views";
import { createTestDb, makePerson, makeProduct, makeSession } from "../testing";
import { makeCreditGrant, makeEntry, makeMembership } from "../testing/credits-factories";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

const DAY = 864e5;
type ProductKind = (typeof productsKind.enumValues)[number];

/** An order of `person` with one line per kind; paid now with `totalCents` unless told otherwise. */
async function makeOrder(
  db: DbOrTx,
  personId: string,
  kinds: ProductKind[],
  opts: { totalCents?: number; status?: "paid" | "refunded" | "partially_refunded" | "pending_payment"; paidAt?: Date | null } = {},
) {
  const total = opts.totalCents ?? 5000;
  const status = opts.status ?? "paid";
  const [order] = await db
    .insert(orders)
    .values({
      personId,
      channel: "portal",
      status,
      subtotalCents: total,
      vatCents: 0,
      totalCents: total,
      locale: "nl-BE",
      clientKey: randomUUID(),
      paidAt: opts.paidAt === undefined ? (status === "pending_payment" ? null : new Date()) : opts.paidAt,
    })
    .returning();
  for (const [i, kind] of kinds.entries()) {
    const product = await makeProduct(db, { kind });
    const amount = i === 0 ? total : 0;
    await db.insert(orderLines).values({
      orderId: order!.id,
      lineNo: i + 1,
      productId: product.id,
      sku: product.sku,
      productKind: kind,
      ...(kind === "session" || kind === "night" || kind === "ticket"
        ? { sessionId: (await makeSession(db, { kind: kind === "night" ? "night" : "day" })).id }
        : {}),
      description: { en: kind },
      quantity: 1,
      unitAmountCents: amount,
      lineTotalCents: amount,
      vatRatePct: "21.00",
      vatCents: 0,
      pricingTrace: {},
    });
  }
  return order!;
}

const balance = async (grantId: string) =>
  (await h.db.select().from(vCreditGrantBalances).where(eq(vCreditGrantBalances.grantId, grantId)))[0]!;
const statusOf = async (db: DbOrTx, personId: string) =>
  (await db.select().from(vPersonStatus).where(eq(vPersonStatus.personId, personId)))[0];

describe("v_credit_grant_balances", () => {
  it("is the sum of the ledger, split into used, guest, expired and adjusted units", async () => {
    const owner = await makePerson(h.db);
    const guest = await makePerson(h.db);
    const g = await makeCreditGrant(h.db, { personId: owner.id, units: 10, data: { original_units: 12 } });
    const own = await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -2, beneficiaryPersonId: owner.id });
    await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -1, beneficiaryPersonId: guest.id });
    await makeEntry(h.db, { grantId: g.id, kind: "release", quantity: 2, reversesEntryId: own.id, beneficiaryPersonId: owner.id });
    await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -1, beneficiaryPersonId: owner.id });
    await makeEntry(h.db, { grantId: g.id, kind: "adjust", quantity: -1, reason: "correction" });
    await makeEntry(h.db, { grantId: g.id, kind: "expire", quantity: -3 });
    const b = await balance(g.id);
    expect(b).toMatchObject({
      unitsGranted: 10,
      baseUnits: 12,
      remainingUnits: 10 - 2 - 1 + 2 - 1 - 1 - 3,
      usedUnits: 2,
      guestUnits: 1,
      expiredUnits: 3,
      adjustedUnits: -1,
      isUsable: true,
      personId: owner.id,
      creditKind: "day",
      source: "manual",
    });
    expect(b.lastUsedAt).toBeInstanceOf(Date);
    const [sum] = await h.db.execute<{ s: number }>(sql`select sum(quantity)::int as s from credit_entries where grant_id = ${g.id}`).then((r) => (r as { rows: { s: number }[] }).rows);
    expect(b.remainingUnits).toBe(sum!.s);
  });

  it("is not usable before starts_at, after expires_at, at zero balance or when not active", async () => {
    const future = await makeCreditGrant(h.db, { startsAt: new Date(Date.now() + 2 * DAY), expiresAt: new Date(Date.now() + 30 * DAY) });
    const expired = await makeCreditGrant(h.db, { startsAt: new Date(Date.now() - 30 * DAY), expiresAt: new Date(Date.now() - DAY) });
    const empty = await makeCreditGrant(h.db, { units: 1 });
    await makeEntry(h.db, { grantId: empty.id, kind: "consume", quantity: -1 });
    const revoked = await makeCreditGrant(h.db, { status: "revoked" });
    const noExpiry = await makeCreditGrant(h.db, { creditKind: "euro", units: 500, expiresAt: null });
    expect((await balance(future.id)).isUsable).toBe(false);
    expect((await balance(expired.id)).isUsable).toBe(false);
    expect((await balance(empty.id)).isUsable).toBe(false);
    expect((await balance(revoked.id)).isUsable).toBe(false);
    expect((await balance(noExpiry.id)).isUsable).toBe(true);
    const unentered = await makeCreditGrant(h.db, { withEntry: false });
    expect(await balance(unentered.id)).toMatchObject({ remainingUnits: 0, usedUnits: 0, isUsable: false, lastUsedAt: null });
  });
});

describe("v_person_credits", () => {
  it("sums only usable grants per kind and lists their product ids", async () => {
    const p = await makePerson(h.db);
    const pkgA = await makeProduct(h.db, { kind: "package" });
    const pkgB = await makeProduct(h.db, { kind: "package" });
    const soon = new Date(Date.now() + 5 * DAY);
    await makeCreditGrant(h.db, { personId: p.id, units: 3, productId: pkgA.id, expiresAt: soon });
    await makeCreditGrant(h.db, { personId: p.id, units: 4, productId: pkgB.id });
    await makeCreditGrant(h.db, { personId: p.id, units: 2 }); // no product
    await makeCreditGrant(h.db, { personId: p.id, units: 9, startsAt: new Date(Date.now() + DAY) }); // future
    await makeCreditGrant(h.db, { personId: p.id, units: 9, status: "expired" });
    await makeCreditGrant(h.db, { personId: p.id, creditKind: "night", units: 2, unitValueCents: 12000 });
    await makeCreditGrant(h.db, { personId: p.id, creditKind: "euro", units: 2500 });
    const rows = await h.db.select().from(vPersonCredits).where(eq(vPersonCredits.personId, p.id));
    const day = rows.find((r) => r.creditKind === "day")!;
    expect(day).toMatchObject({ remainingUnits: 9, usableGrants: 3, remainingValueCents: 0 });
    expect(day.nextExpiresAt?.getTime()).toBe(soon.getTime());
    expect([...(day.productIds ?? [])].sort()).toEqual([pkgA.id, pkgB.id].sort());
    expect(rows.find((r) => r.creditKind === "night")).toMatchObject({ remainingUnits: 2, remainingValueCents: 24000, productIds: null });
    expect(rows.find((r) => r.creditKind === "euro")).toMatchObject({ remainingUnits: 2500, remainingValueCents: 2500 });
  });

  it("has no row for a person without usable grants", async () => {
    const p = await makePerson(h.db);
    await makeCreditGrant(h.db, { personId: p.id, status: "exhausted", expiresAt: new Date(Date.now() + DAY) });
    expect(await h.db.select().from(vPersonCredits).where(eq(vPersonCredits.personId, p.id))).toEqual([]);
  });
});

describe("v_person_status", () => {
  it("a new person is a lead", async () => {
    const p = await makePerson(h.db);
    expect(await statusOf(h.db, p.id)).toMatchObject({ derivedStatus: "lead", status: "lead", isMember: false, statusOverride: null, firstPaidAt: null, memberSinceAt: null });
  });

  it("a paid package, session, night, membership or ticket line makes a customer", async () => {
    for (const kind of ["package", "session", "night", "membership", "ticket"] as const) {
      const p = await makePerson(h.db);
      const o = await makeOrder(h.db, p.id, [kind]);
      const s = await statusOf(h.db, p.id);
      expect(s, kind).toMatchObject({ derivedStatus: "customer", status: "customer" });
      expect(s!.firstPaidAt?.getTime()).toBe(o.paidAt!.getTime());
    }
  });

  it("orders of only items or vouchers, a € 0 order and an unpaid order leave a lead", async () => {
    const items = await makePerson(h.db);
    await makeOrder(h.db, items.id, ["item", "voucher"]);
    const free = await makePerson(h.db);
    await makeOrder(h.db, free.id, ["session"], { totalCents: 0 });
    const unpaid = await makePerson(h.db);
    await makeOrder(h.db, unpaid.id, ["package"], { status: "pending_payment" });
    for (const p of [items, free, unpaid]) expect((await statusOf(h.db, p.id))?.derivedStatus).toBe("lead");
    const mixed = await makePerson(h.db);
    await makeOrder(h.db, mixed.id, ["item", "session"]);
    expect((await statusOf(h.db, mixed.id))?.derivedStatus).toBe("customer");
  });

  it("a refunded or partially refunded order keeps the customer", async () => {
    for (const status of ["refunded", "partially_refunded"] as const) {
      const p = await makePerson(h.db);
      await makeOrder(h.db, p.id, ["package"], { status });
      expect((await statusOf(h.db, p.id))?.derivedStatus).toBe("customer");
    }
  });

  it("imported day grants make a customer; imported euro, voucher and bonus grants do not", async () => {
    const day = await makePerson(h.db);
    const start = new Date(Date.now() - 100 * DAY);
    await makeCreditGrant(h.db, { personId: day.id, source: "import", validityRule: "fixed", startsAt: start });
    const s = await statusOf(h.db, day.id);
    expect(s?.derivedStatus).toBe("customer");
    expect(s?.firstPaidAt?.getTime()).toBe(start.getTime());
    const euro = await makePerson(h.db);
    await makeCreditGrant(h.db, { personId: euro.id, source: "import", creditKind: "euro", units: 1000 });
    const bonus = await makePerson(h.db);
    await makeCreditGrant(h.db, { personId: bonus.id, source: "bonus" });
    const voucher = await makePerson(h.db);
    const vOrder = await makeOrder(h.db, (await makePerson(h.db)).id, ["voucher"]);
    const [vLine] = await h.db.select().from(orderLines).where(eq(orderLines.orderId, vOrder.id));
    await makeCreditGrant(h.db, { personId: voucher.id, source: "voucher", creditKind: "euro", units: 5000, orderLineId: vLine!.id });
    for (const p of [euro, bonus, voucher]) expect((await statusOf(h.db, p.id))?.derivedStatus).toBe("lead");
  });

  it("active and past_due memberships make a member with the plan discount", async () => {
    for (const status of ["active", "past_due"] as const) {
      const m = await makeMembership(h.db, { status, discountPct: "15.00" });
      const s = await statusOf(h.db, m.personId);
      expect(s, status).toMatchObject({
        derivedStatus: "member",
        status: "member",
        isMember: true,
        membershipId: m.id,
        membershipStatus: status,
        memberDiscountPct: "15.00",
      });
      expect(s!.membershipPeriodEndAt?.getTime()).toBe(m.currentPeriodEndAt.getTime());
      expect(s!.memberSinceAt?.getTime()).toBe(m.startedAt.getTime());
    }
  });

  it("a membership cancelled while pending does not count; an ended one sets only member_since_at", async () => {
    const start = new Date(Date.now() + 3 * DAY);
    const never = await makeMembership(h.db, { status: "cancelled", endReason: "cancelled_by_customer", startedAt: start, endedAt: new Date() });
    expect(await statusOf(h.db, never.personId)).toMatchObject({ derivedStatus: "lead", memberSinceAt: null, isMember: false });
    const pending = await makeMembership(h.db, { status: "pending", startedAt: start });
    expect(await statusOf(h.db, pending.personId)).toMatchObject({ derivedStatus: "lead", isMember: false, memberDiscountPct: "0" });
    const started = new Date(Date.now() - 60 * DAY);
    const former = await makeMembership(h.db, { status: "expired", startedAt: started, endedAt: new Date(Date.now() - DAY) });
    const s = await statusOf(h.db, former.personId);
    expect(s).toMatchObject({ derivedStatus: "lead", isMember: false });
    expect(s!.memberSinceAt?.getTime()).toBe(started.getTime());
  });

  it("a manual override wins for the status but not for derived_status", async () => {
    const m = await makeMembership(h.db);
    await h.db.update(persons).set({ statusOverride: "customer", statusOverrideReason: "staff decision" }).where(eq(persons.id, m.personId));
    expect(await statusOf(h.db, m.personId)).toMatchObject({ derivedStatus: "member", status: "customer", statusOverride: "customer", isMember: true });
    const lead = await makePerson(h.db, { statusOverride: "member", statusOverrideReason: "partner" });
    expect(await statusOf(h.db, lead.id)).toMatchObject({ derivedStatus: "lead", status: "member" });
  });

  it("excludes erased and merged persons", async () => {
    const erased = await makePerson(h.db, { erasedAt: new Date() });
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db, { mergedIntoPersonId: winner.id });
    expect(await statusOf(h.db, erased.id)).toBeUndefined();
    expect(await statusOf(h.db, loser.id)).toBeUndefined();
    expect(await statusOf(h.db, winner.id)).toBeDefined();
  });

  it("acceptance: a waiting lead who buys is reclassified inside the paying transaction; a staff override lead stays lead", async () => {
    const p = await makePerson(h.db);
    const kept = await makePerson(h.db, { statusOverride: "lead", statusOverrideReason: "staff keeps lead" });
    await h.db.transaction(async (tx) => {
      expect((await statusOf(tx, p.id))?.status).toBe("lead");
      await makeOrder(tx, p.id, ["package"]);
      await makeOrder(tx, kept.id, ["package"]);
      expect((await statusOf(tx, p.id))?.status).toBe("customer");
      expect(await statusOf(tx, kept.id)).toMatchObject({ derivedStatus: "customer", status: "lead" });
    });
    expect((await statusOf(h.db, p.id))?.status).toBe("customer");
  });
});

describe("finance views", () => {
  it("v_credit_liability equals the remaining value of active grants", async () => {
    const p = await makePerson(h.db);
    await makeCreditGrant(h.db, { personId: p.id, source: "purchase", orderLineId: (await lineOf(p.id, "package")).id, lineUnitIndex: 1, units: 10, unitValueCents: 1500, vatRatePct: "6.00" });
    await makeCreditGrant(h.db, { personId: p.id, creditKind: "euro", units: 4000, source: "manual", vatTreatment: "multi_purpose" });
    await makeCreditGrant(h.db, { personId: p.id, status: "expired", units: 3, unitValueCents: 1000 });
    const rows = await h.db.select().from(vCreditLiability);
    const total = rows.reduce((s, r) => s + r.remainingValueCents, 0);
    const [expected] = await h.db
      .execute<{ v: number }>(sql`select coalesce(sum(remaining_units * unit_value_cents), 0)::int as v from v_credit_grant_balances where status = 'active' and remaining_units > 0`)
      .then((r) => (r as { rows: { v: number }[] }).rows);
    expect(total).toBe(expected!.v);
    expect(rows.find((r) => r.creditKind === "day" && r.vatRatePct === "6.00" && r.vatTreatment === "single_purpose")).toMatchObject({
      remainingUnits: 10,
      remainingValueCents: 15000,
      grants: 1,
    });
  });

  it("v_euro_voucher_redemptions lists euro consumes of orders and whether they were released", async () => {
    const p = await makePerson(h.db);
    const g = await makeCreditGrant(h.db, { personId: p.id, creditKind: "euro", units: 5000, source: "manual" });
    const orderA = randomUUID();
    const orderB = randomUUID();
    const a = await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -1200, refType: "order", refId: orderA, beneficiaryPersonId: p.id, data: { vat_at_redemption: true } });
    const b = await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -300, refType: "order", refId: orderB, beneficiaryPersonId: p.id });
    await makeEntry(h.db, { grantId: g.id, kind: "release", quantity: 300, reversesEntryId: b.id, refType: "order", refId: orderB, beneficiaryPersonId: p.id });
    const day = await makeCreditGrant(h.db, { personId: p.id });
    await makeEntry(h.db, { grantId: day.id, kind: "consume", quantity: -1, refType: "booking", refId: randomUUID() });
    const rows = await h.db.select().from(vEuroVoucherRedemptions).where(eq(vEuroVoucherRedemptions.personId, p.id));
    expect(rows.map((r) => ({ id: r.entryId, order: r.orderId, amount: r.amountCents, reversed: r.isReversed })).sort((x, y) => y.amount - x.amount)).toEqual([
      { id: a.id, order: orderA, amount: 1200, reversed: false },
      { id: b.id, order: orderB, amount: 300, reversed: true },
    ]);
  });

  it("v_credit_movements_monthly sums per Brussels month across a month boundary at 23:30 UTC", async () => {
    // A grant with an isolating VAT rate (12 %) and dates in 2020, so other tests do not mix in.
    const p = await makePerson(h.db);
    const g = await makeCreditGrant(h.db, {
      personId: p.id,
      source: "purchase",
      orderLineId: (await lineOf(p.id, "package")).id,
      lineUnitIndex: 1,
      units: 10,
      unitValueCents: 2000,
      vatRatePct: "12.00",
      startsAt: new Date("2020-01-10T10:00:00Z"),
      expiresAt: new Date("2021-01-10T10:00:00Z"),
      withEntry: false,
    });
    await makeEntry(h.db, { grantId: g.id, kind: "grant", quantity: 10, createdAt: new Date("2020-01-10T10:00:00Z") });
    await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -1, createdAt: new Date("2020-01-31T22:30:00Z") }); // 23:30 Brussels, January
    await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -2, createdAt: new Date("2020-01-31T23:30:00Z") }); // 00:30 Brussels, February
    await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -1, createdAt: new Date("2020-02-15T12:00:00Z") });
    await makeEntry(h.db, { grantId: g.id, kind: "expire", quantity: -6, createdAt: new Date("2021-01-10T10:00:00Z") });
    const rows = await h.db.select().from(vCreditMovementsMonthly).where(eq(vCreditMovementsMonthly.vatRatePct, "12.00"));
    const pick = (month: string, kind: string) => rows.find((r) => r.monthOn === month && r.entryKind === kind);
    expect(pick("2020-01-01", "grant")).toMatchObject({ units: 10, valueCents: 20000, creditKind: "day", vatTreatment: "single_purpose" });
    expect(pick("2020-01-01", "consume")).toMatchObject({ units: -1, valueCents: -2000 });
    expect(pick("2020-02-01", "consume")).toMatchObject({ units: -3, valueCents: -6000 });
    expect(pick("2021-01-01", "expire")).toMatchObject({ units: -6, valueCents: -12000 });
    expect(rows).toHaveLength(4);
  });
});

/** An order line of `kind` on a paid order of `personId`. */
async function lineOf(personId: string, kind: ProductKind) {
  const order = await makeOrder(h.db, personId, [kind]);
  const [line] = await h.db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
  return line!;
}
