/**
 * email-P1 regression: `email_messages.rendered_file_id` is `on delete set null`, so deleting the
 * rendered copy (the daily `files.purge_expired`, the `platform.files_rendered_email` sweep, or
 * person erasure) never fails on the foreign key and the message row only loses the link.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailMessages, files } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import { purgeExpiredFiles } from "@/lib/files";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime } from "@/lib/testing";
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
beforeEach(() => {
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("APP_ENV", "local");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const magic = { url: "https://example.com/nl/account/login/verify?token=abc", expiresMinutes: 15 };

async function sendOne(key: string, personId?: string) {
  const ctx = makeCtx(handle.db);
  const { emailMessageId } = await sendTransactional(ctx, {
    template: "platform.magic_link",
    ...(personId ? { personId } : { to: "lotte@example.com" }),
    locale: "nl-BE",
    data: magic,
    key,
  });
  await sendEmailMessage(makeJobCtx(handle.db, "email.send", { integrations: createFakeIntegrations() }), { emailMessageId, template: "platform.magic_link" });
  const [m] = await handle.db.select().from(emailMessages).where(eq(emailMessages.id, emailMessageId));
  expect(m!.renderedFileId).not.toBeNull();
  return m!;
}

async function messageOf(id: string) {
  const [m] = await handle.db.select().from(emailMessages).where(eq(emailMessages.id, id));
  return m!;
}

describe("email_messages.rendered_file_id on delete set null", () => {
  it("purgeExpiredFiles deletes an expired rendered copy and leaves the message with a null link", async () => {
    const message = await sendOne("email-p1:rendered:purge");
    await handle.db.execute(sql`update files set expires_at = now() - interval '1 day' where id = ${message.renderedFileId}`);
    await expect(purgeExpiredFiles(handle.db)).resolves.toBeGreaterThanOrEqual(1);
    expect(await handle.db.select().from(files).where(eq(files.id, message.renderedFileId!))).toHaveLength(0);
    const after = await messageOf(message.id);
    expect(after.renderedFileId).toBeNull();
    expect(after.status).toBe("sent");
  });

  it("deleting a person's rendered_email files (erasure, sweep) does not fail on the foreign key", async () => {
    const person = await makePerson(handle.db, { email: "camille@example.com", locale: "nl-BE" });
    const message = await sendOne("email-p1:rendered:erase", person.id);
    await expect(handle.db.execute(sql`delete from files where kind = 'rendered_email' and person_id = ${person.id}`)).resolves.toBeDefined();
    expect((await messageOf(message.id)).renderedFileId).toBeNull();
  });
});
