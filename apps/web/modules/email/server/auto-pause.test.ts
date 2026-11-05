/**
 * email-P6: bounce-rate auto-pause (email spec rule 37, decision 30). At least 100 sent and more
 * than 2 % hard bounces pause a `sending` campaign with reason `bounce_rate`, enqueue a High
 * Slack alert and create one marketing review task; a `sent` campaign gets the alert and the task
 * without a status change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, emailMessages, emailTemplates, jobs, tasks } from "@beam/db/schema";
import { and, eq, sql } from "@/lib/ctx";
import { makeJobCtx, resetRuntime } from "@/lib/testing";
import { campaignOf, campaignRow, publishedTemplate, staff } from "../email-p6.fixtures";
import { bounceRateExceeded, evaluateBounceRate } from "./auto-pause";

let h: DbHandle;
let userId: string;
let templateId: string;
let versionId: string;

beforeAll(async () => {
  h = await createTestDb();
  userId = (await staff(h.db)).id;
  templateId = await publishedTemplate(h.db);
  const [t] = await h.db.select().from(emailTemplates).where(eq(emailTemplates.id, templateId));
  versionId = t!.currentVersionId!;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** A campaign in `status` with `sent` campaign messages of which `hard` bounced hard. */
async function campaignWith(status: "sending" | "sent", sent: number, hard: number) {
  const c = await campaignRow(h.db, { templateId, createdByUserId: userId, status, templateVersionId: versionId, startedAt: new Date() });
  const at = new Date();
  await h.db.insert(emailMessages).values(
    Array.from({ length: sent }, (_, i) => ({
      kind: "campaign" as const,
      purpose: "newsletter" as const,
      campaignId: c.id,
      templateVersionId: versionId,
      locale: "nl-BE",
      fromDomain: "news.beam.be" as const,
      idempotencyKey: `p6-bounce:${c.id}:${i}`,
      status: i < hard ? ("bounced" as const) : ("delivered" as const),
      bounceType: i < hard ? ("hard" as const) : null,
      sentAt: at,
      bouncedAt: i < hard ? at : null,
    })),
  );
  return c.id;
}

const evaluate = (campaignId: string) => {
  const ctx = makeJobCtx(h.db, "campaign.send_chunk");
  return evaluateBounceRate(ctx.tx as Tx, campaignId, ctx);
};
const slackJobs = (campaignId: string) => h.db.select().from(jobs).where(sql`${jobs.idempotencyKey} like ${`slack:email:bounce:${campaignId}:%`}`);
const tasksOf = (campaignId: string) => h.db.select().from(tasks).where(eq(tasks.dedupeKey, `email:bounce:${campaignId}`));

describe("evaluateBounceRate", () => {
  it("3 hard bounces of 120 sent pause the campaign with bounce_rate, alert and create a task", async () => {
    const id = await campaignWith("sending", 120, 3);
    expect(await evaluate(id)).toBe("paused");
    expect(await campaignOf(h.db, id)).toMatchObject({ status: "paused", pausedReason: "bounce_rate" });
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "email.campaign_auto_pause")));
    expect(audit).toBeDefined();
    expect((audit!.actor as { kind: string }).kind).not.toBe("staff");
    const slack = await slackJobs(id);
    expect(slack).toHaveLength(1);
    expect(slack[0]!.payload).toMatchObject({ fingerprint: `email:bounce:${id}`, severity: "high" });
    const [task] = await tasksOf(id);
    expect(task).toMatchObject({ kind: "review", priority: "high", source: "system", refType: "campaign", refId: id, ownerUserId: userId });
    // A second evaluation changes nothing.
    expect(await evaluate(id)).toBe("paused");
    expect(await tasksOf(id)).toHaveLength(1);
  });

  it("1 hard bounce of 120 does not pause", async () => {
    const id = await campaignWith("sending", 120, 1);
    expect(await evaluate(id)).toBe("ok");
    expect((await campaignOf(h.db, id)).status).toBe("sending");
    expect(await slackJobs(id)).toHaveLength(0);
  });

  it("fewer than 100 sent never pause, whatever the rate", async () => {
    const id = await campaignWith("sending", 99, 40);
    expect(await evaluate(id)).toBe("ok");
    expect((await campaignOf(h.db, id)).status).toBe("sending");
    expect(bounceRateExceeded({ sent: 99, hardBounced: 99 }, { bounce_min_sent: 100, bounce_pause_pct: 2 })).toBe(false);
    expect(bounceRateExceeded({ sent: 100, hardBounced: 2 }, { bounce_min_sent: 100, bounce_pause_pct: 2 })).toBe(false);
    expect(bounceRateExceeded({ sent: 100, hardBounced: 3 }, { bounce_min_sent: 100, bounce_pause_pct: 2 })).toBe(true);
  });

  it("a bounce on an already sent campaign alerts and creates the task without a status change", async () => {
    const id = await campaignWith("sent", 120, 3);
    expect(await evaluate(id)).toBe("ok");
    expect((await campaignOf(h.db, id)).status).toBe("sent");
    expect(await slackJobs(id)).toHaveLength(1);
    expect(await tasksOf(id)).toHaveLength(1);
  });

  it("works with the caller's transaction alone (no context given)", async () => {
    const id = await campaignWith("sending", 150, 10);
    await h.db.transaction(async (tx) => expect(await evaluateBounceRate(tx as unknown as Tx, id)).toBe("paused"));
    expect((await campaignOf(h.db, id)).status).toBe("paused");
    expect(await slackJobs(id)).toHaveLength(1);
  });
});
