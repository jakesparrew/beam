/**
 * platform-P14 registry seam (PL-96, gap G12): the R3 reports and the management dashboard are
 * registered where the CSV export and the dashboard pages read them, with real module code on
 * PGlite after the full demo seed (`runSeed` with the generated `DEMO_SEEDS`). Only Next.js
 * request APIs are mocked (`next/headers`, `next/server`); the ads spend comes from the Meta and
 * Google Ads fakes through ops' own `ads.pull_yesterday` job function.
 *
 * - `REPORT_CSV` imported from `apps/web/modules/ops/reports/registry.ts` (its one home) has the
 *   keys `marketing`, `attribution` and `ads`; each generator, framed by `toCsv` with its
 *   `REPORT_CSV_COLUMNS` header the way `/admin/reports/[report]/csv` does, yields a header row
 *   and rows of the header's width; the CSV route itself answers 200 with that header.
 * - `getManagementDashboard(ctx)` for the seeded owner returns the customers, sales mix,
 *   retention and B2B tile groups.
 * - A staff user without `reports.read` (the seeded reception role) gets `forbidden` from the
 *   queries of the four ops pages, a 404 from their page guard and a 403 from the CSVs.
 * - The registry has one home: exactly one source file defines `REPORT_CSV`, the card registry
 *   `CARDS` lives in `modules/ops/dashboard/cards.ts` and carries the R3 `b2b_proposals` card.
 *
 * A failing seam is written to `docs/build/seam-issues-r3.md` with the owning package; the case
 * is then marked `it.fails` with the issue id until the fix package lands.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import type { Actor } from "@/lib/ctx";
import { adSpendDaily, featureFlags, roles, settings } from "@beam/db/schema";
import { ForbiddenError } from "@beam/core/errors";
import { toCsv } from "@beam/core/ops";
import { createAdsFake, FAKE_CAMPAIGNS } from "@beam/integrations/ads";
import { createTestDb, makeUser } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.14" })),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), after: () => undefined }));

vi.stubEnv("APP_ENV", "local");
vi.stubEnv("INTEGRATIONS", "fake");
vi.stubEnv("APP_URL", "https://app.example.com");
vi.stubEnv("AUTH_SECRET", "seams-r3-auth-secret-0123456789abcdef");
vi.stubEnv("SENSITIVE_DATA_KEY_V1", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("VOUCHER_CODE_SECRET", "seams-r3-voucher-secret-0123456789abcdef");

const { eq, sql } = await import("@/lib/ctx");
const { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime } = await import("@/lib/testing");
const { rowsOf } = await import("@/lib/sensitive");
const { actorFromSession, createAuthSession, getSession, SESSION_COOKIE } = await import("@/lib/auth");
const { runSeed } = await import("@/scripts/seed-demo");
const { REPORT_CSV, REPORT_CSV_COLUMNS, REPORT_KEYS } = await import("@/modules/ops/reports/registry");
const { staffReadCtx } = await import("@/modules/ops/reports/queries");
const q = await import("@/modules/ops/marketing/queries");
const { CUSTOMER_TILES, RETENTION_TILES } = await import("@/modules/ops/marketing/management");
const { setAdsClients } = await import("@/modules/ops/marketing/ads");
const { runAdsPullYesterday } = await import("@/modules/ops/marketing/jobs");
const { CARDS } = await import("@/modules/ops/dashboard/cards");
const { GET: reportCsv } = await import("@/app/(admin)/admin/reports/[report]/csv/route");

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "..");
const REPO = path.resolve(WEB, "../..");

/** 12:00 Brussels (CEST) on a Thursday; the demo seed's `now` is the start of this Brussels day. */
const NOW = new Date("2026-10-15T10:00:00.000Z");
const FROM = "2026-10-01";
const TO = "2026-10-14";
const AD_DAYS = ["2026-10-12", "2026-10-13", "2026-10-14"];
const META_ACCOUNT = "act_seams_r3";
const GOOGLE_ACCOUNT = "123-456-7890";
const R3_REPORTS = ["marketing", "attribution", "ads"] as const;

type StaffActor = Extract<Actor, { kind: "staff" }>;
let h: DbHandle;
let owner: StaffActor;
let reception: StaffActor;
const ownerToken = { value: "" };
const receptionToken = { value: "" };

/** A real staff session for a user of `roleKey` (MFA done): the actor the pages see. */
async function signIn(roleKey: "owner" | "reception"): Promise<{ actor: StaffActor; token: string }> {
  const user = await makeUser(h.db, { roleKey });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  const actor = actorFromSession(await getSession());
  if (!actor || actor.kind !== "staff") throw new Error(`no staff actor for ${roleKey}`);
  return { actor, token };
}

