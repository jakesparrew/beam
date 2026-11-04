/**
 * email-P3: Resend events (email spec rules 46 to 49; edge cases 1 to 3), through crm's real
 * `addSuppression` (automation's `requestSuppressionExit` is a stub until automation lands, so it
 * is mocked and asserted). Acceptance: "hard bounces are suppressed".
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailMessages, suppressions, webhookEvents } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";
import { eq } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, type FakeIntegrations } from "@/lib/testing";
import { requestSuppressionExit } from "@/modules/automation/api";
import { getCurrentConsents } from "@/modules/crm/api";
import { queueMarketingEmail, sendTransactional } from "../api";
import { sendEmailMessage } from "../jobs";
import { blockTemplate, completeCompany, consent, eventsOf, jobsOf, messageOf, personWith, resetEmailTables, timeline } from "../email-p3.fixtures";
import { processResendEvent, retrySoftBounce } from "./process-event";

vi.mock("@/modules/automation/api", async (orig) => ({
  ...(await orig<typeof import("@/modules/automation/api")>()),
  requestSuppressionExit: vi.fn(() => Promise.resolve({ jobId: null })),
}));

let h: DbHandle;
let fakes: FakeIntegrations;
beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
  await blockTemplate(h.db, { slug: "p3e-news", kind: "marketing", purpose: "newsletter" });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await resetEmailTables(h.db);
  fakes = createFakeIntegrations();
  vi.mocked(requestSuppressionExit).mockClear();
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("INTEGRATIONS", "fake");
  vi.stubEnv("APP_URL", "https://beam.be");
});
afterEach(() => vi.unstubAllEnvs());

const magic = { url: "https://example.com/nl/account/login/verify?token=abc", expiresMinutes: 15 };

async function sentTransactional(key: string, email?: string) {
  const p = await personWith(h.db, email ? { email } : {});
  const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "nl-BE", data: magic, key });
  await sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId, template: "platform.magic_link" });
  const m = await messageOf(h.db, emailMessageId);
  return { person: p, message: m };
}

/** One signed delivery, stored like `handleWebhook` stores it, then processed like `webhook.process`. */
async function deliver(type: string, resendId: string, extra: Record<string, unknown> = {}, at?: Date) {
  const emitted = fakes.resend.emitWebhook(type, resendId, at ? { created_at: at.toISOString(), ...extra } : extra);
  const [row] = await h.db
    .insert(webhookEvents)
    .values({ provider: "resend", externalEventId: `${emitted.id}:${crypto.randomUUID()}`, payload: emitted.payload as Record<string, unknown>, jobId: crypto.randomUUID() })
    .returning({ id: webhookEvents.id });
  return processResendEvent(makeJobCtx(h.db, "webhook.process"), { id: row!.id, payload: emitted.payload });
}

const suppressionsOf = (email: string) => h.db.select().from(suppressions).where(eq(suppressions.emailHash, emailHash(email)));

