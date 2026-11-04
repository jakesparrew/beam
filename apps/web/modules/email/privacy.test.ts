/**
 * email-P3: the GDPR registration (email spec section 9): export, erase, retention sweeps and
 * the agreement between `sweep` keys and the seeded `retention_policies` rows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { campaignRecipients, campaigns, emailAiDrafts, emailEvents, emailMessages, emailTemplates, jobs, retentionPolicies } from "@beam/db/schema";
import { seed as emailDefaults } from "@beam/db/seed/email";
import { eq, sql, type Tx } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";
import { GDPR_REGISTRY } from "@/registry/privacy.generated";
import { getTemplateInfo, sendTransactional } from "./api";
import { blockTemplate, completeCompany, personWith, resetEmailTables } from "./email-p3.fixtures";
import { sendEmailMessage } from "./jobs";
import { emailPrivacy, privacy, retention } from "./privacy";

let h: DbHandle;
let versionId: string;
let userId: string;
beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
  await blockTemplate(h.db, { slug: "p3p-news", kind: "marketing", purpose: "newsletter" });
  versionId = (await getTemplateInfo(h.db, "p3p-news"))!.templateVersionId;
  userId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await resetEmailTables(h.db);
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("APP_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

const magic = { url: "https://example.com/nl/account/login/verify?token=abc", expiresMinutes: 15 };
const inTx = <T>(fn: (tx: Tx) => Promise<T>) => h.db.transaction((tx) => fn(tx as unknown as Tx));

async function campaignWith(personId: string, opts: { finishedAt?: Date; snapshot?: boolean } = {}) {
  const [template] = await h.db.select({ id: emailTemplates.id }).from(emailTemplates).where(eq(emailTemplates.slug, "p3p-news"));
  const [c] = await h.db
    .insert(campaigns)
    .values({
      name: `P3 campaign ${crypto.randomUUID().slice(0, 6)}`,
      templateId: template!.id,
      purpose: "newsletter",
      status: "sent",
      finishedAt: opts.finishedAt ?? new Date(),
      statsSnapshot: opts.snapshot ? { sent: 1 } : null,
      createdByUserId: userId,
    })
    .returning();
  const [m] = await h.db
    .insert(emailMessages)
    .values({
      personId,
      toEmail: "member@example.com",
      kind: "campaign",
      purpose: "newsletter",
      templateVersionId: versionId,
      campaignId: c!.id,
      locale: "nl-BE",
      idempotencyKey: `campaign:${c!.id}:person:${personId}`,
      status: "sent",
      sentAt: new Date(),
      fromDomain: "news.beam.be",
    })
    .returning();
  await h.db.insert(campaignRecipients).values({ campaignId: c!.id, personId, locale: "nl-BE", chunkNo: 0, status: "sent", emailMessageId: m!.id });
  await h.db.insert(emailEvents).values({ emailMessageId: m!.id, type: "delivered", source: "resend", occurredAt: new Date() });
  return { campaignId: c!.id, messageId: m!.id };
}

describe("export", () => {
  it("lists the person's messages with template, status and times, their events and campaigns", async () => {
    const p = await personWith(h.db);
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "nl-BE", data: magic, key: "p3p:export" });
    await sendEmailMessage(makeJobCtx(h.db, "email.send", { integrations: createFakeIntegrations() }), { emailMessageId, template: "platform.magic_link" });
    await campaignWith(p.id);
    const out = (await inTx((tx) => privacy.export(tx, p.id))) as { messages: { id: string; status: string }[]; events: unknown[]; campaignRecipients: { campaign: string }[]; provider: string };
    expect(out.messages.map((m) => m.id)).toContain(emailMessageId);
    expect(out.messages).toHaveLength(2);
    expect(out.events).toHaveLength(1);
    expect(out.campaignRecipients).toHaveLength(1);
    expect(out.provider).toMatch(/Resend/);
    expect(emailPrivacy).toBe(privacy);
    expect(GDPR_REGISTRY).toHaveProperty("email");
  });
});

describe("erase", () => {
  it("leaves no row referencing the person and enqueues no provider job", async () => {
    const p = await personWith(h.db);
    const other = await personWith(h.db);
    const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "nl-BE", data: magic, key: "p3p:erase" });
    const { emailMessageId: keep } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: other.id, locale: "nl-BE", data: magic, key: "p3p:keep" });
    await h.db
      .insert(emailMessages)
      .values({ personId: p.id, toEmail: p.email, kind: "transactional", locale: "nl-BE", idempotencyKey: "p3p:erase:retry", attempt: 2, retryOfMessageId: emailMessageId });
    await campaignWith(p.id);
    const jobsBefore = (await h.db.select().from(jobs)).length;
    const report = await inTx((tx) => privacy.erase(tx, p.id));
    expect(report.find((r) => r.table === "email_messages")!.rows).toBe(3);
    const left = rowsOf<{ n: number }>(
      await h.db.execute(sql`
        select (select count(*) from email_messages where person_id = ${p.id}::uuid)
             + (select count(*) from campaign_recipients where person_id = ${p.id}::uuid)
             + (select count(*) from email_events e join email_messages m on m.id = e.email_message_id where m.person_id = ${p.id}::uuid) as n`),
    );
    expect(Number(left[0]!.n)).toBe(0);
    expect((await h.db.select().from(jobs)).length).toBe(jobsBefore);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.id, keep))).toHaveLength(1);
  });
});

describe("sweep", () => {
  it("the sweep keys equal the seeded retention_policies keys", async () => {
    await emailDefaults.run(h.db, {});
    const seeded = (await h.db.select().from(retentionPolicies)).filter((r) => r.key.startsWith("email.")).map((r) => r.key).sort();
    const keys = ["email.campaign_recipients", "email.email_ai_drafts", "email.email_events", "email.email_messages"];
    expect(seeded).toEqual(keys);
    expect(Object.keys(privacy.sweep!).sort()).toEqual(keys);
    expect(retention.map((r) => r.key).sort()).toEqual(keys);
  });

  it("each handler deletes only rows past the cutoff", async () => {
    const old = new Date(Date.now() - 800 * 86_400_000);
    const cutoff = new Date(Date.now() - 730 * 86_400_000);
    const p = await personWith(h.db);

    // email.email_events
    const recent = await campaignWith(p.id);
    const oldEvent = await h.db.insert(emailEvents).values({ emailMessageId: recent.messageId, type: "opened", source: "tracking", occurredAt: old }).returning();
    expect(await inTx((tx) => privacy.sweep!["email.email_events"]!(tx, cutoff))).toBe(1);
    expect(await h.db.select().from(emailEvents).where(eq(emailEvents.id, oldEvent[0]!.id))).toHaveLength(0);
    expect(await h.db.select().from(emailEvents).where(eq(emailEvents.emailMessageId, recent.messageId))).toHaveLength(1);

    // email.email_messages: old transactional rows and old campaign rows with a snapshot only.
    const { emailMessageId: oldTx } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", personId: p.id, locale: "nl-BE", data: magic, key: "p3p:sweep:old" });
    await h.db.update(emailMessages).set({ createdAt: old }).where(eq(emailMessages.id, oldTx));
    const unsnapped = await campaignWith(p.id, { finishedAt: old });
    const snapped = await campaignWith(p.id, { finishedAt: old, snapshot: true });
    await h.db.update(emailMessages).set({ createdAt: old }).where(eq(emailMessages.campaignId, unsnapped.campaignId));
    await h.db.update(emailMessages).set({ createdAt: old }).where(eq(emailMessages.campaignId, snapped.campaignId));
    expect(await inTx((tx) => privacy.sweep!["email.email_messages"]!(tx, cutoff))).toBe(2);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.id, unsnapped.messageId))).toHaveLength(1);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.id, recent.messageId))).toHaveLength(1);

    // email.campaign_recipients: only campaigns finished before the cutoff.
    expect(await inTx((tx) => privacy.sweep!["email.campaign_recipients"]!(tx, cutoff))).toBe(2);
    expect(await h.db.select().from(campaignRecipients).where(eq(campaignRecipients.campaignId, recent.campaignId))).toHaveLength(1);

    // email.email_ai_drafts (365 days)
    const [oldDraft] = await h.db.insert(emailAiDrafts).values({ brief: "A brief long enough", inputs: { sessionIds: [], segmentId: null, purpose: "newsletter", locales: ["en"] }, createdByUserId: userId, createdAt: old }).returning();
    const [newDraft] = await h.db.insert(emailAiDrafts).values({ brief: "Another brief here", inputs: { sessionIds: [], segmentId: null, purpose: "events", locales: ["en"] }, createdByUserId: userId }).returning();
    expect(await inTx((tx) => privacy.sweep!["email.email_ai_drafts"]!(tx, new Date(Date.now() - 365 * 86_400_000)))).toBe(1);
    expect(await h.db.select().from(emailAiDrafts).where(eq(emailAiDrafts.id, oldDraft!.id))).toHaveLength(0);
    expect(await h.db.select().from(emailAiDrafts).where(eq(emailAiDrafts.id, newDraft!.id))).toHaveLength(1);
  });
});
