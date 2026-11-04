import { describe, expect, it } from "vitest";
import { createLogger, maskPii, reportError, scrubSentryEvent } from "./logger";
import { fakeSentry } from "./testing";

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ write: (s: string) => void lines.push(s) });
  logger.level = "info";
  return { logger, lines };
}

describe("pino redaction (PL-72)", () => {
  it("logs none of email, phone, first name or the cookie header", () => {
    const { logger, lines } = capture();
    logger.info(
      {
        email: "ann.peeters@example.com",
        phone: "+32 470 12 34 56",
        first_name: "Annelies",
        req: { headers: { cookie: "authjs.session-token=s3cr3t-cookie-value", authorization: "Bearer tok-123456" } },
        person: { email: "nested@example.com", last_name: "Peeters" },
        personId: "7b0d5a8e-0000-4000-8000-000000000001",
      },
      "signed in",
    );
    const out = lines.join("");
    for (const value of ["ann.peeters@example.com", "+32 470 12 34 56", "Annelies", "s3cr3t-cookie-value", "tok-123456", "nested@example.com", "Peeters"]) {
      expect(out).not.toContain(value);
    }
    expect(out).toContain("7b0d5a8e-0000-4000-8000-000000000001");
    expect(out).toContain("[redacted]");
  });
});

describe("Sentry beforeSend (PL-72)", () => {
  it("masks an email and a phone number in the message and exception", () => {
    const event = scrubSentryEvent({
      message: "Could not send to ann@example.com, call 0470 12 34 56",
      exception: { values: [{ value: "Bounce for bob@example.com" }] },
    });
    expect(event.message).toBe("Could not send to [email], call [phone]");
    expect(event.exception?.values?.[0]?.value).toBe("Bounce for [email]");
  });

  it("drops request bodies, cookies and auth headers, and keeps only the user id", () => {
    const event = scrubSentryEvent({
      request: { data: { password: "x" }, cookies: { a: "b" }, headers: { Cookie: "a=b", Authorization: "Bearer x", "user-agent": "ua" } },
      user: { id: "u1", email: "ann@example.com", ip_address: "1.2.3.4" },
    });
    expect(event.request).toEqual({ headers: { "user-agent": "ua" } });
    expect(event.user).toEqual({ id: "u1" });
  });

  it("removes reset/invite tokens and query strings from every URL of errors and transactions", () => {
    const event = scrubSentryEvent({
      transaction: "/admin/reset-password/s3cr3tT0ken",
      request: { url: "https://beam.example.com/nl/account/login/verify?token=abc&email=ann@example.com", query_string: "token=abc&email=ann%40example.com" },
      contexts: { trace: { data: { "url.full": "https://beam.example.com/admin/invite/inv1te?x=1" } } },
      spans: [{ description: "GET /admin/invite/inv1te?x=1", data: { "http.url": "https://beam.example.com/admin/reset-password/tok#frag" } }],
      breadcrumbs: [{ data: { from: "/admin/invite/inv1te", to: "/nl/account/login/verify?token=abc" } }],
    });
    const text = JSON.stringify(event);
    for (const secret of ["s3cr3tT0ken", "inv1te", "tok#", "token=abc", "ann@example.com", "ann%40"]) expect(text).not.toContain(secret);
    expect(event.transaction).toBe("/admin/reset-password/[token]");
    expect(event.request).toEqual({ url: "https://beam.example.com/nl/account/login/verify" });
    expect(event.contexts?.trace?.data?.["url.full"]).toBe("https://beam.example.com/admin/invite/[token]");
    expect(event.breadcrumbs?.[0]?.data).toEqual({ from: "/admin/invite/[token]", to: "/nl/account/login/verify" });
    expect(event.spans?.[0]?.description).toBe("GET /admin/invite/[token]");
  });

  it("removes the module token routes from request.url, the Referer header and breadcrumbs", () => {
    const cases: [string, string][] = [
      ["/nl/preferences/pr3fT0k", "/nl/preferences/[token]"],
      ["/nl/claim/cla1mT0k", "/nl/claim/[token]"],
      ["/nl/pay/payT0k", "/nl/pay/[token]"],
      ["/nl/f/intake/r/f0rmT0k", "/nl/f/intake/r/[token]"],
      ["/api/public/unsubscribe/unsubT0k", "/api/public/unsubscribe/[token]"],
      ["/api/public/preferences/pr3fT0k", "/api/public/preferences/[token]"],
      ["/api/public/claim/cla1mT0k", "/api/public/claim/[token]"],
      ["/api/public/forms/result/f0rmT0k/go/book", "/api/public/forms/result/[token]/go/book"],
    ];
    for (const [path, scrubbed] of cases) {
      const event = scrubSentryEvent({
        request: { url: `https://beam.example.com${path}?x=1`, headers: { Referer: `https://beam.example.com${path}` } },
        breadcrumbs: [{ data: { from: "/nl", to: path } }],
      });
      expect(event.request?.url).toBe(`https://beam.example.com${scrubbed}`);
      expect(event.request?.headers?.Referer).toBe(`https://beam.example.com${scrubbed}`);
      expect(event.breadcrumbs?.[0]?.data?.to).toBe(scrubbed);
    }
    expect(scrubSentryEvent({ transaction: "/nl/account/preferences" }).transaction).toBe("/nl/account/preferences");
  });

  it("maskPii leaves ids and amounts alone", () => {
    expect(maskPii("order 3f2a payment 1250 cents")).toBe("order 3f2a payment 1250 cents");
  });

  it("reportError goes through the swappable reporter", () => {
    const sentry = fakeSentry();
    reportError(new Error("boom"), { tags: { where: "test" } });
    expect(sentry.exceptions).toHaveLength(1);
    expect(sentry.exceptions[0]!.tags).toEqual({ where: "test" });
    sentry.restore();
  });
});
