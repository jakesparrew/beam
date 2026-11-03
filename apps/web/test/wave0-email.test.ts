/**
 * The Wave 0 `email.sendTransactional` and `email.send` (platform spec 4.9, platform-P7).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailMessages, files, jobs } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { eq, sql } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, runJobTwice } from "@/lib/testing";
import { sendTransactional } from "@/modules/email/api";
import { sendEmailMessage } from "@/modules/email/jobs";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`delete from jobs`);
  await handle.db.execute(sql`delete from email_messages`);
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("APP_ENV", "local");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const magic = { url: "https://example.com/nl/account/login/verify?token=abc", expiresMinutes: 15 };

async function queue(input: Partial<Parameters<typeof sendTransactional>[1]> & { key: string }) {
  const ctx = makeCtx(handle.db);
  return sendTransactional(ctx, { template: "platform.magic_link", to: "lotte@example.com", locale: "nl-BE", data: magic, ...input });
}

async function jobOf(emailMessageId: string) {
  const [job] = await handle.db.select().from(jobs).where(eq(jobs.idempotencyKey, `email:${emailMessageId}`));
  return job!;
}

async function messageOf(id: string) {
  const [m] = await handle.db.select().from(emailMessages).where(eq(emailMessages.id, id));
  return m!;
}

describe("sendTransactional", () => {
  it("the same key twice is one email_messages row and one job", async () => {
    const a = await queue({ key: "test:magic:1" });
    const b = await queue({ key: "test:magic:1" });
    expect(b).toEqual(a);
    const msgs = await handle.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, "test:magic:1"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ status: "queued", kind: "transactional", toEmail: "lotte@example.com", locale: "nl-BE" });
    const queued = await handle.db.select().from(jobs).where(eq(jobs.kind, "email.send"));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id: a.jobId, lane: "fast", priority: 1, idempotencyKey: `email:${a.emailMessageId}` });
  });

  it("sendAt sets the job's run_at", async () => {
    const sendAt = new Date(Date.now() + 3 * 3_600_000);
    const { emailMessageId } = await queue({ key: "test:magic:later", sendAt });
    expect((await jobOf(emailMessageId)).runAt.getTime()).toBe(sendAt.getTime());
  });

  it("uses the person's email when no `to` is given", async () => {
    const person = await makePerson(handle.db, { email: "camille@example.com", locale: "fr-BE" });
    const ctx = makeCtx(handle.db);
    const { emailMessageId } = await sendTransactional(ctx, { template: "platform.magic_link", personId: person.id, locale: "fr-BE", data: magic, key: "test:person" });
    expect(await messageOf(emailMessageId)).toMatchObject({ toEmail: "camille@example.com", personId: person.id });
  });

  it("accepts `context` and sends", async () => {
    const integrations = createFakeIntegrations();
    const { emailMessageId } = await queue({ key: "test:context", context: { bookingId: "b-1" } });
    await sendEmailMessage(makeJobCtx(handle.db, "email.send", { integrations }), { emailMessageId, template: "platform.magic_link" });
    expect(integrations.resend.sent).toHaveLength(1);
    expect((await messageOf(emailMessageId)).context).toEqual({ bookingId: "b-1" });
  });
});

describe("email.send", () => {
  it("sends once through the Resend fake when run twice and marks the message sent", async () => {
    const integrations = createFakeIntegrations();
    const { emailMessageId } = await queue({ key: "test:twice" });
    await runJobTwice(handle.db, "email.send", { emailMessageId, template: "platform.magic_link" }, { integrations });
    expect(integrations.resend.sent).toHaveLength(1);
    const sent = integrations.resend.sent[0]!;
    expect(sent.to).toBe("lotte@example.com");
    expect(sent.html).toContain(magic.url);
    expect(sent.text.length).toBeGreaterThan(0);
    expect(sent.idempotencyKey).toBe(`email:${emailMessageId}`);
    const m = await messageOf(emailMessageId);
    expect(m.status).toBe("sent");
    expect(m.resendId).toBe(sent.id);
    expect(m.sentAt).not.toBeNull();
    expect(m.subject).toBe(sent.subject);
  });

  it("EMAIL_SINK rewrites `to` and the HTML is stored as a rendered_email file", async () => {
    vi.stubEnv("EMAIL_SINK", "sink@example.com");
    const integrations = createFakeIntegrations();
    const { emailMessageId } = await queue({ key: "test:sink" });
    await sendEmailMessage(makeJobCtx(handle.db, "email.send", { integrations }), { emailMessageId, template: "platform.magic_link" });
    expect(integrations.resend.sent[0]!.to).toBe("sink@example.com");
    const m = await messageOf(emailMessageId);
    expect(m.renderedFileId).not.toBeNull();
    const [file] = await handle.db.select().from(files).where(eq(files.id, m.renderedFileId!));
    expect(file!.kind).toBe("rendered_email");
    expect(Buffer.from(file!.bytes).toString("utf8")).toContain(magic.url);
  });

  it("stores no rendered copy in production", async () => {
    vi.stubEnv("APP_ENV", "production");
    const integrations = createFakeIntegrations();
    const { emailMessageId } = await queue({ key: "test:prod" });
    await sendEmailMessage(makeJobCtx(handle.db, "email.send", { integrations }), { emailMessageId, template: "platform.magic_link" });
    expect((await messageOf(emailMessageId)).renderedFileId).toBeNull();
  });

  it("an unknown template key is a PermanentError", async () => {
    const { emailMessageId } = await queue({ key: "test:unknown", template: "booking.does_not_exist" });
    await expect(
      sendEmailMessage(makeJobCtx(handle.db, "email.send"), { emailMessageId, template: "booking.does_not_exist" }),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it("an attachment reaches the fake as bytes with its filename; replyTo and threading headers too", async () => {
    const integrations = createFakeIntegrations();
    const bytes = new TextEncoder().encode("%PDF-1.4 demo");
    const { fileId } = await storeFile(makeCtx(handle.db), { kind: "invoice_pdf", name: "BEAM-2026-000001.pdf", mime: "application/pdf", bytes });
    const { emailMessageId } = await queue({
      key: "test:attach",
      attachments: [{ fileId, filename: "invoice.pdf" }],
      replyTo: "reply@example.com",
      headers: { "In-Reply-To": "<m1@example.com>", References: "<m0@example.com> <m1@example.com>" },
    });
    await sendEmailMessage(makeJobCtx(handle.db, "email.send", { integrations }), { emailMessageId, template: "platform.magic_link" });
    const sent = integrations.resend.sent[0]!;
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments![0]!.filename).toBe("invoice.pdf");
    expect(Buffer.from(sent.attachments![0]!.content).toString("utf8")).toBe("%PDF-1.4 demo");
    expect(sent.replyTo).toBe("reply@example.com");
    expect(sent.headers).toEqual({ "In-Reply-To": "<m1@example.com>", References: "<m0@example.com> <m1@example.com>" });
  });
});
