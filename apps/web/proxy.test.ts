import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/auth-config";
import { proxy } from "./proxy";

function request(path: string, init: { headers?: Record<string, string>; cookies?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  const cookie = Object.entries(init.cookies ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(new URL(path, "http://localhost:3100"), { headers });
}

const location = (res: Response) => {
  const value = res.headers.get("location");
  if (!value) return null;
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
};

describe("proxy locale negotiation (PL-65)", () => {
  it("sends a bare / to /nl by default", () => {
    const res = proxy(request("/"));
    expect(res.status).toBe(307);
    expect(location(res)).toBe("/nl");
  });

  it("follows Accept-Language", () => {
    expect(location(proxy(request("/", { headers: { "accept-language": "fr-BE,fr;q=0.9,en;q=0.5" } })))).toBe("/fr");
    expect(location(proxy(request("/pricing", { headers: { "accept-language": "en-GB" } })))).toBe("/en/pricing");
  });

  it("lets the NEXT_LOCALE cookie win over Accept-Language", () => {
    const res = proxy(request("/", { headers: { "accept-language": "fr" }, cookies: { NEXT_LOCALE: "en" } }));
    expect(location(res)).toBe("/en");
  });

  it("passes a prefixed path with the locale and nonce headers", () => {
    const res = proxy(request("/fr/pricing"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-beam-locale")).toBe("fr-BE");
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
  });
});

describe("proxy session presence", () => {
  it("sends /admin without a cookie to the login with returnTo", () => {
    const res = proxy(request("/admin/system/jobs?status=dead"));
    expect(res.status).toBe(307);
    expect(location(res)).toBe(`/admin/login?returnTo=${encodeURIComponent("/admin/system/jobs?status=dead")}`);
  });

  it("lets the login, invite and reset pages through without a cookie", () => {
    for (const path of ["/admin/login", "/admin/invite/abc", "/admin/reset-password", "/admin/reset-password/tok"]) {
      expect(proxy(request(path)).status).toBe(200);
    }
    expect(proxy(request("/admin/mfa/verify")).status).toBe(307);
  });

  it("only checks that the cookie exists", () => {
    expect(proxy(request("/admin/system/jobs", { cookies: { [SESSION_COOKIE]: "anything" } })).status).toBe(200);
  });

  it("sends the portal without a cookie to its localized login", () => {
    expect(location(proxy(request("/fr/account/security")))).toBe(`/fr/account/login?returnTo=${encodeURIComponent("/fr/account/security")}`);
    expect(proxy(request("/fr/account/login/check-email")).status).toBe(200);
  });
});

describe("proxy security headers (PL-67)", () => {
  it("sets a CSP with the request nonce and HSTS", () => {
    const res = proxy(request("/nl"));
    const csp = res.headers.get("content-security-policy")!;
    const nonce = res.headers.get("x-middleware-request-x-nonce")!;
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains; preload");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("uses a fresh nonce per request", () => {
    const a = proxy(request("/nl")).headers.get("x-middleware-request-x-nonce");
    const b = proxy(request("/nl")).headers.get("x-middleware-request-x-nonce");
    expect(a).not.toBe(b);
  });

  it("sends exactly one CSP header under /nl/f/contact, allowing any frame ancestor", () => {
    const res = proxy(request("/nl/f/contact"));
    const values = [...res.headers.entries()].filter(([k]) => k.toLowerCase() === "content-security-policy");
    expect(values).toHaveLength(1);
    expect(values[0]![1]).toContain("frame-ancestors *");
  });

  it("adds the headers to redirects too", () => {
    const res = proxy(request("/"));
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect(res.headers.get("strict-transport-security")).toBeTruthy();
  });
});

describe("legacy WordPress paths answer 410 Gone (site-P2 request)", () => {
  it("answers 410 with the security headers, with or without a locale prefix", () => {
    for (const path of ["/wp-admin", "/nl/wp-admin/options.php", "/wp-login.php", "/fr/xmlrpc.php", "/en/wp-json/wp/v2/posts"]) {
      const res = proxy(request(path));
      expect(res.status, path).toBe(410);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-security-policy")).toBeTruthy();
    }
  });

  it("renders the localised gone page: the URL's locale, one h1, a link back to home", async () => {
    const res = proxy(request("/fr/wp-admin"));
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<html lang="fr-BE">');
    expect(html).toContain('data-status="410"');
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<a href="/fr">');
    expect(html).not.toContain("<script");
    expect(await proxy(request("/wp-login.php", { headers: { "accept-language": "en" } })).text()).toContain('<html lang="en">');
  });

  it("leaves look-alikes and normal pages alone", () => {
    expect(proxy(request("/nl/wp-adminx")).status).not.toBe(410);
    expect(proxy(request("/nl/over-ons")).status).toBe(200);
    expect(proxy(request("/admin/login")).status).toBe(200);
  });

  it("the matcher sends the legacy .php files to the proxy", async () => {
    const { config } = await import("./proxy");
    // Next compiles `config.matcher` with its bundled path-to-regexp (no type declarations).
    const { createRequire } = await import("node:module");
    const { pathToRegexp } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as { pathToRegexp: (p: string) => RegExp };
    const matches = (path: string) => config.matcher.some((m) => pathToRegexp(m).test(path));
    expect(matches("/wp-login.php")).toBe(true);
    expect(matches("/nl/xmlrpc.php")).toBe(true);
    expect(matches("/nl/over-ons")).toBe(true);
    expect(matches("/logo.png")).toBe(false);
    expect(matches("/api/health")).toBe(false);
  });

  it("the matcher keeps signed-token pages whose last segment looks like an extension", async () => {
    const { config } = await import("./proxy");
    const { createRequire } = await import("node:module");
    const { pathToRegexp } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as { pathToRegexp: (p: string) => RegExp };
    const matches = (path: string) => config.matcher.some((m) => pathToRegexp(m).test(path));
    // A webinar link `<registration id>.<n>.<signature>`: a signature of letters and digits only
    // used to read as a file extension, and the page skipped the CSP.
    expect(matches("/nl/w/2b900abe-c376-4ba7-9865-70754bb4c4ab.1.Qx7fK2mZpL9sTb4wN8eRvY3cH6jD1aGk")).toBe(true);
    expect(matches("/fr/f/recovery-check/r/abc.def123")).toBe(true);
    expect(matches("/fonts/inter.woff2")).toBe(false);
    expect(matches("/images/hero.webp")).toBe(false);
  });
});
