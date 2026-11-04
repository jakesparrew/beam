"use client";

/**
 * Consent-gated analytics (rule 37, section 6; site-P5). Nothing is requested before analytics
 * consent. After it, Vercel Analytics (`/_vercel/insights/script.js`) loads and, when the server
 * passed a GA4 measurement id (public site pages in production with `settings.site`
 * `analytics_enabled` and `ga_measurement_id` set), `gtag/js` loads with Consent Mode v2:
 * `analytics_storage` granted, `ad_storage`, `ad_user_data` and `ad_personalization` denied.
 * Both go through `next/script` with the request nonce, so the CSP's `'strict-dynamic'` admits
 * them; the gtag queue is set up here in the bundle, so no inline snippet exists.
 */
import Script from "next/script";
import { useEffect } from "react";
import { useConsent } from "./consent-provider";

const GA_ID_RE = /^G-[A-Z0-9]{4,12}$/;

/** The GA4 id to load on this page, or null (production, switched on, valid id). */
export function gaIdFor(input: { isProduction: boolean; analyticsEnabled: boolean; gaMeasurementId: string | null | undefined }): string | null {
  if (!input.isProduction || !input.analyticsEnabled) return null;
  const id = input.gaMeasurementId?.trim() ?? "";
  return GA_ID_RE.test(id) ? id : null;
}

type GtagWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void } & Record<string, unknown>;

/** Sets up the gtag queue with Consent Mode v2 defaults (idempotent per page). */
export function initGtag(win: GtagWindow, id: string): void {
  win[`ga-disable-${id}`] = false;
  if (win.gtag) return;
  win.dataLayer = win.dataLayer ?? [];
  win.gtag = function gtag() {
    // gtag.js reads the `arguments` object, not an array.
    // eslint-disable-next-line prefer-rest-params
    win.dataLayer!.push(arguments);
  };
  win.gtag("consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  win.gtag("js", new Date());
  win.gtag("config", id);
}

export function AnalyticsLoader({ nonce, gaMeasurementId, vercel = true }: { nonce?: string | null; gaMeasurementId?: string | null; vercel?: boolean }) {
  const { analytics } = useConsent();
  const gaId = gaMeasurementId && GA_ID_RE.test(gaMeasurementId) ? gaMeasurementId : null;

  // The queue works in either order: gtag.js adopts an existing `dataLayer`, and a later
  // `initGtag` pushes into the one gtag.js created.
  useEffect(() => {
    if (analytics && gaId) initGtag(window as unknown as GtagWindow, gaId);
  }, [analytics, gaId]);

  if (!analytics) return null;
  const n = nonce ?? undefined;
  return (
    <>
      {vercel ? <Script id="beam-vercel-insights" src="/_vercel/insights/script.js" strategy="afterInteractive" nonce={n} /> : null}
      {gaId ? (
        <Script id="beam-gtag" src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`} strategy="afterInteractive" nonce={n} />
      ) : null}
    </>
  );
}
