/**
 * email-P7: complaint alert (email spec rule 38). 0.2 % complaints over at least 600 delivered
 * `news.beam.be` messages in the last 24 hours alerts High once per hour (fingerprint
 * `email:complaints`); 0.05 % does not; fewer than 500 delivered never alerts. The same run
 * re-evaluates the bounce-rate auto-pause (rule 37) for campaigns `sending`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { jobs } from "@beam/db/schema";
import { sql } from "@/lib/ctx";
import { makeJobCtx, resetRuntime } from "@/lib/testing";
import { campaignOf, campaignRow, staff } from "../email-p6.fixtures";
import { insertMessages, templateVersion, wipeMessages } from "../email-p7.fixtures";
import { complaintState, watchComplaints } from "./complaints";

let h: DbHandle;
let versionId: string;
let templateId: string;
let userId: string;

const HOUR = 3_600_000;
const now = new Date("2026-11-05T10:20:00Z");

beforeAll(async () => {
  h = await createTestDb();
  ({ versionId, templateId } = await templateVersion(h.db));
  userId = (await staff(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await wipeMessages(h.db);
  await h.db.execute(sql`delete from jobs`);
});

/** `delivered` news.beam.be messages in the last 24 hours, `complained` of them complained. */
async function traffic(delivered: number, complained: number, at = new Date(now.getTime() - 2 * HOUR)) {
  await insertMessages(h.db, delivered, { templateVersionId: versionId, sentAt: at, deliveredAt: at }, (i) =>
    i < complained ? { status: "complained", complainedAt: new Date(at.getTime() + 60_000) } : {},
  );
}

const alerts = () => h.db.select().from(jobs).where(sql`${jobs.kind} = 'notify.slack' and ${jobs.idempotencyKey} like 'slack:email:complaints:%'`);
const watch = (at: Date = now) => watchComplaints(makeJobCtx(h.db, "email.watch_complaints", { now: at }));

describe("email.watch_complaints", () => {
  it("0.2 % complaints over 1,000 delivered alerts High, once per hour", async () => {
    await traffic(1000, 2);
    expect(await complaintState(h.db, now)).toMatchObject({ delivered: 1000, complained: 2, alert: true });
    expect((await watch()).alerted).toBe(true);
    await watch(new Date(now.getTime() + 15 * 60_000));
    const sent = await alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ fingerprint: "email:complaints", severity: "high" });
    expect(String((sent[0]!.payload as { text: string }).text)).not.toContain("@");
    // The next hour alerts again.
    await watch(new Date(now.getTime() + HOUR));
    expect(await alerts()).toHaveLength(2);
  });

  it("complaints above 0.1 % with 600 delivered alert too", async () => {
    await traffic(600, 2); // 0.33 %: 0.2 % of 600 is not a whole number of complaints
    expect((await watch()).alerted).toBe(true);
  });

  it("0.05 % does not alert", async () => {
    await traffic(2000, 1);
    expect(await complaintState(h.db, now)).toMatchObject({ delivered: 2000, complained: 1, alert: false });
    expect((await watch()).alerted).toBe(false);
    expect(await alerts()).toHaveLength(0);
  });

  it("fewer than 500 delivered never alerts, and messages older than 24 hours do not count", async () => {
    await traffic(400, 4);
    await traffic(800, 8, new Date(now.getTime() - 30 * HOUR));
    expect(await complaintState(h.db, now)).toMatchObject({ delivered: 400, alert: false });
    expect((await watch()).alerted).toBe(false);
  });

  it("re-evaluates the bounce-rate auto-pause for campaigns sending", async () => {
    const c = await campaignRow(h.db, { templateId, templateVersionId: versionId, createdByUserId: userId, status: "sending", startedAt: now });
    await insertMessages(h.db, 120, { templateVersionId: versionId, kind: "campaign", campaignId: c.id, sentAt: now }, (i) =>
      i < 5 ? { status: "bounced", bounceType: "hard", bouncedAt: now, deliveredAt: null } : {},
    );
    const result = await watch();
    expect(result.pausedCampaigns).toEqual([c.id]);
    expect(await campaignOf(h.db, c.id)).toMatchObject({ status: "paused", pausedReason: "bounce_rate" });
  });
});
