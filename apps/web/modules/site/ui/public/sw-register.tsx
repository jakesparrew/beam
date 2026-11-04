"use client";

/**
 * Registers the service worker `/sw.js` (built from `app/sw.ts` by Serwist; site spec section 5)
 * with scope `/` once the page has loaded. Skipped in development (the Serwist plugin is disabled
 * there, so no worker file exists) and where the browser has no service worker support.
 */
import { useEffect } from "react";

export const SW_URL = "/sw.js";

export function registerServiceWorker(nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator): Promise<ServiceWorkerRegistration | null> {
  if (!nav || !("serviceWorker" in nav) || !nav.serviceWorker) return Promise.resolve(null);
  return nav.serviceWorker.register(SW_URL, { scope: "/" }).catch(() => null);
}

export function SwRegister({ enabled = process.env.NODE_ENV === "production" }: { enabled?: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    const run = () => void registerServiceWorker();
    if (document.readyState === "complete") run();
    else {
      window.addEventListener("load", run, { once: true });
      return () => window.removeEventListener("load", run);
    }
  }, [enabled]);
  return null;
}
