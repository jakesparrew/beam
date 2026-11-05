"use client";

/**
 * Consent-gated analytics and marketing tags (rule 37, section 6; site-P5, R3 tags by site-P9).
 * Nothing is requested before consent. After analytics consent, Vercel Analytics
 * (`/_vercel/insights/script.js`) loads and, when the server passed a GA4 measurement id (public
 * site pages in production with `settings.site` `analytics_enabled` and `ga_measurement_id` set),
 * `gtag/js` loads with Consent Mode v2: `analytics_storage` granted, `ad_storage`, `ad_user_data`
 * and `ad_personalization` denied. After marketing consent (R3), the Google Ads conversion tag
 * (`gtag` with the `AW-` id; the ad storage signals are granted) and the Meta Pixel
 * (`fbevents.js`) load when the server passed their ids, and a completed form (`window`
 * CustomEvent `beam-form:completed`) is reported as a conversion. Withdrawing marketing consent
 * denies the ad signals again and revokes the pixel. Every script goes through `next/script`
 * with the request nonce, so the CSP's `'strict-dynamic'` admits it; the `gtag` and `fbq` queues
 * are set up here in the bundle, so no inline snippet exists.
 */
import Script from "next/script";
import { useEffect } from "react";
import { isGaMeasurementId, marketingTagIds } from "@beam/core/site";
import { useConsent } from "./consent-provider";

/**
 * Re-exported for client code; server code (the site layout) imports it from `@beam/core/site`,
 * because a function of a `"use client"` module cannot be called on the server.
 */
export { gaIdFor } from "@beam/core/site";

type Fbq = ((...args: unknown[]) => void) & { queue?: unknown[]; callMethod?: (...args: unknown[]) => void; loaded?: boolean; version?: string; push?: unknown };
type GtagWindow = Window & {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  fbq?: Fbq;
  _fbq?: Fbq;
  __beamGtagConfigured?: string[];
  __beamMarketing?: { googleAdsId: string | null; metaPixelId: string | null; pixelInitialised?: boolean };
} & Record<string, unknown>;

const AD_SIGNALS = ["ad_storage", "ad_user_data", "ad_personalization"] as const;
const adConsent = (value: "granted" | "denied") => Object.fromEntries(AD_SIGNALS.map((k) => [k, value]));

/** Defines the gtag queue with Consent Mode v2 defaults; false when it already existed. */
function defineGtag(win: GtagWindow, analyticsStorage: "granted" | "denied"): boolean {
  if (win.gtag) return false;
  win.dataLayer = win.dataLayer ?? [];
  win.gtag = function gtag() {
    // gtag.js reads the `arguments` object, not an array.
    // eslint-disable-next-line prefer-rest-params
    win.dataLayer!.push(arguments);
  };
  win.gtag("consent", "default", { analytics_storage: analyticsStorage, ...adConsent("denied") });
  win.gtag("js", new Date());
  return true;
}

/** `gtag('config', id)` once per page for each id. */
function configureOnce(win: GtagWindow, id: string): void {
  const done = (win.__beamGtagConfigured = win.__beamGtagConfigured ?? []);
  if (done.includes(id)) return;
  done.push(id);
  win.gtag!("config", id);
}

/** Sets up the gtag queue with Consent Mode v2 defaults and configures GA4 (idempotent per page). */
export function initGtag(win: GtagWindow, id: string): void {
  win[`ga-disable-${id}`] = false;
  if (!defineGtag(win, "granted")) win.gtag!("consent", "update", { analytics_storage: "granted" });
  configureOnce(win, id);
}

/** Defines the Meta Pixel queue (the official stub, without its inline loader). */
function defineFbq(win: GtagWindow): Fbq {
  if (win.fbq) return win.fbq;
  const fbq: Fbq = function fbq(...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue!.push(args);
  };
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.queue = [];
  win.fbq = fbq;
  if (!win._fbq) win._fbq = fbq;
  return fbq;
}

/**
 * Marketing consent given (R3): grants the ad signals and configures the Google Ads tag, and
 * initialises the Meta Pixel with a page view. Idempotent per page.
 */
