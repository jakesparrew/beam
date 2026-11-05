/**
 * email-P6: the campaign lifecycle up to `sending` (email spec rules 25 to 29 and 31, section 4
 * campaign actions). Scheduling checks (segment, test send after the last edit, audience locales,
 * footer, permission, send window), the audience snapshot of `campaign.plan` (exclusions,
 * reachability, chunk numbers, warm-up ordering), recipient removal and restore, refresh,
 * unschedule, optimistic versions and the minute dispatch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.56" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, campaignRecipients, campaigns, emailMessages, jobs, roles, segmentMembers, settings } from "@beam/db/schema";
import { createCtx, eq, sql, type Ctx } from "@/lib/ctx";
import { createAuthSession, SESSION_COOKIE } from "@/lib/auth";
import { makeCtx, makeJobCtx, resetRuntime, staffActor } from "@/lib/testing";
import * as actions from "./actions";
import { COMPANY, completeCompany } from "./email-p3.fixtures";
import { bulkPersons, campaignOf, grant, jobsWithKeyPrefix, publishedTemplate, recipientStatusCounts, recipientsOf, staff, staticSegment } from "./email-p6.fixtures";
import {
  createCampaignRecord,
  removeRecipientRecord,
  restoreRecipientRecord,
  refreshAudienceRecord,
  scheduleCampaignRecord,
  unscheduleCampaignRecord,
  updateCampaignRecord,
} from "./server/campaigns";
import { dispatchDueCampaigns, getAudienceEstimate, planCampaign, planJobKey } from "./server/plan";
import { saveTemplateDraftRecord } from "./server/templates";

let h: DbHandle;
let user: { id: string; email: string };

/** Wednesday 24 March 2027, 11:00 Brussels: inside the send window. */
const NOW = new Date("2027-03-24T10:00:00Z");
const IN_WINDOW = new Date("2027-03-24T14:00:00Z");

const staffCtx = (now = NOW, perms = ["email.write", "campaigns.send", "email.send"]): Ctx => makeCtx(h.db, { actor: staffActor({ userId: user.id, roleKey: "marketing", permissions: perms }), now });
const jobCtx = (now = NOW, attempt = 1) => makeJobCtx(h.db, "campaign.plan", { now, attempt });

async function setWarmup(dailyCaps: number[], startOn: string | null = "2027-03-22") {
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
  await setWarmup([]);
  jar.clear();
});

/** A draft campaign on a published template with a segment of `n` reachable persons and a test send. */
async function ready(input: { n?: number; persons?: string[]; locales?: ("nl-BE" | "fr-BE" | "en")[]; tested?: boolean; segment?: boolean } = {}) {
  const people = input.persons ?? (await bulkPersons(h.db, input.n ?? 3));
  const segmentId = await staticSegment(h.db, `P6 segment ${people.length}`, people);
  const templateId = await publishedTemplate(h.db, "newsletter", input.locales);
  const ctx = staffCtx();
  const { campaignId } = await createCampaignRecord(ctx, { name: "Spring newsletter", purpose: "newsletter", templateId });
  if (input.segment !== false) await updateCampaignRecord(ctx, { campaignId, expectedVersion: 1, segmentId });
  if (input.tested !== false) await h.db.update(campaigns).set({ testSentAt: new Date(NOW.getTime() - 60_000) }).where(eq(campaigns.id, campaignId));
  return { campaignId, segmentId, templateId, people, version: (await campaignOf(h.db, campaignId)).version };
}

/** Schedules and runs `campaign.plan`. */
async function scheduled(input: Parameters<typeof ready>[0] = {}) {
  const r = await ready(input);
  await scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: IN_WINDOW });
  const c = await campaignOf(h.db, r.campaignId);
  await planCampaign(jobCtx(), { campaignId: r.campaignId, version: c.version });
  return { ...r, campaign: await campaignOf(h.db, r.campaignId) };
}

const refusal = (fields: Record<string, string>) => ({ code: "validation", message: "schedule_refused", fields: expect.objectContaining(fields) });

