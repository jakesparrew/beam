// @vitest-environment jsdom
/**
 * fix-w09-site-review: the public site layout (`app/[locale]/(site)/layout.tsx`, rule 37, booking
 * spec 5.3) loads no analytics script (`beam-gtag`, `beam-vercel-insights`) on the claim and
 * preference-centre token pages, even after analytics consent, and still loads both on a content
 * page. GA4 runs in production mode with a measurement id, so `gaIdFor` is called on the server
 * path of the layout (it must not come from the client module).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeConsentCookie } from "@beam/core/site";
import type * as Consent from "@/modules/site/server/consent";

const req = vi.hoisted((): { path: string | null; cookie: string | null } => ({ path: "/nl", cookie: null }));

vi.mock("next/script", () => ({
  default: (props: { id?: string; src?: string }) => <script data-testid={props.id} data-src={props.src} />,
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers(req.path === null ? { "x-nonce": "n0nce" } : { "x-nonce": "n0nce", "x-pathname": req.path })),
  cookies: () => Promise.resolve({ get: (name: string) => (name === "beam_consent" && req.cookie ? { name, value: req.cookie } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found");
  },
  usePathname: () => req.path ?? "/nl",
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("@/lib/ctx", () => ({ getAppDb: () => Promise.resolve({}) }));
vi.mock("@/lib/settings", () => ({ getSetting: () => Promise.resolve({ analytics_enabled: true, ga_measurement_id: "G-TEST1234" }) }));
vi.mock("@/lib/logger", () => ({
  reportError: (error: unknown) => {
    throw error;
  },
}));
vi.mock("@/modules/site/queries", () => ({
  getNavMenus: () => Promise.resolve({ header: [], footer: [], legal: [] }),
  getCompanyFooter: () => Promise.resolve(null),
}));
vi.mock("@/modules/site/server/consent", async (importOriginal) => {
  const real = await importOriginal<typeof Consent>();
  return {
    ...real,
    analyticsProductionMode: () => true,
    getConsentChromeState: () => Promise.resolve({ bannerVersion: 2, latestMaterialOrdinal: null, cookieNoticeHref: null }),
  };
});
vi.mock("@/modules/site/ui/public/site-header", () => ({ SiteHeader: () => <header /> }));
vi.mock("@/modules/site/ui/public/site-footer", () => ({ SiteFooter: () => <footer /> }));
vi.mock("@/modules/site/ui/public/sw-register", () => ({ SwRegister: () => null }));

const { default: SiteLayout } = await import("@/app/[locale]/(site)/layout");

const KEY = "3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const consented = () => encodeConsentCookie({ k: KEY, v: 2, a: true, m: false, t: Math.floor(Date.now() / 1000) });

async function renderAt(path: string | null) {
  req.path = path;
  req.cookie = consented();
  const tree = await SiteLayout({ children: <p>page</p>, params: Promise.resolve({ locale: "nl" }) });
  render(tree);
}

afterEach(() => cleanup());

describe("site layout analytics on token pages", () => {
  it("loads GA4 and Vercel Analytics on a content page after consent", async () => {
    await renderAt("/nl/dagsessies");
    expect(screen.getByTestId("beam-gtag").getAttribute("data-src")).toContain("G-TEST1234");
    expect(screen.queryByTestId("beam-vercel-insights")).not.toBeNull();
  });

  it.each(["/nl/claim/x", "/nl/preferences/x", "/nl/pay/x", "/nl/f/intake/r/x"])("loads no analytics script on %s after consent", async (path) => {
    await renderAt(path);
    expect(screen.getByText("page")).toBeTruthy();
    expect(screen.queryByTestId("beam-gtag")).toBeNull();
    expect(screen.queryByTestId("beam-vercel-insights")).toBeNull();
  });

  it("loads no analytics script when the requested path is unknown", async () => {
    await renderAt(null);
    expect(screen.queryByTestId("beam-gtag")).toBeNull();
    expect(screen.queryByTestId("beam-vercel-insights")).toBeNull();
  });
});
