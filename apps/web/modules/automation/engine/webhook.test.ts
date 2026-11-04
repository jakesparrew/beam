/**
 * The webhook step (automation-P3, section 6): the client signs the exact body (HMAC SHA-256),
 * sends the idempotency header and never follows redirects; `automation.call_webhook` writes
 * `webhook_called` on 2xx, turns 4xx into `PermanentError` and 5xx into `RetryableError`, and
 * sends only `WEBHOOK_ALLOWED_FIELDS` of the person. No network: an injected `fetch` and the fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationRuns } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { PermanentError, RetryableError } from "@beam/core/errors";
import { WEBHOOK_ALLOWED_FIELDS } from "@beam/core/automation";
import { createWebhookClient, createWebhookFake, signWebhookBody, verifyWebhookSignature } from "@beam/integrations/webhook";
import { and, eq, sql } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import type * as EmailApi from "@/modules/email/api";

vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));

const { callWebhook, webhookFake, webhookStatusOutcome } = await import("./webhook");
const f = await import("./automation-p3.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await f.makeTag(h.db, "engaged");
  await h.db.execute(sql`insert into settings (key, value) values ('automation_rules', ${JSON.stringify({
    max_marketing_per_day: 1,
    max_marketing_per_week: 3,
    quiet_start: "21:00",
    quiet_end: "08:00",
    webhook_hosts: ["hooks.example.com"],
  })}::jsonb) on conflict (key) do update set value = excluded.value`);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const SECRET = "test-webhook-secret";
const now = new Date("2026-11-06T09:00:00Z");
const fake = createWebhookFake();
beforeEach(() => fake.reset());

async function webhookEnrolment(url = "https://hooks.example.com/beam") {
  const a = await f.makeAutomation(h.db, { isMarketing: false, slug: `hook-${Math.random().toString(36).slice(2, 8)}`, definition: f.steps([{ key: "w", type: "webhook", url }]) });
  const p = await makePerson(h.db, { firstName: "Noor", locale: "fr-BE", phone: "+32470000000" });
  const id = await f.enrolInto(h.db, a.id, p.id, { now });
  return { a, p, id };
}
const call = (enrolmentId: string) =>
  callWebhook(h.db as unknown as Tx, makeCtx(h.db, { now }), { enrolmentId, stepKey: "w" }, { post: fake.postWebhook, secret: SECRET });

describe("webhook client", () => {
  it("signs the exact body with HMAC SHA-256, sends the idempotency key and does not follow redirects", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = createWebhookClient({
      fetch: (url, init) => {
        seen.push({ url: String(url), init: init! });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    const body = { event: "automation.step", n: 1 };
    expect(await client.postWebhook({ url: "https://hooks.example.com/x", body, secret: SECRET, idempotencyKey: "automation_webhook:e:w" })).toEqual({ status: 204 });
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(seen[0]!.init.redirect).toBe("manual");
    expect(seen[0]!.init.body).toBe(JSON.stringify(body));
    expect(headers["X-Beam-Signature"]).toBe(signWebhookBody(JSON.stringify(body), SECRET));
    expect(headers["X-Beam-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(JSON.stringify(body), SECRET, headers["X-Beam-Signature"])).toBe(true);
    expect(verifyWebhookSignature(JSON.stringify(body), "other", headers["X-Beam-Signature"])).toBe(false);
    expect(headers["X-Beam-Idempotency-Key"]).toBe("automation_webhook:e:w");
  });

  it("a network failure is retryable; a non-https url or a missing secret is permanent", async () => {
    const client = createWebhookClient({ fetch: () => Promise.reject(new Error("ECONNRESET")) });
    await expect(client.postWebhook({ url: "https://hooks.example.com/x", body: {}, secret: SECRET, idempotencyKey: "k" })).rejects.toBeInstanceOf(RetryableError);
    await expect(client.postWebhook({ url: "http://hooks.example.com/x", body: {}, secret: SECRET, idempotencyKey: "k" })).rejects.toBeInstanceOf(PermanentError);
    await expect(client.postWebhook({ url: "https://hooks.example.com/x", body: {}, secret: "", idempotencyKey: "k" })).rejects.toBeInstanceOf(PermanentError);
  });

  it("reports each call with the host only (no body, no path)", async () => {
    const calls: unknown[] = [];
    const client = createWebhookClient({ fetch: () => Promise.resolve(new Response("x", { status: 500 })), onCall: (e) => void calls.push(e) });
    await client.postWebhook({ url: "https://hooks.example.com/secret/path?token=abc", body: { a: 1 }, secret: SECRET, idempotencyKey: "k" });
    expect(calls).toEqual([expect.objectContaining({ provider: "webhook", operation: "webhook.post", statusCode: 500, ok: false })]);
    expect(JSON.stringify(calls)).not.toMatch(/secret\/path|token|abc/);
  });
});

describe("automation.call_webhook", () => {
  it("2xx writes webhook_called; the payload carries only the allowed person fields", async () => {
    const { a, p, id } = await webhookEnrolment();
    expect(await call(id)).toEqual({ status: "called", httpStatus: 200, host: "hooks.example.com" });
    const [sent] = fake.calls;
    expect(sent!.idempotencyKey).toBe(`automation_webhook:${id}:w`);
    expect(verifyWebhookSignature(sent!.bodyText, SECRET, sent!.headers["X-Beam-Signature"])).toBe(true);
    const body = sent!.body as { person: Record<string, unknown> } & Record<string, unknown>;
    expect(Object.keys(body.person).sort()).toEqual([...WEBHOOK_ALLOWED_FIELDS].sort());
    expect(body).toMatchObject({ event: "automation.step", automation: a.slug, step_key: "w", enrolment_id: id, occurred_at: now.toISOString() });
    expect(body.person).toMatchObject({ id: p.id, first_name: "Noor", locale: "fr-BE", status: "lead", tags: [] });
    expect(sent!.bodyText).not.toContain("@");
    expect(sent!.bodyText).not.toContain("+32470000000");
    const runs = await h.db.select().from(automationRuns).where(and(eq(automationRuns.enrolmentId, id), eq(automationRuns.outcome, "webhook_called")));
    expect(runs).toHaveLength(1);
    // A retry after a commit race calls nothing again.
    expect(await call(id)).toEqual({ status: "noop", reason: "already_called" });
    expect(fake.calls).toHaveLength(1);
  });

  it("4xx is a PermanentError (dead at once), 5xx a RetryableError; neither writes a run", async () => {
    const { id } = await webhookEnrolment();
    fake.failNext(410);
    await expect(call(id)).rejects.toBeInstanceOf(PermanentError);
    fake.failNext(503);
    await expect(call(id)).rejects.toBeInstanceOf(RetryableError);
    fake.networkErrorNext();
    await expect(call(id)).rejects.toBeInstanceOf(RetryableError);
    expect(await h.db.select().from(automationRuns).where(and(eq(automationRuns.enrolmentId, id), eq(automationRuns.outcome, "webhook_called")))).toEqual([]);
    expect([webhookStatusOutcome(301), webhookStatusOutcome(404), webhookStatusOutcome(429), webhookStatusOutcome(500), webhookStatusOutcome(201)]).toEqual([
      "permanent",
      "permanent",
      "retry",
      "retry",
      "ok",
    ]);
  });

  it("a host removed from the allow-list or a missing secret is permanent; nothing is sent", async () => {
    const { id } = await webhookEnrolment("https://other.example.com/hook");
    await expect(call(id)).rejects.toThrow("webhook_host_not_allowed:other.example.com");
    const ok = await webhookEnrolment();
    await expect(callWebhook(h.db as unknown as Tx, makeCtx(h.db, { now }), { enrolmentId: ok.id, stepKey: "w" }, { post: fake.postWebhook, secret: undefined })).rejects.toThrow(
      "webhook_not_configured",
    );
    expect(fake.calls).toEqual([]);
  });

  it("with INTEGRATIONS=fake and the secret set, the call goes to the process fake and never to fetch", async () => {
    const { id } = await webhookEnrolment();
    const realFetch = vi.fn(() => Promise.reject(new Error("real fetch called")));
    vi.stubGlobal("fetch", realFetch);
    vi.stubEnv("INTEGRATIONS", "fake");
    vi.stubEnv("APP_ENV", "preview");
    vi.stubEnv("AUTOMATION_WEBHOOK_SECRET", SECRET);
    try {
      const before = webhookFake().calls.length;
      expect(await callWebhook(h.db as unknown as Tx, makeCtx(h.db, { now }), { enrolmentId: id, stepKey: "w" })).toEqual({
        status: "called",
        httpStatus: 200,
        host: "hooks.example.com",
      });
      expect(realFetch).not.toHaveBeenCalled();
      const calls = webhookFake().calls.slice(before);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ host: "hooks.example.com", idempotencyKey: `automation_webhook:${id}:w` });
      expect(verifyWebhookSignature(calls[0]!.bodyText, SECRET, calls[0]!.headers["X-Beam-Signature"])).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("a missing enrolment is a no-op", async () => {
    expect(await call("00000000-0000-4000-8000-00000000beef")).toEqual({ status: "noop", reason: "missing" });
  });
});
