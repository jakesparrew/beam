/**
 * email-P5: test sends (email spec rule 60, action `sendTestEmail`). Only `users.email` of
 * active staff are accepted; the campaign's `test_sent_at` is set; a test message carries no
 * link token and writes no timeline event.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, auditLog, campaigns, emailMessages, emailTemplates } from "@beam/db/schema";
import { eq } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, staffActor } from "@/lib/testing";
import { sendEmailMessage } from "./jobs";
import { blockTemplate, completeCompany, messageOf, resetEmailTables } from "./email-p3.fixtures";
import { sendTestEmailRecord } from "./server/templates";

let h: DbHandle;
let staffUser: { id: string; email: string };
let templateId: string;
let slug: string;

beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
  staffUser = await makeUser(h.db, { roleKey: "marketing", email: "marketing.p5@demo.beam.be" });
  templateId = await blockTemplate(h.db, { slug: "p5-test-send", kind: "marketing", purpose: "events" });
  slug = "p5-test-send";
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await resetEmailTables(h.db);
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("APP_URL", "https://beam.be");
});

const ctxWith = (permissions: string[] = ["email.write"]) => makeCtx(h.db, staffActor({ userId: staffUser.id, permissions }));
const base = { templateId: "", use: "current" as const, locales: ["nl-BE" as const], to: [] as string[], as: { sample: "lead" as const } };

describe("sendTestEmail", () => {
  it("accepts only addresses of active staff users", async () => {
    const customer = await makeUser(h.db, { audience: "customer", email: "customer.p5@example.com" });
    const disabled = await makeUser(h.db, { roleKey: "marketing", email: "gone.p5@demo.beam.be", status: "disabled" });
    for (const to of [[customer.email], ["nobody.p5@example.com"], [disabled.email], [staffUser.email, "outsider.p5@example.com"]]) {
      await expect(sendTestEmailRecord(ctxWith(), { ...base, templateId, to })).rejects.toMatchObject({ code: "validation", message: "not_staff_address" });
    }
    expect(await h.db.select().from(emailMessages)).toHaveLength(0);
    const { messageIds } = await sendTestEmailRecord(ctxWith(), { ...base, templateId, to: [staffUser.email.toUpperCase()], locales: ["nl-BE", "en"] });
    expect(messageIds).toHaveLength(2);
    const rows = await h.db.select().from(emailMessages);
    expect(rows.map((r) => [r.kind, r.toEmail, r.personId, r.purpose, r.fromDomain]).sort()).toEqual([
      ["test", staffUser.email, null, "events", "news.beam.be"],
      ["test", staffUser.email, null, "events", "news.beam.be"],
    ]);
    expect(rows.map((r) => r.locale).sort()).toEqual(["en", "nl-BE"]);
  });

  it("sets the campaign's test_sent_at and audits email.test_send on the campaign", async () => {
    const [campaign] = await h.db.insert(campaigns).values({ name: "P5 test send", templateId, purpose: "events", createdByUserId: staffUser.id }).returning();
    expect(campaign!.testSentAt).toBeNull();
    const ctx = ctxWith();
    await sendTestEmailRecord(ctx, { ...base, templateId, to: [staffUser.email], campaignId: campaign!.id });
    const [after] = await h.db.select().from(campaigns).where(eq(campaigns.id, campaign!.id));
    expect(after!.testSentAt?.getTime()).toBe(ctx.now.getTime());
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.entityId, campaign!.id));
    expect(audits.map((a) => [a.action, a.entityType])).toContainEqual(["email.test_send", "campaign"]);
    const [message] = await h.db.select().from(emailMessages);
    expect(message!.campaignId).toBe(campaign!.id);
  });

  it("sends with a [TEST] subject, without link token and without timeline events, also when previewing as a real contact", async () => {
    const person = await makePerson(h.db, { firstName: "Jonas", email: "jonas.p5@example.com" });
    await expect(sendTestEmailRecord(ctxWith(), { ...base, templateId, to: [staffUser.email], as: { personId: person.id } })).rejects.toMatchObject({ name: "ForbiddenError" });
    const { messageIds } = await sendTestEmailRecord(ctxWith(["email.write", "persons.read"]), { ...base, templateId, to: [staffUser.email], as: { personId: person.id } });
    const fakes = createFakeIntegrations();
    const result = await sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: fakes }), { emailMessageId: messageIds[0]!, template: slug });
    expect(result.status).toBe("sent");
    const m = await messageOf(h.db, messageIds[0]!);
    expect(m).toMatchObject({ kind: "test", status: "sent", linkTokenHash: null, personId: null, links: null });
    const sent = fakes.resend.sentTo(staffUser.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject.startsWith("[TEST] ")).toBe(true);
    expect(sent[0]!.html).not.toContain("/api/public/track/");
    expect(await h.db.select().from(activityEvents).where(eq(activityEvents.personId, person.id))).toHaveLength(0);
    const kinds = (await h.db.select({ kind: activityEvents.kind }).from(activityEvents)).map((r) => r.kind);
    expect(kinds.filter((k) => k.startsWith("email."))).toEqual([]);
  });

  it("refuses the draft when none exists and a locale without content", async () => {
    await expect(sendTestEmailRecord(ctxWith(), { ...base, templateId, use: "draft", to: [staffUser.email] })).rejects.toMatchObject({ message: "no_draft" });
    const partial = await blockTemplate(h.db, { slug: "p5-test-send-nl", kind: "marketing", locales: ["nl-BE"] });
    await expect(sendTestEmailRecord(ctxWith(), { ...base, templateId: partial, to: [staffUser.email], locales: ["fr-BE"] })).rejects.toMatchObject({ message: "missing_translation" });
    const [t] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.id, partial));
    expect(t!.slug).toBe("p5-test-send-nl");
  });
});
