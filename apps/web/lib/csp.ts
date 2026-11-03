/**
 * The Content-Security-Policy of every HTML response (PL-67), built per request by `proxy.ts`
 * with a fresh nonce. The whole CSP lives here: a second CSP header elsewhere would be
 * enforced together with this one. A new origin is added here by an orchestrator PR only.
 */

/** A fresh base64 nonce of 16 random bytes (Web Crypto, so it also runs in the proxy). */
export function generateNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Forms' embeddable pages `/:locale/f/:path*` may be framed by any site (the one exception). */
export function isEmbeddablePath(pathname: string): boolean {
  return /^\/(nl|fr|en)\/f\/[^/]+/.test(pathname);
}

const GA_IMG = ["https://*.google-analytics.com", "https://*.googletagmanager.com"];
const GA_CONNECT = ["https://*.google-analytics.com", "https://*.analytics.google.com", "https://www.googletagmanager.com"];
/** R3 ad tags (Google Ads conversion, Meta pixel), present from Wave 0 so R3 needs no change here. */
const AD_TAGS = ["https://www.googleadservices.com", "https://googleads.g.doubleclick.net", "https://www.facebook.com"];

export function buildCsp(input: { nonce: string; pathname: string }): string {
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", `'nonce-${input.nonce}'`, "'strict-dynamic'", "https://connect.facebook.net"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https://i.ytimg.com", ...GA_IMG, ...AD_TAGS]],
    ["font-src", ["'self'", "data:"]],
    ["frame-src", ["https://www.youtube-nocookie.com", "https://www.youtube.com"]],
    [
      "connect-src",
      ["'self'", "https://*.ingest.de.sentry.io", ...GA_CONNECT, ...AD_TAGS, "https://va.vercel-scripts.com", "https://api.pwnedpasswords.com"],
    ],
    ["frame-ancestors", [isEmbeddablePath(input.pathname) ? "*" : "'none'"]],
    ["form-action", ["'self'", "https://www.mollie.com"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/** The static security headers of PL-67 (also set by `next.config.ts` for non-proxied paths). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
