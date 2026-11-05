/**
 * email-P7 jobs run twice (conventions: every job runs twice): `email.freeze_campaign_stats`,
 * `email.freeze_due_stats`, `email.watch_complaints` and `email.watch_delivery` leave the same
 * state after a second run with the same payload; their schedules are declared with the spec's
 * cron.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { campaigns, jobs } from "@beam/db/schema";
import { asc, eq } from "@/lib/ctx";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { campaignRow, staff } from "./email-p6.fixtures";
import { insertMessages, templateVersion } from "./email-p7.fixtures";
import { jobs as jobDefs } from "./jobs";
import { schedules } from "./schedules";

let h: DbHandle;
let campaignId: string;

const DAY = 86_400_000;

beforeAll(async () => {
  h = await createTestDb();
  const { templateId, versionId } = await templateVersion(h.db);
  const userId = (await staff(h.db)).id;
  const finishedAt = new Date(Date.now() - 31 * DAY);
  campaignId = (await campaignRow(h.db, { templateId, templateVersionId: versionId, createdByUserId: userId, status: "sent", startedAt: finishedAt, finishedAt })).id;
  await insertMessages(h.db, 3, { templateVersionId: versionId, kind: "campaign", campaignId, sentAt: finishedAt, deliveredAt: finishedAt });
  // Delivery and complaint signals for the watches.
  await insertMessages(h.db, 1, { templateVersionId: versionId, kind: "transactional", purpose: null, fromDomain: "mail.beam.be", status: "queued", queuedAt: new Date(Date.now() - 30 * 60_000) });
  await insertMessages(h.db, 600, { templateVersionId: versionId, sentAt: new Date(), deliveredAt: new Date() }, (i) => (i < 3 ? { status: "complained", complainedAt: new Date() } : {}));
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const state = async () => ({
  jobs: (await h.db.select({ kind: jobs.kind, key: jobs.idempotencyKey, payload: jobs.payload }).from(jobs).orderBy(asc(jobs.idempotencyKey))).map((j) => ({ ...j })),
  campaigns: await h.db.select({ id: campaigns.id, status: campaigns.status, snapshot: campaigns.statsSnapshot }).from(campaigns).orderBy(asc(campaigns.id)),
});

describe("email-P7 jobs", () => {
  for (const [kind, payload] of [
    ["email.freeze_due_stats", {}],
    ["email.freeze_campaign_stats", null],
    ["email.watch_complaints", {}],
    ["email.watch_delivery", {}],
  ] as const) {
    it(`${kind} runs twice to the same state`, async () => {
      let afterFirst: unknown;
      await runJobTwice(h.db, kind, payload ?? { campaignId }, { between: async () => void (afterFirst = await state()) });
      expect(await state()).toEqual(afterFirst);
    });
  }

  it("froze the campaign and alerted once per fingerprint", async () => {
    const [c] = await h.db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    expect(c!.statsSnapshot).toMatchObject({ sent: 3, delivered: 3 });
    const slack = (await h.db.select().from(jobs).where(eq(jobs.kind, "notify.slack"))).map((j) => (j.payload as { fingerprint: string }).fingerprint).sort();
    expect(slack).toEqual(["email:complaints", "email:delivery:queued"]);
  });

  it("declares the jobs and the schedules with the spec's cron", () => {
    const kinds = jobDefs.map((j) => j.kind);
    expect(kinds).toEqual(expect.arrayContaining(["email.freeze_campaign_stats", "email.freeze_due_stats", "email.watch_complaints", "email.watch_delivery"]));
    expect(jobDefs.find((j) => j.kind === "email.freeze_campaign_stats")).toMatchObject({ lane: "bulk", priority: 9, maxAttempts: 3 });
    const cron = (kind: string) => schedules.find((s) => s.kind === kind)?.cron;
    expect(cron("email.watch_complaints")).toBe("*/15 * * * *");
    expect(cron("email.watch_delivery")).toBe("*/5 * * * *");
    expect(cron("email.freeze_due_stats")).toBe("40 4 * * *");
  });
});
