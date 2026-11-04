/**
 * The service worker (site spec section 5, site-P5), built by the Serwist plugin of
 * `next.config.ts` into `public/sw.js` and registered by `M/ui/public/sw-register.tsx`.
 * - precaches the build assets and the offline pages `/nl/offline`, `/fr/offline`, `/en/offline`;
 * - `/_next/static` cache-first; images stale-while-revalidate (7 days, 200 entries);
 * - public navigations network-first with a 3-second timeout, the locale's offline page as fallback;
 * - portal navigations (`/<prefix>/account...`) network-only (never served from cache while the
 *   network answers, never stored), with the offline fallback;
 * - never handles `/admin/*`, `/api/*` or non-GET requests (no route matches them, so the
 *   browser fetches them itself).
 */
import { CacheFirst, ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist, StaleWhileRevalidate, type PrecacheEntry, type RouteMatchCallbackOptions } from "serwist";

// The worker global, declared locally so the app keeps the DOM lib (no `webworker` lib needed).
declare const self: { __SW_MANIFEST: (PrecacheEntry | string)[] | undefined };

const PREFIXES = ["nl", "fr", "en"] as const;
/** Bump when the offline page changes (its URL carries no build hash). */
const OFFLINE_REVISION = "site-p5-1";

const isExcluded = (url: URL): boolean => /^\/(admin|api)(\/|$)/.test(url.pathname);
const isPortal = (url: URL): boolean => /^\/(nl|fr|en)\/account(\/|$)/.test(url.pathname);
const isNavigation = ({ request }: { request: Request }): boolean => request.mode === "navigate" || request.destination === "document";

const offlineUrl = (url: URL): string => {
  const prefix = PREFIXES.find((p) => url.pathname === `/${p}` || url.pathname.startsWith(`/${p}/`)) ?? "nl";
  return `/${prefix}/offline`;
};

const serwist = new Serwist({
  precacheEntries: [...(self.__SW_MANIFEST ?? []), ...PREFIXES.map((p) => ({ url: `/${p}/offline`, revision: OFFLINE_REVISION }))],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ url, sameOrigin }: RouteMatchCallbackOptions) => sameOrigin && url.pathname.startsWith("/_next/static/"),
      handler: new CacheFirst({ cacheName: "next-static", plugins: [new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 365 * 86_400 })] }),
    },
    {
      matcher: ({ request, url, sameOrigin }: RouteMatchCallbackOptions) => sameOrigin && !isExcluded(url) && request.destination === "image",
      handler: new StaleWhileRevalidate({ cacheName: "images", plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 86_400 })] }),
    },
    {
      matcher: ({ request, url, sameOrigin }: RouteMatchCallbackOptions) => sameOrigin && !isExcluded(url) && isPortal(url) && isNavigation({ request }),
      handler: new NetworkOnly(),
    },
    {
      matcher: ({ request, url, sameOrigin }: RouteMatchCallbackOptions) => sameOrigin && !isExcluded(url) && !isPortal(url) && isNavigation({ request }),
      handler: new NetworkFirst({ cacheName: "pages", networkTimeoutSeconds: 3, plugins: [new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 7 * 86_400 })] }),
    },
  ],
  fallbacks: {
    entries: PREFIXES.map((p) => ({
      url: `/${p}/offline`,
      matcher: ({ request }: { request: Request }) => isNavigation({ request }) && offlineUrl(new URL(request.url)) === `/${p}/offline`,
    })),
  },
});

serwist.addEventListeners();
