/**
 * fix-w23-ops-wiring, the screen wiring of the open ops requests: the action dashboard renders a
 * card's second figure (rule 29, the imported webinar leads) and its link to the screen that owns
 * the list (rule 31, credits' sharing review); `/admin/reports` lists the R2 retention reports
 * behind `ff_ops_retention` and the R3 marketing reports behind `ff_ops_marketing`, each only
 * while its flag is on for the viewer.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { featureFlags, roles } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { LOCALES } from "@beam/core/i18n";
import type { ActionCard as ActionCardData } from "./cards";
import type * as DashboardQueries from "./queries";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.23" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

const dashboardCards: { value: ActionCardData[] } = { value: [] };
vi.mock("./queries", async (importOriginal) => ({
  ...(await importOriginal<typeof DashboardQueries>()),
  getActionDashboard: vi.fn(() => Promise.resolve(dashboardCards.value)),
}));

const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { clearFlagCache } = await import("@/lib/flags");
const { adminLocale, translator } = await import("@/lib/i18n");
const { resetRuntime, staffActor } = await import("@/lib/testing");
const { REPORT_PAGES, listReportPages, reportFlagsOn } = await import("../reports/queries");
const { ActionCard } = await import("../ui/ActionCard");
const { SHARING_REVIEW_HREF } = await import("./cards");
const { default: DashboardPage } = await import("@/app/(admin)/admin/dashboard/page");
const { default: ReportsPage } = await import("@/app/(admin)/admin/reports/page");

let h: DbHandle;

async function asStaff(perms: string[]) {
  const user = await makeUser(h.db, { roleKey: "reception" });
  await h.db.update(roles).set({ permissions: perms }).where(eq(roles.key, "reception"));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function setFlag(key: "ff_ops_retention" | "ff_ops_marketing", state: "on" | "off") {
  await h.db.insert(featureFlags).values({ key, state }).onConflictDoUpdate({ target: featureFlags.key, set: { state } });
  clearFlagCache();
}

const readCtx = (permissions: string[]) => ({ tx: h.db, actor: staffActor({ permissions }), now: new Date(), locale: "en" as const });

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await setFlag("ff_ops_retention", "off");
  await setFlag("ff_ops_marketing", "off");
});

const labels = {
  title: "Title",
  count: "3 people",
  empty: "Nothing",
  createTask: "Create task",
  taskCreated: "Created",
  taskExists: "Exists",
  openList: "Open list",
  openPerson: "Open person",
  error: "Error",
  errors: {},
};

describe("ActionCard (rules 29 and 31)", () => {
  it("shows the second figure and the link to the owning screen when given", () => {
    const html = renderToStaticMarkup(
      createElement(ActionCard, {
        cardKey: "shared_package_abuse",
        count: 3,
        rows: [],
        canCreateTask: false,
        listHref: null,
        linkHref: SHARING_REVIEW_HREF,
        labels: { ...labels, secondary: "2 imported from the old webinar tool", link: "Review on the sharing screen" },
      }),
    );
    expect(html).toContain('data-testid="action-card-secondary"');
    expect(html).toContain("2 imported from the old webinar tool");
    expect(html).toContain(`href="${SHARING_REVIEW_HREF}"`);
    expect(html).toContain("Review on the sharing screen");
  });

  it("renders neither without them", () => {
    const html = renderToStaticMarkup(createElement(ActionCard, { cardKey: "vip_inactive", count: 0, rows: [], canCreateTask: false, listHref: null, labels }));
    expect(html).not.toContain("action-card-secondary");
    expect(html).not.toContain("action-card-link");
  });
});

describe("/admin/dashboard renders ActionCard.secondary and ActionCard.linkHref", () => {
  it("the webinar card shows its imported figure and the sharing card links to credits' review", async () => {
    await asStaff(["reports.read"]);
    dashboardCards.value = [
      { key: "webinar_leads_not_booked", count: 5, rows: [], canCreateTask: false, secondary: { key: "imported", count: 2 } },
      { key: "shared_package_abuse", count: 1, rows: [], canCreateTask: false, linkHref: SHARING_REVIEW_HREF },
      { key: "vip_inactive", count: 0, rows: [], canCreateTask: false },
    ];
    const html = renderToStaticMarkup(await DashboardPage({ searchParams: Promise.resolve({}) }));
    const tr = translator(await adminLocale());
    const secondary = tr("ops.dashboard.card.webinar_leads_not_booked.secondary", { count: 2 });
    expect(secondary).toContain("2");
    const webinar = html.slice(html.indexOf('data-testid="action-card-webinar_leads_not_booked"'), html.indexOf('data-testid="action-card-shared_package_abuse"'));
    expect(webinar).toContain(secondary.replace(/'/g, "&#x27;"));
    const sharing = html.slice(html.indexOf('data-testid="action-card-shared_package_abuse"'), html.indexOf('data-testid="action-card-vip_inactive"'));
    expect(sharing).toContain(`href="${SHARING_REVIEW_HREF}"`);
    expect(sharing).toContain(tr("ops.dashboard.card.shared_package_abuse.review"));
    const vip = html.slice(html.indexOf('data-testid="action-card-vip_inactive"'));
    expect(vip).not.toContain("action-card-secondary");
    expect(vip).not.toContain("action-card-link");
  });

  it("the labels exist in all three languages", () => {
    for (const locale of LOCALES) {
      const tr = translator(locale);
      for (const key of ["ops.dashboard.card.webinar_leads_not_booked.secondary", "ops.dashboard.card.shared_package_abuse.review"]) {
        expect(tr(key, { count: 1 }), `${locale} ${key}`).not.toBe(key);
      }
    }
  });
});

describe("REPORT_PAGES (ff_ops_retention, ff_ops_marketing)", () => {
  const retention = ["/admin/reports/no-shows", "/admin/reports/abandoned-checkouts", "/admin/reports/capacity"];
  const marketing = ["/admin/reports/marketing", "/admin/reports/attribution", "/admin/reports/ads"];

  it("lists the retention pages behind ff_ops_retention and the marketing pages behind ff_ops_marketing", () => {
    const flagOf = new Map<string, string | undefined>(REPORT_PAGES.map((p) => [p.href, "flag" in p ? p.flag : undefined]));
    for (const href of retention) expect(flagOf.get(href)).toBe("ff_ops_retention");
    for (const href of marketing) expect(flagOf.get(href)).toBe("ff_ops_marketing");
    expect(flagOf.has("/admin/reports/revenue")).toBe(true);
    expect(flagOf.get("/admin/reports/revenue")).toBeUndefined();
  });

  it("listReportPages shows a flagged page only while its flag is on", () => {
    const ctx = readCtx(["reports.read"]);
    const off = listReportPages(ctx).map((p) => p.href);
    expect(off).toContain("/admin/reports/revenue");
    for (const href of [...retention, ...marketing]) expect(off).not.toContain(href);
    const r2 = listReportPages(ctx, new Set(["ff_ops_retention"])).map((p) => p.href);
    expect(r2).toEqual(expect.arrayContaining(retention));
    for (const href of marketing) expect(r2).not.toContain(href);
    const both = listReportPages(ctx, new Set(["ff_ops_retention", "ff_ops_marketing"])).map((p) => p.href);
    expect(both).toEqual(expect.arrayContaining([...retention, ...marketing, "/admin/reports/revenue"]));
  });

  it("reportFlagsOn reads the viewer's flags", async () => {
    const ctx = readCtx(["reports.read"]);
    expect([...(await reportFlagsOn(ctx))]).toEqual([]);
    await setFlag("ff_ops_marketing", "on");
    expect([...(await reportFlagsOn(ctx))]).toEqual(["ff_ops_marketing"]);
  });

  it("every report title exists in all three languages", () => {
    for (const locale of LOCALES) {
      const tr = translator(locale);
      for (const p of REPORT_PAGES) expect(tr(p.titleKey), `${locale} ${p.titleKey}`).not.toBe(p.titleKey);
    }
  });

  it("/admin/reports links the flagged reports once their flag is on", async () => {
    await asStaff(["reports.read"]);
    let html = renderToStaticMarkup(await ReportsPage());
    expect(html).toContain('href="/admin/reports/revenue"');
    for (const href of [...retention, ...marketing]) expect(html).not.toContain(`href="${href}"`);
    await setFlag("ff_ops_retention", "on");
    await setFlag("ff_ops_marketing", "on");
    html = renderToStaticMarkup(await ReportsPage());
    for (const href of [...retention, ...marketing]) expect(html).toContain(`href="${href}"`);
  });
});