const readCtx = (actor: StaffActor) => ({ tx: h.db, actor, now: NOW, locale: "en" as const });

/** The CSV text the route would stream: `toCsv` with the registry header (no BOM). */
async function csvText(report: (typeof R3_REPORTS)[number], rows: unknown[][]): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of toCsv([...REPORT_CSV_COLUMNS[report]], rows, { bom: false })) text += decoder.decode(chunk);
  return text;
}

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  // `pnpm seed:demo` on a fresh database: defaults, then every module's demo rows in `after` order.
  const report = await runSeed(h.db, { profile: "demo", env: { APP_ENV: "local" }, clock: NOW, runJobsAfter: true, jobsBudgetMs: 30_000, log: () => undefined });
  expect(report.demo.map((d) => d.module)).toContain("ops");
  expect(report.demo.find((d) => d.module === "crm")!.created).toBeGreaterThan(0);

  // R3 marketing on, two ads accounts, and the fakes (ops spec section 6).
  await h.db.insert(featureFlags).values({ key: "ff_ops_marketing", state: "on" }).onConflictDoUpdate({ target: featureFlags.key, set: { state: "on" } });
  const ads = { meta_account_ids: [META_ACCOUNT], google_customer_ids: [GOOGLE_ACCOUNT] };
  await h.db.insert(settings).values({ key: "ads", value: ads }).onConflictDoUpdate({ target: settings.key, set: { value: ads } });
  setAdsClients(createAdsFake({ now: () => NOW }));
  for (const day of AD_DAYS) {
    for (const [platform, accountId] of [["meta", META_ACCOUNT], ["google", GOOGLE_ACCOUNT]] as const) {
      await runAdsPullYesterday(makeJobCtx(h.db, "ads.pull_yesterday", { now: NOW }), { platform, accountId, day, runOn: "2026-10-15" });
    }
  }

  ({ actor: owner, token: ownerToken.value } = await signIn("owner"));
  ({ actor: reception, token: receptionToken.value } = await signIn("reception"));
}, 240_000);

afterAll(async () => {
  setAdsClients(undefined);
  vi.unstubAllEnvs();
  resetRuntime();
  await h?.close();
});

beforeEach(() => jar.clear());

describe("demo seed and ads fakes", () => {
  it("the ads job wrote the fakes' campaigns for each pulled day", async () => {
    const rows = await h.db.select({ day: adSpendDaily.dayOn, platform: adSpendDaily.platform }).from(adSpendDaily);
    for (const day of AD_DAYS) {
      expect(rows.filter((r) => r.day === day && r.platform === "meta")).toHaveLength(FAKE_CAMPAIGNS.meta.length);
      expect(rows.filter((r) => r.day === day && r.platform === "google")).toHaveLength(FAKE_CAMPAIGNS.google.length);
    }
  });

  it("the seeded roles: owner holds everything, reception lacks reports.read", async () => {
    const [ownerRole] = await h.db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.key, "owner"));
    const [receptionRole] = await h.db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.key, "reception"));
    expect(ownerRole).toBeDefined();
    expect(receptionRole!.permissions).not.toContain("reports.read");
    expect(reception.roleKey).toBe("reception");
    expect(owner.roleKey).toBe("owner");
  });
});

describe("REPORT_CSV registry (PL-96, gap G12)", () => {
  it("has the R3 keys marketing, attribution and ads, each with a header", () => {
    for (const key of R3_REPORTS) {
      expect(REPORT_KEYS).toContain(key);
      expect(typeof REPORT_CSV[key]).toBe("function");
      expect(REPORT_CSV_COLUMNS[key].length).toBeGreaterThan(1);
    }
  });

  it.each(R3_REPORTS)("%s yields a header row and rows of the header's width", async (key) => {
    const rows: unknown[][] = [];
    for await (const row of REPORT_CSV[key](readCtx(owner), { from: FROM, to: TO })) rows.push(row);
    for (const row of rows) expect(row).toHaveLength(REPORT_CSV_COLUMNS[key].length);
    if (key === "ads") expect(rows.length).toBeGreaterThan(0);

    const text = await csvText(key, rows);
    const [header, ...body] = text.split("\r\n").filter((l) => l.length > 0);
    expect(header).toBe(REPORT_CSV_COLUMNS[key].join(","));
    expect(body).toHaveLength(rows.length);
  });

  it.each(R3_REPORTS)("GET /admin/reports/%s/csv answers 200 for the owner with the registry's header", async (key) => {
    jar.set(SESSION_COOKIE, ownerToken.value);
    const res = await reportCsv(new Request(`https://app.example.com/admin/reports/${key}/csv?from=${FROM}&to=${TO}`), { params: Promise.resolve({ report: key }) });
    expect(res.status).toBe(200);
    const first = (await res.text()).replace(/^\uFEFF/, "").split("\r\n")[0];
    expect(first).toBe(REPORT_CSV_COLUMNS[key].join(","));
  });

  it("exactly one source file defines REPORT_CSV, at modules/ops/reports/registry.ts", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && /export const REPORT_CSV\b/.test(readFileSync(full, "utf8"))) hits.push(path.relative(REPO, full).split(path.sep).join("/"));
      }
    };
    for (const root of ["apps/web", "packages"]) walk(path.join(REPO, root));
    expect(hits).toEqual(["apps/web/modules/ops/reports/registry.ts"]);
  });

  it("the dashboard card registry CARDS carries the R3 b2b_proposals card", () => {
    expect(CARDS.map((c) => c.key)).toContain("b2b_proposals");
  });
});

