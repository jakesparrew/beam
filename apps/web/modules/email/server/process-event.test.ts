/**
 * email-P3: Resend events (email spec rules 46 to 49; edge cases 1 to 3), through crm's real
 * `addSuppression`, which calls automation's real `requestSuppressionExit`; the exit is asserted as
 * the queued `automation.exit_for_suppression` job (key `supp:<suppressionId>`). Acceptance:
 * "hard bounces are suppressed".
 *
 * email-P9: `email.received` is mapped to crm's `ingestInboundEmail(tx, ctx, { messageId,
 * inReplyTo?, from, fromName?, subject, text, attachmentCount, receivedAt })` (the real crm
 * function, wrapped in a spy) once per svix id, never with the raw payload, and writes no
 * `email_events` row; a hard bounce of a campaign message re-evaluates the bounce-rate pause.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailEvents, emailMessages, inboxMessages, inboxThreads, jobs, suppressions, webhookEvents } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";
import { eq, setAppDb } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, type FakeIntegrations } from "@/lib/testing";
import { getCurrentConsents, ingestInboundEmail } from "@/modules/crm/api";
import { POST } from "@/app/api/webhooks/resend/route";
import { queueMarketingEmail, sendTransactional } from "../api";
import { sendEmailMessage } from "../jobs";
import { blockTemplate, completeCompany, consent, eventsOf, jobsOf, messageOf, personWith, resetEmailTables, timeline } from "../email-p3.fixtures";
import { campaignOf, campaignRow, staff } from "../email-p6.fixtures";
import { templateVersion } from "../email-p7.fixtures";
import { htmlToPlainText, parseAddress, processResendEvent, retrySoftBounce } from "./process-event";

vi.mock("@/modules/crm/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/crm/api")>();
  return { ...actual, ingestInboundEmail: vi.fn(actual.ingestInboundEmail) };
});
const ingest = vi.mocked(ingestInboundEmail);

let h: DbHandle;
let fakes: FakeIntegrations;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
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
    .values({ provider: "resend", externalEventId: `${emitted.id}:${crypto.randomUUID()}`, payload: emitted.payload, jobId: crypto.randomUUID() })
    .returning({ id: webhookEvents.id });
  return processResendEvent(makeJobCtx(h.db, "webhook.process"), { id: row!.id, payload: emitted.payload });
}

/** The exit jobs crm.addSuppression queued through automation.requestSuppressionExit. */
const exitJobsOf = async () =>
  (await jobsOf(h.db, "automation.exit_for_suppression")).map((j) => ({ idempotencyKey: j.idempotencyKey, payload: j.payload }));

const suppressionsOf = (email: string) => h.db.select().from(suppressions).where(eq(suppressions.emailHash, emailHash(email)));

describe("processResendEvent", () => {
  it("a hard bounce suppresses the address for everything through crm, which asks automation to exit (hard bounces are suppressed)", async () => {
    const { person, message } = await sentTransactional("p3e:hard");
    expect(await deliver("email.bounced", message.resendId!, { bounce: { type: "Permanent", subType: "General", message: "550 no such user" } })).toMatchObject({ outcome: "processed" });
    expect(await messageOf(h.db, message.id)).toMatchObject({ status: "bounced", bounceType: "hard" });
    const [s] = await suppressionsOf(person.email!);
    expect(s).toMatchObject({ scope: "all", reason: "hard_bounce", source: `resend:${message.resendId}` });
    expect(await exitJobsOf()).toEqual([{ idempotencyKey: `supp:${s!.id}`, payload: { suppressionId: s!.id } }]);
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
    const [s] = await suppressionsOf(p.email!);
    expect(s).toMatchObject({ scope: "all", reason: "complaint" });
    expect((await getCurrentConsents(h.db, p.id)).newsletter?.status).toBe("withdrawn");
    expect(await exitJobsOf()).toEqual([{ idempotencyKey: `supp:${s!.id}`, payload: { suppressionId: s!.id } }]);
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
      .values({ provider: "resend", externalEventId: `${emitted.id}:${crypto.randomUUID()}`, payload: emitted.payload, jobId: crypto.randomUUID() })
      .returning();
    const ctx = makeJobCtx(h.db, "webhook.process");
    expect(await processResendEvent(ctx, { id: row!.id, payload: emitted.payload })).toMatchObject({ outcome: "processed" });
    expect(await processResendEvent(ctx, { id: row!.id, payload: emitted.payload })).toEqual({ outcome: "ignored", reason: "duplicate" });
    expect(await eventsOf(h.db, message.id)).toHaveLength(1);
  });
});