export function initMarketingTags(win: GtagWindow, ids: { googleAdsId: string | null; metaPixelId: string | null }): void {
  const state = (win.__beamMarketing = { pixelInitialised: false, ...win.__beamMarketing, googleAdsId: ids.googleAdsId, metaPixelId: ids.metaPixelId });
  if (ids.googleAdsId) {
    defineGtag(win, "denied");
    win.gtag!("consent", "update", adConsent("granted"));
    configureOnce(win, ids.googleAdsId);
  }
  if (ids.metaPixelId) {
    const fbq = defineFbq(win);
    if (state.pixelInitialised) {
      fbq("consent", "grant");
    } else {
      fbq("init", ids.metaPixelId);
      fbq("track", "PageView");
      state.pixelInitialised = true;
    }
  }
}

/** Marketing consent withdrawn on this page: the ad signals are denied again and the pixel revoked. */
export function revokeMarketingTags(win: GtagWindow): void {
  if (win.gtag) win.gtag("consent", "update", adConsent("denied"));
  if (win.fbq) win.fbq("consent", "revoke");
  if (win.__beamMarketing) win.__beamMarketing = { ...win.__beamMarketing, googleAdsId: null, metaPixelId: null };
}

/**
 * Reports a conversion to the marketing tags loaded on this page (a completed form, or commerce's
 * paid return page). Does nothing before marketing consent or without configured ids.
 */
export function trackMarketingConversion(kind: "lead" | "purchase", input: { valueCents?: number; currency?: string } = {}, win: GtagWindow = window as unknown as GtagWindow): void {
  const ids = win.__beamMarketing;
  if (!ids) return;
  const value = typeof input.valueCents === "number" && input.valueCents > 0 ? { value: input.valueCents / 100, currency: input.currency ?? "EUR" } : {};
  if (ids.googleAdsId && win.gtag) win.gtag("event", "conversion", { send_to: ids.googleAdsId, ...value });
  if (ids.metaPixelId && win.fbq) win.fbq("track", kind === "purchase" ? "Purchase" : "Lead", value);
}

export function AnalyticsLoader({
  nonce,
  gaMeasurementId,
  googleAdsId,
  metaPixelId,
  vercel = true,
}: {
  nonce?: string | null;
  gaMeasurementId?: string | null;
  /** R3: `settings.site.google_ads_conversion_id`, passed only in production. */
  googleAdsId?: string | null;
  /** R3: `settings.site.meta_pixel_id`, passed only in production. */
  metaPixelId?: string | null;
  vercel?: boolean;
}) {
  const { analytics, marketing } = useConsent();
  const gaId = isGaMeasurementId(gaMeasurementId) ? gaMeasurementId : null;
  const ads = marketingTagIds({ isProduction: true, googleAdsConversionId: googleAdsId, metaPixelId });
  const adsId = ads.googleAdsId;
  const pixelId = ads.metaPixelId;
  const hasMarketingTags = !!(adsId || pixelId);

  // The queue works in either order: gtag.js adopts an existing `dataLayer`, and a later
  // `initGtag` pushes into the one gtag.js created.
  useEffect(() => {
    if (analytics && gaId) initGtag(window as unknown as GtagWindow, gaId);
  }, [analytics, gaId]);

  useEffect(() => {
    if (!hasMarketingTags) return;
    const win = window as unknown as GtagWindow;
    if (!marketing) {
      if (win.__beamMarketing?.googleAdsId || win.__beamMarketing?.metaPixelId) revokeMarketingTags(win);
      return;
    }
    initMarketingTags(win, { googleAdsId: adsId, metaPixelId: pixelId });
    const onCompleted = () => trackMarketingConversion("lead", {}, win);
    window.addEventListener("beam-form:completed", onCompleted);
    return () => window.removeEventListener("beam-form:completed", onCompleted);
  }, [marketing, adsId, pixelId, hasMarketingTags]);

  const withAnalytics = analytics;
  const withMarketing = marketing && hasMarketingTags;
  if (!withAnalytics && !withMarketing) return null;
  const n = nonce ?? undefined;
  // One gtag.js serves GA4 and Google Ads; it loads with the GA4 id when analytics is allowed.
  const gtagId = withAnalytics && gaId ? gaId : marketing && adsId ? adsId : null;
  return (
    <>
      {withAnalytics && vercel ? <Script id="beam-vercel-insights" src="/_vercel/insights/script.js" strategy="afterInteractive" nonce={n} /> : null}
      {gtagId ? (
        <Script id="beam-gtag" src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gtagId)}`} strategy="afterInteractive" nonce={n} />
      ) : null}
      {marketing && pixelId ? <Script id="beam-meta-pixel" src="https://connect.facebook.net/en_US/fbevents.js" strategy="afterInteractive" nonce={n} /> : null}
    </>
  );
}
