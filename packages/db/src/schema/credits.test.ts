/**
 * credits schema (credits-P1): every check constraint rejects a bad row and every partial unique
 * index refuses its duplicate, on a fresh PGlite database built from the TypeScript schema.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../client";
import { APPEND_ONLY_TABLES } from "./_shared";
import { orderLines, orders } from "./commerce";
import {
  CREDITS_APPEND_ONLY,
  creditBulkExtensions,
  creditEntries,
  creditGrants,
  creditReconciliationRuns,
  membershipPeriods,
  membershipPlanBenefits,
  membershipPlanInclusions,
  memberships,
  packageShares,
} from "./credits";
import { createTestDb, makePerson, makeProduct, makeUser } from "../testing";
import { makeCreditGrant, makeEntry, makeMembership } from "../testing/credits-factories";
import { CREDITS_RETENTION_POLICIES, CREDITS_SETTINGS_DEFAULT, seed, seedCreditsDefaults, seedCreditsDemo } from "../seed/credits";
import { DEFAULT_SEEDS } from "../seed/index.generated";
import { settings } from "./platform";
import { vPersonCredits, vPersonStatus } from "./credits.views";

/** The Postgres error behind a failed Drizzle query (message, SQLSTATE and constraint). */
async function pgError(promise: Promise<unknown>): Promise<{ message: string; code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause =
      (error as { cause?: { message?: string; code?: string; constraint?: string } }).cause ??
      (error as { message?: string; code?: string; constraint?: string });
    return { message: String(cause.message ?? error), code: cause.code, constraint: cause.constraint };
  }
  throw new Error("expected the query to fail");
}

/** Expects a check violation (23514) naming `constraint`. */
async function rejectsCheck(promise: Promise<unknown>, constraint: string) {
  const err = await pgError(promise);
  expect(err.code, err.message).toBe("23514");
  expect(`${err.constraint ?? ""} ${err.message}`).toContain(constraint);
}

/** Expects a unique violation (23505) naming `constraint`. */
async function rejectsUnique(promise: Promise<unknown>, constraint: string) {
  const err = await pgError(promise);
  expect(err.code, err.message).toBe("23505");
  expect(`${err.constraint ?? ""} ${err.message}`).toContain(constraint);
}

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

const actor = { kind: "system" as const, id: null };

/** A paid order with one line of `kind` and `quantity`. */
async function makeOrderLine(kind: "package" | "voucher" = "package", quantity = 3) {
  const person = await makePerson(h.db);
  const product = await makeProduct(h.db, { kind });
  const unit = 10000;
  const [order] = await h.db
    .insert(orders)
    .values({
      personId: person.id,
      channel: "portal",
      status: "paid",
      subtotalCents: unit * quantity,
      vatCents: 0,
      totalCents: unit * quantity,
      locale: "nl-BE",
      clientKey: randomUUID(),
      paidAt: new Date(),
    })
    .returning();
  const [line] = await h.db
    .insert(orderLines)
    .values({
      orderId: order!.id,
      lineNo: 1,
      productId: product.id,
      sku: product.sku,
      productKind: kind,
      description: { en: "Test line" },
      quantity,
      unitAmountCents: unit,
      lineTotalCents: unit * quantity,
      vatRatePct: "21.00",
      vatCents: 0,
      pricingTrace: {},
    })
    .returning();
  return { person, product, order: order!, line: line! };
}

const grantValues = (personId: string, extra: Partial<typeof creditGrants.$inferInsert> = {}) => ({
  personId,
  creditKind: "day" as const,
  unitsGranted: 5,
  source: "manual" as const,
  ...extra,
});

describe("credits append-only list", () => {
  it("names the module's APPEND tables, all in APPEND_ONLY_TABLES", () => {
    expect(CREDITS_APPEND_ONLY).toEqual(["credit_entries", "membership_periods"]);
    for (const t of CREDITS_APPEND_ONLY) expect(APPEND_ONLY_TABLES).toContain(t);
  });

  it("refuses an update of a ledger entry and of a membership period", async () => {
    const grant = await makeCreditGrant(h.db);
    const err = await pgError(h.db.execute(sql`update credit_entries set reason = 'x' where grant_id = ${grant.id}`));
    expect(err.code).toBe("55000");
    const m = await makeMembership(h.db);
    await h.db.insert(membershipPeriods).values({
      membershipId: m.id,
      personId: m.personId,
      periodStartAt: m.currentPeriodStartAt,
      periodEndAt: m.currentPeriodEndAt,
      source: "purchase",
    });
    const err2 = await pgError(h.db.execute(sql`delete from membership_periods where membership_id = ${m.id}`));
    expect(err2.code).toBe("55000");
  });
});