describe("scheduleCampaign checks (rule 26)", () => {
  it("is refused without a segment", async () => {
    const r = await ready({ segment: false });
    await expect(scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: IN_WINDOW })).rejects.toMatchObject(refusal({ segment: "segment_required" }));
    expect((await campaignOf(h.db, r.campaignId)).status).toBe("draft");
  });

  it("is refused without a test send after the last edit of the content", async () => {
    const untested = await ready({ tested: false });
    await expect(scheduleCampaignRecord(staffCtx(), { campaignId: untested.campaignId, expectedVersion: untested.version, scheduledAt: IN_WINDOW })).rejects.toMatchObject(
      refusal({ test_send: "test_send_required" }),
    );
    // A test send, then an edit of the draft: the test is stale again.
    const r = await ready();
    const ctx = makeCtx(h.db, { actor: staffActor({ userId: user.id, permissions: ["email.write"] }), now: NOW });
    const { current } = (await import("./queries").then((q) => q.getCampaign(h.db, r.campaignId)))!;
    await saveTemplateDraftRecord(ctx, { templateId: r.templateId, draftUpdatedAt: current!.updatedAt, subject: current!.subject, preheader: current!.preheader, document: current!.document! });
    await expect(scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: IN_WINDOW })).rejects.toMatchObject(refusal({ test_send: "test_send_required" }));
  });

  it("is refused when a locale of the audience is missing in the content", async () => {
    const nl = await bulkPersons(h.db, 2, { locale: "nl-BE" });
    const en = await bulkPersons(h.db, 1, { locale: "en" });
    const r = await ready({ persons: [...nl, ...en], locales: ["nl-BE"] });
    expect((await getAudienceEstimate(h.db, { segmentId: r.segmentId, purpose: "newsletter" })).byLocale).toEqual({ "nl-BE": 2, "fr-BE": 0, en: 1 });
    await expect(scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: IN_WINDOW })).rejects.toMatchObject(refusal({ "locale:en": "missing_locale" }));
  });

  it("is refused while the legal footer data is incomplete (rule 5)", async () => {
    const r = await ready();
    await h.db.update(settings).set({ value: { ...COMPANY, legal_name: "" } }).where(eq(settings.key, "company"));
    try {
      await expect(scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: IN_WINDOW })).rejects.toMatchObject(refusal({ footer: "footer_required" }));
    } finally {
      await completeCompany(h.db);
    }
  });

  it("refuses a Belgian public holiday or 22:00 without confirmOutsideWindow and accepts them with it", async () => {
    const easterMonday = new Date("2027-03-29T08:00:00Z"); // 10:00 Brussels, Easter Monday
    const late = new Date("2027-03-25T21:00:00Z"); // Thursday 22:00 Brussels
    for (const at of [easterMonday, late]) {
      const r = await ready();
      await expect(scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: at })).rejects.toMatchObject(
        refusal({ confirmOutsideWindow: expect.stringMatching(/^outside_window:(public_holiday|after_21)/) }),
      );
      await expect(scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: at, confirmOutsideWindow: true })).resolves.toEqual({ status: "planning" });
    }
  });

  it("refuses a time less than 5 minutes or more than 90 days ahead; 'now' is accepted", async () => {
    const r = await ready();
    const soon = new Date(NOW.getTime() + 2 * 60_000);
    const far = new Date(NOW.getTime() + 91 * 86_400_000);
    await expect(scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: soon })).rejects.toMatchObject(refusal({ scheduledAt: "too_soon" }));
    await expect(scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: far, confirmOutsideWindow: true })).rejects.toMatchObject(
      refusal({ scheduledAt: "too_far" }),
    );
    await scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: "now" });
    const c = await campaignOf(h.db, r.campaignId);
    expect(c).toMatchObject({ status: "planning", scheduledAt: NOW });
    expect(c.templateVersionId).not.toBeNull();
    const [plan] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, planJobKey(c.id, c.version)));
    expect(plan).toMatchObject({ kind: "campaign.plan", lane: "bulk", priority: 9 });
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.entityId, c.id));
    expect(audits.map((a) => a.action)).toContain("email.campaign_schedule");
  });

  it("is refused without campaigns.send through the action", async () => {
    const r = await ready();
    const u = await makeUser(h.db, { roleKey: "customer_service" });
    await h.db.update(roles).set({ permissions: ["email.write"] }).where(eq(roles.key, "customer_service"));
    const { token } = await createAuthSession(h.db, { userId: u.id, audience: "staff", roleKey: "customer_service", now: new Date(), mfaAt: new Date() });
    jar.set(SESSION_COOKIE, token);
    for (const run of [
      () => actions.scheduleCampaign({ campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: "now" }),
      () => actions.pauseCampaign({ campaignId: r.campaignId, expectedVersion: r.version }),
      () => actions.removeRecipient({ campaignId: r.campaignId, personId: r.people[0]! }),
    ]) {
      expect(await run()).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect((await campaignOf(h.db, r.campaignId)).status).toBe("draft");
  });

  it("answers conflict for a stale version, and one of two concurrent schedules wins", async () => {
    const r = await ready();
    await expect(updateCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version - 1, name: "Stale" })).rejects.toMatchObject({ code: "conflict" });
    const inTx = () =>
      h.db.transaction(async (tx) => {
        const ctx = createCtx({ tx: tx as unknown as Tx, actor: staffActor({ userId: user.id, permissions: ["campaigns.send", "email.send"] }), now: NOW });
        return scheduleCampaignRecord(ctx, { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: IN_WINDOW });
      });
    const results = await Promise.allSettled([inTx(), inTx()]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.find((x) => x.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect(await jobsWithKeyPrefix(h.db, `campaign:${r.campaignId}:plan:`)).toHaveLength(1);
  });
});

