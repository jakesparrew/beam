import { describe, expect, it } from "vitest";
import type { IntegrationCallEntry } from "../_shared/types";
import { createResendClient } from "./client";
import { createFakeResendClient, createResendFake } from "./fake";
import type { OutgoingEmail, SendEmailInput } from "./types";

const msg = (i: number): OutgoingEmail => ({
  from: "BEAM <news@news.beam.be>",
  to: `person-${i}@example.com`,
  replyTo: "info@beam.be",
  subject: `Hi ${i}`,
  html: "<p>Hi</p>",
  text: "Hi",
  headers: { "List-Unsubscribe": "<https://beam.be/api/public/unsubscribe?t=x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  tags: [
    { name: "message_id", value: `m${i}` },
    { name: "kind", value: "campaign" },
  ],
});

/** The exact Wave 0 call shape of `email.send` (platform-P7). */
const wave0: SendEmailInput = {
  from: "BEAM <hello@mail.beam.be>",
  to: "customer1@example.com",
  subject: "Your login link",
  html: "<p>Link</p>",
  text: "Link",
  replyTo: "info@beam.be",
  headers: {},
  attachments: [{ filename: "checkin-qr.png", content: new Uint8Array([1, 2, 3]), contentType: "image/png", inline: true }],
  idempotencyKey: "email:m1",
};

type Seen = { url: string; method: string; headers: Headers; body: unknown };

function recorder(responder: (seen: Seen) => Response) {
  const calls: Seen[] = [];
  const fetch = (url: string | URL, init?: RequestInit) => {
    const seen: Seen = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(seen);
    return Promise.resolve(responder(seen));
  };
  return { calls, fetch };
}

describe("Resend fake", () => {
  it("honours idempotency keys for single and batch sends, with deterministic re_fake_<n> ids", async () => {
    const fake = createFakeResendClient();
    const a = await fake.sendEmail({ ...msg(1), idempotencyKey: "email:1" });
    const again = await fake.sendEmail({ ...msg(1), idempotencyKey: "email:1" });
    expect(a).toEqual({ id: "re_fake_1" });
    expect(again).toEqual(a);
    const batch = await fake.sendBatch([msg(2), msg(3)], { idempotencyKey: "campaign:c:chunk:0:batch:0" });
    const retried = await fake.sendBatch([msg(2), msg(3)], { idempotencyKey: "campaign:c:chunk:0:batch:0" });
    expect(batch).toEqual({ ids: ["re_fake_2", "re_fake_3"] });
    expect(retried).toEqual(batch);
    expect(fake.sent).toHaveLength(3);
    expect(fake.batches).toEqual([{ idempotencyKey: "campaign:c:chunk:0:batch:0", ids: ["re_fake_2", "re_fake_3"] }]);
    expect(fake.sentTo("PERSON-3@example.com")[0]).toMatchObject({ id: "re_fake_3", batchKey: "campaign:c:chunk:0:batch:0" });
  });

  it("refuses a batch of 101, an empty batch and a batch with attachments", async () => {
    const fake = createFakeResendClient();
    const many = Array.from({ length: 101 }, (_, i) => msg(i));
    await expect(fake.sendBatch(many, { idempotencyKey: "k" })).rejects.toMatchObject({ provider: "resend", retryable: false, code: "batch_too_large" });
    await expect(fake.sendBatch([], { idempotencyKey: "k" })).rejects.toMatchObject({ code: "batch_empty" });
    await expect(fake.sendBatch([{ ...msg(1), attachments: wave0.attachments! }], { idempotencyKey: "k" })).rejects.toMatchObject({ code: "batch_attachments" });
    expect((await fake.sendBatch(many.slice(0, 100), { idempotencyKey: "k100" })).ids).toHaveLength(100);
    expect(fake.sent).toHaveLength(100);
  });

  it("fails the next call on demand, retryable or permanent, and records calls", async () => {
    const entries: IntegrationCallEntry[] = [];
    const fake = createFakeResendClient({ onCall: (e) => void entries.push(e) });
    fake.failNext("retryable");
    await expect(fake.sendEmail({ ...msg(1), idempotencyKey: "email:1" })).rejects.toMatchObject({ retryable: true, statusCode: 503 });
    fake.failNext("permanent");
    await expect(fake.sendBatch([msg(1)], { idempotencyKey: "b" })).rejects.toMatchObject({ retryable: false, statusCode: 422 });
    fake.failNext(429);
    await expect(fake.getDomain("news.beam.be")).rejects.toMatchObject({ retryable: true, statusCode: 429 });
    expect(await fake.sendEmail({ ...msg(1), idempotencyKey: "email:1" })).toEqual({ id: "re_fake_1" });
    expect(entries.map((e) => [e.operation, e.ok])).toEqual([
      ["emails.send", false],
      ["emails.batch", false],
      ["domains.get", false],
      ["emails.send", true],
    ]);
  });

  it("reports domains (verified by default) and deletes contacts defensively", async () => {
    const fake = createFakeResendClient();
    expect((await fake.getDomain("mail.beam.be")).status).toBe("verified");
    fake.setDomain("news.beam.be", { status: "failed", records: [{ type: "TXT", name: "resend._domainkey.news.beam.be", status: "failed" }] });
    expect((await fake.getDomain("news.beam.be")).status).toBe("failed");
    expect(await fake.deleteContact("nobody@example.com")).toEqual({ deleted: false });
    fake.addContact("Someone@example.com");
    expect(await fake.deleteContact("someone@example.com")).toEqual({ deleted: true });
    expect(fake.deletedContacts).toEqual(["someone@example.com"]);
    fake.reset();
    expect(fake.sent).toHaveLength(0);
  });

  it("keeps the Wave 0 fake_<uuid> ids and call shape through createResendFake", async () => {
    const fake = createResendFake();
    const { id } = await fake.sendEmail(wave0);
    expect(id).toMatch(/^fake_[0-9a-f-]{36}$/);
    expect(fake.sent[0]).toMatchObject({ to: "customer1@example.com", idempotencyKey: "email:m1" });
  });
});