describe("credit_grants checks", () => {
  it("rejects a euro grant whose unit value is not 1", async () => {
    const p = await makePerson(h.db);
    await rejectsCheck(
      h.db.insert(creditGrants).values(grantValues(p.id, { creditKind: "euro", unitValueCents: 0, vatTreatment: "multi_purpose" })),
      "credit_grants_euro_unit_ck",
    );
  });

  it("rejects a euro grant treated as single-purpose", async () => {
    const p = await makePerson(h.db);
    await rejectsCheck(
      h.db.insert(creditGrants).values(grantValues(p.id, { creditKind: "euro", unitValueCents: 1, vatTreatment: "single_purpose" })),
      "credit_grants_euro_vat_ck",
    );
  });

  it("rejects a day grant treated as multi-purpose", async () => {
    const p = await makePerson(h.db);
    await rejectsCheck(
      h.db.insert(creditGrants).values(grantValues(p.id, { vatTreatment: "multi_purpose" })),
      "credit_grants_multi_purpose_ck",
    );
  });

  it("rejects a purchase without an order line and without a line unit index", async () => {
    const p = await makePerson(h.db);
    await rejectsCheck(
      h.db.insert(creditGrants).values(grantValues(p.id, { source: "purchase", lineUnitIndex: 1, vatTreatment: "single_purpose" })),
      "credit_grants_order_line_ck",
    );
    const { line } = await makeOrderLine();
    await rejectsCheck(
      h.db.insert(creditGrants).values(grantValues(p.id, { source: "purchase", orderLineId: line.id, vatTreatment: "single_purpose" })),
      "credit_grants_purchase_unit_ck",
    );
    await rejectsCheck(
      h.db
        .insert(creditGrants)
        .values(grantValues(p.id, { source: "purchase", orderLineId: line.id, lineUnitIndex: 0, vatTreatment: "single_purpose" })),
      "credit_grants_line_unit_index_ck",
    );
  });

  it("rejects a voucher grant without voucher_id or of a non-euro kind", async () => {
    const { person, line } = await makeOrderLine("voucher", 1);
    const euro = { creditKind: "euro" as const, unitValueCents: 1, vatTreatment: "multi_purpose" as const, source: "voucher" as const };
    await rejectsCheck(
      h.db.insert(creditGrants).values(grantValues(person.id, { ...euro, orderLineId: line.id })),
      "credit_grants_voucher_ck",
    );
    await rejectsCheck(
      h.db.insert(creditGrants).values(
        grantValues(person.id, { source: "voucher", orderLineId: line.id, voucherId: randomUUID(), vatTreatment: "single_purpose" }),
      ),
      "credit_grants_voucher_ck",
    );
  });

  it("rejects a membership grant without membership, zero units, a bad VAT rate and an expiry before the start", async () => {
    const p = await makePerson(h.db);
    await rejectsCheck(h.db.insert(creditGrants).values(grantValues(p.id, { source: "membership" })), "credit_grants_membership_ck");
    await rejectsCheck(h.db.insert(creditGrants).values(grantValues(p.id, { unitsGranted: 0 })), "credit_grants_units_ck");
    await rejectsCheck(h.db.insert(creditGrants).values(grantValues(p.id, { vatRatePct: "7.00" })), "credit_grants_vat_rate_ck");
    const now = new Date();
    await rejectsCheck(
      h.db.insert(creditGrants).values(grantValues(p.id, { startsAt: now, expiresAt: new Date(now.getTime() - 1000) })),
      "credit_grants_expiry_ck",
    );
    await rejectsCheck(h.db.insert(creditGrants).values(grantValues(p.id, { note: "x".repeat(1001) })), "credit_grants_note_ck");
  });

  it("accepts the shapes the services write, with the documented defaults", async () => {
    const p = await makePerson(h.db);
    const [row] = await h.db.insert(creditGrants).values(grantValues(p.id)).returning();
    expect(row).toMatchObject({
      status: "active",
      validityRule: "from_purchase",
      vatTreatment: "not_applicable",
      unitValueCents: 0,
      data: {},
      sharing: { mode: "none", max_guest_uses_per_month: 0, allowed_person_ids: [] },
    });
    expect(row!.statusChangedAt).toBeInstanceOf(Date);
    const voucher = await makeCreditGrant(h.db, { source: "voucher", creditKind: "euro", units: 5000, orderLineId: (await makeOrderLine("voucher", 1)).line.id });
    expect(voucher.vatTreatment).toBe("multi_purpose");
    const member = await makeCreditGrant(h.db, { source: "membership" });
    expect(member.membershipId).not.toBeNull();
  });
});

