/**
 * fix-w23-ops-wiring, forms' widget sources on custom dashboards (forms-P10, rule 79): the
 * registry offers `forms.funnel`, `forms.outcomes` and `forms.conversion` with forms' own keys and
 * visualisations (`FORMS_DASHBOARD_SOURCES` of `@/modules/forms/api`), the picker lists them in a
 * "forms" group, and `evaluateKpi` loads them through forms' `loadFormsDashboardSource` for the
 * period's Brussels days (mocked to its contract here, then once for real on an empty database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { checkDashboardDefinition, FORMS_KPI_KEYS, KPI_GROUPS, KPI_REGISTRY } from "@beam/core/ops";
import { LOCALES } from "@beam/core/i18n";
import { createTestDb } from "@beam/db/testing";

vi.mock("@/modules/forms/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), loadFormsDashboardSource: vi.fn() }));

const forms = await import("@/modules/forms/api");
const actual = await vi.importActual<typeof import("@/modules/forms/api")>("@/modules/forms/api");
const { translator } = await import("@/lib/i18n");
const { resetRuntime, staffActor } = await import("@/lib/testing");
const { evaluateKpi } = await import("./evaluate-kpi");
const { evaluateDashboard, getDashboardEditor, kpiCatalogue } = await import("./queries");

let h: DbHandle;
// Pinned: Wednesday 15 October 2026, 12:00 Brussels.
const NOW = new Date("2026-10-15T10:00:00.000Z");
const ctxWith = (permissions: string[] = ["reports.read"]) => ({ tx: h.db, actor: staffActor({ permissions }), now: NOW, locale: "en" as const });
const load = vi.mocked(forms.loadFormsDashboardSource);

const zero = { views: 0, started: 0, engaged: 0, completed: 0, abandoned: 0 };
const FUNNEL = {
  totals: { views: 40, started: 20, engaged: 15, completed: 10, abandoned: 5, completionRate: 0.5 },
  series: [
    { day: "2026-10-13", ...zero, completed: 4 },
    { day: "2026-10-14", ...zero, completed: 6 },
  ],
};
const OUTCOMES = {
  completed: 10,
  rows: [
    { key: "high_stress", label: "high_stress", count: 7, share: 0.7 },
    { key: null, label: "forms.report.no_outcome", count: 3, share: 0.3 },
  ],
};
const CONVERSION = {
  totals: { linked: 8, booked: 3, purchased: 2, revenueCents: 12_000, bookingRate: 0.375, purchaseRate: 0.25 },
  series: [{ day: "2026-10-14", linked: 8, booked: 3, purchased: 2, revenueCents: 12_000 }],
};

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  load.mockReset().mockImplementation(async (_db, key) => (key === "forms.funnel" ? FUNNEL : key === "forms.outcomes" ? OUTCOMES : CONVERSION) as never);
});

describe("KPI_REGISTRY offers forms' widget sources", () => {
  it("has every key of FORMS_DASHBOARD_SOURCES with forms' visualisations, in the forms group", () => {
    expect([...FORMS_KPI_KEYS].sort()).toEqual([...actual.FORMS_DASHBOARD_SOURCE_KEYS].sort());
    expect(KPI_GROUPS).toContain("forms");
    for (const key of actual.FORMS_DASHBOARD_SOURCE_KEYS) {
      const d = KPI_REGISTRY[key];
      expect(d.group).toBe("forms");
      expect(d.unit).toBe("count");
      expect([...d.views].sort()).toEqual([...actual.FORMS_DASHBOARD_SOURCES[key].views].sort());
      expect(d.segmentable).toBe(false);
    }
  });

  it("the picker lists them with labels in all three languages", async () => {
    const keys = kpiCatalogue(staffActor({ permissions: ["reports.read"] })).map((k) => k.key);
    expect(keys).toEqual(expect.arrayContaining([...FORMS_KPI_KEYS]));
    const editor = await getDashboardEditor(ctxWith());
    const funnel = editor.catalogue.find((k) => k.key === "forms.funnel")!;
    expect(funnel.label).toBe(translator("en")("ops.kpi.forms.funnel"));
    for (const locale of LOCALES) {
      const tr = translator(locale);
      for (const key of ["ops.kpi.group.forms", ...FORMS_KPI_KEYS.map((k) => KPI_REGISTRY[k].label)]) expect(tr(key), `${locale} ${key}`).not.toBe(key);
    }
  });

  it("a definition accepts forms widgets and refuses a visualisation forms does not offer", () => {
    expect(checkDashboardDefinition({ widgets: [{ id: "a", kpi: "forms.funnel", period: "month", viz: "line" }] })).toEqual([]);
    expect(checkDashboardDefinition({ widgets: [{ id: "b", kpi: "forms.outcomes", period: "month", viz: "line" }] })).toEqual([{ widgetId: "b", reason: "viz" }]);
  });
});

describe("evaluateKpi loads forms' sources through @/modules/forms/api", () => {
  it("forms.funnel: completed submissions, the stages as rows and the daily series, for the period's Brussels days", async () => {
    const v = await evaluateKpi(ctxWith(), "forms.funnel", { period: "month", at: NOW, compare: false });
    expect(load.mock.calls.map((c) => c.slice(1))).toEqual([["forms.funnel", { from: "2026-10-01", to: "2026-10-15" }]]);
    expect(load.mock.calls[0]![0]).toBe(h.db);
    expect(v).toMatchObject({ key: "forms.funnel", unit: "count", current: 10, previous: null });
    expect(v.breakdown!.map((b) => [b.key, b.label, b.current])).toEqual([
      ["views", "forms.report.views", 40],
      ["started", "forms.report.started", 20],
      ["engaged", "forms.report.engaged", 15],
      ["completed", "forms.report.completed", 10],
      ["abandoned", "forms.report.abandoned", 5],
    ]);
    expect(v.series).toEqual([
      { day: "2026-10-13", value: 4 },
      { day: "2026-10-14", value: 6 },
    ]);
  });

  it("forms.outcomes and forms.conversion, with the previous period when compared", async () => {
    const o = await evaluateKpi(ctxWith(), "forms.outcomes", { period: "month", at: NOW, compare: true });
    // Month to date (rule 34): 1-15 October against 1-15 September, both days inclusive for forms.
    expect(load.mock.calls.map((c) => c.slice(1))).toEqual([
      ["forms.outcomes", { from: "2026-10-01", to: "2026-10-15" }],
      ["forms.outcomes", { from: "2026-09-01", to: "2026-09-15" }],
    ]);
    expect(o).toMatchObject({ current: 10, previous: 10, change: 0 });
    expect(o.breakdown!.map((b) => [b.key, b.label, b.current, b.previous])).toEqual([
      ["high_stress", "high_stress", 7, 7],
      ["none", "forms.report.no_outcome", 3, 3],
    ]);
    const c = await evaluateKpi(ctxWith(), "forms.conversion", { period: "month", at: NOW, compare: false });
    expect(c.current).toBe(3);
    expect(c.breakdown!.map((b) => [b.key, b.current])).toEqual([
      ["linked", 8],
      ["booked", 3],
      ["purchased", 2],
    ]);
    expect(c.series).toEqual([{ day: "2026-10-14", value: 3 }]);
  });

  it("needs reports.read", async () => {
    await expect(evaluateKpi(ctxWith(["credits.read"]), "forms.funnel", { period: "month", at: NOW, compare: false })).rejects.toThrow(/forbidden/i);
    expect(load).not.toHaveBeenCalled();
  });

  it("evaluates on an empty database with forms' real sources", async () => {
    load.mockImplementation(actual.loadFormsDashboardSource as never);
    const results = await evaluateDashboard(
      ctxWith(),
      {
        widgets: [
          { id: "f", kpi: "forms.funnel", period: "last_30d", compare: true, viz: "line" },
          { id: "o", kpi: "forms.outcomes", period: "ytd", compare: false, viz: "table" },
          { id: "c", kpi: "forms.conversion", period: "week", compare: true, viz: "number" },
        ],
      },
      NOW,
    );
    expect(results.map((r) => [r.widgetId, r.error, r.value?.current])).toEqual([
      ["f", null, 0],
      ["o", null, 0],
      ["c", null, 0],
    ]);
  });
});