/** A Resend Inbound `email.received` payload (the fake signs it like any other event). */
function inbound(data: Record<string, unknown>) {
  return fakes.resend.emitWebhook("email.received", `re_in_${crypto.randomUUID().slice(0, 8)}`, data);
}

async function store(emitted: { id: string; payload: unknown }) {
  const [row] = await h.db
    .insert(webhookEvents)
    .values({ provider: "resend", externalEventId: `${emitted.id}:${crypto.randomUUID()}`, payload: emitted.payload, jobId: crypto.randomUUID() })
    .returning({ id: webhookEvents.id });
  return row!.id;
}

describe("processResendEvent: email.received (R3 inbound, rule 46)", () => {
  beforeEach(() => {
    ingest.mockClear();
  });

  it("maps the payload to crm.ingestInboundEmail with the Message-ID header, never the raw payload, and stores no email event", async () => {
    const emitted = inbound({
      from: "Lotte Peeters <Lotte.Peeters@Example.com>",
      to: ["inbox@in.beam.be"],
      subject: "  Vraag over mijn abonnement ",
      text: "Hallo, kan ik mijn abonnement pauzeren?",
      message_id: "<data-field@mail.example.com>",
      headers: { "Message-ID": "<CAB123@mail.example.com>", "In-Reply-To": "<out-1@mail.beam.be>" },
      attachments: [{ id: "att_1", filename: "foto.jpg" }, { id: "att_2", filename: "scan.pdf" }],
      created_at: "2026-11-02T09:15:00.000Z",
    });
    const id = await store(emitted);
    const ctx = makeJobCtx(h.db, "webhook.process");
    const out = await processResendEvent(ctx, { id, payload: emitted.payload });

    expect(ingest).toHaveBeenCalledTimes(1);
    const [tx, passedCtx, input] = ingest.mock.calls[0]!;
    expect(tx).toBe(ctx.tx);
    expect(passedCtx).toBe(ctx);
    expect(input).toEqual({
      messageId: "<CAB123@mail.example.com>",
      inReplyTo: "<out-1@mail.beam.be>",
      from: "lotte.peeters@example.com",
      fromName: "Lotte Peeters",
      subject: "Vraag over mijn abonnement",
      text: "Hallo, kan ik mijn abonnement pauzeren?",
      attachmentCount: 2,
      receivedAt: new Date("2026-11-02T09:15:00.000Z"),
    });
    expect(input).not.toHaveProperty("payload");

    expect(out).toMatchObject({ outcome: "inbound" });
    const threadId = (out as { threadId: string }).threadId;
    const [thread] = await h.db.select().from(inboxThreads).where(eq(inboxThreads.id, threadId));
    expect(thread).toMatchObject({ channel: "email", fromAddress: "lotte.peeters@example.com" });
    const [msg] = await h.db.select().from(inboxMessages).where(eq(inboxMessages.externalMessageId, "<CAB123@mail.example.com>"));
    expect(msg).toMatchObject({ threadId, attachmentCount: 2 });
    expect(await h.db.select().from(emailEvents)).toHaveLength(0);
  });

  it("reads headers given as a list, falls back to the HTML part and to message_id, and leaves out absent optional fields", async () => {
    const emitted = inbound({
      from: "info@example.com",
      subject: "Factuur",
      html: "<html><head><style>p{}</style></head><body><p>Goedendag &amp; dank</p><p>Tot&nbsp;snel<br>Jan</p></body></html>",
      headers: [{ name: "x-mailer", value: "x" }, { name: "message-id", value: "<list-form@example.com>" }],
    });
    await processResendEvent(makeJobCtx(h.db, "webhook.process"), { id: await store(emitted), payload: emitted.payload });
    expect(ingest.mock.calls[0]![2]).toEqual({
      messageId: "<list-form@example.com>",
      from: "info@example.com",
      subject: "Factuur",
      text: "Goedendag & dank\nTot snel\nJan",
      attachmentCount: 0,
      receivedAt: expect.any(Date) as Date,
    });

    ingest.mockClear();
    const plain = inbound({ from: "a@example.com", subject: "Hi", text: "Body", message_id: "<only-field@example.com>" });
    await processResendEvent(makeJobCtx(h.db, "webhook.process"), { id: await store(plain), payload: plain.payload });
    expect(ingest.mock.calls[0]![2]).toMatchObject({ messageId: "<only-field@example.com>" });
  });

  it("without a Message-ID the delivery is ignored and crm is not called", async () => {
    const emitted = inbound({ from: "a@example.com", subject: "No id", text: "x" });
    expect(await processResendEvent(makeJobCtx(h.db, "webhook.process"), { id: await store(emitted), payload: emitted.payload })).toEqual({
      outcome: "ignored",
      reason: "no_message_id",
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("calls crm once per svix id: a duplicate delivery is stored once, and processing it again keeps one inbox message", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", fakes.resend.webhookSecret);
    const emitted = inbound({ from: "b@example.com", subject: "Twice", text: "x", headers: { "message-id": "<twice@example.com>" } });
    const post = () =>
      POST(new Request("https://beam.be/api/webhooks/resend", { method: "POST", body: emitted.body, headers: { "content-type": "application/json", ...emitted.headers } }));
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const stored = await h.db.select().from(webhookEvents).where(eq(webhookEvents.externalEventId, emitted.id));
    expect(stored).toHaveLength(1);
    const queued = await h.db.select().from(jobs).where(eq(jobs.kind, "webhook.process"));
    expect(queued).toHaveLength(1);

    const ctx = makeJobCtx(h.db, "webhook.process");
    const first = await processResendEvent(ctx, { id: stored[0]!.id, payload: stored[0]!.payload });
    expect(ingest).toHaveBeenCalledTimes(1);
    // A retried job (at-least-once) lands on crm's Message-ID idempotency: same thread, one message.
    const again = await processResendEvent(ctx, { id: stored[0]!.id, payload: stored[0]!.payload });
    expect(again).toEqual(first);
    expect(await h.db.select().from(inboxMessages).where(eq(inboxMessages.externalMessageId, "<twice@example.com>"))).toHaveLength(1);
    expect(await h.db.select().from(emailEvents)).toHaveLength(0);
  });
});

describe("inbound helpers", () => {
  it("parseAddress splits a display name and lower-cases the address", () => {
    expect(parseAddress('"De Smet, An" <AN@example.com>')).toEqual({ address: "an@example.com", name: "De Smet, An" });
    expect(parseAddress("<x@example.com>")).toEqual({ address: "x@example.com", name: null });
    expect(parseAddress("y@example.com")).toEqual({ address: "y@example.com", name: null });
    expect(parseAddress(null)).toEqual({ address: "", name: null });
  });

  it("htmlToPlainText drops scripts and tags and decodes entities", () => {
    expect(htmlToPlainText("<script>alert(1)</script><div>&lt;b&gt; &#233;t&#xE9;</div><p></p><p>x</p>")).toBe("<b> été\n\nx");
  });
});

describe("processResendEvent: bounce-rate pause (rule 37)", () => {
  async function sendingCampaign(sent: number, hard: number) {
    const userId = (await staff(h.db)).id;
    const tv = await templateVersion(h.db);
    const c = await campaignRow(h.db, { templateId: tv.templateId, templateVersionId: tv.versionId, createdByUserId: userId, status: "sending", startedAt: new Date() });
    const at = new Date();
    const rows = await h.db
      .insert(emailMessages)
      .values(
        Array.from({ length: sent }, (_, i) => ({
          kind: "campaign" as const,
          purpose: "newsletter" as const,
          campaignId: c.id,
          templateVersionId: tv.versionId,
          locale: "nl-BE",
          fromDomain: "news.beam.be" as const,
          toEmail: `p9-bounce-${i}-${c.id.slice(0, 8)}@example.com`,
          resendId: `re_p9_${c.id.slice(0, 8)}_${i}`,
          idempotencyKey: `p9-bounce:${c.id}:${i}`,
          status: i < hard ? ("bounced" as const) : ("delivered" as const),
          bounceType: i < hard ? ("hard" as const) : null,
          sentAt: at,
          bouncedAt: i < hard ? at : null,
        })),
      )
      .returning({ id: emailMessages.id, resendId: emailMessages.resendId });
    return { campaignId: c.id, messages: rows };
  }

  it("a hard bounce that takes a sending campaign over 2 % pauses it with reason bounce_rate", async () => {
    const { campaignId, messages } = await sendingCampaign(100, 2);
    await deliver("email.bounced", messages[50]!.resendId!, { bounce: { type: "Transient" } });
    expect((await campaignOf(h.db, campaignId)).status).toBe("sending");
    await deliver("email.bounced", messages[60]!.resendId!, { bounce: { type: "Permanent", subType: "General" } });
    expect(await campaignOf(h.db, campaignId)).toMatchObject({ status: "paused", pausedReason: "bounce_rate" });
  });

  it("a hard bounce below the threshold leaves the campaign sending", async () => {
    const { campaignId, messages } = await sendingCampaign(100, 1);
    await deliver("email.bounced", messages[70]!.resendId!, { bounce: { type: "Permanent" } });
    expect((await campaignOf(h.db, campaignId)).status).toBe("sending");
  });
});
