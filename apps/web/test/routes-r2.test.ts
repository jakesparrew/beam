/**
 * platform-P13 route seam (PL-95): the R2 pages are real routes. automation-P7's three rule
 * pages (`/admin/automations/rules`, `/conflicts`, `/groups`) resolve through `resolveRoute` to
 * their `page.tsx` under `apps/web/app/(admin)/admin/automations/`, statically (not through
 * `[id]`), and belong to automation-P7 in the ownership map. Every portal, public and admin URL
 * that `e2e/acceptance-r2.spec.ts` visits, and every route handler it calls, resolves under
 * `apps/web/app/` too, so a page that exists only on paper fails here, at the unit-test gate,
 * instead of at the wave 18 checkpoint.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_DIR, assertRoutes, checkRoutes, relativeFile, resolveRoute, type RequiredRoute } from "./support/route-map";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "../../..");
const UUID = "00000000-0000-4000-8000-000000000013";
const TOKEN = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXhx";

/** automation-P7's rule pages (gap G15 neighbours, PL-95). */
const AUTOMATION_RULE_ROUTES: RequiredRoute[] = [
  { url: "/admin/automations/rules", owner: "automation-P7" },
  { url: "/admin/automations/conflicts", owner: "automation-P7" },
  { url: "/admin/automations/groups", owner: "automation-P7" },
];

/** The pages `acceptance-r2.spec.ts` visits, with the package that built each one. */
const R2_PAGES: (RequiredRoute & { file: string })[] = [
  { url: `/nl/w/${TOKEN}`, owner: "webinar", file: "app/[locale]/(site)/w/[token]/page.tsx" },
  { url: "/nl/webinars/slaap-beter", owner: "webinar", file: "app/[locale]/(site)/webinars/[slug]/page.tsx" },
  { url: `/admin/webinars/${UUID}/report`, owner: "webinar", file: "app/(admin)/admin/webinars/[id]/report/page.tsx" },
  { url: `/nl/account/book/${UUID}`, owner: "booking", file: "app/[locale]/(portal)/account/book/[sessionId]/page.tsx" },
  { url: `/nl/account/bookings/${UUID}`, owner: "booking", file: "app/[locale]/(portal)/account/bookings/[id]/page.tsx" },
  { url: "/nl/account/shop/PKG-5-DAYS", owner: "commerce", file: "app/[locale]/(portal)/account/shop/[sku]/page.tsx" },
  { url: "/nl/account/checkout", owner: "commerce", file: "app/[locale]/(portal)/account/checkout/page.tsx" },
  { url: `/nl/account/checkout/return/${UUID}`, owner: "commerce", file: "app/[locale]/(portal)/account/checkout/return/[orderId]/page.tsx" },
  { url: `/nl/checkout/resume/${TOKEN}`, owner: "commerce", file: "app/[locale]/(site)/checkout/resume/[token]/page.tsx" },
  { url: "/admin/reports/abandoned-checkouts", owner: "ops", file: "app/(admin)/admin/reports/abandoned-checkouts/page.tsx" },
];

/** The route handlers the spec calls (webinar registration and player, fake payment, claim links). */
const R2_HANDLERS: { url: string; file: string }[] = [
  { url: "/api/public/webinars/slaap-beter/register", file: "app/api/public/webinars/[slug]/register/route.ts" },
  { url: "/api/webinar/view", file: "app/api/webinar/view/route.ts" },
  { url: "/api/webinar/heartbeat", file: "app/api/webinar/heartbeat/route.ts" },
  { url: "/api/webinar/interact", file: "app/api/webinar/interact/route.ts" },
  { url: `/api/dev/fake-pay/${UUID}`, file: "app/api/dev/fake-pay/[id]/route.ts" },
];

type Ownership = Record<string, { owns?: string[] }>;
const ownership = JSON.parse(readFileSync(path.join(REPO, "docs/build/ownership.json"), "utf8")) as Ownership;
const ownersOf = (repoPath: string) =>
  Object.entries(ownership)
    .filter(([, v]) => (v.owns ?? []).includes(repoPath))
    .map(([k]) => k);

describe("R2 routes (PL-95)", () => {
  it("the three automation rule pages resolve to page files", () => {
    expect(checkRoutes(AUTOMATION_RULE_ROUTES)).toEqual([]);
    expect(() => assertRoutes(AUTOMATION_RULE_ROUTES)).not.toThrow();
  });

  it.each(AUTOMATION_RULE_ROUTES.map((r) => [r.url] as const))("%s resolves statically to automation-P7's page.tsx, not to [id]", (url) => {
    const found = resolveRoute(url);
    expect(found, url).not.toBeNull();
    const file = relativeFile(found!.file);
    expect(file).toBe(`app/(admin)/admin${url.slice("/admin".length)}/page.tsx`);
    expect(found!.params).toEqual({});
    expect(file).not.toContain("[id]");
    expect(ownersOf(`apps/web/${file}`)).toContain("automation-P7");
  });

  it("the automation pages sit under the (admin) shell, whose layout and error boundary apply", () => {
    expect(existsSync(path.join(APP_DIR, "(admin)/admin/layout.tsx"))).toBe(true);
    expect(existsSync(path.join(APP_DIR, "(admin)/admin/error.tsx"))).toBe(true);
  });

  it("every page the R2 acceptance spec visits resolves to its page.tsx under apps/web/app", () => {
    expect(checkRoutes(R2_PAGES)).toEqual([]);
    for (const page of R2_PAGES) {
      const found = resolveRoute(page.url);
      expect(found ? relativeFile(found.file) : null, page.url).toBe(page.file);
      const owners = ownersOf(`apps/web/${page.file}`);
      expect(
        owners.some((o) => o.startsWith(`${page.owner}-`)),
        `${page.file} owned by ${page.owner} (${owners.join(", ")})`,
      ).toBe(true);
    }
  });

  it("every route handler the R2 acceptance spec calls resolves to its route.ts", () => {
    for (const handler of R2_HANDLERS) {
      const found = resolveRoute(handler.url);
      expect(found ? relativeFile(found.file) : null, handler.url).toBe(handler.file);
    }
  });
});
