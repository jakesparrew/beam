/**
 * email-P4: `isSegmentInUse` (crm's segment archive guard). A campaign that is not terminal keeps
 * its audience segment and its exclusion segments in use; a `sent`, `stopped` or `cancelled`
 * campaign does not.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb, makeUser } from "@beam/db/testing";
import { campaigns } from "@beam/db/schema";
import { ACTIVE_CAMPAIGN_STATUSES, TERMINAL_CAMPAIGN_STATUSES, type CampaignStatus } from "@beam/core/email";
import type { Tx } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { isSegmentInUse } from "../api";
import { blockTemplate } from "../email-p3.fixtures";

let h: DbHandle;
let templateId: string;
let userId: string;

beforeAll(async () => {
  h = await createTestDb();
  templateId = await blockTemplate(h.db, { slug: "p4-segments-news", kind: "marketing", purpose: "newsletter" });
  userId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function campaign(status: CampaignStatus, input: { segmentId?: string | null; exclude?: string[] }) {
  const [row] = await h.db
    .insert(campaigns)
    .values({
      name: `p4 ${status}`,
      templateId,
      purpose: "newsletter",
      status,
      pausedReason: status === "paused" ? "manual" : null,
      segmentId: input.segmentId ?? null,
      excludeSegmentIds: input.exclude ?? [],
      createdByUserId: userId,
    })
    .returning({ id: campaigns.id });
  return row!.id;
}

describe("isSegmentInUse", () => {
  it("a segment targeted by a scheduled campaign is in use", async () => {
    const segment = randomUUID();
    await campaign("scheduled", { segmentId: segment });
    expect(await isSegmentInUse(h.db, segment)).toBe(true);
  });

  it("a segment used as an exclusion of a scheduled campaign is in use", async () => {
    const audience = randomUUID();
    const excluded = randomUUID();
    await campaign("scheduled", { segmentId: audience, exclude: [randomUUID(), excluded] });
    expect(await isSegmentInUse(h.db, excluded)).toBe(true);
  });

  it("every non-terminal status keeps the segment in use, as audience and as exclusion", async () => {
    for (const status of ACTIVE_CAMPAIGN_STATUSES) {
      const audience = randomUUID();
      const excluded = randomUUID();
      await campaign(status, { segmentId: audience, exclude: [excluded] });
      expect(await isSegmentInUse(h.db, audience), status).toBe(true);
      expect(await isSegmentInUse(h.db, excluded), status).toBe(true);
    }
  });

  it("a segment used only by a sent campaign is not in use, nor by a stopped or cancelled one", async () => {
    for (const status of TERMINAL_CAMPAIGN_STATUSES) {
      const audience = randomUUID();
      const excluded = randomUUID();
      await campaign(status, { segmentId: audience, exclude: [excluded] });
      expect(await isSegmentInUse(h.db, audience), status).toBe(false);
      expect(await isSegmentInUse(h.db, excluded), status).toBe(false);
    }
  });

  it("an unused segment and a value that is not a uuid are not in use", async () => {
    expect(await isSegmentInUse(h.db, randomUUID())).toBe(false);
    expect(await isSegmentInUse(h.db, "not-a-uuid")).toBe(false);
  });

  it("reads through the caller's transaction (OD-15): a campaign written in the same transaction counts", async () => {
    const segment = randomUUID();
    await h.db.transaction(async (tx) => {
      await (tx as unknown as Tx).insert(campaigns).values({
        name: "p4 in tx",
        templateId,
        purpose: "newsletter",
        status: "draft",
        segmentId: segment,
        createdByUserId: userId,
      });
      expect(await isSegmentInUse(tx as unknown as Tx, segment)).toBe(true);
      tx.rollback();
    }).catch(() => undefined);
    expect(await isSegmentInUse(h.db, segment)).toBe(false);
  });
});
