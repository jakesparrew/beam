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