describe("credit_grants partial uniques", () => {
  it("allows one purchase grant per (order line, unit index)", async () => {
    const { person, line } = await makeOrderLine("package", 3);
    const base = { personId: person.id, source: "purchase" as const, orderLineId: line.id, units: 10 };
    for (const i of [1, 2, 3]) await makeCreditGrant(h.db, { ...base, lineUnitIndex: i });
    await rejectsUnique(makeCreditGrant(h.db, { ...base, lineUnitIndex: 2 }), "credit_grants_order_line_unit_uq");
  });

  it("allows one voucher grant per voucher", async () => {
    const { person, line } = await makeOrderLine("voucher", 1);
    const voucherId = randomUUID();
    const base = { personId: person.id, source: "voucher" as const, creditKind: "euro" as const, orderLineId: line.id, voucherId, units: 2500 };
    await makeCreditGrant(h.db, base);
    await rejectsUnique(makeCreditGrant(h.db, base), "credit_grants_voucher_uq");
  });

  it("allows one membership grant per (membership, kind, period start)", async () => {
    const m = await makeMembership(h.db);
    const base = { personId: m.personId, source: "membership" as const, membershipId: m.id, startsAt: m.currentPeriodStartAt };
    await makeCreditGrant(h.db, base);
    await makeCreditGrant(h.db, { ...base, creditKind: "night" });
    await rejectsUnique(makeCreditGrant(h.db, base), "credit_grants_membership_kind_start_uq");
  });
});

describe("credit_entries checks", () => {
  const entry = (grantId: string, personId: string, extra: Partial<typeof creditEntries.$inferInsert>) => ({
    grantId,
    personId,
    kind: "consume" as const,
    quantity: -1,
    actor,
    idempotencyKey: `test:${randomUUID()}`,
    ...extra,
  });

  it("rejects quantities of the wrong sign", async () => {
    const g = await makeCreditGrant(h.db);
    for (const [kind, quantity] of [
      ["consume", 1],
      ["consume", 0],
      ["expire", 2],
      ["revoke", 1],
      ["transfer_out", 3],
      ["grant", -1],
      ["transfer_in", 0],
    ] as const) {
      await rejectsCheck(h.db.insert(creditEntries).values(entry(g.id, g.personId, { kind, quantity })), "credit_entries_sign_ck");
    }
  });

  it("rejects an adjust without a reason, with a short reason or with quantity 0", async () => {
    const g = await makeCreditGrant(h.db);
    await rejectsCheck(h.db.insert(creditEntries).values(entry(g.id, g.personId, { kind: "adjust", quantity: 1 })), "credit_entries_adjust_ck");
    await rejectsCheck(
      h.db.insert(creditEntries).values(entry(g.id, g.personId, { kind: "adjust", quantity: -1, reason: "  ab  " })),
      "credit_entries_adjust_ck",
    );
    await rejectsCheck(
      h.db.insert(creditEntries).values(entry(g.id, g.personId, { kind: "adjust", quantity: 0, reason: "goodwill" })),
      "credit_entries_adjust_ck",
    );
    await h.db.insert(creditEntries).values(entry(g.id, g.personId, { kind: "adjust", quantity: -1, reason: "goodwill" }));
  });

  it("rejects an extend with a quantity other than 0 or without data.new_expires_at", async () => {
    const g = await makeCreditGrant(h.db);
    const data = { old_expires_at: null, new_expires_at: new Date().toISOString() };
    await rejectsCheck(h.db.insert(creditEntries).values(entry(g.id, g.personId, { kind: "extend", quantity: 1, data })), "credit_entries_extend_ck");
    await rejectsCheck(h.db.insert(creditEntries).values(entry(g.id, g.personId, { kind: "extend", quantity: 0 })), "credit_entries_extend_ck");
    await h.db.insert(creditEntries).values(entry(g.id, g.personId, { kind: "extend", quantity: 0, data }));
  });

  it("rejects a release without reverses_entry_id", async () => {
    const g = await makeCreditGrant(h.db);
    await rejectsCheck(h.db.insert(creditEntries).values(entry(g.id, g.personId, { kind: "release", quantity: 1 })), "credit_entries_release_ck");
  });

  it("rejects an unknown ref_type and a beneficiary on a non-use entry", async () => {
    const g = await makeCreditGrant(h.db);
    await rejectsCheck(
      h.db.insert(creditEntries).values(entry(g.id, g.personId, { refType: "invoice" as never, refId: randomUUID() })),
      "credit_entries_ref_type_ck",
    );
    await rejectsCheck(
      h.db.insert(creditEntries).values(entry(g.id, g.personId, { kind: "grant", quantity: 1, beneficiaryPersonId: g.personId })),
      "credit_entries_beneficiary_ck",
    );
    for (const refType of ["booking", "order", "refund", "privacy_request"] as const) {
      await h.db.insert(creditEntries).values(entry(g.id, g.personId, { refType, refId: randomUUID(), quantity: -1, beneficiaryPersonId: g.personId }));
    }
  });

  it("refuses a duplicate idempotency key and a second release of one consume", async () => {
    const g = await makeCreditGrant(h.db, { units: 3 });
    const consume = await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -1, idempotencyKey: `consume:${randomUUID()}:${g.id}` });
    await rejectsUnique(
      makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -1, idempotencyKey: consume.idempotencyKey }),
      "credit_entries_idempotency_key_unique",
    );
    await makeEntry(h.db, { grantId: g.id, kind: "release", quantity: 1, reversesEntryId: consume.id });
    await rejectsUnique(
      makeEntry(h.db, { grantId: g.id, kind: "release", quantity: 1, reversesEntryId: consume.id }),
      "credit_entries_release_uq",
    );
  });
});

