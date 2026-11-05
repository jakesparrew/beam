/**
 * crm-P9 Meta channel (crm spec 4.4, 4.5 and 6; edge case 28) with the Meta messaging fake:
 * the signature check, the subscription challenge, one stored event and one message per `mid`,
 * linking by `external_ids.meta_psid`, the Send API reply and a closed 24-hour window as a
 * permanent error with the reason on the message.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { inboxMessages, inboxThreads, persons, settings, webhookEvents } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { createMetaMessagingClient, createMetaMessagingFake, parseMetaWebhook, signMetaBody, verifyMetaSignature } from "@beam/integrations/meta-messaging";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
vi.mock("next/server", () => ({ after: () => undefined }));

const { GET, POST } = await import("@/app/api/webhooks/meta/route");
const { handleMetaWebhook, runSendMetaReply, setMetaMessagingClient } = await import("./jobs");
const api = await import("./api");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
const fake = createMetaMessagingFake();

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  setMetaMessagingClient(fake);
  await h.db
    .insert(settings)
    .values({ key: "inbox", value: { escalation_hours: 24, stale_pending_days: 14, default_assignee_role: "customer_service", meta_enabled: true } })
    .onConflictDoNothing();
});
afterEach(() => fake.reset());
afterAll(async () => {
  setMetaMessagingClient(undefined);
  resetRuntime();
  await h.close();
});

const post = (raw: string, signature: string | null) =>
  POST(new Request("https://beam.example.com/api/webhooks/meta", { method: "POST", body: raw, headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) } }));
const delivery = (messages: { mid: string; senderId: string; text?: string; attachments?: number }[], channel: "messenger" | "instagram" = "messenger") => JSON.stringify(fake.webhookBody({ channel, messages }));
const eventsFor = (mid: string) => h.db.select().from(webhookEvents).where(and(eq(webhookEvents.provider, "meta"), eq(webhookEvents.externalEventId, mid)));

describe("Meta messaging client", () => {
  it("verifies X-Hub-Signature-256 in constant time and rejects anything else", () => {
    const raw = '{"object":"page","entry":[]}';
    expect(verifyMetaSignature(raw, signMetaBody(raw, "secret"), "secret")).toBe(true);
    expect(verifyMetaSignature(raw, signMetaBody(raw, "other"), "secret")).toBe(false);
    expect(verifyMetaSignature(`${raw} `, signMetaBody(raw, "secret"), "secret")).toBe(false);
    expect(verifyMetaSignature(raw, null, "secret")).toBe(false);
    expect(verifyMetaSignature(raw, signMetaBody(raw, ""), "")).toBe(false);
    const client = createMetaMessagingClient({ appSecret: "secret", pageAccessToken: "token" });
    expect(client.verifySignature(raw, signMetaBody(raw, "secret"))).toBe(true);
  });

  it("parses inbound messages and skips echoes and non-message items", () => {
    const body = {
      object: "instagram",
      entry: [
        {
          time: 1_700_000_000_000,
          messaging: [
            { sender: { id: "u1" }, recipient: { id: "p" }, timestamp: 1_700_000_000_000, message: { mid: "m1", text: "Hi", attachments: [{}, {}] } },
            { sender: { id: "p" }, recipient: { id: "u1" }, message: { mid: "m2", text: "echo", is_echo: true } },
            { sender: { id: "u1" }, recipient: { id: "p" }, read: { watermark: 1 } },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(body)).toEqual([{ channel: "instagram", mid: "m1", senderId: "u1", recipientId: "p", text: "Hi", attachmentCount: 2, sentAt: new Date(1_700_000_000_000) }]);
    expect(parseMetaWebhook({ object: "whatsapp_business_account", entry: [] })).toEqual([]);
    expect(parseMetaWebhook("nonsense")).toEqual([]);
  });

  it("maps a closed window to a permanent error and a 5xx to a retryable one", async () => {
    const calls: string[] = [];
    const client = createMetaMessagingClient({
      appSecret: "s",
      pageAccessToken: "secret-token",
      fetch: (input) => {
        calls.push(String(input));
        return Promise.resolve(
          calls.length === 1
            ? new Response(JSON.stringify({ error: { message: "outside of allowed window", code: 10, error_subcode: 2018278 } }), { status: 400 })
            : new Response("busy", { status: 503 }),
        );
      },
    });
    await expect(client.sendMessage({ recipientPsid: "u1", text: "Hello" })).rejects.toMatchObject({ retryable: false, code: "window_closed", statusCode: 400 });
    await expect(client.sendMessage({ recipientPsid: "u1", text: "Hello" })).rejects.toMatchObject({ retryable: true, statusCode: 503 });
  });
});

describe("POST /api/webhooks/meta", () => {
  it("stores one event per mid for a valid signature and enqueues nothing twice (edge case 28)", async () => {
    const mid = `m_${randomUUID()}`;
    const raw = delivery([{ mid, senderId: `psid-${randomUUID()}`, text: "Hello BEAM" }]);
    expect((await post(raw, fake.sign(raw))).status).toBe(200);
    expect((await post(raw, fake.sign(raw))).status).toBe(200);
    expect(await eventsFor(mid)).toHaveLength(1);
  });

  it("answers 401 for a bad or missing signature and stores nothing", async () => {
    const mid = `m_${randomUUID()}`;
    const raw = delivery([{ mid, senderId: "psid-x" }]);
    expect((await post(raw, signMetaBody(raw, "wrong-secret"))).status).toBe(401);
    expect((await post(raw, null)).status).toBe(401);
    expect(await eventsFor(mid)).toHaveLength(0);
  });
});

describe("GET /api/webhooks/meta (subscription challenge)", () => {
  it("answers hub.challenge for the right verify token and 403 otherwise", async () => {
    process.env.META_VERIFY_TOKEN = "verify-me";
    const url = (token: string) => `https://beam.example.com/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`;
    const ok = GET(new Request(url("verify-me")));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    expect(GET(new Request(url("wrong"))).status).toBe(403);
    delete process.env.META_VERIFY_TOKEN;
    expect(GET(new Request(url("verify-me"))).status).toBe(403);
  });
});

describe("the meta webhook handler and crm.send_meta_reply", () => {
  it("ingests each message once, threads by sender and links by external_ids.meta_psid", async () => {
    const psid = `psid-${randomUUID()}`;
    const p = await makePerson(h.db, { externalIds: { meta_psid: psid } });
    const body = fake.webhookBody({ channel: "instagram", messages: [{ mid: `m_${randomUUID()}`, senderId: psid, text: "Is the sauna open on Monday?", attachments: 1 }] });
    const ctx = makeJobCtx(h.db, "webhook.process");
    expect(await handleMetaWebhook(ctx, { id: "1", payload: body })).toEqual({ ingested: 1 });
    expect(await handleMetaWebhook(ctx, { id: "1", payload: body })).toEqual({ ingested: 0 });
    const [t] = await h.db.select().from(inboxThreads).where(and(eq(inboxThreads.channel, "instagram"), eq(inboxThreads.externalThreadId, psid)));
    expect(t).toMatchObject({ personId: p.id, status: "open", fromAddress: psid });
    const msgs = await h.db.select().from(inboxMessages).where(eq(inboxMessages.threadId, t!.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: "in", attachmentCount: 1, body: "Is the sauna open on Monday?" });
  });

  it("an unknown Meta sender stays unlinked; staff linking stores the sender id on the person", async () => {
    const psid = `psid-${randomUUID()}`;
    const now = new Date();
    const { threadId } = await api.ingestMetaMessage(h.db as never, makeCtx(h.db, { now }), { channel: "messenger", mid: `m_${randomUUID()}`, senderId: psid, recipientId: "p", text: "Hi", attachmentCount: 0, sentAt: now });
    expect((await h.db.select().from(inboxThreads).where(eq(inboxThreads.id, threadId)))[0]!.personId).toBeNull();
    const p = await makePerson(h.db);
    await api.linkStaffThreadPerson(makeCtx(h.db, { now }), { threadId, personId: p.id });
    const [row] = await h.db.select({ externalIds: persons.externalIds }).from(persons).where(eq(persons.id, p.id));
    expect(row!.externalIds).toMatchObject({ meta_psid: psid });
  });

  async function metaReply(psid: string): Promise<string> {
    const now = new Date();
    const { threadId } = await api.ingestMetaMessage(h.db as never, makeCtx(h.db, { now }), { channel: "messenger", mid: `m_${randomUUID()}`, senderId: psid, recipientId: "p", text: "Hello", attachmentCount: 0, sentAt: now });
    const [m] = await h.db.insert(inboxMessages).values({ threadId, direction: "out", body: "Thanks for your message!", occurredAt: now }).returning();
    return m!.id;
  }

  it("sends a reply through the Send API once and stores the Meta message id", async () => {
    const psid = `psid-${randomUUID()}`;
    const messageId = await metaReply(psid);
    const first = await runSendMetaReply(makeJobCtx(h.db, "crm.send_meta_reply" as never), { messageId });
    const second = await runSendMetaReply(makeJobCtx(h.db, "crm.send_meta_reply" as never), { messageId });
    expect(first).toMatchObject({ status: "sent" });
    expect(second).toMatchObject({ status: "already_sent" });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ recipientPsid: psid, text: "Thanks for your message!" });
    const [m] = await h.db.select().from(inboxMessages).where(eq(inboxMessages.id, messageId));
    expect(m).toMatchObject({ externalMessageId: fake.sent[0]!.messageId, deliveryError: null });
  });

  it("a closed 24-hour window is a permanent error and the message shows why it was not delivered", async () => {
    const psid = `psid-${randomUUID()}`;
    const messageId = await metaReply(psid);
    fake.closeWindow(psid);
    await expect(runSendMetaReply(makeJobCtx(h.db, "crm.send_meta_reply" as never), { messageId })).rejects.toBeInstanceOf(PermanentError);
    const [m] = await h.db.select().from(inboxMessages).where(eq(inboxMessages.id, messageId));
    expect(m).toMatchObject({ externalMessageId: null, deliveryError: "window_closed" });
    expect(fake.sent).toHaveLength(0);
  });

  it("a 5xx from Meta is retried (not permanent) and stores no reason", async () => {
    const messageId = await metaReply(`psid-${randomUUID()}`);
    fake.failNext(503);
    const error = await runSendMetaReply(makeJobCtx(h.db, "crm.send_meta_reply" as never), { messageId }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(PermanentError);
    expect(error).toMatchObject({ retryable: true });
    const [m] = await h.db.select().from(inboxMessages).where(eq(inboxMessages.id, messageId));
    expect(m!.deliveryError).toBeNull();
  });
});
