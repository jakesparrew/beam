/**
 * email-P3: `sendTransactional` and `email.send` (email spec rules 39 to 44, 51 to 53, 59).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { files, persons } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { eq, createCtx, type Tx } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, type FakeIntegrations } from "@/lib/testing";
import { addSuppression } from "@/modules/crm/api";
import { cancelScheduledMessage, queueMarketingEmail, sendTransactional } from "./api";
import { sendEmailMessage } from "./jobs";
import { blockTemplate, completeCompany, consent, messageOf, personWith, resetEmailTables, sendJobOf, timeline } from "./email-p3.fixtures";

let h: DbHandle;
let fakes: FakeIntegrations;
beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
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

async function queue(input: Partial<Parameters<typeof sendTransactional>[1]> & { key: string }) {
  return sendTransactional(makeCtx(h.db), { template: "platform.magic_link", to: "lotte@example.com", locale: "nl-BE", data: magic, ...input });
}

const run = (emailMessageId: string, template = "platform.magic_link") =>
  sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId, template });

describe("sendTransactional", () => {
  it("is idempotent: the same key returns the same message and job ids", async () => {
    const a = await queue({ key: "p3:idem" });
    const b = await queue({ key: "p3:idem" });
    expect(b).toEqual(a);
    expect((await sendJobOf(h.db, a.emailMessageId))?.id).toBe(a.jobId);
  });

  it("commits inside the caller's transaction even for an unknown template key; email.send then fails it", async () => {
    let personId = "";
    let messageId = "";
    await h.db.transaction(async (tx) => {
      const ctx = createCtx({ tx: tx, actor: { kind: "system", jobId: "" } });
      const [p] = await tx.insert(persons).values({ email: "booker@example.com", firstName: "Booker", locale: "nl-BE", acquisition: { source: "manual" } }).returning();
      personId = p!.id;
      ({ emailMessageId: messageId } = await sendTransactional(ctx, { template: "booking.does_not_exist", personId, locale: "nl-BE", data: {}, key: "p3:unknown" }));
    });
    expect((await h.db.select().from(persons).where(eq(persons.id, personId))).length).toBe(1);
    await expect(run(messageId, "booking.does_not_exist")).rejects.toBeInstanceOf(PermanentError);
    expect(await messageOf(h.db, messageId)).toMatchObject({ status: "failed", error: "unknown_template" });
  });

  it("data that fails the template schema fails with invalid_template_data", async () => {
    const { emailMessageId } = await queue({ key: "p3:invalid", data: { url: "not a url" } });
    await expect(run(emailMessageId)).rejects.toBeInstanceOf(PermanentError);
    expect(await messageOf(h.db, emailMessageId)).toMatchObject({ status: "failed", error: "invalid_template_data" });
    expect(fakes.resend.sent).toHaveLength(0);
  });

  it("no address at all is written and fails at send with no_recipient", async () => {
    const p = await personWith(h.db, { email: null });
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "nl-BE", data: magic, key: "p3:norecipient" });
    await expect(run(emailMessageId)).rejects.toBeInstanceOf(PermanentError);
    expect(await messageOf(h.db, emailMessageId)).toMatchObject({ status: "failed", error: "no_recipient" });
  });

  it("sendAt in the future sets the job's run_at", async () => {
    const sendAt = new Date(Date.now() + 3 * 86_400_000);
    const { emailMessageId } = await queue({ key: "p3:later", sendAt });
    expect((await sendJobOf(h.db, emailMessageId))!.runAt.getTime()).toBe(sendAt.getTime());
  });
});

describe("email.send final checks (rule 40)", () => {
  it("an erased person is suppressed", async () => {
    const p = await personWith(h.db);
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "nl-BE", data: magic, key: "p3:erased" });
    await h.db.update(persons).set({ erasedAt: new Date() }).where(eq(persons.id, p.id));
    expect(await run(emailMessageId)).toMatchObject({ status: "suppressed" });
    expect((await messageOf(h.db, emailMessageId)).status).toBe("suppressed");
    expect(fakes.resend.sent).toHaveLength(0);
  });

  it("a hard-bounce suppression blocks every template, a magic link included", async () => {
    const p = await personWith(h.db);
    await addSuppression(h.db as unknown as Tx, makeCtx(h.db), { email: p.email!, scope: "all", reason: "hard_bounce", source: "test" });
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "nl-BE", data: magic, key: "p3:hard" });
    expect(await run(emailMessageId)).toMatchObject({ status: "suppressed" });
    expect(await timeline(h.db, p.id, "email.blocked")).toHaveLength(1);
  });

  it("a complaint does not block a magic link but blocks other transactional mail", async () => {
    const p = await personWith(h.db);
    await addSuppression(h.db as unknown as Tx, makeCtx(h.db), { email: p.email!, scope: "all", reason: "complaint", source: "test" });
    const magicMsg = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "nl-BE", data: magic, key: "p3:complaint:magic" });
    expect(await run(magicMsg.emailMessageId)).toMatchObject({ status: "sent" });
    const other = await sendTransactional(makeCtx(h.db), {
      template: "crm.confirm_resubscribe",
      personId: p.id,
      locale: "nl-BE",
      data: { purpose: "newsletter", firstName: "Lotte" },
      key: "p3:complaint:other",
    });
    expect(await run(other.emailMessageId, "crm.confirm_resubscribe")).toMatchObject({ status: "suppressed" });
  });

  it("a scoped unsubscribe does not block crm.confirm_resubscribe", async () => {
    const p = await personWith(h.db);
    await addSuppression(h.db as unknown as Tx, makeCtx(h.db), { email: p.email!, scope: "newsletter", reason: "unsubscribe", source: "test" });
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), {
      template: "crm.confirm_resubscribe",
      personId: p.id,
      locale: "fr-BE",
      data: { purpose: "newsletter", firstName: "Camille" },
      key: "p3:scoped",
    });
    expect(await run(emailMessageId, "crm.confirm_resubscribe")).toMatchObject({ status: "sent" });
  });

  it("a marketing message whose person became unreachable is suppressed", async () => {
    await blockTemplate(h.db, { slug: "p3-news-unreachable", kind: "marketing", purpose: "newsletter" });
    const p = await personWith(h.db);
    await consent(h.db, p.id, "newsletter", "granted");
    const r = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "p3-news-unreachable", personId: p.id, enrolmentId: crypto.randomUUID(), idempotencyKey: "p3:mkt:unreach", context: {} });
    expect(r.status).toBe("queued");
    await consent(h.db, p.id, "newsletter", "withdrawn");
    expect(await run(r.messageId, "p3-news-unreachable")).toMatchObject({ status: "suppressed" });
  });
});

describe("email.send rendering and delivery", () => {
  it("every non-test message gets a link token; transactional ones carry the preferences link but no List-Unsubscribe and no tracking", async () => {
    const p = await personWith(h.db);
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "en", data: magic, key: "p3:token" });
    await run(emailMessageId);
    const m = await messageOf(h.db, emailMessageId);
    expect(m.linkTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.links).toBeNull();
    const sent = fakes.resend.sent[0]!;
    expect(sent.headers["List-Unsubscribe"]).toBeUndefined();
    expect(sent.html).toContain("Manage email preferences");
    expect(sent.html).toContain("/preferences/");
    expect(sent.html).not.toContain("/api/public/track/");
    expect(sent.html).toContain("Vibrant Lifestyle Collective BV");
    expect(await timeline(h.db, p.id, "email.sent")).toHaveLength(1);
  });

  it("a marketing message carries List-Unsubscribe, tracking and the marketing footer", async () => {
    await blockTemplate(h.db, { slug: "p3-news-ok", kind: "marketing", purpose: "newsletter" });
    const p = await personWith(h.db, { firstName: "Femke" });
    await consent(h.db, p.id, "newsletter", "granted");
    const r = await queueMarketingEmail(makeCtx(h.db), { templateSlug: "p3-news-ok", personId: p.id, enrolmentId: crypto.randomUUID(), idempotencyKey: "p3:mkt:ok", context: {} });
    expect(await run(r.messageId, "p3-news-ok")).toMatchObject({ status: "sent" });
    const sent = fakes.resend.sent[0]!;
    expect(sent.headers["List-Unsubscribe"]).toMatch(/^<https?:\/\/.+\/api\/public\/unsubscribe\/.+>$/);
    expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent.html).toContain("/api/public/track/open?t=");
    expect(sent.html).toContain("/api/public/track/click?t=");
    expect(sent.html).toContain("Femke");
    expect(sent.from).toContain("news.beam.be");
    expect((await messageOf(h.db, r.messageId)).links).toContain("https://beam.be/en/events");
  });

  it("a missing locale is blocked_translation with a timeline event and no fallback language", async () => {
    await blockTemplate(h.db, { slug: "automation.p3_only_en", kind: "transactional", locales: ["en"] });
    const p = await personWith(h.db);
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "automation.p3_only_en", personId: p.id, locale: "nl-BE", data: {}, key: "p3:missing-locale" });
    await expect(run(emailMessageId, "automation.p3_only_en")).rejects.toBeInstanceOf(PermanentError);
    expect((await messageOf(h.db, emailMessageId)).status).toBe("blocked_translation");
    expect(await timeline(h.db, p.id, "email.blocked")).toHaveLength(1);
    expect(fakes.resend.sent).toHaveLength(0);
  });

  it("a cancelled scheduled message is not sent", async () => {
    const { emailMessageId } = await queue({ key: "p3:cancel", sendAt: new Date(Date.now() + 86_400_000) });
    expect(await cancelScheduledMessage(makeCtx(h.db), { messageId: emailMessageId })).toEqual({ cancelled: true });
    expect(await cancelScheduledMessage(makeCtx(h.db), { messageId: emailMessageId })).toEqual({ cancelled: false });
    expect(await run(emailMessageId)).toMatchObject({ status: "failed" });
    expect(await messageOf(h.db, emailMessageId)).toMatchObject({ status: "failed", error: "cancelled" });
    expect(fakes.resend.sent).toHaveLength(0);
  });

  it("attachments go through the single send and inline ones are marked for a content id", async () => {
    const bytes = new TextEncoder().encode("PNG demo");
    const { fileId } = await storeFile(makeCtx(h.db), { kind: "invoice_pdf", name: "checkin-qr.png", mime: "image/png", bytes });
    const { emailMessageId } = await queue({ key: "p3:attach", attachments: [{ fileId, filename: "checkin-qr.png", inline: true }] });
    await run(emailMessageId);
    expect(fakes.resend.batches).toHaveLength(0);
    const att = fakes.resend.sent[0]!.attachments!;
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ filename: "checkin-qr.png", inline: true });
  });

  it("outside production the sink rewrites the recipient and the rendered copy is stored", async () => {
    vi.stubEnv("EMAIL_SINK", "sink@example.com");
    vi.stubEnv("APP_ENV", "preview");
    const { emailMessageId } = await queue({ key: "p3:sink" });
    await run(emailMessageId);
    const sent = fakes.resend.sent[0]!;
    expect(sent.to).toBe("sink@example.com");
    expect(sent.subject).toMatch(/^\[preview → lotte@example\.com\] /);
    const m = await messageOf(h.db, emailMessageId);
    expect(m.toEmail).toBe("lotte@example.com");
    const [file] = await h.db.select().from(files).where(eq(files.id, m.renderedFileId!));
    expect(file!.kind).toBe("rendered_email");
  });

  it("a real Resend client outside production without EMAIL_SINK fails with email_sink_missing", async () => {
    vi.stubEnv("APP_ENV", "preview");
    vi.stubEnv("INTEGRATIONS", "");
    vi.stubEnv("RESEND_API_KEY", "re_test_key_for_mode_only");
    const { emailMessageId } = await queue({ key: "p3:nosink" });
    await expect(run(emailMessageId)).rejects.toThrow(/email_sink_missing/);
    expect(fakes.resend.sent).toHaveLength(0);
  });

  it("a Resend 422 fails the message with invalid_recipient", async () => {
    const { emailMessageId } = await queue({ key: "p3:422" });
    fakes.resend.failNext(422);
    await expect(run(emailMessageId)).rejects.toBeInstanceOf(PermanentError);
    expect(await messageOf(h.db, emailMessageId)).toMatchObject({ status: "failed", error: "invalid_recipient" });
  });
});
