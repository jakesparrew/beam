/**
 * ops V1 views (ops spec 2.4) on `createTestDb()`: `v_person_profile`, `v_retention_candidates`
 * (each reason fires at its threshold and not just before), `v_revenue_daily`,
 * `v_no_show_report` and `v_abandoned_checkouts`. Other modules' rows come from the shared
 * factories; tables without a factory (bookings, forms, invoices, checkouts) get minimal rows.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PERSON_PROFILE_V1_COLUMNS, PROFILE_FORBIDDEN_COLUMNS, RETENTION_DEFAULTS, retentionScore } from "@beam/core/ops";
import { SEGMENT_ALLOWED_FIELDS } from "@beam/core/crm";
import type { DbHandle } from "../client";
import { createTestDb, makePerson, makeProduct, makeSession, makeUser } from "../testing";
import { makeOrder, makeOrderLine, makePaidOrder } from "../testing/commerce-factories";
import { makeCreditGrant, makeEntry, makeMembership } from "../testing/credits-factories";
import { SENSITIVE_COLUMNS } from "./_shared";
import { bookings } from "./booking";
import { checkouts, payments, refunds } from "./commerce";
import { companies, personTags, tags } from "./crm";
import { forms, formSubmissions, formVersions } from "./forms";
import { invoices } from "./finance";
import { personStats } from "./ops";
import { settings } from "./platform";

let h: DbHandle;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);
const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => {
  const r = (await h.db.execute(q)) as unknown as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
};
const customer = (over: Parameters<typeof makePerson>[1] = {}) => makePerson(h.db, { isTester: false, ...over });
const candidates = (personId: string, reason: string) =>
  rows<{ reason: string; score: number; ref_id: string; detail: Record<string, unknown> }>(
    sql`select reason, score, ref_id, detail from v_retention_candidates where person_id = ${personId} and reason = ${reason}`,
  );

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("v_person_profile", () => {
  it("has exactly the V1 profile columns, every crm segment field, and no sensitive or contact column", async () => {
    const cols = (
      await rows<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_name = 'v_person_profile' order by ordinal_position`,
      )
    ).map((c) => c.column_name);
    expect(cols).toEqual([...PERSON_PROFILE_V1_COLUMNS]);
    for (const f of SEGMENT_ALLOWED_FIELDS) expect(cols).toContain(f);
    for (const forbidden of [...PROFILE_FORBIDDEN_COLUMNS, ...SENSITIVE_COLUMNS.map((c) => c.column)]) expect(cols).not.toContain(forbidden);
  });

  it("excludes erased, merged and restricted people; testers stay in with is_tester", async () => {
    const kept = await customer();
    const tester = await makePerson(h.db, { isTester: true });
    const erased = await customer({ erasedAt: new Date(), email: null });
    const merged = await customer({ mergedIntoPersonId: kept.id });
    const restricted = await customer({ processingRestrictedAt: new Date() });
    const ids = [kept.id, tester.id, erased.id, merged.id, restricted.id];
    const found = await rows<{ person_id: string; is_tester: boolean }>(
      sql`select person_id, is_tester from v_person_profile where person_id = any(${`{${ids.join(",")}}`}::uuid[])`,
    );
    expect(found.map((r) => r.person_id).sort()).toEqual([kept.id, tester.id].sort());
    expect(found.find((r) => r.person_id === tester.id)?.is_tester).toBe(true);
  });

  it("shows the outcome of the latest completed assessment, also for a version with sensitive fields (forms L6)", async () => {
    const p = await customer();
    const [form] = await h.db.insert(forms).values({ slug: `scan-${randomUUID().slice(0, 8)}`, kind: "assessment", name: { "nl-BE": "Scan", "fr-BE": "Scan", en: "Scan" }, status: "draft" }).returning();
    const [v1] = await h.db
      .insert(formVersions)
      .values({ formId: form!.id, version: 1, definition: {} as never, definitionHash: "a", sensitiveFieldKeys: ["sleep_quality"] })
      .returning();
    const submit = (outcomeKey: string, completedAt: Date, status: "completed" | "started" = "completed") =>
      h.db.insert(formSubmissions).values({ formId: form!.id, formVersionId: v1!.id, personId: p.id, status, outcomeKey, funnel: "test", locale: "nl-BE", completedAt: status === "completed" ? completedAt : null });
    await submit("low_energy", ago(10));
    await submit("high_stress", ago(2));
    await submit("ignored_started", ago(1), "started");
    const [row] = await rows<{ last_assessment_form_slug: string; last_assessment_outcome_key: string }>(
      sql`select last_assessment_form_slug, last_assessment_outcome_key from v_person_profile where person_id = ${p.id}`,
    );
    expect(row).toEqual({ last_assessment_form_slug: form!.slug, last_assessment_outcome_key: "high_stress" });
  });

  it("package_product_ids is the union of v_person_credits.product_ids; credits per kind; is_high_value by tag", async () => {
    const p = await customer();
    const a = await makeProduct(h.db, { kind: "package" });
    const b = await makeProduct(h.db, { kind: "package" });
    await makeCreditGrant(h.db, { personId: p.id, productId: a.id, units: 5 });
    await makeCreditGrant(h.db, { personId: p.id, productId: b.id, creditKind: "night", units: 2 });
    await makeCreditGrant(h.db, { personId: p.id, productId: a.id, units: 1 });
    const [tag] = await h.db.insert(tags).values({ key: RETENTION_DEFAULTS.vip_tag_key, name: { "nl-BE": "VIP", "fr-BE": "VIP", en: "VIP" } }).onConflictDoNothing().returning();
    const vipId = tag?.id ?? (await rows<{ id: string }>(sql`select id from tags where key = 'vip'`))[0]!.id;
    await h.db.insert(personTags).values({ personId: p.id, tagId: vipId, source: "manual", addedBy: { kind: "system", id: null } });
    const [row] = await rows<{ package_product_ids: string[] | string; credits_day_remaining: number; credits_night_remaining: number; is_high_value: boolean; tags: string[] | string }>(
      sql`select package_product_ids, credits_day_remaining, credits_night_remaining, is_high_value, tags from v_person_profile where person_id = ${p.id}`,
    );
    const union = await rows<{ ids: string[] | string }>(
      sql`select coalesce(array_agg(distinct x order by x), '{}') as ids from v_person_credits c, unnest(c.product_ids) x where c.person_id = ${p.id}`,
    );
    const asArray = (v: string[] | string) => (Array.isArray(v) ? v : v.replace(/[{}]/g, "").split(",").filter(Boolean));
    expect(asArray(row!.package_product_ids).sort()).toEqual([a.id, b.id].sort());
    expect(asArray(row!.package_product_ids).sort()).toEqual(asArray(union[0]!.ids).sort());
    expect(row!.credits_day_remaining).toBe(6);
    expect(row!.credits_night_remaining).toBe(2);
    expect(row!.is_high_value).toBe(true);
    expect(asArray(row!.tags)).toEqual(["vip"]);
  });
});

describe("v_retention_candidates (each reason at its threshold)", () => {
  const stats = (personId: string, over: Partial<typeof personStats.$inferInsert>) => h.db.insert(personStats).values({ personId, ...over });

  it("visiting_less fires below the drop ratio with the baseline met, not at the ratio", async () => {
    const fires = await customer();
    const not = await customer();
    const noBaseline = await customer();
    await stats(fires.id, { visitsPrev180d: 3, visitsLast60d: 0, lastActivityAt: ago(70) });
    await stats(not.id, { visitsPrev180d: 3, visitsLast60d: 1, lastActivityAt: ago(10) });
    await stats(noBaseline.id, { visitsPrev180d: 2, visitsLast60d: 0, lastActivityAt: ago(70) });
    const [hit] = await candidates(fires.id, "visiting_less");
    expect(hit).toMatchObject({ score: 30 + 0 + 7, detail: { visits_last_60d: 0, visits_prev_180d: 3, days_since_activity: 70 } });
    expect(await candidates(not.id, "visiting_less")).toEqual([]);
    expect(await candidates(noBaseline.id, "visiting_less")).toEqual([]);
  });

  it("package_nearly_finished fires at 80 % used, not at 70 %", async () => {
    const p = await customer();
    const at80 = await makeCreditGrant(h.db, { personId: p.id, units: 10 });
    await makeEntry(h.db, { grantId: at80.id, kind: "consume", quantity: -8 });
    const at70 = await makeCreditGrant(h.db, { personId: p.id, units: 10 });
    await makeEntry(h.db, { grantId: at70.id, kind: "consume", quantity: -7 });
    const hits = await candidates(p.id, "package_nearly_finished");
    expect(hits.map((x) => x.ref_id)).toEqual([at80.id]);
    expect(hits[0]!.detail).toMatchObject({ grant_id: at80.id, remaining: 2, units_granted: 10 });
  });

  it("package_finished_no_repurchase fires 14 days after the last consume, not at 13, and not after a repurchase", async () => {
    const fires = await customer();
    const tooSoon = await customer();
    const rebought = await customer();
    for (const [p, days] of [[fires, 15], [tooSoon, 13], [rebought, 20]] as const) {
      const g = await makeCreditGrant(h.db, { personId: p.id, units: 1, status: "exhausted" });
      await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -1, createdAt: ago(days) });
    }
    await makeCreditGrant(h.db, { personId: rebought.id, units: 5 });
    expect(await candidates(fires.id, "package_finished_no_repurchase")).toHaveLength(1);
    expect(await candidates(tooSoon.id, "package_finished_no_repurchase")).toEqual([]);
    expect(await candidates(rebought.id, "package_finished_no_repurchase")).toEqual([]);
  });

  it("package_expiring fires within expiry_days with the urgency of retentionScore, not beyond", async () => {
    const p = await customer();
    const soon = await makeCreditGrant(h.db, { personId: p.id, units: 3, expiresAt: new Date(Date.now() + 10 * DAY + 3_600_000) });
    await makeCreditGrant(h.db, { personId: p.id, units: 3, expiresAt: ahead(RETENTION_DEFAULTS.expiry_days + 1) });
    const hits = await candidates(p.id, "package_expiring");
    expect(hits.map((x) => x.ref_id)).toEqual([soon.id]);
    expect(hits[0]!.score).toBe(retentionScore("package_expiring", { revenueCents: 0, daysUntil: 10 }));
  });

  it("high_value_inactive fires at 60 days for revenue >= the threshold, not at 59, not with a future booking", async () => {
    const fires = await customer();
    const recent = await customer();
    const booked = await customer();
    await stats(fires.id, { revenueCents: 100_000, purchases: 2, lastActivityAt: ago(60.5) });
    await stats(recent.id, { revenueCents: 100_000, purchases: 2, lastActivityAt: ago(59.5) });
    await stats(booked.id, { revenueCents: 200_000, purchases: 2, lastActivityAt: ago(90) });
    const s = await makeSession(h.db, { startsAt: ahead(3) });
    await h.db.insert(bookings).values({ sessionId: s.id, personId: booked.id, status: "confirmed", paidWith: "free", source: "admin" });
    const [hit] = await candidates(fires.id, "high_value_inactive");
    expect(hit!.score).toBe(retentionScore("high_value_inactive", { revenueCents: 100_000, daysSinceActivity: 60 }));
    expect(await candidates(recent.id, "high_value_inactive")).toEqual([]);
    expect(await candidates(booked.id, "high_value_inactive")).toEqual([]);
  });

  it("membership_renewal_due fires within renewal_days (+10 with cancel_at), not beyond", async () => {
    const fires = await customer();
    const later = await customer();
    const m = await makeMembership(h.db, { personId: fires.id, startedAt: ago(20), currentPeriodStartAt: ago(20), currentPeriodEndAt: new Date(Date.now() + 5 * DAY + 3_600_000), cancelAt: ahead(5) });
    await makeMembership(h.db, { personId: later.id, startedAt: ago(5), currentPeriodStartAt: ago(5), currentPeriodEndAt: ahead(RETENTION_DEFAULTS.renewal_days + 2) });
    const [hit] = await candidates(fires.id, "membership_renewal_due");
    expect(hit).toMatchObject({ ref_id: m.id, score: retentionScore("membership_renewal_due", { revenueCents: 0, daysUntil: 5, cancelAtSet: true }) });
    expect(await candidates(later.id, "membership_renewal_due")).toEqual([]);
  });

  it("purchased_never_booked fires 14 days after a purchase grant without any booking, not at 13", async () => {
    const fires = await customer();
    const tooSoon = await customer();
    const booked = await customer();
    for (const [p, days] of [[fires, 15], [tooSoon, 13], [booked, 20]] as const) {
      const line = await makeOrderLine(h.db, { productKind: "package" });
      await makeCreditGrant(h.db, { personId: p.id, source: "purchase", orderLineId: line.id, lineUnitIndex: 1, createdAt: ago(days), units: 5 });
    }
    const s = await makeSession(h.db, { startsAt: ago(2) });
    await h.db.insert(bookings).values({ sessionId: s.id, personId: booked.id, status: "attended", attendedAt: ago(2), paidWith: "free", source: "admin" });
    expect(await candidates(fires.id, "purchased_never_booked")).toHaveLength(1);
    expect(await candidates(tooSoon.id, "purchased_never_booked")).toEqual([]);
    expect(await candidates(booked.id, "purchased_never_booked")).toEqual([]);
  });

  it("unused_sessions fires for a grant unused for 45 days, not for one used 44 days ago", async () => {
    const p = await customer();
    const idle = await makeCreditGrant(h.db, { personId: p.id, units: 5, createdAt: ago(100), startsAt: ago(100) });
    await makeEntry(h.db, { grantId: idle.id, kind: "consume", quantity: -1, createdAt: ago(46) });
    const used = await makeCreditGrant(h.db, { personId: p.id, units: 5, createdAt: ago(100), startsAt: ago(100) });
    await makeEntry(h.db, { grantId: used.id, kind: "consume", quantity: -1, createdAt: ago(44) });
    expect((await candidates(p.id, "unused_sessions")).map((x) => x.ref_id)).toEqual([idle.id]);
  });

  it("never lists testers, and a changed setting moves a threshold", async () => {
    const tester = await makePerson(h.db, { isTester: true });
    const g = await makeCreditGrant(h.db, { personId: tester.id, units: 10 });
    await makeEntry(h.db, { grantId: g.id, kind: "consume", quantity: -9 });
    expect(await candidates(tester.id, "package_nearly_finished")).toEqual([]);

    const p = await customer();
    const g2 = await makeCreditGrant(h.db, { personId: p.id, units: 10 });
    await makeEntry(h.db, { grantId: g2.id, kind: "consume", quantity: -6 });
    expect(await candidates(p.id, "package_nearly_finished")).toEqual([]);
    await h.db.insert(settings).values({ key: "retention_defaults", value: { ...RETENTION_DEFAULTS, nearly_finished_pct: 60 } });
    expect(await candidates(p.id, "package_nearly_finished")).toHaveLength(1);
    await h.db.delete(settings).where(sql`key = 'retention_defaults'`);
  });
});

describe("v_revenue_daily", () => {
  const day = (on: string) =>
    rows<{ channel: string; product_kind: string; orders: number; gross_cents: number; vat_cents: number; refunds_cents: number; refunds_vat_cents: number }>(
      sql`select channel, product_kind, orders, gross_cents, vat_cents, refunds_cents, refunds_vat_cents from v_revenue_daily where day_on = ${on}::date order by channel, product_kind`,
    );

  it("puts an order paid at 23:30 UTC on the next Brussels day and excludes testers", async () => {
    const p = await customer();
    const tester = await makePerson(h.db, { isTester: true });
    await makePaidOrder(h.db, { personId: p.id, lines: [{ productKind: "item", unitAmountCents: 12_100 }], order: { paidAt: new Date("2025-06-30T23:30:00Z") } });
    await makePaidOrder(h.db, { personId: tester.id, lines: [{ productKind: "item", unitAmountCents: 5_000 }], order: { paidAt: new Date("2025-07-01T09:00:00Z") } });
    expect(await day("2025-06-30")).toEqual([]);
    expect(await day("2025-07-01")).toEqual([{ channel: "portal", product_kind: "item", orders: 1, gross_cents: 12_100, vat_cents: 2_100, refunds_cents: 0, refunds_vat_cents: 0 }]);
  });

  it("counts a company order without a person", async () => {
    const [company] = await h.db.insert(companies).values({ name: "Example BV" }).returning();
    const order = await makeOrder(h.db, { companyId: company!.id, personId: null, status: "paid", paidAt: new Date("2025-03-03T10:00:00Z"), subtotalCents: 24_200, totalCents: 24_200 });
    await makeOrderLine(h.db, { orderId: order.id, productKind: "item", unitAmountCents: 24_200 });
    expect(await day("2025-03-03")).toMatchObject([{ channel: "admin", product_kind: "item", orders: 1, gross_cents: 24_200 }]);
  });

  it("adds a refund row on the refund day with the credit-note VAT made positive", async () => {
    const p = await customer();
    const { order } = await makePaidOrder(h.db, { personId: p.id, lines: [{ productKind: "item", unitAmountCents: 12_100 }], order: { paidAt: new Date("2025-04-01T10:00:00Z") } });
    const user = await makeUser(h.db, { roleKey: "owner" });
    const [pay] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status: "paid", amountCents: 12_100, paidAt: new Date("2025-04-01T10:00:00Z") }).returning();
    const base = {
      orderId: order.id, personId: p.id, locale: "nl-BE" as const, customerSnapshot: { person_id: p.id } as never, sellerSnapshot: {} as never,
      lines: [{}] as never, vatBreakdown: [] as never, issuedOn: "2025-04-01", fiscalYear: 2025, issuedBy: { kind: "system", id: null } as never,
    };
    const [inv] = await h.db.insert(invoices).values({ ...base, kind: "invoice", number: "BEAM-2025-000901", sequenceNumber: 901, subtotalCents: 10_000, vatCents: 2_100, totalCents: 12_100, status: "paid", paidAt: new Date("2025-04-01T10:00:00Z") }).returning();
    const [cn] = await h.db
      .insert(invoices)
      .values({ ...base, kind: "credit_note", number: "CN-2025-000901", sequenceNumber: 901, subtotalCents: -5_000, vatCents: -1_050, totalCents: -6_050, status: "issued", reversesInvoiceId: inv!.id, reason: "Refund", issuedOn: "2025-04-05" })
      .returning();
    await h.db.insert(refunds).values({ paymentId: pay!.id, orderId: order.id, amountCents: 6_050, reason: "test", lines: [], creditAction: "none", status: "refunded", creditNoteId: cn!.id, createdByUserId: user.id, createdAt: new Date("2025-04-05T10:00:00Z") });
    expect(await day("2025-04-05")).toEqual([{ channel: "portal", product_kind: "refund", orders: 0, gross_cents: 0, vat_cents: 0, refunds_cents: 6_050, refunds_vat_cents: 1_050 }]);
  });
});

describe("v_no_show_report", () => {
  it("counts credits forfeited for a no-show, none for a released cancellation, and flags a BEAM-cancelled session", async () => {
    const p = await customer();
    const s = await makeSession(h.db, { startsAt: ago(3) });
    const grant = await makeCreditGrant(h.db, { personId: p.id, units: 5, unitValueCents: 2_000 });
    const [noShow] = await h.db.insert(bookings).values({ sessionId: s.id, personId: p.id, status: "no_show", paidWith: "credit", source: "admin", noShowMarkedAt: ago(3) }).returning();
    await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -1, refType: "booking", refId: noShow!.id });
    const cancelledSession = await makeSession(h.db, { startsAt: ago(2), status: "cancelled", cancelledAt: ago(4) });
    const [cancelled] = await h.db
      .insert(bookings)
      .values({ sessionId: cancelledSession.id, personId: p.id, status: "cancelled", paidWith: "credit", source: "admin", cancelledAt: ago(4), cancelReasonCode: "session_cancelled" as never })
      .returning();
    const consume = await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -1, refType: "booking", refId: cancelled!.id });
    await makeEntry(h.db, { grantId: grant.id, kind: "release", quantity: 1, refType: "booking", refId: cancelled!.id, reversesEntryId: consume.id });
    const found = await rows<{ booking_id: string; status: string; value_cents: number; credit_units_forfeited: number; is_session_cancelled: boolean; notice_hours: string | null }>(
      sql`select booking_id, status, value_cents, credit_units_forfeited, is_session_cancelled, notice_hours from v_no_show_report where person_id = ${p.id} order by status`,
    );
    expect(found).toMatchObject([
      { booking_id: cancelled!.id, status: "cancelled", value_cents: 2_000, credit_units_forfeited: 0, is_session_cancelled: true },
      { booking_id: noShow!.id, status: "no_show", value_cents: 2_000, credit_units_forfeited: 1, is_session_cancelled: false, notice_hours: null },
    ]);
    expect(Number(found[0]!.notice_hours)).toBe(48);
  });
});

describe("v_abandoned_checkouts", () => {
  it("takes value_cents from checkouts.total_cents, the product mix from items[].productId and the recovered revenue", async () => {
    const p = await customer();
    const a = await makeProduct(h.db, { kind: "package" });
    const b = await makeProduct(h.db, { kind: "item" });
    const { order } = await makePaidOrder(h.db, { personId: p.id, lines: [{ productKind: "item", unitAmountCents: 9_000 }] });
    const [c] = await h.db
      .insert(checkouts)
      .values({
        personId: p.id, channel: "portal", status: "abandoned", items: [{ productId: a.id, quantity: 2 }, { productId: b.id, quantity: 1 }, { productId: a.id, quantity: 1 }],
        totalCents: 9_000, abandonedAt: ago(1), abandonedReason: "payment_failed", recoveredOrderId: order.id, recoveredAt: new Date(),
      })
      .returning();
    await h.db.insert(checkouts).values({ personId: p.id, channel: "portal", status: "started", items: [] });
    const found = await rows<{ checkout_id: string; item_count: number; value_cents: number; product_ids: string[] | string; had_payment_failure: boolean; recovered_revenue_cents: number }>(
      sql`select checkout_id, item_count, value_cents, product_ids, had_payment_failure, recovered_revenue_cents from v_abandoned_checkouts where person_id = ${p.id}`,
    );
    expect(found).toHaveLength(1);
    const ids = Array.isArray(found[0]!.product_ids) ? found[0]!.product_ids : found[0]!.product_ids.replace(/[{}]/g, "").split(",");
    expect(found[0]).toMatchObject({ checkout_id: c!.id, item_count: 4, value_cents: 9_000, had_payment_failure: true, recovered_revenue_cents: 9_000 });
    expect([...ids].sort()).toEqual([a.id, b.id].sort());
  });
});
