/**
 * email-P3: the Resend webhook route (email spec rule 45, edge case 1): a bad signature answers
 * 401 and stores nothing; the same `svix-id` delivered twice is stored and enqueued once; the
 * enqueued `webhook.process` reaches `processResendEvent` through the generated handler registry.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailEvents, jobs, webhookEvents } from "@beam/db/schema";
import { eq, setAppDb, sql } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, runJobTwice, type FakeIntegrations } from "@/lib/testing";
import { POST } from "@/app/api/webhooks/resend/route";
import { WEBHOOK_HANDLERS } from "@/registry/webhooks.generated";
import { sendTransactional } from "./api";
import { sendEmailMessage } from "./jobs";
import { completeCompany, messageOf, resetEmailTables } from "./email-p3.fixtures";

let h: DbHandle;
let fakes: FakeIntegrations;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await completeCompany(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await resetEmailTables(h.db);
  await h.db.execute(sql`delete from webhook_events`);
  fakes = createFakeIntegrations();
  vi.stubEnv("RESEND_WEBHOOK_SECRET", fakes.resend.webhookSecret);
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("INTEGRATIONS", "fake");
});
afterEach(() => vi.unstubAllEnvs());

const post = (body: string, headers: Record<string, string>) =>
  POST(new Request("https://beam.be/api/webhooks/resend", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));

async function sentMessage(key: string) {
  const { emailMessageId } = await sendTransactional(makeCtx(h.db), {
    template: "platform.magic_link",
    to: "lotte@example.com",
    locale: "nl-BE",
    data: { url: "https://example.com/nl/login?token=x", expiresMinutes: 15 },
    key,
  });
  await sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId, template: "platform.magic_link" });
  return messageOf(h.db, emailMessageId);
}

describe("POST /api/webhooks/resend", () => {
  it("a bad signature answers 401 and stores nothing", async () => {
    const m = await sentMessage("p3w:bad");
    const emitted = fakes.resend.emitWebhook("email.delivered", m.resendId!);
    const res = await post(emitted.body, { ...emitted.headers, "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    expect(res.status).toBe(401);
    const tampered = await post(emitted.body.replace("email.delivered", "email.bounced"), emitted.headers);
    expect(tampered.status).toBe(401);
    expect(await h.db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("a duplicate svix-id is stored and enqueued once; webhook.process applies it", async () => {
    const m = await sentMessage("p3w:dupe");
    const emitted = fakes.resend.emitWebhook("email.delivered", m.resendId!);
    expect((await post(emitted.body, emitted.headers)).status).toBe(200);
    expect((await post(emitted.body, emitted.headers)).status).toBe(200);
    const stored = await h.db.select().from(webhookEvents).where(eq(webhookEvents.externalEventId, emitted.id));
    expect(stored).toHaveLength(1);
    const queued = await h.db.select().from(jobs).where(eq(jobs.kind, "webhook.process"));
    expect(queued).toHaveLength(1);

    expect(WEBHOOK_HANDLERS).toHaveProperty("resend");
    await runJobTwice(h.db, "webhook.process", queued[0]!.payload, { integrations: fakes });
    expect((await messageOf(h.db, m.id)).status).toBe("delivered");
    const events = await h.db.select().from(emailEvents).where(eq(emailEvents.emailMessageId, m.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "delivered", source: "resend", resendEventId: emitted.id });
  });
});
