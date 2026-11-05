/**
 * The service worker (site spec section 5, site-P5), built by the Serwist plugin of
 * `next.config.ts` into `public/sw.js` and registered by `M/ui/public/sw-register.tsx`.
 * - precaches the build assets and the offline pages `/nl/offline`, `/fr/offline`, `/en/offline`;
 * - `/_next/static` cache-first; images stale-while-revalidate (7 days, 200 entries);
 * - public navigations network-first with a 3-second timeout, the locale's offline page as fallback;
 * - personal navigations network-only (never stored, never served from cache), with the offline
 *   fallback: the portal (`/<prefix>/account...`) and the token and session pages outside it
 *   (`checkout`, `pay`, `claim`, `preferences`, `preview`, `gift`, form resume links `f/<slug>/r/...`),
 *   and on activation such pages a previous worker stored in `pages` are deleted (edge case 24). A
 *   `Cache-Control` filter is not used: every site page is dynamic (the layout reads the request
 *   nonce and the consent cookie), so Next sends `no-store` on public content pages too;
 * - never handles `/admin/*`, `/api/*` or non-GET requests (no route matches them, so the
 *   browser fetches them itself).
 */
import { CacheFirst, ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist, StaleWhileRevalidate, type PrecacheEntry, type RouteMatchCallbackOptions } from "serwist";

// The worker global, declared locally so the app keeps the DOM lib (no `webworker` lib needed).
declare const self: {
  __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  addEventListener(type: "activate", listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void): void;
};

const PREFIXES = ["nl", "fr", "en"] as const;
/** Bump when the offline page changes (its URL carries no build hash). */
const OFFLINE_REVISION = "site-p5-1";

const isExcluded = (url: URL): boolean => /^\/(admin|api)(\/|$)/.test(url.pathname);
/** Navigations that carry personal data or a credential in the URL, cookie or session: never cached. */
const isPersonal = (url: URL): boolean =>
  /^\/(nl|fr|en)\/(account|checkout|pay|claim|preferences|preview|gift)(\/|$)/.test(url.pathname) || /^\/(nl|fr|en)\/f\/[^/]+\/r(\/|$)/.test(url.pathname);
const isNavigation = ({ request }: { request: Request }): boolean => request.mode === "navigate" || request.destination === "document";

const offlineUrl = (url: URL): string => {
  const prefix = PREFIXES.find((p) => url.pathname === `/${p}` || url.pathname.startsWith(`/${p}/`)) ?? "nl";
  return `/${prefix}/offline`;
};

const serwist = new Serwist({
  precacheEntries: [...(self.__SW_MANIFEST ?? []), ...PREFIXES.map((p) => ({ url: `/${p}/offline`, revision: OFFLINE_REVISION }))],
  skipWaiting: true,
  clientsClaim: true,
  // Off on purpose: with preload on, the browser sends a preload request for every navigation the
  // worker controls, including /api/* that no route here answers, and then fetches the URL again.
  // Every GET with a side effect ran twice: a magic link was consumed by the first request and the
  // second ended on error=Verification (final e2e gate). Pages lose only the preload head start.
  navigationPreload: false,
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
      matcher: ({ request, url, sameOrigin }: RouteMatchCallbackOptions) => sameOrigin && !isExcluded(url) && isPersonal(url) && isNavigation({ request }),
      handler: new NetworkOnly(),
    },
    {
      matcher: ({ request, url, sameOrigin }: RouteMatchCallbackOptions) => sameOrigin && !isExcluded(url) && !isPersonal(url) && isNavigation({ request }),
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

/** Deletes personal pages an earlier worker version stored in the `pages` cache. */
async function purgePersonalPages(): Promise<void> {
  const cache = await caches.open("pages");
  for (const request of await cache.keys()) if (isPersonal(new URL(request.url))) await cache.delete(request);
}

self.addEventListener("activate", (event) => event.waitUntil(purgePersonalPages()));
serwist.addEventListeners();
