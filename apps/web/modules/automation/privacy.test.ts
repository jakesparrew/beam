/**
 * automation privacy (spec section 9): export is complete, erase leaves no row of the person,
 * the sweep handlers are keyed `automation.automation_runs` and `automation.automation_enrolments`
 * and purge by age, and a restricted person enters transactional journeys only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automationRuns } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { eq, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { GDPR_REGISTRY, NO_PII_TABLES } from "@/registry/privacy.generated";
import { def, makeAutomation } from "./engine/automation-p2.fixtures";

vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof import("@/modules/email/api")>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));

const { enrol } = await import("./engine/enrol");
const { privacy, noPiiTables, sweep, purgeAutomationHistory, automationPrivacy } = await import("./privacy");

let h: DbHandle;
let tx: Tx;
beforeAll(async () => {
  h = await createTestDb();
  tx = h.db as unknown as Tx;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const SYSTEM = { kind: "system", jobId: "" } as const;
const DAY = 86_400_000;

async function journeys(personId: string) {
  const a = await makeAutomation(h.db, { slug: `priv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, definition: def({ trigger: { manual: true } }) });
  const b = await makeAutomation(h.db, { isMarketing: false, definition: def({ trigger: { manual: true } }) });
  const r1 = await enrol(tx, { automation: a.id, personId, source: "staff", actor: SYSTEM, now: new Date() });
  const r2 = await enrol(tx, { automation: b.id, personId, source: "staff", actor: SYSTEM, now: new Date() });
  return { a, b, ids: [r1, r2].map((r) => (r.status === "enrolled" ? r.enrolmentId : "")) };
}

const count = async (table: "automation_runs" | "automation_enrolments", personId: string) =>
  Number(((await h.db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where person_id = ${personId}`)) as unknown as { rows: { n: number }[] }).rows[0]!.n);

describe("automation privacy registration", () => {
  it("registers the two person tables, the sweep keys and the configuration tables", () => {
    expect(automationPrivacy).toBe(privacy);
    expect(GDPR_REGISTRY.automation).toBe(privacy);
    expect([...privacy.tables].sort()).toEqual(["automation_enrolments", "automation_runs"]);
    expect(Object.keys(privacy.sweep ?? {}).sort()).toEqual(["automation.automation_enrolments", "automation.automation_runs"]);
    expect(privacy.sweep).toBe(sweep);
    expect(noPiiTables).toEqual(["automation_groups", "automations", "automation_versions"]);
    for (const t of noPiiTables) expect(NO_PII_TABLES).toContain(t);
  });

  it("export returns every enrolment and every run of the person", async () => {
    const p = await makePerson(h.db);
    const other = await makePerson(h.db);
    const { a, ids } = await journeys(p.id);
    await journeys(other.id);
    const out = (await privacy.export(tx, p.id)) as { enrolments: { id: string; automationSlug: string; version: number }[]; runs: { enrolmentId: string | null; outcome: string }[] };
    expect(out.enrolments.map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(out.enrolments.find((e) => e.id === ids[0])).toMatchObject({ automationSlug: a.slug, version: 1, status: "active", plan: expect.any(Array) });
    const runCount = await count("automation_runs", p.id);
    expect(out.runs).toHaveLength(runCount);
    expect(out.runs.every((r) => ids.includes(r.enrolmentId ?? ""))).toBe(true);
  });

  it("erase ends the active journeys, then leaves no run and no enrolment of the person", async () => {
    const p = await makePerson(h.db);
    const other = await makePerson(h.db);
    await journeys(p.id);
    await journeys(other.id);
    const otherRuns = await count("automation_runs", other.id);
    const report = await h.db.transaction((t) => privacy.erase(t, p.id));
    expect(report).toEqual([
      { table: "automation_enrolments", rows: 2, action: "exited" },
      { table: "automation_runs", rows: expect.any(Number), action: "deleted" },
      { table: "automation_enrolments", rows: 2, action: "deleted" },
    ]);
    expect(await count("automation_runs", p.id)).toBe(0);
    expect(await count("automation_enrolments", p.id)).toBe(0);
    expect(await count("automation_runs", other.id)).toBe(otherRuns);
  });

  it("sweep: runs older than the cutoff and ended enrolments older than the cutoff are deleted; active ones never", async () => {
    const p = await makePerson(h.db);
    const { ids } = await journeys(p.id);
    const old = new Date(Date.now() - 2_000 * DAY);
    await h.db.transaction(async (t) => {
      await t.execute(sql`set local beam.allow_rewrite = 'on'`);
      await t.update(automationRuns).set({ occurredAt: old }).where(eq(automationRuns.enrolmentId, ids[0]!));
    });
    await h.db
      .update(automationEnrolments)
      .set({ status: "completed", endedAt: old, endReason: "completed", nextStepAt: null, nextStepKey: null })
      .where(eq(automationEnrolments.id, ids[0]!));
    const cutoff = new Date(Date.now() - 730 * DAY);
    const runsBefore = await count("automation_runs", p.id);
    const purgedRuns = await h.db.transaction((t) => sweep["automation.automation_runs"](t, cutoff));
    expect(purgedRuns).toBeGreaterThan(0);
    expect(await count("automation_runs", p.id)).toBe(runsBefore - purgedRuns);
    const purged = await h.db.transaction((t) => purgeAutomationHistory(t, "automation.automation_enrolments", new Date(Date.now() - 1_095 * DAY)));
    expect(purged).toBe(1);
    const left = await h.db.select({ id: automationEnrolments.id }).from(automationEnrolments).where(eq(automationEnrolments.personId, p.id));
    expect(left.map((r) => r.id)).toEqual([ids[1]]);
  });

  it("a restricted person is not enrolled into a marketing journey but is enrolled into waitlist-offer", async () => {
    const p = await makePerson(h.db, { processingRestrictedAt: new Date() });
    const marketing = await makeAutomation(h.db, { definition: def({ trigger: { manual: true } }) });
    const waitlist = await makeAutomation(h.db, { slug: `waitlist-offer-${Date.now()}`, isMarketing: false, definition: def({ trigger: { manual: true } }) });
    expect(await enrol(tx, { automation: marketing.id, personId: p.id, source: "api", actor: SYSTEM, now: new Date() })).toEqual({ status: "skipped", outcome: "skipped_unreachable" });
    expect((await enrol(tx, { automation: waitlist.id, personId: p.id, source: "api", actor: SYSTEM, now: new Date() })).status).toBe("enrolled");
  });
});
