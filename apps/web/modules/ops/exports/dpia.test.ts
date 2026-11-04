import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, automationGroups, automations, dpiaRecords } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { DPIA_GATED, DPIA_KEYS, DPIA_STATUSES, type DpiaStatus } from "@beam/core/ops";

const jar = new Map<string, string>();
vi.mock("next/headers", async () => (await import("../imports/ops-p4.fixtures")).headersMock(jar));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { signInStaff } = await import("../imports/ops-p4.fixtures");
const { isDpiaApproved } = await import("../api");
const { listDpiaGates } = await import("./dpia");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

const WEBINAR_JOURNEYS = ["webinar-watched-end", "webinar-cta-click", "webinar-watched-30", "webinar-watched-15", "webinar-replay", "webinar-on-demand", "webinar-attended", "webinar-cta-sales-task"];

async function setStatus(key: (typeof DPIA_KEYS)[number], status: DpiaStatus) {
  await h.db.insert(dpiaRecords).values({ key, status, decisionNote: "test" }).onConflictDoUpdate({ target: dpiaRecords.key, set: { status } });
}

describe("DPIA gate (ops rule 70)", () => {
  it("isDpiaApproved is true only for approved and not_required, per key; a missing record is not approved", async () => {
    for (const key of DPIA_KEYS) {
      expect(await isDpiaApproved(h.db, key), `${key} missing`).toBe(false);
      for (const status of DPIA_STATUSES) {
        await setStatus(key, status);
        expect(await isDpiaApproved(h.db, key), `${key} ${status}`).toBe(status === "approved" || status === "not_required");
      }
      await setStatus(key, "not_started");
    }
  });

  it("the register lists each key's gates: features, watch-time profile fields and the automation journeys with requires_dpia", async () => {
    const [group] = await h.db.insert(automationGroups).values({ key: "webinar_behaviour", name: "Webinar behaviour" }).returning({ id: automationGroups.id });
    for (const slug of WEBINAR_JOURNEYS) await h.db.insert(automations).values({ slug, name: slug, groupId: group!.id, purpose: "events", requiresDpia: "watch_time_profiling" });
    await h.db.insert(automations).values({ slug: "welcome-lead", name: "Welcome", groupId: group!.id, purpose: "newsletter" });

    const gates = await listDpiaGates(h.db);
    expect(Object.keys(gates).sort()).toEqual([...DPIA_KEYS].sort());
    for (const key of DPIA_KEYS) expect(gates[key], key).toEqual(expect.arrayContaining([...DPIA_GATED[key]]));
    expect(gates.sensitive_assessment_processing).toEqual(expect.arrayContaining(["forms.publish_sensitive_version", "platform.sensitive_ai_switch"]));
    expect(gates.watch_time_profiling).toEqual(expect.arrayContaining(["v_person_profile.watch_sec_total", ...WEBINAR_JOURNEYS.map((s) => `automation:${s}`)]));
    expect(gates.watch_time_profiling).not.toContain("automation:welcome-lead");
    expect(gates.behavioural_scoring).toEqual(expect.arrayContaining(["ops.churn_indicators", "ops.opportunity_scores"]));
    expect(gates.ai_customer_ranking).toContain("ops.ai_questions_ranking");
    expect(gates.b2b_prospecting).toEqual([]);
    expect(gates.voice_ai).toEqual([]);
  });

  it("approved or not_required without a decision note is refused; every change is audited with old and new values", async () => {
    await signInStaff(h.db, jar, ["settings.write"], "management");
    expect(await actions.updateDpiaRecord({ key: "behavioural_scoring", status: "approved" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.updateDpiaRecord({ key: "behavioural_scoring", status: "not_required", decisionNote: "  " })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await isDpiaApproved(h.db, "behavioural_scoring")).toBe(false);

    expect(await actions.updateDpiaRecord({ key: "behavioural_scoring", status: "in_progress", purpose: "Churn indicators", risks: "Profiling" })).toMatchObject({ ok: true });
    expect(await actions.updateDpiaRecord({ key: "behavioural_scoring", status: "approved", decisionNote: "Approved by the DPO on 2026-11-01", measures: "Opt-out" })).toMatchObject({ ok: true });
    expect(await isDpiaApproved(h.db, "behavioural_scoring")).toBe(true);
    const [row] = await h.db.select().from(dpiaRecords).where(eq(dpiaRecords.key, "behavioural_scoring"));
    expect(row).toMatchObject({ status: "approved", purpose: "Churn indicators", risks: "Profiling", measures: "Opt-out", decisionNote: "Approved by the DPO on 2026-11-01" });
    expect(row!.reviewedByUserId).not.toBeNull();

    const audits = await h.db
      .select({ oldValue: auditLog.oldValue, newValue: auditLog.newValue })
      .from(auditLog)
      .where(and(eq(auditLog.action, "dpia.updated"), eq(auditLog.entityId, row!.id)))
      .orderBy(auditLog.createdAt);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ oldValue: { status: "in_progress" }, newValue: { status: "approved", decisionNote: "Approved by the DPO on 2026-11-01" } });
  });

  it("a document must be a stored file", async () => {
    await signInStaff(h.db, jar, ["settings.write"], "management");
    expect(await actions.updateDpiaRecord({ key: "voice_ai", status: "in_progress", documentFileId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});