describe("Resend client", () => {
  it("accepts Wave 0's sendEmail call shape and posts it with the Idempotency-Key", async () => {
    const r = recorder(() => Response.json({ id: "re_1" }));
    const client = createResendClient({ apiKey: "re_test_key_123456", fetch: r.fetch });
    expect(await client.sendEmail(wave0)).toEqual({ id: "re_1" });
    const call = r.calls[0]!;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.headers.get("idempotency-key")).toBe("email:m1");
    expect(call.headers.get("authorization")).toBe("Bearer re_test_key_123456");
    expect(call.body).toMatchObject({
      to: ["customer1@example.com"],
      reply_to: "info@beam.be",
      attachments: [{ filename: "checkin-qr.png", content: "AQID", content_type: "image/png", content_id: "checkin-qr.png" }],
    });
  });

  it("sends tags and batches with the batch Idempotency-Key, ids in order", async () => {
    const r = recorder(() => Response.json({ data: [{ id: "re_a" }, { id: "re_b" }] }));
    const client = createResendClient({ apiKey: "k", fetch: r.fetch });
    expect(await client.sendBatch([msg(1), msg(2)], { idempotencyKey: "campaign:c:chunk:0:batch:1" })).toEqual({ ids: ["re_a", "re_b"] });
    const call = r.calls[0]!;
    expect(call.url).toBe("https://api.resend.com/emails/batch");
    expect(call.headers.get("idempotency-key")).toBe("campaign:c:chunk:0:batch:1");
    expect(call.body).toMatchObject([{ to: ["person-1@example.com"], tags: [{ name: "message_id", value: "m1" }, { name: "kind", value: "campaign" }] }, { subject: "Hi 2" }]);
  });

  it("refuses a batch of 101 before any request", async () => {
    const r = recorder(() => Response.json({ data: [] }));
    const client = createResendClient({ apiKey: "k", fetch: r.fetch });
    await expect(client.sendBatch(Array.from({ length: 101 }, (_, i) => msg(i)), { idempotencyKey: "k" })).rejects.toMatchObject({ retryable: false, code: "batch_too_large" });
    expect(r.calls).toHaveLength(0);
  });

  it.each([
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [400, false],
    [401, false],
    [422, false],
  ])("maps HTTP %i to retryable=%s", async (status, retryable) => {
    const client = createResendClient({ apiKey: "k", fetch: () => Promise.resolve(new Response("nope", { status })) });
    await expect(client.sendEmail(wave0)).rejects.toMatchObject({ provider: "resend", retryable, statusCode: status });
    await expect(client.sendBatch([msg(1)], { idempotencyKey: "b" })).rejects.toMatchObject({ retryable, statusCode: status });
  });

  it("treats a network failure as retryable and never logs bodies or addresses", async () => {
    const entries: IntegrationCallEntry[] = [];
    const client = createResendClient({ apiKey: "k", onCall: (e) => void entries.push(e), fetch: () => Promise.reject(new Error("connect ECONNRESET for customer1@example.com")) });
    await expect(client.sendEmail(wave0)).rejects.toMatchObject({ retryable: true });
    expect(JSON.stringify(entries)).not.toContain("customer1@example.com");
    expect(entries[0]).toMatchObject({ provider: "resend", operation: "emails.send", ok: false });
  });

  it("refuses a batch response whose id count differs (retryable)", async () => {
    const client = createResendClient({ apiKey: "k", fetch: () => Promise.resolve(Response.json({ data: [{ id: "re_a" }] })) });
    await expect(client.sendBatch([msg(1), msg(2)], { idempotencyKey: "b" })).rejects.toMatchObject({ retryable: true, code: "invalid_response" });
  });

  it("maps deleteContact 404 to { deleted: false } and 200 to { deleted: true }", async () => {
    const r = recorder((seen) => (seen.url.includes("gone%40example.com") ? new Response("not found", { status: 404 }) : Response.json({ deleted: true })));
    const client = createResendClient({ apiKey: "k", fetch: r.fetch });
    expect(await client.deleteContact("Gone@example.com")).toEqual({ deleted: false });
    expect(await client.deleteContact("here@example.com")).toEqual({ deleted: true });
    expect(r.calls.map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
    const failing = createResendClient({ apiKey: "k", fetch: () => Promise.resolve(new Response("x", { status: 500 })) });
    await expect(failing.deleteContact("x@example.com")).rejects.toMatchObject({ retryable: true });
  });

  it("reads a domain by configured id, or finds the id by name", async () => {
    const domain = { id: "d_news", name: "news.beam.be", status: "temporary_failure", records: [{ record: "DKIM", type: "TXT", name: "resend._domainkey", status: "failed" }] };
    const r = recorder((seen) =>
      seen.url.endsWith("/domains") ? Response.json({ data: [{ id: "d_mail", name: "mail.beam.be" }, { id: "d_news", name: "news.beam.be" }] }) : Response.json(domain),
    );
    const byName = createResendClient({ apiKey: "k", fetch: r.fetch });
    expect(await byName.getDomain("news.beam.be")).toEqual({ status: "pending", records: [{ type: "TXT", name: "resend._domainkey", status: "failed" }] });
    expect(r.calls.map((c) => c.url)).toEqual(["https://api.resend.com/domains", "https://api.resend.com/domains/d_news"]);
    const byId = createResendClient({ apiKey: "k", fetch: r.fetch, domainIds: { "news.beam.be": "d_news" } });
    await byId.getDomain("news.beam.be");
    expect(r.calls.at(-1)?.url).toBe("https://api.resend.com/domains/d_news");
    expect(r.calls).toHaveLength(3);
  });
});
