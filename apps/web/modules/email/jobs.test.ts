/**
 * email-P3: every email job handler run twice with the same payload leaves the same state
 * (conventions: `runJobTwice`), and the schedules point at registered jobs. email-P6 adds the
 * campaign jobs: `campaign.plan`, `email.dispatch_due_campaigns` and `campaign.send_chunk`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { emailMessages, emailTemplates, webhookEvents } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, resetRuntime, runJobTwice, type FakeIntegrations } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";
import { sendTransactional } from "./api";
import { completeCompany, jobsOf, messageOf, resetEmailTables } from "./email-p3.fixtures";
import { bulkPersons, campaignOf, campaignRow, publishedTemplate, staff, staticSegment } from "./email-p6.fixtures";
import { jobs, webhookHandlers } from "./jobs";
import { schedules } from "./schedules";

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
  vi.stubEnv("APP_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

/** Everything the email jobs write, without volatile timestamps. */
async function state() {
  const messages = rowsOf(
    await h.db.execute(sql`select id, status, error, resend_id, props, attempt, retry_of_message_id, link_token_hash is not null as has_token, sent_at from email_messages order by idempotency_key`),
  );
  const events = rowsOf(await h.db.execute(sql`select email_message_id, type, resend_event_id from email_events order by email_message_id, type`));
  const queued = rowsOf(await h.db.execute(sql`select kind, idempotency_key from jobs where kind <> 'email.send' or status = 'pending' order by idempotency_key`));
  const timeline = rowsOf(await h.db.execute(sql`select kind, dedupe_key from activity_events where kind like 'email.%' order by dedupe_key`));
  return { messages, events, queued, timeline };
}

const magic = { url: "https://example.com/nl/account/login/verify?token=abc", expiresMinutes: 15 };

async function queued(key: string) {
  const { emailMessageId } = await sendTransactional(makeCtx(h.db), { template: "platform.magic_link", to: "lotte@example.com", locale: "nl-BE", data: magic, key });
  return emailMessageId;
}

describe("every email job twice -> same state", () => {
  it("email.send", async () => {
    const id = await queued("p3j:send");
    let afterFirst: unknown;
    await runJobTwice(h.db, "email.send", { emailMessageId: id, template: "platform.magic_link" }, { integrations: fakes, between: async () => void (afterFirst = await state()) });
    expect(await state()).toEqual(afterFirst);
    expect(fakes.resend.sent).toHaveLength(1);
    expect((await messageOf(h.db, id)).status).toBe("sent");
  });

  it("email.retry_soft_bounce", async () => {
    const id = await queued("p3j:retry");
    await h.db.update(emailMessages).set({ status: "bounced", bounceType: "soft", bouncedAt: new Date(), sentAt: new Date(), resendId: "re_p3j_1" }).where(eq(emailMessages.id, id));
    let afterFirst: unknown;
    await runJobTwice(h.db, "email.retry_soft_bounce", { emailMessageId: id }, { integrations: fakes, between: async () => void (afterFirst = await state()) });
    expect(await state()).toEqual(afterFirst);
    const retries = await h.db.select().from(emailMessages).where(eq(emailMessages.retryOfMessageId, id));
    expect(retries).toHaveLength(1);
  });

  it("email.purge_props", async () => {
    const id = await queued("p3j:purge");
    const fresh = await queued("p3j:purge:fresh");
    await h.db.update(emailMessages).set({ status: "sent", sentAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(emailMessages.id, id));
    await h.db.update(emailMessages).set({ status: "sent", sentAt: new Date() }).where(eq(emailMessages.id, fresh));
    let afterFirst: unknown;
    await runJobTwice(h.db, "email.purge_props", {}, { integrations: fakes, between: async () => void (afterFirst = await state()) });
    expect(await state()).toEqual(afterFirst);
    expect((await messageOf(h.db, id)).props).toBeNull();
    expect((await messageOf(h.db, fresh)).props).toEqual(magic);
  });

  it("email.check_domains alerts once per domain and hour", async () => {
    fakes.resend.setDomain("news.beam.be", { status: "pending", records: [{ type: "TXT", name: "resend._domainkey.news.beam.be", status: "pending" }] });
    let afterFirst: unknown;
    const { first, second } = await runJobTwice(h.db, "email.check_domains", {}, { integrations: fakes, between: async () => void (afterFirst = await state()) });
    expect(first).toEqual({ problems: ["news.beam.be"] });
    expect(second).toEqual(first);
    expect(await state()).toEqual(afterFirst);
    const alerts = await jobsOf(h.db, "notify.slack");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.idempotencyKey).toMatch(/^slack:email:domain:news\.beam\.be:/);
  });

  it("the resend webhook handler (webhook.process)", async () => {
    const id = await queued("p3j:webhook");
    await runJobTwice(h.db, "email.send", { emailMessageId: id, template: "platform.magic_link" }, { integrations: fakes });
    const emitted = fakes.resend.emitWebhook("email.delivered", (await messageOf(h.db, id)).resendId!);
    const [row] = await h.db
      .insert(webhookEvents)
      .values({ provider: "resend", externalEventId: `${emitted.id}:${id}`, payload: emitted.payload, jobId: crypto.randomUUID() })
      .returning();
    let afterFirst: unknown;
    await runJobTwice(h.db, "webhook.process", { webhookEventId: row!.id }, { integrations: fakes, between: async () => void (afterFirst = await state()) });
    expect(await state()).toEqual(afterFirst);
    expect((await messageOf(h.db, id)).status).toBe("delivered");
  });
});