describe("campaign.plan (rule 27)", () => {
  it("snapshots the segment minus exclusion segments and unreachable persons", async () => {
    const [a, b, excluded, noConsent, withdrawn] = [
      ...(await bulkPersons(h.db, 3)),
      ...(await bulkPersons(h.db, 1, { consent: false })),
      ...(await bulkPersons(h.db, 1)),
    ];
    await grant(h.db, [withdrawn!], "newsletter", "withdrawn", new Date(Date.now() + 1000));
    const exclusion = await staticSegment(h.db, "P6 exclusion", [excluded!]);
    const r = await ready({ persons: [a!, b!, excluded!, noConsent!, withdrawn!] });
    await updateCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, excludeSegmentIds: [exclusion] });
    const estimate = await getAudienceEstimate(h.db, { segmentId: r.segmentId, excludeSegmentIds: [exclusion], purpose: "newsletter" });
    expect(estimate).toMatchObject({ total: 4, reachable: 2, blockedByReason: { no_consent: 1, withdrawn: 1 } });
    const c0 = await campaignOf(h.db, r.campaignId);
    await scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: c0.version, scheduledAt: IN_WINDOW });
    const c1 = await campaignOf(h.db, r.campaignId);
    expect(await planCampaign(jobCtx(), { campaignId: r.campaignId, version: c1.version })).toMatchObject({ status: "scheduled", recipients: 2, chunks: 1 });
    const rows = await recipientsOf(h.db, r.campaignId);
    expect(rows.map((x) => x.personId).sort()).toEqual([a, b].sort());
    expect(rows.every((x) => x.status === "planned" && x.chunkNo === 0 && x.locale === "nl-BE")).toBe(true);
    expect(await campaignOf(h.db, r.campaignId)).toMatchObject({ status: "scheduled", recipientsCount: 2, chunkCount: 1, audienceSnapshotAt: NOW });
    // A second run of the same job changes nothing.
    expect(await planCampaign(jobCtx(), { campaignId: r.campaignId, version: c1.version })).toEqual({ status: "skipped" });
  });

  it("numbers the chunks of 1,234 recipients 0 to 2", async () => {
    const { campaign } = await scheduled({ n: 1234 });
    expect(campaign).toMatchObject({ status: "scheduled", recipientsCount: 1234, chunkCount: 3 });
    const rows = await h.db
      .select({ chunk: campaignRecipients.chunkNo, n: sql<number>`count(*)::int` })
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id))
      .groupBy(campaignRecipients.chunkNo)
      .orderBy(campaignRecipients.chunkNo);
    expect(rows.map((x) => [x.chunk, Number(x.n)])).toEqual([
      [0, 500],
      [1, 500],
      [2, 234],
    ]);
  });

  it("puts the most engaged recipients first during warm-up, and orders by person_id outside it", async () => {
    const people = await bulkPersons(h.db, 502);
    const last = [...people].sort().slice(-2);
    for (const [i, personId] of last.entries()) {
      await h.db.insert(emailMessages).values({ personId, kind: "transactional", locale: "nl-BE", idempotencyKey: `p6-open-${personId}`, status: "sent", sentAt: NOW, openedAt: new Date(NOW.getTime() - i * 3600_000) });
    }
    const chunkOf = async (campaignId: string) => new Map((await recipientsOf(h.db, campaignId)).map((x) => [x.personId, x.chunkNo]));

    await setWarmup([]);
    const cold = await scheduled({ persons: people });
    const coldChunks = await chunkOf(cold.campaignId);
    expect(last.map((p) => coldChunks.get(p))).toEqual([1, 1]);

    await setWarmup([1000, 2000]);
    const warm = await scheduled({ persons: people });
    const warmChunks = await chunkOf(warm.campaignId);
    expect(last.map((p) => warmChunks.get(p))).toEqual([0, 0]);
    expect([...warmChunks.values()].filter((c) => c === 1)).toHaveLength(2);
  });

  it("moves the campaign back to draft with last_error when the last attempt fails", async () => {
    const r = await ready();
    await scheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: r.version, scheduledAt: IN_WINDOW });
    const c = await campaignOf(h.db, r.campaignId);
    await h.db.update(campaigns).set({ segmentId: null }).where(eq(campaigns.id, c.id));
    await expect(planCampaign(jobCtx(NOW, 1), { campaignId: c.id, version: c.version })).rejects.toThrow("segment_required");
    expect(await planCampaign(jobCtx(NOW, 3), { campaignId: c.id, version: c.version })).toMatchObject({ status: "draft" });
    expect(await campaignOf(h.db, c.id)).toMatchObject({ status: "draft", lastError: "segment_required" });
  });
});

