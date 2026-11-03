import { describe, expect, it } from "vitest";
import { buildCsp, generateNonce } from "./csp";

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? "";

describe("buildCsp (PL-67)", () => {
  it("uses a fresh nonce per call", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(directive(buildCsp({ nonce: a, pathname: "/nl" }), "script-src")).toContain(`'nonce-${a}'`);
  });

  it("denies framing everywhere except the embeddable forms pages", () => {
    for (const pathname of ["/nl/account", "/nl/f", "/nl/forms", "/admin/login", "/"]) {
      expect(directive(buildCsp({ nonce: "n", pathname }), "frame-ancestors")).toBe("frame-ancestors 'none'");
    }
    for (const pathname of ["/nl/f/intake", "/fr/f/contact", "/en/f/contact/thanks"]) {
      expect(directive(buildCsp({ nonce: "n", pathname }), "frame-ancestors")).toBe("frame-ancestors *");
    }
  });

  it("allows YouTube frames, Sentry, GA4 and the R3 ad tags", () => {
    const csp = buildCsp({ nonce: "n", pathname: "/nl" });
    expect(directive(csp, "frame-src")).toContain("https://www.youtube-nocookie.com");
    expect(directive(csp, "frame-src")).toContain("https://www.youtube.com");
    const connect = directive(csp, "connect-src");
    const img = directive(csp, "img-src");
    expect(connect).toContain("https://*.ingest.de.sentry.io");
    expect(connect).toContain("https://api.pwnedpasswords.com");
    for (const host of ["https://*.google-analytics.com", "https://*.analytics.google.com", "https://www.googletagmanager.com"]) {
      expect(connect).toContain(host);
    }
    for (const host of ["https://*.google-analytics.com", "https://*.googletagmanager.com"]) expect(img).toContain(host);
    for (const host of ["https://www.googleadservices.com", "https://googleads.g.doubleclick.net", "https://www.facebook.com"]) {
      expect(connect).toContain(host);
      expect(img).toContain(host);
    }
    expect(directive(csp, "script-src")).toContain("https://connect.facebook.net");
  });

  it("never allows unsafe-eval and keeps the fixed directives", () => {
    const csp = buildCsp({ nonce: "n", pathname: "/fr/f/contact" });
    expect(csp).not.toContain("unsafe-eval");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "form-action")).toBe("form-action 'self' https://www.mollie.com");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
  });
});
