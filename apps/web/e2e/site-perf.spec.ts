/**
 * The performance gate of the public site (site-P5, rule 51): on home, an offer page and an
 * event detail page, with Chromium CPU throttling 4x and the DevTools "Fast 4G" profile through
 * CDP, LCP <= 2.5 s and CLS <= 0.1 from `PerformanceObserver`, and the transferred first-load
 * JavaScript (compressed bytes on the wire) <= 200 KB (OD-19). Field p75 values (LCP, CLS, INP) are read
 * from Vercel Analytics after go-live; this spec is the lab gate. Each page is loaded once warm
 * (server caches) and measured on the second, cold-browser-cache load in a fresh context.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import { closeE2eDb, e2eRows } from "./support/db";
import { createEventPage, removeEventPage, type E2eEventPage } from "./support/event-page";

const LCP_BUDGET_MS = 2500;
const CLS_BUDGET = 0.1;
/** OD-19: Next 16 and React 19 alone are about 135 KB gzip; BEAM's own code gets the rest. */
const JS_BUDGET_BYTES = 200 * 1024;

/** DevTools "Fast 4G": 9 Mbit/s down, 1.5 Mbit/s up, 60 ms RTT with the 2.75 multiplier. */
const FAST_4G = { offline: false, downloadThroughput: (9 * 1000 * 1000) / 8, uploadThroughput: (1.5 * 1000 * 1000) / 8, latency: 165 };

async function nlPath(kind: string): Promise<string | null> {
  const [row] = await e2eRows<{ path: string }>(sql`
    select r.path from page_routes r join pages p on p.id = r.page_id
    where p.status = 'published' and r.locale = 'nl-BE' and p.kind = ${kind}
    order by p.slug limit 1`);
  if (!row) return null;
  return row.path ? `/nl/${row.path}` : "/nl";
}

/** The demo seed of beam_dev has no event page; the event case then uses one of this spec's own. */
let ownEvent: E2eEventPage | null = null;
async function pathOf(kind: string): Promise<string | null> {
  const seeded = await nlPath(kind);
  if (seeded || kind !== "event") return seeded;
  ownEvent ??= await createEventPage("e2e-perf-event");
  return ownEvent.nlPath;
}

test.afterAll(async () => {
  await removeEventPage(ownEvent);
  await closeE2eDb();
});

type Measured = { lcp: number; cls: number; jsBytes: number; scripts: number };

async function measure(browser: Browser, baseURL: string, path: string): Promise<Measured> {
  const context = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });
  const page: Page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __lcp: number; __cls: number };
    w.__lcp = 0;
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__lcp = entry.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (!entry.hadRecentInput) w.__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", FAST_4G);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  const scriptRequests = new Set<string>();
  let jsBytes = 0;
  cdp.on("Network.responseReceived", (e: { requestId: string; type: string }) => {
    if (e.type === "Script") scriptRequests.add(e.requestId);
  });
  cdp.on("Network.loadingFinished", (e: { requestId: string; encodedDataLength: number }) => {
    if (scriptRequests.has(e.requestId)) jsBytes += e.encodedDataLength;
  });

  const res = await page.goto(path, { waitUntil: "load" });
  expect(res?.status()).toBe(200);
  await page.waitForLoadState("networkidle");
  // Let the last LCP and layout-shift entries arrive after network idle.
  await page.waitForTimeout(500);
  const { lcp, cls } = await page.evaluate(() => {
    const w = window as unknown as { __lcp: number; __cls: number };
    return { lcp: w.__lcp, cls: w.__cls };
  });
  const scripts = scriptRequests.size;
  await context.close();
  return { lcp, cls, jsBytes, scripts };
}

test.describe("performance budgets (lab)", () => {
  test.setTimeout(120_000);
  for (const kind of ["home", "offer", "event"]) {
    test(`${kind}: LCP <= 2.5 s, CLS <= 0.1, first-load JS <= 200 KB`, async ({ browser, baseURL }) => {
      const path = await pathOf(kind);
      test.skip(!path, `no seeded ${kind} page in nl-BE`);
      const origin = baseURL ?? "http://localhost:3100";
      // Warm the server caches (unstable_cache, ISR) so the measured load is a returning-server one.
      await measure(browser, origin, path!);
      const m = await measure(browser, origin, path!);
      test.info().annotations.push({ type: "perf", description: `${path}: LCP ${Math.round(m.lcp)} ms, CLS ${m.cls.toFixed(3)}, JS ${Math.round(m.jsBytes / 1024)} KB in ${m.scripts} scripts` });
      expect(m.lcp, "LCP (ms)").toBeGreaterThan(0);
      expect(m.lcp, "LCP (ms)").toBeLessThanOrEqual(LCP_BUDGET_MS);
      expect(m.cls, "CLS").toBeLessThanOrEqual(CLS_BUDGET);
      expect(m.jsBytes, "first-load JavaScript (bytes on the wire)").toBeLessThanOrEqual(JS_BUDGET_BYTES);
    });
  }
});
