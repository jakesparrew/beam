/**
 * email-P7: campaign report (email spec rules 61 and 62). On a fixture campaign of 12 recipients
 * (10 sent, 2 skipped) the open, click, bounce, complaint and unsubscribe rates equal the
 * hand-computed values; clicks are counted per link index; after `email.freeze_campaign_stats`
 * the report reads the snapshot and stays unchanged when retention deletes the messages.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { campaignRecipients, emailEvents, jobs, suppressions } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";
import { eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { makeJobCtx, resetRuntime } from "@/lib/testing";
import { bulkPersons, campaignOf, campaignRow, staff } from "../email-p6.fixtures";
import { insertMessages, templateVersion, wipeMessages } from "../email-p7.fixtures";
import { listCampaigns } from "../queries";
import { freezeCampaignStats, freezeDueStats } from "./freeze";
import { campaignReportCsv, getCampaignReport, getCampaignStats } from "./reports";

let h: DbHandle;
let campaignId: string;
let messageIds: string[];

const DAY = 86_400_000;
const sentAt = new Date(Date.now() - 40 * DAY);

beforeAll(async () => {
  h = await createTestDb();
  const userId = (await staff(h.db)).id;
  const { templateId, versionId } = await templateVersion(h.db);
  const c = await campaignRow(h.db, { templateId, templateVersionId: versionId, createdByUserId: userId, status: "sent", startedAt: sentAt, finishedAt: new Date(sentAt.getTime() + 3600_000) });
  campaignId = c.id;
  const nl = await bulkPersons(h.db, 6, { consent: false, locale: "nl-BE" });
  const fr = await bulkPersons(h.db, 6, { consent: false, locale: "fr-BE" });
  const persons = [...nl.slice(0, 6), ...fr.slice(0, 4)];
  const at = (minutes: number) => new Date(sentAt.getTime() + minutes * 60_000);
  // 0..9 sent; 0..7 delivered; 8 hard bounce; 9 soft bounce; opens 0..3 (0 through Apple MPP); clicks 0, 1; complaint 7.
  messageIds = await insertMessages(h.db, 10, { templateVersionId: versionId, kind: "campaign", campaignId }, (i) => ({
    personId: persons[i]!,
    locale: i < 6 ? "nl-BE" : "fr-BE",
    toEmail: `p7-report-${i}@example.com`,
    sentAt: at(i < 5 ? 1 : 20),
    deliveredAt: i < 8 ? at(25) : null,
    status: i === 7 ? "complained" : i === 8 || i === 9 ? "bounced" : "delivered",
    bounceType: i === 8 ? "hard" : i === 9 ? "soft" : null,
    bouncedAt: i >= 8 ? at(26) : null,
    complainedAt: i === 7 ? at(30) : null,
    openedAt: i < 4 ? at(40) : null,
    clickedAt: i < 2 ? at(41) : null,
  }));
  await h.db.insert(campaignRecipients).values([
    ...persons.map((personId, i) => ({ campaignId, personId, locale: i < 6 ? "nl-BE" : "fr-BE", chunkNo: 0, status: "sent" as const, emailMessageId: messageIds[i]! })),
    { campaignId, personId: fr[4]!, locale: "fr-BE", chunkNo: 0, status: "skipped_suppressed" as const },
    { campaignId, personId: fr[5]!, locale: "fr-BE", chunkNo: 0, status: "skipped_consent" as const },
  ]);
  const ev = (i: number, type: "opened" | "clicked", extra: Partial<typeof emailEvents.$inferInsert> = {}) => ({ emailMessageId: messageIds[i]!, type, source: "tracking" as const, occurredAt: at(40), ...extra });
  await h.db.insert(emailEvents).values([
    ev(0, "opened", { payload: { ua_family: "apple_mpp" } }),
    ev(1, "opened"),
    ev(2, "opened"),
    ev(3, "opened"),
    ev(0, "clicked", { linkIndex: 0, url: "https://beam.be/en/events" }),
    ev(0, "clicked", { linkIndex: 0, url: "https://beam.be/en/events" }),
    ev(0, "clicked", { linkIndex: 1, url: "https://beam.be/en/shop" }),
    ev(1, "clicked", { linkIndex: 0, url: "https://beam.be/en/events" }),
  ]);
  // Message 3 unsubscribed through the one-click route.
  await h.db.insert(suppressions).values({ emailHash: emailHash("p7-report-3@example.com"), scope: "newsletter", reason: "unsubscribe", source: `one_click:${messageIds[3]}`, actor: { kind: "system", id: null } });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const EXPECTED = {
  recipients: 12,
  skipped: 2,
  sent: 10,
  delivered: 8,
  hardBounced: 1,
  softBounced: 1,
  complained: 1,
  uniqueOpens: 4,
  privacyProxyOpens: 1,
  uniqueClicks: 2,
  unsubscribed: 1,
  openRate: 4 / 8,
  clickRate: 2 / 8,
  clickToOpenRate: 2 / 4,
  bounceRate: 1 / 10,
  complaintRate: 1 / 8,
  unsubscribeRate: 1 / 8,
};

describe("getCampaignReport", () => {
  it("rates equal the hand-computed values", async () => {
    const r = await getCampaignReport(h.db, campaignId);
    expect(r).not.toBeNull();
    expect(r!.frozenAt).toBeNull();
    expect(r!.stats).toMatchObject(EXPECTED);
    expect(r!.skippedByReason).toEqual({ skipped_suppressed: 1, skipped_consent: 1 });
  });

  it("counts clicks per link index (unique messages and all clicks)", async () => {
    const r = await getCampaignReport(h.db, campaignId);
    expect(r!.clicksByLink).toEqual([
      { linkIndex: 0, url: "https://beam.be/en/events", uniqueClicks: 2, clicks: 3 },
      { linkIndex: 1, url: "https://beam.be/en/shop", uniqueClicks: 1, clicks: 1 },
    ]);
  });

  it("counts per locale and per 15 minutes", async () => {
    const r = await getCampaignReport(h.db, campaignId);
    expect(r!.byLocale).toEqual([
      { locale: "fr-BE", recipients: 6, sent: 4, delivered: 2, uniqueOpens: 0, uniqueClicks: 0 },
      { locale: "nl-BE", recipients: 6, sent: 6, delivered: 6, uniqueOpens: 4, uniqueClicks: 2 },
    ]);
    expect(r!.timeline.map((b) => b.sent).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("lists bounces and complaints with masked addresses unless unmasked", async () => {
    const masked = await getCampaignReport(h.db, campaignId);
    expect(masked!.bounces.map((b) => b.kind).sort()).toEqual(["complaint", "hard", "soft"]);
    expect(masked!.bounces.every((b) => b.email?.startsWith("p***@"))).toBe(true);
    const open = await getCampaignReport(h.db, campaignId, { unmasked: true });
    expect(open!.bounces.map((b) => b.email)).toContain("p7-report-8@example.com");
  });

  it("exports a CSV of ids, statuses and times without addresses", async () => {
    const csv = await campaignReportCsv(h.db, campaignId);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(13);
    expect(lines[0]).toContain("email_message_id");
    expect(csv).not.toContain("@example.com");
  });

  it("getCampaignStats gives the cross-module shape", async () => {
    const [s] = await getCampaignStats(h.db, [campaignId, campaignId]);
    expect(s).toEqual({ campaignId, recipients: 12, sent: 10, delivered: 8, opened: 4, clicked: 2, bounced: 2, complained: 1, unsubscribed: 1 });
  });
});

describe("stats freezing", () => {
  it("does nothing before 30 days after the end", async () => {
    const userId = (await staff(h.db)).id;
    const { templateId } = await templateVersion(h.db);
    const recent = await campaignRow(h.db, { templateId, createdByUserId: userId, status: "sent", finishedAt: new Date(Date.now() - 5 * DAY) });
    expect(await freezeCampaignStats(makeJobCtx(h.db, "email.freeze_campaign_stats"), { campaignId: recent.id })).toEqual({ frozen: false });
    expect((await campaignOf(h.db, recent.id)).statsSnapshot).toBeNull();
  });

  it("freeze_due_stats enqueues the freeze for campaigns finished 30 days ago", async () => {
    await freezeDueStats(makeJobCtx(h.db, "email.freeze_due_stats"));
    const [job] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `campaign:${campaignId}:freeze`));
    expect(job).toMatchObject({ kind: "email.freeze_campaign_stats", payload: { campaignId } });
  });

  it("the report reads the snapshot after freezing and stays unchanged after retention deletes", async () => {
    const before = await getCampaignReport(h.db, campaignId);
    expect(await freezeCampaignStats(makeJobCtx(h.db, "email.freeze_campaign_stats"), { campaignId })).toEqual({ frozen: true });
    expect(await freezeCampaignStats(makeJobCtx(h.db, "email.freeze_campaign_stats"), { campaignId })).toEqual({ frozen: false });
    const snapshot = (await campaignOf(h.db, campaignId)).statsSnapshot as Record<string, unknown>;
    expect(snapshot).toMatchObject({ campaign_id: campaignId, sent: 10, delivered: 8 });
    expect(JSON.stringify(snapshot)).not.toContain("@example.com");

    await wipeMessages(h.db, sql`campaign_id = ${campaignId}::uuid`);
    expect(await rowsAfterWipe()).toMatchObject({ sent: 0 });

    const after = await getCampaignReport(h.db, campaignId);
    expect(after!.frozenAt).not.toBeNull();
    expect(after!.stats).toEqual(before!.stats);
    expect(after!.clicksByLink).toEqual(before!.clicksByLink);
    expect(after!.byLocale).toEqual(before!.byLocale);
    expect(after!.skippedByReason).toEqual(before!.skippedByReason);
    const [s] = await getCampaignStats(h.db, [campaignId]);
    expect(s).toMatchObject({ sent: 10, opened: 4, clicked: 2 });
    const list = await listCampaigns(h.db, {});
    expect(list.items.find((c) => c.id === campaignId)).toMatchObject({ openRate: 0.5, clickRate: 0.25 });
  });
});

async function rowsAfterWipe() {
  return rowsOf<{ sent: number }>(await h.db.execute(sql`select sent from v_campaign_stats where campaign_id = ${campaignId}::uuid`))[0];
}