describe("memberships", () => {
  it("allows one active or past_due membership per person", async () => {
    const m = await makeMembership(h.db, { status: "past_due" });
    await rejectsUnique(makeMembership(h.db, { personId: m.personId, status: "active" }), "memberships_person_live_uq");
    // A cancelled one and a pending one may exist beside it.
    await makeMembership(h.db, { personId: m.personId, status: "cancelled" });
    await makeMembership(h.db, { personId: m.personId, status: "pending", startedAt: new Date(Date.now() + 864e5) });
  });

  it("allows one pending membership per person", async () => {
    const start = new Date(Date.now() + 5 * 864e5);
    const m = await makeMembership(h.db, { status: "pending", startedAt: start });
    await rejectsUnique(makeMembership(h.db, { personId: m.personId, status: "pending", startedAt: start }), "memberships_person_pending_uq");
  });

  it("checks the period, the end reason, the discount and the dunning attempt", async () => {
    const now = new Date();
    await rejectsCheck(makeMembership(h.db, { currentPeriodStartAt: now, currentPeriodEndAt: now }), "memberships_period_ck");
    await rejectsCheck(makeMembership(h.db, { status: "active", endReason: "refunded" }), "memberships_end_reason_ck");
    await rejectsCheck(makeMembership(h.db, { status: "expired", endReason: null }), "memberships_end_reason_ck");
    await rejectsCheck(makeMembership(h.db, { discountPct: "100.01" }), "memberships_discount_ck");
    await rejectsCheck(makeMembership(h.db, { dunningAttempt: 4 }), "memberships_dunning_ck");
    const m = await makeMembership(h.db);
    expect(m).toMatchObject({ status: "active", source: "purchase", version: 1, dunningAttempt: 0, discountPct: "0.00" });
  });

  it("keeps one period row per (membership, period start)", async () => {
    const m = await makeMembership(h.db);
    const period = { membershipId: m.id, personId: m.personId, periodStartAt: m.currentPeriodStartAt, periodEndAt: m.currentPeriodEndAt, source: "purchase" as const };
    await h.db.insert(membershipPeriods).values(period);
    await rejectsUnique(h.db.insert(membershipPeriods).values(period), "membership_periods_membership_start_uq");
    await rejectsCheck(
      h.db.insert(membershipPeriods).values({ ...period, periodStartAt: m.currentPeriodEndAt, periodEndAt: m.currentPeriodStartAt }),
      "membership_periods_window_ck",
    );
  });
});

