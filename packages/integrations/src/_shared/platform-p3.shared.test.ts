import { describe, expect, it } from "vitest";
import { NotImplementedError, PermanentError } from "@beam/core/errors";
import { createBillitClient } from "../billit";
import { digestRequest, errorFromStatus, IntegrationError, isPermanentFailure, scrubError, trackCall, withTimeout, type IntegrationCallEntry } from "./index";

describe("digestRequest", () => {
  it("is stable across param order and excludes secrets", () => {
    const a = digestRequest({ method: "get", path: "/v2/payments?limit=5&from=tr_1", params: { apiKey: "secret-1" } });
    const b = digestRequest({ method: "GET", path: "/v2/payments", params: { from: "tr_1", limit: 5, token: "other-secret" } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(digestRequest({ method: "GET", path: "/v2/payments", params: { limit: 6 } })).not.toBe(a);
  });
});

describe("errors", () => {
  it("maps statuses: 408, 429 and 5xx retryable; other 4xx permanent", () => {
    expect([408, 429, 500, 503, 529].map((s) => errorFromStatus("mollie", "payments.get", s).retryable)).toEqual([true, true, true, true, true]);
    expect([400, 401, 403, 404, 422].map((s) => errorFromStatus("mollie", "payments.get", s).retryable)).toEqual([false, false, false, false, false]);
    expect(isPermanentFailure(errorFromStatus("mollie", "x", 422))).toBe(true);
    expect(isPermanentFailure(errorFromStatus("mollie", "x", 503))).toBe(false);
    expect(isPermanentFailure(new PermanentError("x"))).toBe(true);
    expect(isPermanentFailure(new Error("x"))).toBe(false);
  });

  it("scrubs emails, bearer tokens and keys", () => {
    expect(scrubError("to lotte@example.com with Bearer abc.def and test_abcdefghijk")).toBe("to [email] with Bearer [redacted] and [redacted]");
    expect(scrubError("x".repeat(2000))).toHaveLength(1000);
  });
});

describe("withTimeout and trackCall", () => {
  it("times out with a retryable IntegrationError and aborts the work", async () => {
    let aborted = false;
    const err = await withTimeout(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve("late");
          });
        }),
      10,
      { provider: "slack", operation: "webhook.post" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err).toMatchObject({ retryable: true, code: "timeout" });
    expect(aborted).toBe(true);
  });

  it("logs success and failure; unknown errors become retryable network errors", async () => {
    const entries: IntegrationCallEntry[] = [];
    const meta = { provider: "resend" as const, operation: "emails.send", requestDigest: "d" };
    let t = 0;
    const clock = () => (t += 5);
    expect(await trackCall((e) => void entries.push(e), meta, () => ({ value: 1, statusCode: 200 }), clock)).toBe(1);
    const err = await trackCall((e) => void entries.push(e), meta, () => {
      throw new TypeError("fetch failed for lotte@example.com");
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: true, code: "network" });
    expect(entries).toEqual([
      { ...meta, statusCode: 200, ok: true, durationMs: 5, error: null },
      { ...meta, statusCode: null, ok: false, durationMs: expect.any(Number), error: "resend emails.send: fetch failed for [email]" },
    ]);
  });
});

describe("billit Wave 0 client", () => {
  it("has finance's signature and throws NotImplementedError on every call", async () => {
    const client = createBillitClient({ baseUrl: "https://api.sandbox.billit.be", apiKey: "x", partyId: "1", onCall: () => undefined });
    await expect(client.getOrder("1")).rejects.toBeInstanceOf(NotImplementedError);
    await expect(client.anonymiseCustomer("1")).rejects.toBeInstanceOf(PermanentError);
  });
});
