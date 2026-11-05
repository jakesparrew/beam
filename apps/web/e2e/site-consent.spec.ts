/**
 * Cookie consent, consent-gated analytics and the PWA (site-P5, rules 36-39, section 5) on
 * beam_dev. No request reaches `googletagmanager.com` or `/_vercel/insights/*` before consent;
 * "Reject all" keeps it so; "Accept all" loads both through `next/script` with the page's nonce
 * and no CSP violation (GA4 needs the production-mode flag `BEAM_ANALYTICS_PRODUCTION=1` in the
 * server env and `settings.site.analytics_enabled` with a measurement id, which this spec sets
 * and restores); withdrawing from the footer removes the `_ga` cookies; the three banner
 * buttons have the same size. Third-party scripts are answered by `page.route`, so the spec
 * never talks to Google. The manifest and the service worker pass Chrome's installability basics.
 * R3 (site-P9): without marketing consent no Google Ads or Meta request is made and no `beam_ref`
 * cookie is set, a `?ref=` code rides only on that page view's portal, checkout and form links;
 * with it both tags load with the nonce, `beam_ref` keeps the first code for 30 days, and
 * withdrawing marketing deletes it (the Ads and Pixel ids are set in `settings.site` and restored).
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import { settings } from "@beam/db/schema";
import { eq } from "drizzle-orm";
import { expectAccessible } from "./support/a11y";
import { closeE2eDb, e2eDb } from "./support/db";

const GA_ID = "G-E2ETEST01";
const isAnalytics = (url: string) => /googletagmanager\.com|google-analytics\.com|\/_vercel\/insights\//.test(url);

/** Collects analytics requests and CSP violations of a page, and stubs the third-party scripts. */
async function watch(page: Page): Promise<{ analytics: string[]; violations: () => Promise<string[]> }> {
  const analytics: string[] = [];
  page.on("request", (req: Request) => {
    if (isAnalytics(req.url())) analytics.push(req.url());
  });
  await page.route(/googletagmanager\.com|google-analytics\.com/, (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "/* e2e stub */" }));
  await page.route(/\/_vercel\/insights\//, (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "/* e2e stub */" }));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return { analytics, violations: () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? []) };
}

const banner = (page: Page) => page.locator("[data-cookie-banner]");

let originalSite: unknown;

test.beforeAll(async () => {
  const db = await e2eDb();
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "site"));
  originalSite = row?.value ?? null;
});

test.afterAll(async () => {
  const db = await e2eDb();
  if (originalSite !== undefined && originalSite !== null) await db.update(settings).set({ value: originalSite }).where(eq(settings.key, "site"));
  await closeE2eDb();
});

/** Switches GA4 on for this spec (restored in `afterAll` and after the test that needs it). */
async function enableGa(): Promise<void> {
  const db = await e2eDb();
  const base = (originalSite && typeof originalSite === "object" ? originalSite : {}) as Record<string, unknown>;
  await db.update(settings).set({ value: { ...base, analytics_enabled: true, ga_measurement_id: GA_ID } }).where(eq(settings.key, "site"));
}

const ADS_ID = "AW-123456789";
const PIXEL_ID = "1234567890123";
const isMarketing = (url: string) =>
  /googleadservices\.com|googleads\.g\.doubleclick\.net|connect\.facebook\.net|facebook\.com\/tr/.test(url) || url.includes(`gtag/js?id=${ADS_ID}`);

/** Sets the R3 marketing tag ids (GA4 off, so gtag.js loads with the Ads id). */
async function enableMarketingTags(): Promise<void> {
  const db = await e2eDb();
  const base = (originalSite && typeof originalSite === "object" ? originalSite : {}) as Record<string, unknown>;
  await db.update(settings).set({ value: { ...base, analytics_enabled: false, google_ads_conversion_id: ADS_ID, meta_pixel_id: PIXEL_ID } }).where(eq(settings.key, "site"));
}

/** Collects marketing requests and stubs the Google Ads and Meta scripts. */
async function watchMarketing(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on("request", (req: Request) => {
    if (isMarketing(req.url())) seen.push(req.url());
  });
  await page.route(/googleadservices\.com|googleads\.g\.doubleclick\.net|connect\.facebook\.net|facebook\.com\/tr/, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "/* e2e stub */" }),
  );
  return seen;
}

/** Appends portal, checkout, form and other links after hydration (the capture also handles late links). */
async function injectLinks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nav = document.createElement("nav");
    nav.id = "e2e-ref-links";
    for (const [id, href] of [["signin", "/nl/account/login"], ["checkout", "/nl/checkout?sku=DAY"], ["form", "/nl/f/contact"], ["other", "/nl/prijzen"]]) {
      const a = document.createElement("a");
      a.id = `e2e-${id}`;
      a.href = href!;
      a.textContent = id!;
      nav.append(a);
    }
    document.body.append(nav);
  });
}

async function restoreSite(): Promise<void> {
  if (originalSite === undefined || originalSite === null) return;
  const db = await e2eDb();
  await db.update(settings).set({ value: originalSite }).where(eq(settings.key, "site"));
}