describe("plans, shares, bulk extensions and reconciliation runs", () => {
  it("plan inclusions refuse euro, zero units and a duplicate kind", async () => {
    const plan = await makeProduct(h.db, { kind: "membership" });
    await rejectsCheck(
      h.db.insert(membershipPlanInclusions).values({ productId: plan.id, creditKind: "euro", unitsPerPeriod: 1 }),
      "membership_plan_inclusions_kind_ck",
    );
    await rejectsCheck(
      h.db.insert(membershipPlanInclusions).values({ productId: plan.id, creditKind: "night", unitsPerPeriod: 0 }),
      "membership_plan_inclusions_units_ck",
    );
    await h.db.insert(membershipPlanInclusions).values({ productId: plan.id, creditKind: "night", unitsPerPeriod: 1 });
    await rejectsUnique(
      h.db.insert(membershipPlanInclusions).values({ productId: plan.id, creditKind: "night", unitsPerPeriod: 2 }),
      "membership_plan_inclusions_product_kind_uq",
    );
    const [b] = await h.db
      .insert(membershipPlanBenefits)
      .values({ productId: plan.id, kind: "event_access", text: { "nl-BE": "Toegang", "fr-BE": "Accès", en: "Access" } })
      .returning();
    expect(b).toMatchObject({ sortOrder: 0, isActive: true });
  });

  it("package shares: one creator, positive max_units, one active share per grant and person", async () => {
    const g = await makeCreditGrant(h.db);
    const friend = await makePerson(h.db);
    const staff = await makeUser(h.db);
    await rejectsCheck(
      h.db.insert(packageShares).values({ grantId: g.id, sharedWithPersonId: friend.id }),
      "package_shares_creator_ck",
    );
    await rejectsCheck(
      h.db.insert(packageShares).values({ grantId: g.id, sharedWithPersonId: friend.id, createdByUserId: staff.id, createdByPersonId: g.personId }),
      "package_shares_creator_ck",
    );
    await rejectsCheck(
      h.db.insert(packageShares).values({ grantId: g.id, sharedWithPersonId: friend.id, createdByPersonId: g.personId, maxUnits: 0 }),
      "package_shares_max_units_ck",
    );
    await h.db.insert(packageShares).values({ grantId: g.id, sharedWithPersonId: friend.id, createdByPersonId: g.personId, status: "revoked", revokedAt: new Date() });
    await h.db.insert(packageShares).values({ grantId: g.id, sharedWithPersonId: friend.id, createdByPersonId: g.personId });
    await rejectsUnique(
      h.db.insert(packageShares).values({ grantId: g.id, sharedWithPersonId: friend.id, createdByUserId: staff.id }),
      "package_shares_active_uq",
    );
  });

  it("bulk extensions need a reason and 1 to 90 days", async () => {
    const staff = await makeUser(h.db);
    const filter = { kinds: ["day" as const], sources: ["purchase" as const], expires_from_on: "2026-12-01", expires_to_on: "2026-12-31" };
    await rejectsCheck(
      h.db.insert(creditBulkExtensions).values({ reason: "ab", days: 7, filter, createdByUserId: staff.id }),
      "credit_bulk_extensions_reason_ck",
    );
    await rejectsCheck(
      h.db.insert(creditBulkExtensions).values({ reason: "Closed for works", days: 91, filter, createdByUserId: staff.id }),
      "credit_bulk_extensions_days_ck",
    );
    const [row] = await h.db
      .insert(creditBulkExtensions)
      .values({ reason: "Closed for works", days: 14, filter, createdByUserId: staff.id })
      .returning();
    expect(row).toMatchObject({ status: "pending", matchedCount: 0, extendedCount: 0 });
  });

  it("reconciliation runs have a status exactly when finished", async () => {
    await rejectsCheck(
      h.db.insert(creditReconciliationRuns).values({ startedAt: new Date(), status: "ok" }),
      "credit_reconciliation_runs_finished_ck",
    );
    const [row] = await h.db.insert(creditReconciliationRuns).values({ startedAt: new Date() }).returning();
    expect(row).toMatchObject({ status: null, findings: [], fixed: [], checkedGrants: 0 });
  });

  it("memberships accept a membership-grant reference from credit_grants", async () => {
    const m = await makeMembership(h.db);
    const g = await makeCreditGrant(h.db, { personId: m.personId, source: "membership", membershipId: m.id });
    const rows = await h.db.select().from(memberships).where(sql`${memberships.id} = ${g.membershipId}`);
    expect(rows).toHaveLength(1);
  });
});

const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? res : (res as { rows: T[] }).rows) as T[];