describe("processResendEvent", () => {
  it("a hard bounce suppresses the address for everything through crm, which asks automation to exit (hard bounces are suppressed)", async () => {
    const { person, message } = await sentTransactional("p3e:hard");
    expect(await deliver("email.bounced", message.resendId!, { bounce: { type: "Permanent", subType: "General", message: "550 no such user" } })).toMatchObject({ outcome: "processed" });
    expect(await messageOf(h.db, message.id)).toMatchObject({ status: "bounced", bounceType: "hard" });
    const [s] = await suppressionsOf(person.email!);
    expect(s).toMatchObject({ scope: "all", reason: "hard_bounce", source: `resend:${message.resendId}` });
    expect(requestSuppressionExit).toHaveBeenCalledWith(expect.anything(), { suppressionId: s!.id });
    expect(await timeline(h.db, person.id, "email.bounced")).toHaveLength(1);
    const [event] = await eventsOf(h.db, message.id);
    expect(event!.payload).toEqual({ bounce: { type: "Permanent", subType: "General", message: "550 no such user" } });
  });

  it("a complaint suppresses with reason complaint and crm withdraws the marketing consents", async () => {
    const p = await personWith(h.db);
    await consent(h.db, p.id, "newsletter", "granted");
    const r = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "p3e-news", personId: p.id, enrolmentId: crypto.randomUUID(), idempotencyKey: "p3e:complaint", context: {} });
    await sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId: r.messageId, template: "p3e-news" });
    const m = await messageOf(h.db, r.messageId);
    await deliver("email.complained", m.resendId!);
    expect((await messageOf(h.db, m.id)).status).toBe("complained");
    expect((await suppressionsOf(p.email!))[0]).toMatchObject({ scope: "all", reason: "complaint" });
    expect((await getCurrentConsents(h.db, p.id)).newsletter?.status).toBe("withdrawn");
    expect(requestSuppressionExit).toHaveBeenCalledTimes(1);
  });

  it("a soft bounce of a transactional message is retried once, one hour later", async () => {
    const { message } = await sentTransactional("p3e:soft");
    const at = new Date();
    await deliver("email.bounced", message.resendId!, { bounce: { type: "Transient", subType: "MailboxFull" } }, at);
    expect(await messageOf(h.db, message.id)).toMatchObject({ status: "bounced", bounceType: "soft" });
    const [retryJob] = await jobsOf(h.db, "email.retry_soft_bounce");
    expect(retryJob).toMatchObject({ idempotencyKey: `email:${message.id}:retry` });
    expect(retryJob!.runAt.getTime()).toBe(at.getTime() + 3_600_000);

    const ctx = makeJobCtx(h.db, "email.retry_soft_bounce", { integrations: fakes });
    const first = await retrySoftBounce(ctx, { emailMessageId: message.id });
    const second = await retrySoftBounce(ctx, { emailMessageId: message.id });
    expect(second).toEqual(first);
    const retry = await messageOf(h.db, first.retryMessageId!);
    expect(retry).toMatchObject({ attempt: 2, retryOfMessageId: message.id, idempotencyKey: "p3e:soft:retry", status: "queued" });
    // The retry itself is never retried again.
    await sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId: retry.id, template: "platform.magic_link" });
    await deliver("email.bounced", (await messageOf(h.db, retry.id)).resendId!, { bounce: { type: "Transient" } });
    expect(await jobsOf(h.db, "email.retry_soft_bounce")).toHaveLength(1);
  });

  it("three soft bounces of one address within 30 days suppress it with source soft_bounce_x3", async () => {
    const email = `soft-${crypto.randomUUID().slice(0, 8)}@example.com`;
    for (let i = 0; i < 3; i++) {
      const p = await personWith(h.db, { email: i === 0 ? email : email.replace("@", `+${i}@`) });
      const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", to: email, personId: p.id, locale: "nl-BE", data: magic, key: `p3e:x3:${i}` });
      await sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId, template: "platform.magic_link" });
      await deliver("email.bounced", (await messageOf(h.db, emailMessageId)).resendId!, { bounce: { type: "Transient" } });
      expect((await suppressionsOf(email)).length).toBe(i === 2 ? 1 : 0);
    }
    expect((await suppressionsOf(email))[0]).toMatchObject({ scope: "all", reason: "hard_bounce", source: "soft_bounce_x3" });
  });

  it("a soft bounce of a marketing message is not retried", async () => {
    const p = await personWith(h.db);
    await consent(h.db, p.id, "newsletter", "granted");
    const r = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "p3e-news", personId: p.id, enrolmentId: crypto.randomUUID(), idempotencyKey: "p3e:mkt-soft", context: {} });
    await sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId: r.messageId, template: "p3e-news" });
    await deliver("email.bounced", (await messageOf(h.db, r.messageId)).resendId!, { bounce: { type: "Transient" } });
    expect(await jobsOf(h.db, "email.retry_soft_bounce")).toHaveLength(0);
  });

  it("out-of-order events move the status forward only and still fill sent_at", async () => {
    const { message } = await sentTransactional("p3e:order");
    await h.db.update(emailMessages).set({ sentAt: null }).where(eq(emailMessages.id, message.id));
    const t1 = new Date("2026-11-01T10:00:05Z");
    const t0 = new Date("2026-11-01T10:00:00Z");
    await deliver("email.delivered", message.resendId!, {}, t1);
    await deliver("email.sent", message.resendId!, {}, t0);
    const m = await messageOf(h.db, message.id);
    expect(m.status).toBe("delivered");
    expect(m.deliveredAt?.toISOString()).toBe(t1.toISOString());
    expect(m.sentAt?.toISOString()).toBe(t0.toISOString());
    expect(m.lastEventAt?.toISOString()).toBe(t1.toISOString());
  });

  it("an unknown resend id and an unknown type change nothing", async () => {
    expect(await deliver("email.delivered", "re_unknown_1")).toEqual({ outcome: "ignored", reason: "unknown_message" });
    const { message } = await sentTransactional("p3e:unknown-type");
    expect(await deliver("email.something_new", message.resendId!)).toEqual({ outcome: "ignored", reason: "unknown_type" });
    expect(await eventsOf(h.db, message.id)).toHaveLength(0);
  });

  it("the same delivery processed twice is stored once", async () => {
    const { message } = await sentTransactional("p3e:dupe");
    const emitted = fakes.resend.emitWebhook("email.delivered", message.resendId!);
    const [row] = await h.db
      .insert(webhookEvents)
      .values({ provider: "resend", externalEventId: `${emitted.id}:${crypto.randomUUID()}`, payload: emitted.payload as Record<string, unknown>, jobId: crypto.randomUUID() })
      .returning();
    const ctx = makeJobCtx(h.db, "webhook.process");
    expect(await processResendEvent(ctx, { id: row!.id, payload: emitted.payload })).toMatchObject({ outcome: "processed" });
    expect(await processResendEvent(ctx, { id: row!.id, payload: emitted.payload })).toEqual({ outcome: "ignored", reason: "duplicate" });
    expect(await eventsOf(h.db, message.id)).toHaveLength(1);
  });
});
