/**
 * email-P6: `campaign.send_chunk` (email spec rules 7, 30, 32 to 36). Chunks and batches through
 * the Resend fake, the per-batch re-checks (suppression, consent, translation), pause, resume
 * with `r2` keys, stop, the warm-up cap and its next-day continuation, the last chunk setting
 * `sent`, and idempotent retries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, campaignRecipients, campaigns, emailMessages, persons, settings } from "@beam/db/schema";
import { and, eq, inArray, sql } from "@/lib/ctx";
import { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, staffActor, type FakeIntegrations } from "@/lib/testing";
import { addSuppression } from "@/modules/crm/api";
import { completeCompany } from "../email-p3.fixtures";
import { bulkPersons, campaignOf, grant, jobOfKey, publishedTemplate, recipientStatusCounts, recipientsOf, staff, staticSegment } from "../email-p6.fixtures";
import { createCampaignRecord, pauseCampaignRecord, resumeCampaignRecord, scheduleCampaignRecord, stopCampaignRecord, updateCampaignRecord } from "./campaigns";
import { chunkJobKey, dispatchDueCampaigns, planCampaign } from "./plan";
import { campaignMessageKey, sendChunk } from "./send-chunk";

let h: DbHandle;
let user: { id: string };
let fakes: FakeIntegrations;

/** Wednesday 24 March 2027 15:00 Brussels. */
const NOW = new Date("2027-03-24T14:00:00Z");
const staffCtx = () => makeCtx(h.db, { actor: staffActor({ userId: user.id, roleKey: "marketing", permissions: ["email.write", "campaigns.send", "email.send"] }), now: NOW });
const chunkCtx = (now = NOW) => makeJobCtx(h.db, "campaign.send_chunk", { integrations: fakes, now });