describe("recipients, refresh and unschedule (rules 28, 29)", () => {
  it("removes and restores a planned recipient, audited with the person", async () => {
    const r = await scheduled({ n: 3 });
    const personId = r.people[0]!;
    await removeRecipientRecord(staffCtx(), { campaignId: r.campaignId, personId });
    expect((await recipientsOf(h.db, r.campaignId)).find((x) => x.personId === personId)).toMatchObject({ status: "removed", removedByUserId: user.id });
    await expect(removeRecipientRecord(staffCtx(), { campaignId: r.campaignId, personId })).rejects.toMatchObject({ message: "recipient_not_planned" });
    await restoreRecipientRecord(staffCtx(), { campaignId: r.campaignId, personId });
    expect((await recipientsOf(h.db, r.campaignId)).find((x) => x.personId === personId)).toMatchObject({ status: "planned", removedByUserId: null });
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.entityType, "campaign_recipient"));
    expect(audits.filter((a) => (a.newValue as { person_id?: string }).person_id === personId).map((a) => a.action).sort()).toEqual(["email.recipient_remove", "email.recipient_restore"]);
  });

  it("refresh adds new members, skips those no longer reachable and keeps removed rows", async () => {
    const r = await scheduled({ n: 3 });
    const [removed, leaving] = r.people;
    await removeRecipientRecord(staffCtx(), { campaignId: r.campaignId, personId: removed! });
    await grant(h.db, [leaving!], "newsletter", "withdrawn", new Date(Date.now() + 1000));
    const [newcomer] = await bulkPersons(h.db, 1);
    await h.db.insert(segmentMembers).values({ segmentId: r.segmentId, personId: newcomer!, source: "manual" });
    const c = await campaignOf(h.db, r.campaignId);
    expect(await refreshAudienceRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: c.version })).toEqual({ added: 1, skipped: 1 });
    const byPerson = new Map((await recipientsOf(h.db, r.campaignId)).map((x) => [x.personId, x.status]));
    expect(byPerson.get(removed!)).toBe("removed");
    expect(byPerson.get(leaving!)).toBe("skipped_unreachable");
    expect(byPerson.get(newcomer!)).toBe("planned");
    expect(await campaignOf(h.db, r.campaignId)).toMatchObject({ recipientsCount: 4, chunkCount: 1 });
  });

  it("unschedule deletes the planned and removed rows and returns to draft", async () => {
    const r = await scheduled({ n: 3 });
    await removeRecipientRecord(staffCtx(), { campaignId: r.campaignId, personId: r.people[0]! });
    const c = await campaignOf(h.db, r.campaignId);
    expect(await unscheduleCampaignRecord(staffCtx(), { campaignId: r.campaignId, expectedVersion: c.version })).toEqual({ status: "draft" });
    expect(await recipientStatusCounts(h.db, r.campaignId)).toEqual({});
    expect(await campaignOf(h.db, r.campaignId)).toMatchObject({ status: "draft", recipientsCount: 0, chunkCount: 0 });
  });
});

describe("email.dispatch_due_campaigns (rule 31)", () => {
  it("two parallel runs set sending once and enqueue each chunk once", async () => {
    const r = await scheduled({ n: 1234 });
    const later = new Date(IN_WINDOW.getTime() + 60_000);
    const run = () =>
      h.db.transaction(async (tx) => dispatchDueCampaigns(makeJobCtx(h.db, "email.dispatch_due_campaigns", { tx: tx as unknown as Tx, now: later })));
    const results = await Promise.all([run(), run()]);
    expect(results.flatMap((x) => x.dispatched).filter((id) => id === r.campaignId)).toHaveLength(1);
    const chunks = await jobsWithKeyPrefix(h.db, `campaign:${r.campaignId}:chunk:`);
    expect(chunks.map((j) => j.idempotencyKey).sort()).toEqual([0, 1, 2].map((n) => `campaign:${r.campaignId}:chunk:${n}:r1`));
    expect(chunks.every((j) => j.lane === "bulk" && j.priority === 9 && j.kind === "campaign.send_chunk")).toBe(true);
    expect(await campaignOf(h.db, r.campaignId)).toMatchObject({ status: "sending", startedAt: later });
  });

  it("leaves campaigns whose time has not come", async () => {
    const r = await scheduled({ n: 2 });
    const { dispatched } = await dispatchDueCampaigns(makeJobCtx(h.db, "email.dispatch_due_campaigns", { now: NOW }));
    expect(dispatched).not.toContain(r.campaignId);
    expect((await campaignOf(h.db, r.campaignId)).status).toBe("scheduled");
  });
});