describe("getManagementDashboard for an owner (rules 34-38)", () => {
  it("returns the customers, sales mix, retention and B2B tile groups", async () => {
    const d = await q.getManagementDashboard(readCtx(owner), { period: "month", at: NOW });
    // Customers (rule 36)
    expect(Object.keys(d.customers).sort()).toEqual([...CUSTOMER_TILES].sort());
    // Sales mix (rule 35): by product kind and by channel
    expect(Array.isArray(d.revenue.byKind)).toBe(true);
    expect(Array.isArray(d.revenue.byChannel)).toBe(true);
    // Retention (rule 37)
    expect(Object.keys(d.retention).sort()).toEqual([...RETENTION_TILES].sort());
    for (const tile of RETENTION_TILES) expect(d.retention[tile]).toHaveProperty("current.denominator");
    // B2B (rule 38)
    for (const field of ["pipelineValueCents", "weightedValueCents", "openCount", "qualifiedCount", "proposalCount"] as const) {
      expect(Number.isInteger(d.b2b[field]), field).toBe(true);
    }
    expect(d.b2b.conversion).toHaveProperty("current");
  });

  it("matches the B2B pipeline the demo seed left in opportunities", async () => {
    const [row] = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from opportunities where stage not in ('won', 'lost')`));
    const d = await q.getManagementDashboard(readCtx(owner), { period: "month", at: NOW });
    expect(d.b2b.openCount).toBe(Number(row?.n ?? 0));
  });
});

describe("a staff user without reports.read (reception)", () => {
  const pageQueries: [string, (ctx: ReturnType<typeof readCtx>) => Promise<unknown>][] = [
    ["/admin/reports/marketing: getMarketingDashboard", (c) => q.getMarketingDashboard(c, { from: FROM, to: TO })],
    ["/admin/reports/attribution: getAttributionReport", (c) => q.getAttributionReport(c, { from: FROM, to: TO })],
    ["/admin/reports/attribution: getCampaignFunnel", (c) => q.getCampaignFunnel(c, { from: FROM, to: TO })],
    ["/admin/reports/ads: getAdsReport", (c) => q.getAdsReport(c, { from: FROM, to: TO })],
    ["/admin/dashboard/management: getManagementDashboard", (c) => q.getManagementDashboard(c, { period: "month", at: NOW })],
  ];

  it.each(pageQueries)("%s is forbidden", async (_name, call) => {
    await expect(call(readCtx(reception))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(pageQueries)("%s answers for the owner", async (_name, call) => {
    await expect(call(readCtx(owner))).resolves.toBeTruthy();
  });

  it("the pages' guard, staffReadCtx({ permission: 'reports.read' }), answers 404", async () => {
    jar.set(SESSION_COOKIE, receptionToken.value);
    const err = await staffReadCtx({ permission: "reports.read" }).catch((e: unknown) => e);
    expect(String((err as { digest?: string }).digest)).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404/);
    jar.set(SESSION_COOKIE, ownerToken.value);
    await expect(staffReadCtx({ permission: "reports.read" })).resolves.toMatchObject({ actor: { kind: "staff", roleKey: "owner" } });
  });

  it.each([...R3_REPORTS, "management"])("GET /admin/reports/%s/csv answers 403", async (key) => {
    jar.set(SESSION_COOKIE, receptionToken.value);
    const res = await reportCsv(new Request(`https://app.example.com/admin/reports/${key}/csv`), { params: Promise.resolve({ report: key }) });
    expect(res.status).toBe(403);
  });
});