async function setWarmup(dailyCaps: number[], startOn = "2027-03-22") {
  const value = { domain: "news.beam.be", start_on: startOn, daily_caps: dailyCaps };
  await h.db.insert(settings).values({ key: "warmup_schedule", value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

beforeAll(async () => {
  h = await createTestDb();
  await completeCompany(h.db);
  user = await staff(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("EMAIL_SINK", "");
  vi.stubEnv("APP_URL", "https://beam.be");
  fakes = createFakeIntegrations();
  await setWarmup([]);
});

/** A campaign in `sending` with `n` reachable recipients (or these persons), dispatched at NOW. */
async function sending(input: { n?: number; persons?: string[]; locales?: ("nl-BE" | "fr-BE" | "en")[] } = {}) {
  const people = input.persons ?? (await bulkPersons(h.db, input.n ?? 3));
  const segmentId = await staticSegment(h.db, `P6 chunk segment ${people.length}`, people);
  const templateId = await publishedTemplate(h.db, "newsletter", input.locales);
  const ctx = staffCtx();
  const { campaignId } = await createCampaignRecord(ctx, { name: "Chunk test", purpose: "newsletter", templateId });
  await updateCampaignRecord(ctx, { campaignId, expectedVersion: 1, segmentId });
  await h.db.update(campaigns).set({ testSentAt: new Date(NOW.getTime() - 60_000) }).where(eq(campaigns.id, campaignId));
  await scheduleCampaignRecord(ctx, { campaignId, expectedVersion: 2, scheduledAt: "now" });
  await planCampaign(makeJobCtx(h.db, "campaign.plan", { now: NOW }), { campaignId, version: (await campaignOf(h.db, campaignId)).version });
  await dispatchDueCampaigns(makeJobCtx(h.db, "email.dispatch_due_campaigns", { now: NOW }));
  return { campaignId, people, campaign: await campaignOf(h.db, campaignId) };
}

/** Moves these persons' rows to `chunkNo` (two small chunks without 500 recipients). */
async function moveToChunk(campaignId: string, personIds: string[], chunkNo: number) {
  await h.db
    .update(campaignRecipients)
    .set({ chunkNo })
    .where(and(eq(campaignRecipients.campaignId, campaignId), inArray(campaignRecipients.personId, personIds)));
}

/** Calls `after(n)` once the n-th `sendBatch` of the fake has answered. */
function afterBatch(n: number, after: () => Promise<void>) {
  const original = fakes.resend.sendBatch.bind(fakes.resend);
  let calls = 0;
  fakes.resend.sendBatch = async (msgs, opts) => {
    const out = await original(msgs, opts);
    if (++calls === n) await after();
    return out;
  };
}

describe("campaign.send_chunk", () => {
  it("sends 1,050 recipients as 3 chunks and 11 batches through the fake, then sets sent", async () => {
    const { campaignId, campaign } = await sending({ n: 1050 });
    expect(campaign).toMatchObject({ status: "sending", chunkCount: 3 });
    for (const chunkNo of [0, 1, 2]) {
      expect(await jobOfKey(h.db, chunkJobKey(campaignId, chunkNo, 1))).toBeDefined();
      await sendChunk(chunkCtx(), { campaignId, chunkNo, runNo: 1 });
    }
    expect(fakes.resend.batches).toHaveLength(11);
    expect(fakes.resend.batches.map((b) => b.idempotencyKey)).toContain(`campaign:${campaignId}:chunk:2:r1:batch:0`);
    expect(fakes.resend.sent).toHaveLength(1050);
    expect(await recipientStatusCounts(h.db, campaignId)).toEqual({ sent: 1050 });
    expect(await campaignOf(h.db, campaignId)).toMatchObject({ status: "sent", sentCount: 1050, finishedAt: NOW });

    const [m] = await h.db.select().from(emailMessages).where(eq(emailMessages.campaignId, campaignId)).limit(1);
    expect(m).toMatchObject({ kind: "campaign", purpose: "newsletter", fromDomain: "news.beam.be", status: "sent", idempotencyKey: campaignMessageKey(campaignId, m!.personId!) });
    expect(m!.linkTokenHash).toMatch(/^[0-9a-f]{64}$/);
    const out = fakes.resend.sent[0]!;
    expect(out.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(out.html).toContain("/api/public/track/open");
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "email.sent"), eq(activityEvents.refId, m!.id)));
    expect(events).toHaveLength(1);
  });

  it("re-checks every batch: suppression, withdrawn consent and a missing locale skip the person", async () => {
    const { campaignId, people } = await sending({ n: 5, locales: ["nl-BE"] });
    const [first, suppressed, withdrawn, english, fine] = people;
    await moveToChunk(campaignId, [suppressed!, withdrawn!, english!, fine!], 1);
    await sendChunk(chunkCtx(), { campaignId, chunkNo: 0, runNo: 1 });
    // Between the chunks: an unsubscribe, a withdrawal and a locale change.
    const [p] = await h.db.select().from(persons).where(eq(persons.id, suppressed!));
    await addSuppression(h.db as unknown as Tx, makeCtx(h.db), { email: p!.email!, scope: "all", reason: "unsubscribe", source: "test:p6", personId: p!.id });
    await grant(h.db, [withdrawn!], "newsletter", "withdrawn", new Date(Date.now() + 1000));
    await h.db.update(persons).set({ locale: "en" }).where(eq(persons.id, english!));
    await sendChunk(chunkCtx(), { campaignId, chunkNo: 1, runNo: 1 });
    const status = new Map((await recipientsOf(h.db, campaignId)).map((r) => [r.personId, r.status]));
    expect([first, suppressed, withdrawn, english, fine].map((id) => status.get(id!))).toEqual(["sent", "skipped_suppressed", "skipped_consent", "skipped_translation", "sent"]);
    expect(fakes.resend.sent).toHaveLength(2);
    expect(await campaignOf(h.db, campaignId)).toMatchObject({ status: "sent", sentCount: 2 });
  });

  it("pause between batches leaves the rest planned; resume uses r2 keys and finishes", async () => {
    const { campaignId } = await sending({ n: 250 });
    afterBatch(1, async () => {
      const c = await campaignOf(h.db, campaignId);
      await pauseCampaignRecord(staffCtx(), { campaignId, expectedVersion: c.version });
    });
    expect(await sendChunk(chunkCtx(), { campaignId, chunkNo: 0, runNo: 1 })).toMatchObject({ sent: 100, exited: "status" });
    expect(await recipientStatusCounts(h.db, campaignId)).toEqual({ sent: 100, planned: 150 });
    expect(await campaignOf(h.db, campaignId)).toMatchObject({ status: "paused", pausedReason: "manual", sentCount: 100 });

    // An old run's job that starts late exits without sending.
    expect(await sendChunk(chunkCtx(), { campaignId, chunkNo: 0, runNo: 1 })).toMatchObject({ sent: 0, exited: "status" });

    const c = await campaignOf(h.db, campaignId);
    expect(await resumeCampaignRecord(staffCtx(), { campaignId, expectedVersion: c.version })).toEqual({ status: "sending" });
    expect(await jobOfKey(h.db, chunkJobKey(campaignId, 0, 2))).toBeDefined();
    expect(await sendChunk(chunkCtx(), { campaignId, chunkNo: 0, runNo: 2 })).toMatchObject({ sent: 150, finished: true });
    expect(fakes.resend.batches.map((b) => b.idempotencyKey)).toEqual([
      `campaign:${campaignId}:chunk:0:r1:batch:0`,
      `campaign:${campaignId}:chunk:0:r2:batch:0`,
      `campaign:${campaignId}:chunk:0:r2:batch:1`,
    ]);
    expect(await campaignOf(h.db, campaignId)).toMatchObject({ status: "sent", sentCount: 250, runNo: 2 });
  });

  it("stop leaves the planned rows planned and reports them as not sent", async () => {
    const { campaignId } = await sending({ n: 150 });
    let notSent = -1;
    afterBatch(1, async () => {
      const c = await campaignOf(h.db, campaignId);
      ({ notSent } = await stopCampaignRecord(staffCtx(), { campaignId, expectedVersion: c.version }));
    });
    await sendChunk(chunkCtx(), { campaignId, chunkNo: 0, runNo: 1 });
    // Counted at the stop, while this chunk's first batch was not committed yet.
    expect(notSent).toBeGreaterThanOrEqual(50);
    expect(await recipientStatusCounts(h.db, campaignId)).toEqual({ sent: 100, planned: 50 });
    expect(await campaignOf(h.db, campaignId)).toMatchObject({ status: "stopped", stoppedAt: NOW });
  });

  it("stops at the warm-up cap mid-chunk and continues the next day at 09:00 Brussels", async () => {
    // Days on which no other test of this file sent from news.beam.be.
    await setWarmup([150, 150, 150, 150, 150]);
    const day1 = new Date("2027-03-30T14:00:00Z");
    const { campaignId } = await sending({ n: 250 });
    expect(await sendChunk(chunkCtx(day1), { campaignId, chunkNo: 0, runNo: 1 })).toMatchObject({ sent: 150, batches: 2, exited: "warmup" });
    expect(await recipientStatusCounts(h.db, campaignId)).toEqual({ sent: 150, planned: 100 });
    expect((await campaignOf(h.db, campaignId)).status).toBe("sending");
    const next = await jobOfKey(h.db, chunkJobKey(campaignId, 0, 1, "2027-03-31"));
    expect(next).toMatchObject({ kind: "campaign.send_chunk", runAt: new Date("2027-03-31T07:00:00Z") });
    expect(next!.payload).toEqual({ campaignId, chunkNo: 0, runNo: 1, day: "2027-03-31" });
    const day2 = new Date("2027-03-31T07:00:00Z");
    expect(await sendChunk(chunkCtx(day2), { campaignId, chunkNo: 0, runNo: 1, day: "2027-03-31" })).toMatchObject({ sent: 100, finished: true });
    expect(fakes.resend.batches.at(-1)!.idempotencyKey).toBe(`campaign:${campaignId}:chunk:0:r1:d2027-03-31:batch:0`);
    expect(await campaignOf(h.db, campaignId)).toMatchObject({ status: "sent", sentCount: 250 });
  });

  it("the last chunk to finish sets sent, in either order", async () => {
    for (const order of [
      [1, 0],
      [0, 1],
    ]) {
      const { campaignId, people } = await sending({ n: 4 });
      await moveToChunk(campaignId, people.slice(2), 1);
      const [a, b] = order as [number, number];
      expect(await sendChunk(chunkCtx(), { campaignId, chunkNo: a, runNo: 1 })).toMatchObject({ sent: 2, finished: false });
      expect((await campaignOf(h.db, campaignId)).status).toBe("sending");
      // Two transactions: the one that commits last sees no planned row under the lock.
      await h.db.transaction(async (tx) => {
        const ctx = makeJobCtx(h.db, "campaign.send_chunk", { integrations: fakes, now: NOW, tx: tx as unknown as Tx });
        expect(await sendChunk(ctx, { campaignId, chunkNo: b, runNo: 1 })).toMatchObject({ sent: 2, finished: true });
      });
      expect(await campaignOf(h.db, campaignId)).toMatchObject({ status: "sent", sentCount: 4 });
    }
  });

  it("resume with no planned recipient left sets sent directly", async () => {
    const { campaignId } = await sending({ n: 2 });
    await sendChunk(chunkCtx(), { campaignId, chunkNo: 0, runNo: 1 });
    // Pretend a pause raced the last batch: everything is sent, the campaign is paused.
    await h.db.update(campaigns).set({ status: "paused", pausedReason: "manual" }).where(eq(campaigns.id, campaignId));
    const c = await campaignOf(h.db, campaignId);
    expect(await resumeCampaignRecord(staffCtx(), { campaignId, expectedVersion: c.version })).toEqual({ status: "sent" });
    expect(await campaignOf(h.db, campaignId)).toMatchObject({ status: "sent", runNo: 1, pausedReason: null });
  });

  it("a batch retried with the same idempotency key does not send twice", async () => {
    const { campaignId } = await sending({ n: 120 });
    // The first attempt reaches Resend, then the job transaction rolls back (crash before commit).
    await expect(
      h.db.transaction(async (tx) => {
        await sendChunk(makeJobCtx(h.db, "campaign.send_chunk", { integrations: fakes, now: NOW, tx: tx as unknown as Tx }), { campaignId, chunkNo: 0, runNo: 1 });
        throw new Error("crash after send");
      }),
    ).rejects.toThrow("crash after send");
    expect(fakes.resend.sent).toHaveLength(120);
    expect(await recipientStatusCounts(h.db, campaignId)).toEqual({ planned: 120 });
    const firstPayload = fakes.resend.sent.map((m) => [m.to, m.subject, m.html, m.headers["List-Unsubscribe"]]);
    // The retry renders byte-identical messages (same message ids, so the same link tokens).
    const original = fakes.resend.sendBatch.bind(fakes.resend);
    const retried: unknown[][] = [];
    fakes.resend.sendBatch = async (msgs, opts) => {
      retried.push(...msgs.map((m) => [m.to, m.subject, m.html, m.headers["List-Unsubscribe"]]));
      return original(msgs, opts);
    };
    await sendChunk(chunkCtx(), { campaignId, chunkNo: 0, runNo: 1 });
    expect(fakes.resend.sent).toHaveLength(120);
    expect(fakes.resend.batches).toHaveLength(2);
    expect(retried).toEqual(firstPayload);
    const ids = await h.db.select({ resendId: emailMessages.resendId }).from(emailMessages).where(eq(emailMessages.campaignId, campaignId));
    expect(new Set(ids.map((r) => r.resendId)).size).toBe(120);
    expect(await campaignOf(h.db, campaignId)).toMatchObject({ status: "sent", sentCount: 120 });
  });

  it("two overlapping runs of one chunk send each recipient once", async () => {
    const { campaignId } = await sending({ n: 30 });
    const run = () => h.db.transaction(async (tx) => sendChunk(makeJobCtx(h.db, "campaign.send_chunk", { integrations: fakes, now: NOW, tx: tx as unknown as Tx }), { campaignId, chunkNo: 0, runNo: 1 }));
    const results = await Promise.all([run(), run()]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(30);
    expect(fakes.resend.sent).toHaveLength(30);
    const [count] = await h.db.select({ n: sql<number>`count(*)::int` }).from(emailMessages).where(eq(emailMessages.campaignId, campaignId));
    expect(Number(count!.n)).toBe(30);
  });
});