describe("credits seeds", () => {
  it("defaults: registers after platform and ops and seeds the credits setting once", async () => {
    expect(seed.after).toEqual(["platform", "ops"]);
    expect((DEFAULT_SEEDS as readonly { module: string }[]).map((s) => s.module)).toContain("credits");
    await seedCreditsDefaults(h.db);
    await h.db
      .update(settings)
      .set({ value: { ...CREDITS_SETTINGS_DEFAULT, max_extension_years: 3 } })
      .where(sql`${settings.key} = 'credits'`);
    await seedCreditsDefaults(h.db);
    const rows = await h.db.select().from(settings).where(sql`${settings.key} = 'credits'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toMatchObject({ threshold_pcts: [50, 75, 80, 90], max_extension_years: 3 });
  });

  it("defaults: writes the retention policies once ops has created retention_policies", async () => {
    await h.db.execute(sql`create table if not exists retention_policies (
      id uuid primary key default gen_random_uuid(), key text not null unique, table_name text not null,
      days integer, action text not null, description text not null)`);
    await seedCreditsDefaults(h.db);
    await seedCreditsDefaults(h.db);
    const rows = rowsOf<{ key: string; days: number }>(
      await h.db.execute(sql`select key, days from retention_policies where key like 'credits.%' order by key`),
    );
    expect(Object.fromEntries(rows.map((r) => [r.key, r.days]))).toEqual({
      "credits.ledger": 3653,
      "credits.memberships": 3653,
      "credits.reconciliation_runs": 365,
      "credits.sharing_reviews": 730,
    });
    expect(rows).toHaveLength(CREDITS_RETENTION_POLICIES.length);
    await h.db.execute(sql`drop table retention_policies`);
  });

  it("demo: package, 3-unit line, voucher, active, past-due and pending memberships, plan benefits; idempotent", async () => {
    const pkg = await makeOrderLine("package", 1);
    const three = await makeOrderLine("package", 3);
    const voucher = await makeOrderLine("voucher", 1);
    const plan = await makeProduct(h.db, { kind: "membership", memberDiscountPct: "10.00" });
    const nextPlan = await makeProduct(h.db, { kind: "membership", recurringInterval: "year" });
    const member = await makePerson(h.db);
    const pastDue = await makePerson(h.db);
    const input = {
      now: new Date(),
      packageCustomer: { personId: pkg.person.id, productId: pkg.product.id, orderLineId: pkg.line.id },
      threeUnitLine: { personId: three.person.id, productId: three.product.id, orderLineId: three.line.id, units: 5, unitValueCents: 2000 },
      voucher: { personId: voucher.person.id, orderLineId: voucher.line.id, voucherId: randomUUID(), amountCents: 5000 },
      plan: { productId: plan.id, nextPlanProductId: nextPlan.id },
      memberPersonId: member.id,
      pastDuePersonId: pastDue.id,
    };
    const first = await seedCreditsDemo(h.db, input);
    const second = await seedCreditsDemo(h.db, input);
    expect(second).toEqual(first);
    expect(first.grantIds).toHaveLength(6);
    const credits = (personId: string) => h.db.select().from(vPersonCredits).where(sql`${vPersonCredits.personId} = ${personId}`);
    expect(await credits(pkg.person.id)).toMatchObject([{ creditKind: "day", remainingUnits: 3 }]);
    expect(await credits(three.person.id)).toMatchObject([{ creditKind: "day", remainingUnits: 15, usableGrants: 3 }]);
    expect(await credits(voucher.person.id)).toMatchObject([{ creditKind: "euro", remainingUnits: 5000 }]);
    expect(await credits(member.id)).toMatchObject([{ creditKind: "day", remainingUnits: 4 }]);
    const status = async (personId: string) =>
      (await h.db.select().from(vPersonStatus).where(sql`${vPersonStatus.personId} = ${personId}`))[0]!;
    expect(await status(member.id)).toMatchObject({ status: "member", membershipStatus: "active", memberDiscountPct: "10.00" });
    expect(await status(pastDue.id)).toMatchObject({ status: "member", membershipStatus: "past_due" });
    const rows = await h.db.select().from(memberships).where(sql`${memberships.personId} = ${member.id}`);
    expect(rows.map((r) => r.status).sort()).toEqual(["active", "pending"]);
    const benefits = await h.db.select().from(membershipPlanBenefits).where(sql`${membershipPlanBenefits.productId} = ${plan.id}`);
    expect(benefits).toHaveLength(4);
    for (const b of benefits) expect(Object.keys(b.text).sort()).toEqual(["en", "fr-BE", "nl-BE"]);
  });
});