test.describe("cookie consent", () => {
  test("no analytics request before consent; the banner's three buttons have equal size", async ({ page }) => {
    const w = await watch(page);
    await page.goto("/nl");
    await expect(banner(page)).toBeVisible();
    const boxes = await Promise.all(["accept_all", "reject_all", "choose"].map((c) => banner(page).locator(`[data-consent="${c}"]`).boundingBox()));
    expect(boxes.every((b) => !!b)).toBe(true);
    const [a, r, c] = boxes as { width: number; height: number }[];
    for (const b of [r!, c!]) {
      expect(Math.abs(b.width - a!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(b.height - a!.height)).toBeLessThanOrEqual(1);
    }
    await expectAccessible(page);
    await page.locator("header a").first().click();
    await page.waitForLoadState("networkidle");
    expect(w.analytics).toEqual([]);
    expect(await page.context().cookies()).not.toContainEqual(expect.objectContaining({ name: "beam_consent" }));
  });

  test("reject all keeps analytics off across pages", async ({ page }) => {
    const w = await watch(page);
    await page.goto("/nl");
    const posted = page.waitForResponse((res) => res.url().endsWith("/api/public/cookie-consent") && res.request().method() === "POST");
    await banner(page).locator('[data-consent="reject_all"]').click();
    expect((await posted).status()).toBe(200);
    await expect(banner(page)).toHaveCount(0);
    const consent = (await page.context().cookies()).find((c) => c.name === "beam_consent");
    expect(consent?.value).toMatch(/^[0-9a-f-]{36}\.\d+\.0\.0\.\d+$/);
    await page.reload();
    await expect(banner(page)).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(w.analytics).toEqual([]);
  });

  test("accept all loads Vercel Analytics and GA4 with the page's nonce and no CSP violation", async ({ page }) => {
    await enableGa();
    try {
      const w = await watch(page);
      await page.goto("/nl");
      const posted = page.waitForResponse((res) => res.url().endsWith("/api/public/cookie-consent") && res.request().method() === "POST");
      const vercel = page.waitForRequest((req) => req.url().includes("/_vercel/insights/script.js"));
      const gtag = page.waitForRequest((req) => req.url().startsWith(`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`));
      await banner(page).locator('[data-consent="accept_all"]').click();
      expect((await posted).status()).toBe(200);
      await Promise.all([vercel, gtag]);
      const nonces = await page.evaluate(() => {
        const own = [...document.querySelectorAll<HTMLScriptElement>("script")].find((s) => s.src.includes("/_next/") && s.nonce)?.nonce ?? null;
        const third = [...document.querySelectorAll<HTMLScriptElement>("script")].filter((s) => /\/_vercel\/insights\/|googletagmanager\.com/.test(s.src)).map((s) => s.nonce);
        return { own, third };
      });
      expect(nonces.own).toBeTruthy();
      expect(nonces.third).toHaveLength(2);
      for (const n of nonces.third) expect(n).toBe(nonces.own);
      expect(await w.violations()).toEqual([]);
      expect(w.analytics.some((u) => u.includes("/_vercel/insights/"))).toBe(true);
    } finally {
      await restoreSite();
    }
  });

  test("withdrawing from the footer's cookie settings removes the _ga cookies", async ({ page, context, baseURL }) => {
    await watch(page);
    await page.goto("/nl");
    await banner(page).locator('[data-consent="accept_all"]').click();
    await expect(banner(page)).toHaveCount(0);
    const url = new URL(baseURL ?? page.url());
    await context.addCookies([
      { name: "_ga", value: "GA1.1.1234567890.1700000000", url: url.origin },
      { name: "_ga_E2ETEST01", value: "GS1.1.1700000000.1.0.1700000000.0.0.0", url: url.origin },
    ]);
    await page.reload();
    await page.locator("footer [data-cookie-settings]").click();
    const dialog = page.locator("dialog[data-cookie-dialog]");
    await expect(dialog).toBeVisible();
    await expectAccessible(page);
    const analytics = dialog.getByRole("switch").nth(1);
    await expect(analytics).toBeChecked();
    await analytics.uncheck();
    await dialog.getByRole("switch").nth(2).uncheck();
    const posted = page.waitForResponse((res) => res.url().endsWith("/api/public/cookie-consent") && res.request().method() === "POST");
    await dialog.locator('[data-consent="save"]').click();
    const body = (await posted).request().postDataJSON() as { action: string };
    expect(body.action).toBe("withdraw");
    await expect(dialog).toBeHidden();
    const names = (await context.cookies()).map((c) => c.name);
    expect(names.filter((n) => /^_ga/.test(n))).toEqual([]);
    expect((await context.cookies()).find((c) => c.name === "beam_consent")?.value).toMatch(/\.0\.0\.\d+$/);
  });
});

test.describe("marketing tags and referral links (R3)", () => {
  test("without marketing consent: no marketing tag, no beam_ref, the code only on portal, checkout and form links", async ({ page, context }) => {
    await enableMarketingTags();
    try {
      await watch(page);
      const marketing = await watchMarketing(page);
      await page.goto("/nl?ref=ABCD2345");
      const posted = page.waitForResponse((res) => res.url().endsWith("/api/public/cookie-consent") && res.request().method() === "POST");
      await banner(page).locator('[data-consent="reject_all"]').click();
      expect((await posted).status()).toBe(200);
      await injectLinks(page);
      await expect(page.locator("#e2e-signin")).toHaveAttribute("href", "/nl/account/login?ref=ABCD2345");
      await expect(page.locator("#e2e-checkout")).toHaveAttribute("href", "/nl/checkout?sku=DAY&ref=ABCD2345");
      await expect(page.locator("#e2e-form")).toHaveAttribute("href", "/nl/f/contact?ref=ABCD2345");
      await expect(page.locator("#e2e-other")).toHaveAttribute("href", "/nl/prijzen");
      await page.waitForLoadState("networkidle");
      expect(marketing).toEqual([]);
      expect((await context.cookies()).map((c) => c.name)).not.toContain("beam_ref");
      // The next page view without `?ref=` carries no code.
      await page.goto("/nl");
      await injectLinks(page);
      await expect(page.locator("#e2e-signin")).toHaveAttribute("href", "/nl/account/login");
    } finally {
      await restoreSite();
    }
  });

  test("with marketing consent: Google Ads and Meta Pixel load with the nonce; beam_ref keeps the first code for 30 days", async ({ page, context }) => {
    await enableMarketingTags();
    try {
      const w = await watch(page);
      await watchMarketing(page);
      await page.goto("/nl?ref=ABCD2345");
      const posted = page.waitForResponse((res) => res.url().endsWith("/api/public/cookie-consent") && res.request().method() === "POST");
      const gtag = page.waitForRequest((req) => req.url().startsWith(`https://www.googletagmanager.com/gtag/js?id=${ADS_ID}`));
      const pixel = page.waitForRequest((req) => req.url().startsWith("https://connect.facebook.net/en_US/fbevents.js"));
      await banner(page).locator('[data-consent="accept_all"]').click();
      expect((await posted).status()).toBe(200);
      await Promise.all([gtag, pixel]);
      const nonces = await page.evaluate(() => {
        const own = [...document.querySelectorAll<HTMLScriptElement>("script")].find((s) => s.src.includes("/_next/") && s.nonce)?.nonce ?? null;
        const third = [...document.querySelectorAll<HTMLScriptElement>("script")].filter((s) => /googletagmanager\.com|connect\.facebook\.net/.test(s.src)).map((s) => s.nonce);
        return { own, third };
      });
      expect(nonces.own).toBeTruthy();
      expect(nonces.third).toHaveLength(2);
      for (const n of nonces.third) expect(n).toBe(nonces.own);
      expect(await w.violations()).toEqual([]);

      await expect.poll(async () => (await context.cookies()).find((c) => c.name === "beam_ref")?.value ?? null).toBe("ABCD2345");
      const ref = (await context.cookies()).find((c) => c.name === "beam_ref")!;
      const days = (ref.expires - Date.now() / 1000) / 86_400;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30.01);
      expect(ref.sameSite).toBe("Lax");
      await injectLinks(page);
      await expect(page.locator("#e2e-signin")).toHaveAttribute("href", "/nl/account/login");

      // A later code does not replace the first one.
      await page.goto("/nl?ref=WXYZ6789");
      await page.waitForLoadState("networkidle");
      expect((await context.cookies()).find((c) => c.name === "beam_ref")?.value).toBe("ABCD2345");

      // Withdrawing marketing deletes beam_ref.
      await page.locator("footer [data-cookie-settings]").click();
      const dialog = page.locator("dialog[data-cookie-dialog]");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("switch").nth(2).uncheck();
      const saved = page.waitForResponse((res) => res.url().endsWith("/api/public/cookie-consent") && res.request().method() === "POST");
      await dialog.locator('[data-consent="save"]').click();
      expect((await saved).status()).toBe(200);
      await expect(dialog).toBeHidden();
      await expect.poll(async () => (await context.cookies()).map((c) => c.name)).not.toContain("beam_ref");
    } finally {
      await restoreSite();
    }
  });
});

test.describe("PWA", () => {
  test("the manifest is installable and the service worker registers", async ({ page }) => {
    await page.goto("/nl");
    const manifest = await page.evaluate(async () => {
      const res = await fetch("/manifest.webmanifest");
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    });
    expect(manifest.status).toBe(200);
    expect(manifest.body).toMatchObject({ short_name: "BEAM", start_url: "/account?source=pwa", scope: "/", display: "standalone" });
    expect(typeof manifest.body.name).toBe("string");
    const icons = manifest.body.icons as { src: string; sizes: string; purpose?: string }[];
    expect(icons.map((i) => `${i.sizes}:${i.purpose ?? "any"}`).sort()).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
    for (const icon of icons) {
      const res = await page.request.get(icon.src);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("image/png");
    }
    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return { scope: reg.scope, script: reg.active?.scriptURL ?? null };
    });
    expect(new URL(sw.scope).pathname).toBe("/");
    expect(sw.script).toMatch(/\/sw\.js$/);

    const offline = await page.request.get("/nl/offline");
    expect(offline.status()).toBe(200);
  });
});
