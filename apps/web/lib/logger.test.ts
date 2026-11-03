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
