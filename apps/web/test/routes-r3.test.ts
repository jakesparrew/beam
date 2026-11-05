/**
 * platform-P14 route seam (PL-95, PL-96, gap G12): the R3 report and dashboard pages are real
 * routes. Each URL resolves through `resolveRoute` to a `page.tsx` under
 * `apps/web/app/(admin)/admin/` that belongs to the package that built it (ops-P8, finance-P8);
 * the four ops pages carry `loading.tsx` and `error.tsx` in their own folder; the finance
 * dashboard relies on the `(admin)` shell's error file (platform spec, route ownership table).
 * The ops dashboard card and report registries have one home each: no `packages/db/src/dashboard/`
 * or `packages/db/src/reports/` folder exists (PL-96).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_DIR, assertRoutes, checkRoutes, relativeFile, resolveRoute, type RequiredRoute } from "./support/route-map";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "..");
const REPO = path.resolve(WEB, "../..");

/** The R3 URLs of gap G12 with the package that owns each page (ownership.json). */
const R3_ROUTES: RequiredRoute[] = [
  { url: "/admin/reports/marketing", owner: "ops-P8", needs: ["loading", "error"] },
  { url: "/admin/reports/attribution", owner: "ops-P8", needs: ["loading", "error"] },
  { url: "/admin/reports/ads", owner: "ops-P8", needs: ["loading", "error"] },
  { url: "/admin/dashboard/management", owner: "ops-P8", needs: ["loading", "error"] },
  { url: "/admin/finance/dashboard", owner: "finance-P8" },
];

/** The page file each URL must reach (relative to `apps/web`). */
const EXPECTED_FILES: Record<string, string> = {
  "/admin/reports/marketing": "app/(admin)/admin/reports/marketing/page.tsx",
  "/admin/reports/attribution": "app/(admin)/admin/reports/attribution/page.tsx",
  "/admin/reports/ads": "app/(admin)/admin/reports/ads/page.tsx",
  "/admin/dashboard/management": "app/(admin)/admin/dashboard/management/page.tsx",
  "/admin/finance/dashboard": "app/(admin)/admin/finance/dashboard/page.tsx",
};

type Ownership = Record<string, { owns?: string[] }>;
const ownership = JSON.parse(readFileSync(path.join(REPO, "docs/build/ownership.json"), "utf8")) as Ownership;
const ownersOf = (repoPath: string) =>
  Object.entries(ownership)
    .filter(([, v]) => (v.owns ?? []).includes(repoPath))
    .map(([k]) => k);

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

describe("R3 routes (PL-95, gap G12)", () => {
  it("every R3 report and dashboard URL resolves to a page, with loading and error beside the four ops pages", () => {
    expect(checkRoutes(R3_ROUTES)).toEqual([]);
    expect(() => assertRoutes(R3_ROUTES)).not.toThrow();
  });

  it.each(R3_ROUTES.map((r) => [r.url, r.owner] as const))("%s resolves to its page.tsx under app/(admin)/admin/ owned by %s", (url, owner) => {
    const found = resolveRoute(url);
    expect(found, url).not.toBeNull();
    const file = relativeFile(found!.file);
    expect(file).toBe(EXPECTED_FILES[url]);
    expect(file.startsWith("app/(admin)/admin/")).toBe(true);
    expect(path.basename(found!.file)).toBe("page.tsx");
    expect(found!.params).toEqual({});
    expect(ownersOf(`apps/web/${file}`)).toContain(owner);
  });

  it("the static report folders win over the dynamic [report] segment", () => {
    for (const report of ["marketing", "attribution", "ads"]) {
      expect(relativeFile(resolveRoute(`/admin/reports/${report}`)!.file)).not.toContain("[report]");
    }
    // Their CSVs are served by the one registry handler (ops spec 4.3).
    for (const report of ["marketing", "attribution", "ads", "management"]) {
      expect(relativeFile(resolveRoute(`/admin/reports/${report}/csv?from=2026-10-01&to=2026-10-31`)!.file)).toBe("app/(admin)/admin/reports/[report]/csv/route.ts");
    }
  });

  it("the four ops pages carry loading.tsx and error.tsx in their own folder", () => {
    for (const route of R3_ROUTES.filter((r) => r.owner === "ops-P8")) {
      const dir = path.dirname(resolveRoute(route.url)!.file);
      expect(existsSync(path.join(dir, "loading.tsx")), `${route.url} loading.tsx`).toBe(true);
      expect(existsSync(path.join(dir, "error.tsx")), `${route.url} error.tsx`).toBe(true);
      // An error boundary is a client component (Next.js requires "use client").
      expect(readFileSync(path.join(dir, "error.tsx"), "utf8")).toMatch(/^\s*["']use client["']/);
    }
  });

  it("the finance dashboard sits under the (admin) shell, whose error.tsx applies", () => {
    expect(existsSync(path.join(APP_DIR, "(admin)/admin/error.tsx"))).toBe(true);
    expect(existsSync(path.join(APP_DIR, "(admin)/admin/layout.tsx"))).toBe(true);
  });

  it("no packages/db/src/dashboard/ or packages/db/src/reports/ folder exists (PL-96)", () => {
    expect(isDir(path.join(REPO, "packages/db/src/dashboard"))).toBe(false);
    expect(isDir(path.join(REPO, "packages/db/src/reports"))).toBe(false);
  });
});