/** The campaign rows and their recipients, plus `state()`. */
async function campaignState(campaignId: string) {
  const campaign = rowsOf(await h.db.execute(sql`select status, version, run_no, sent_count, recipients_count, chunk_count, paused_reason from campaigns where id = ${campaignId}::uuid`));
  const recipients = rowsOf(await h.db.execute(sql`select person_id, status, chunk_no, email_message_id from campaign_recipients where campaign_id = ${campaignId}::uuid order by person_id`));
  return { campaign, recipients, ...(await state()) };
}

describe("campaign jobs twice -> same state (email-P6)", () => {
  it("campaign.plan, email.dispatch_due_campaigns and campaign.send_chunk", async () => {
    vi.stubEnv("EMAIL_LINK_TOKEN_SECRET", "p6-jobs-test-secret");
    vi.stubEnv("APP_URL", "https://beam.be");
    const userId = (await staff(h.db)).id;
    const templateId = await publishedTemplate(h.db);
    const [t] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
    const people = await bulkPersons(h.db, 5);
    const segmentId = await staticSegment(h.db, "P6 jobs segment", people);
    const c = await campaignRow(h.db, { templateId, createdByUserId: userId, status: "planning", segmentId, templateVersionId: t!.currentVersionId, scheduledAt: new Date(Date.now() - 60_000), version: 2 });

    let afterFirst: unknown;
    await runJobTwice(h.db, "campaign.plan", { campaignId: c.id, version: 2 }, { integrations: fakes, between: async () => void (afterFirst = await campaignState(c.id)) });
    expect(await campaignState(c.id)).toEqual(afterFirst);
    expect(await campaignOf(h.db, c.id)).toMatchObject({ status: "scheduled", recipientsCount: 5, chunkCount: 1 });

    await runJobTwice(h.db, "email.dispatch_due_campaigns", {}, { integrations: fakes, between: async () => void (afterFirst = await campaignState(c.id)) });
    expect(await campaignState(c.id)).toEqual(afterFirst);
    expect((await campaignOf(h.db, c.id)).status).toBe("sending");

    await runJobTwice(h.db, "campaign.send_chunk", { campaignId: c.id, chunkNo: 0, runNo: 1 }, { integrations: fakes, between: async () => void (afterFirst = await campaignState(c.id)) });
    expect(await campaignState(c.id)).toEqual(afterFirst);
    expect(fakes.resend.sent).toHaveLength(5);
    expect(await campaignOf(h.db, c.id)).toMatchObject({ status: "sent", sentCount: 5 });
  });
});

describe("registrations", () => {
  it("declares the jobs, the resend webhook handler and schedules of registered jobs", () => {
    const kinds = jobs.map((j) => j.kind);
    expect(kinds).toEqual(expect.arrayContaining(["email.send", "email.retry_soft_bounce", "email.purge_props", "email.check_domains"]));
    expect(jobs.find((j) => j.kind === "email.send")).toMatchObject({ lane: "fast", priority: 1, maxAttempts: 6 });
    expect(webhookHandlers.map((w) => w.provider)).toEqual(["resend"]);
    for (const s of schedules) expect(kinds).toContain(s.kind);
    expect(schedules.find((s) => s.kind === "email.purge_props")?.cron).toBe("20 2 * * *");
    expect(schedules.find((s) => s.kind === "email.check_domains")?.cron).toBe("10 5 * * *");
    expect(schedules.find((s) => s.kind === "email.dispatch_due_campaigns")?.cron).toBe("* * * * *");
    expect(kinds).toEqual(expect.arrayContaining(["campaign.plan", "campaign.send_chunk", "email.dispatch_due_campaigns"]));
    expect(jobs.find((j) => j.kind === "campaign.send_chunk")).toMatchObject({ lane: "bulk", priority: 9, maxAttempts: 6 });
    expect(jobs.find((j) => j.kind === "campaign.plan")).toMatchObject({ lane: "bulk", priority: 9, maxAttempts: 3 });
  });
});
