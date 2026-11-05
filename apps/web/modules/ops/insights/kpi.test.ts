/**
 * ops-P9 `KPI_REGISTRY` and `evaluateKpi` (rule 79): every registry key evaluates on an empty
 * and on a seeded database; the values match the reports they come from; segments restrict the
 * people KPIs; an unknown key, an unsupported period or segment and missing permissions are
 * refused; a definition of 25 widgets is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { companies, dpiaRecords, opportunities, segmentMembers, segments } from "@beam/db/schema";
import { DashboardDefinition, PERIODS } from "@beam/core/ops";
import { ForbiddenError } from "@beam/core/errors";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { ValidationError } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { checkDashboardDefinition, KPI_KEYS, KPI_REGISTRY, MAX_DASHBOARD_WIDGETS, type KpiKey } from "../../../../../packages/core/src/ops/kpis";
import { customerCounts, retentionRates } from "../marketing/management";
import { computeRevenueReport } from "../reports/revenue";
import { daysAgo, makeBooking } from "../stats/ops-p2.fixtures";
import { evaluateKpi } from "./evaluate-kpi";

let h: DbHandle;
// Pinned "now"; fixtures sit at fractional day offsets from it.
const NOW = new Date("2026-10-15T10:00:00.000Z");
const ago = (days: number) => daysAgo(days, NOW);
const ALL_PERMS = ["reports.read", "reports.finance"];
const ctxWith = (permissions: string[] = ALL_PERMS) => ({ tx: h.db, actor: staffActor({ permissions }), now: NOW, locale: "en" as const });

const optsFor = (key: KpiKey, extra: { segmentId?: string } = {}) => ({ period: KPI_REGISTRY[key].periods.includes("month") ? ("month" as const) : KPI_REGISTRY[key].periods[0]!, at: NOW, compare: true, ...extra });

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

describe("KPI_REGISTRY", () => {
  it("has a label key, unit, periods, views and group for every key", () => {
    expect(KPI_KEYS.length).toBeGreaterThan(30);
    for (const key of KPI_KEYS) {
      const d = KPI_REGISTRY[key];
      expect(d.label).toBe(`ops.kpi.${key}`);
      expect(["cents", "count", "pct"]).toContain(d.unit);
      expect(d.periods.length).toBeGreaterThan(0);
      for (const p of d.periods) expect(PERIODS).toContain(p);
      expect(d.views.length).toBeGreaterThan(0);
    }
    // Rules 34-38 and 75 plus the two lists and finance's figures.
    for (const key of ["revenue_net", "sales_by_kind", "customers_new", "repeat_purchase_rate", "b2b_pipeline_value", "leads", "attendance_rate", "retention_candidates_by_reason", "opportunities_by_reason", "finance_net_revenue_cents"]) {
      expect(KPI_KEYS).toContain(key);
    }
    expect(KPI_REGISTRY.finance_net_revenue_cents.permission).toBe("reports.finance");
  });
});

describe("evaluateKpi", () => {
  it("evaluates every registry key on an empty database", async () => {
    const ctx = ctxWith();
    for (const key of KPI_KEYS) {
      const v = await evaluateKpi(ctx, key, optsFor(key));
      expect(v.key, key).toBe(key);
      expect(v.unit).toBe(KPI_REGISTRY[key].unit);
      if (v.unit === "pct") expect(v.current, key).toBeNull();
      else expect(v.current, key).toBe(0);
      if (KPI_REGISTRY[key].snapshot) expect(v.previous, key).toBeNull();
      if (KPI_REGISTRY[key].breakdown) expect(Array.isArray(v.breakdown), key).toBe(true);
    }
  });

  it("evaluates every registry key on a seeded database, matching the source reports", async () => {
    const a = await makePerson(h.db, { isTester: false });
    const b = await makePerson(h.db, { isTester: false });
    await makePaidOrder(h.db, { personId: a.id, lines: [{ productKind: "package", unitAmountCents: 12_100 }], order: { paidAt: ago(3.2) } });
    await makePaidOrder(h.db, { personId: b.id, lines: [{ unitAmountCents: 4_840 }], order: { paidAt: ago(40.2) } });
    await makePaidOrder(h.db, { personId: b.id, lines: [{ unitAmountCents: 2_420 }], order: { paidAt: ago(2.2) } });
    await makeBooking(h.db, { personId: a.id, startsAt: ago(1.2), status: "attended", createdAt: ago(5) });
    const sales = await makeUser(h.db, { roleKey: "sales" });
    const [co] = await h.db.insert(companies).values({ name: "Example BV" }).returning();
    await h.db.insert(opportunities).values([
      { companyId: co!.id, title: "Team days", ownerUserId: sales.id, stage: "proposal", valueCents: 50_000, probabilityPct: 50 },
      { companyId: co!.id, title: "Won", ownerUserId: sales.id, stage: "won", valueCents: 10_000, wonAt: ago(4.2) },
    ]);
    await h.db.insert(dpiaRecords).values({ key: "behavioural_scoring", status: "approved", decisionNote: "test" }).onConflictDoNothing();

    const ctx = ctxWith();
    for (const key of KPI_KEYS) {
      const v = await evaluateKpi(ctx, key, optsFor(key));
      expect(v.key, key).toBe(key);
      if (v.breakdown) expect(v.breakdown.reduce((s, r) => s + r.current, 0), key).toBe(v.current);
    }

    const report = await computeRevenueReport(h.db, { period: "month", at: NOW, vat: "incl" });
    const net = await evaluateKpi(ctx, "revenue_net", { period: "month", at: NOW, compare: true });
    expect(net).toMatchObject({ current: report.net.current, previous: report.net.previous, change: report.net.change, changePct: report.net.changePct });
    expect(net.current).toBe(12_100 + 2_420);
    expect(net.series!.reduce((s, p) => s + p.value, 0)).toBe(net.current);
    const orders = await evaluateKpi(ctx, "revenue_orders", { period: "month", at: NOW, compare: false });
    expect(orders).toMatchObject({ current: 2, previous: null, change: null });

    const kinds = await evaluateKpi(ctx, "sales_by_kind", { period: "month", at: NOW, compare: true });
    expect(kinds.breakdown!.find((r) => r.key === "package")).toMatchObject({ current: 12_100, label: "ops.reports.product_kind.package" });

    const range = { from: new Date("2026-09-30T22:00:00.000Z"), to: new Date("2026-10-15T22:00:00.000Z") };
    const counts = await customerCounts(h.db, range.from, range.to);
    for (const tile of ["new", "active", "returning", "dormant", "reactivated"] as const) {
      expect((await evaluateKpi(ctx, `customers_${tile}`, { period: "month", at: NOW, compare: false })).current, tile).toBe(counts[tile]);
    }
    expect(counts.active).toBe(2);
    const rates = await retentionRates(h.db, range.from, range.to);
    const repeat = await evaluateKpi(ctx, "repeat_purchase_rate", { period: "month", at: NOW, compare: false });
    expect(repeat).toMatchObject({ current: rates.repeat_purchase_rate.rate, ratio: { numerator: 1, denominator: 2 } });

    expect(await evaluateKpi(ctx, "b2b_pipeline_value", optsFor("b2b_pipeline_value"))).toMatchObject({ current: 50_000, previous: null, period: "day" });
    expect(await evaluateKpi(ctx, "b2b_weighted_value", optsFor("b2b_weighted_value"))).toMatchObject({ current: 25_000 });
    expect(await evaluateKpi(ctx, "b2b_conversion", { period: "month", at: NOW, compare: true })).toMatchObject({ current: 1, ratio: { numerator: 1, denominator: 1 } });
  });

  it("restricts people KPIs to a segment", async () => {
    const inSeg = await makePerson(h.db, { isTester: false });
    const outSeg = await makePerson(h.db, { isTester: false });
    await makePaidOrder(h.db, { personId: inSeg.id, order: { paidAt: ago(1.3) } });
    await makePaidOrder(h.db, { personId: outSeg.id, order: { paidAt: ago(1.3) } });
    const [seg] = await h.db.insert(segments).values({ name: "KPI test", kind: "static" }).returning();
    await h.db.insert(segmentMembers).values({ segmentId: seg!.id, personId: inSeg.id, source: "manual" });
    const ctx = ctxWith();
    const all = await evaluateKpi(ctx, "customers_new", { period: "month", at: NOW, compare: false });
    const only = await evaluateKpi(ctx, "customers_new", { period: "month", at: NOW, compare: false, segmentId: seg!.id });
    expect(only.current).toBe(1);
    expect(all.current!).toBeGreaterThan(1);
    const lists = await evaluateKpi(ctx, "opportunities_by_reason", { period: "day", at: NOW, compare: false, segmentId: seg!.id });
    expect(lists.breakdown!.map((r) => r.key)).toEqual(["membership_fit", "package_upgrade", "repurchase_likely", "reactivation_likely", "b2b_link"]);
  });

  it("refuses an unknown key, an unsupported period or segment, and missing permissions", async () => {
    const ctx = ctxWith();
    await expect(evaluateKpi(ctx, "free_sql" as KpiKey, { period: "month", at: NOW, compare: false })).rejects.toBeInstanceOf(ValidationError);
    await expect(evaluateKpi(ctx, "b2b_pipeline_value", { period: "month", at: NOW, compare: false })).rejects.toBeInstanceOf(ValidationError);
    await expect(evaluateKpi(ctx, "revenue_net", { period: "month", at: NOW, compare: false, segmentId: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(ValidationError);
    await expect(evaluateKpi(ctxWith(["tasks.all"]), "revenue_net", { period: "month", at: NOW, compare: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(evaluateKpi(ctxWith(["reports.read"]), "finance_net_revenue_cents", { period: "month", at: NOW, compare: false })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("dashboard definitions (rule 79)", () => {
  const widget = (i: number) => ({ id: `w${i}`, kpi: "revenue_net", period: "month" as const, compare: true, viz: "number" as const });

  it("refuses a definition with 25 widgets", () => {
    const def = { widgets: Array.from({ length: MAX_DASHBOARD_WIDGETS + 1 }, (_, i) => widget(i)) };
    expect(DashboardDefinition.safeParse(def).success).toBe(false);
    expect(checkDashboardDefinition(def)).toContainEqual({ widgetId: null, reason: "too_many_widgets" });
    const ok = { widgets: def.widgets.slice(0, MAX_DASHBOARD_WIDGETS) };
    expect(DashboardDefinition.safeParse(ok).success).toBe(true);
    expect(checkDashboardDefinition(ok)).toEqual([]);
  });

  it("refuses unknown KPIs, unsupported periods, visualisations and segments, and duplicate ids", () => {
    expect(
      checkDashboardDefinition({
        widgets: [
          { ...widget(1), kpi: "select * from persons" },
          { ...widget(2), kpi: "b2b_pipeline_value" },
          { ...widget(3), kpi: "sales_by_kind", viz: "line" },
          { ...widget(4), segmentId: "00000000-0000-4000-8000-000000000000" },
          { ...widget(4), kpi: "customers_new", segmentId: "00000000-0000-4000-8000-000000000000" },
        ],
      }).map((p) => [p.widgetId, p.reason]),
    ).toEqual([
      ["w1", "unknown_kpi"],
      ["w2", "period"],
      ["w3", "viz"],
      ["w4", "segment"],
      ["w4", "duplicate_id"],
    ]);
  });
});
