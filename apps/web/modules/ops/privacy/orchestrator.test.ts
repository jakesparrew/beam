/**
 * Rules 61-63a: the erasure pipeline (ops-P5). Steps run in `ERASE_ORDER` (including `site`),
 * each in its own job transaction under `beam.allow_rewrite = 'on'` and no other session setting
 * (cross-module decision 69); a failing step retries and the rerun is idempotent; a step failing
 * on its last attempt fails the request and run-now reruns it; a cancelled request exits; the
 * start waits 24 hours; one running request per person (an erase waits for a running export).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { ERASE_ORDER } from "@beam/core/ops";
import { activityEvents, automationEnrolments, automationGroups, automations, automationVersions } from "@beam/db/schema";
import { sql } from "drizzle-orm";
import { rowsOf } from "@/lib/sensitive";
import type * as PrivacyRegistry from "@/registry/privacy.generated";

const hooks = vi.hoisted(() => ({
  seen: [] as { module: string; allow: string | null; requestSetting: string | null; inTx: boolean }[],
  failures: {} as Record<string, number>,
  /** Runs once, inside the transaction, right after automation's own erase step. */
  afterAutomation: null as null | ((tx: unknown, personId: string) => Promise<void>),
  hookError: null as unknown,
}));

vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/registry/privacy.generated", async (importOriginal) => {
  const mod = await importOriginal<typeof PrivacyRegistry>();
  const wrapped = Object.fromEntries(
    Object.entries(mod.GDPR_REGISTRY).map(([module, reg]) => [
      module,
      {
        ...reg,
        async erase(tx: Parameters<typeof reg.erase>[0], personId: string) {
          const res = (await tx.execute(
            "select current_setting('beam.allow_rewrite', true) as allow, current_setting('beam.privacy_request_id', true) as req, now() <> statement_timestamp() or true as in_tx",
          )) as unknown as { rows: { allow: string | null; req: string | null; in_tx: boolean }[] };
          const r = res.rows[0]!;
          hooks.seen.push({ module, allow: r.allow, requestSetting: r.req, inTx: r.in_tx });
          if ((hooks.failures[module] ?? 0) > 0) {
            hooks.failures[module]! -= 1;
            throw new Error(`simulated ${module} failure`);
          }
          const out = await reg.erase(tx, personId);
          if (module === "automation" && hooks.afterAutomation) {
            const late = hooks.afterAutomation;
            hooks.afterAutomation = null;
            await late(tx, personId).catch((e: unknown) => {
              hooks.hookError = e;
              throw e;
            });
          }
          return out;
        },
      },
    ]),
  );
  return { ...mod, GDPR_REGISTRY: wrapped };
});

const { setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, staffActor } = await import("@/lib/testing");
const o = await import("./orchestrator");
const { drainPrivacy, privacyJobs, requestOf, seedRequest, useTestKey } = await import("./ops-p5.fixtures");

let h: DbHandle;
let staffId: string;
beforeAll(async () => {
  useTestKey();
  h = await createTestDb();
  setAppDb(h.db);
  staffId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  hooks.seen.length = 0;
  for (const k of Object.keys(hooks.failures)) delete hooks.failures[k];
  hooks.afterAutomation = null;
  hooks.hookError = null;
});

/** ERASE_ORDER as the steps call the registry: automation is swept once more just before crm. */
const CALLS = ERASE_ORDER.flatMap((m) => (m === "crm" ? ["automation", "crm"] : [m]));

const staff = () => makeCtx(h.db, staffActor({ userId: staffId, permissions: ["privacy.run", "persons.erase", "persons.export"] }));

/** A verified erasure that is due now. */
async function dueErasure(personId?: string) {
  const id = personId ?? (await makePerson(h.db)).id;
  const r = await o.createRequest(staff(), { personId: id, kind: "erase", requestedBy: "staff" });
  await o.verifyRequest(staff(), { requestId: r.id, verificationNote: "checked", acknowledgeWarnings: true });
  return { requestId: r.id, personId: id };
}

describe("erasure orchestration", () => {
  it("runs the externals, then every module in ERASE_ORDER (site included), then the report", async () => {
    const { requestId } = await dueErasure();
    await o.runNow(staff(), requestId);
    await drainPrivacy(h.db);
    expect((await requestOf(h.db, requestId)).status).toBe("done");
    expect(hooks.seen.map((s) => s.module)).toEqual(CALLS);
    expect(ERASE_ORDER).toContain("site");
    const keys = (await privacyJobs(h.db, requestId)).map((j) => j.key.replace(`privacy:${requestId}:`, ""));
    const steps = keys.filter((k) => k.startsWith("r1:step:")).map((k) => k.slice("r1:step:".length));
    expect(steps).toEqual([...ERASE_ORDER]);
    expect(keys).toEqual(expect.arrayContaining(["r1:start", "r1:start:now", "r1:external:billit", "r1:external:mandates", "r1:external:resend", "r1:finalise"]));
  });

  it("each step sets beam.allow_rewrite = 'on' inside its own transaction and no other session setting", async () => {
    const { requestId } = await dueErasure();
    await o.runNow(staff(), requestId);
    await drainPrivacy(h.db);
    expect(hooks.seen).toHaveLength(CALLS.length);
    for (const s of hooks.seen) {
      expect(s.allow, s.module).toBe("on");
      expect(s.requestSetting ?? "", s.module).toBe("");
    }
    // SET LOCAL: nothing leaks to the session after the step transactions.
    const res = (await h.db.execute("select current_setting('beam.allow_rewrite', true) as allow")) as unknown as { rows: { allow: string | null }[] };
    expect(res.rows[0]!.allow ?? "").not.toBe("on");
  });

  it("an enrolment made between automation's step and crm's does not block the erasure", async () => {
    // An event of just before the request, dispatched late: automation enrols the person after its
    // own step ran. The enrolment references the person's activity event (restrict), which crm
    // deletes; before the fix the crm step failed on every attempt and the request stayed running.
    hooks.afterAutomation = async (tx, personId) => {
      const t = tx as typeof h.db;
      const stamp = Date.now().toString(36);
      const key = `g_late_${stamp}`;
      const [g] = await t.insert(automationGroups).values({ key, name: key }).returning();
      const [a] = await t.insert(automations).values({ slug: `late-${stamp}`, name: "Late", groupId: g!.id, priority: 100, isMarketing: false, purpose: null }).returning();
      const [v] = await t.insert(automationVersions).values({ automationId: a!.id, version: 1, definition: {}, definitionHash: key }).returning();
      const [ev] = await t.insert(activityEvents).values({ personId, kind: "waitlist.offered", actor: { kind: "system", id: null }, data: {} }).returning({ id: activityEvents.id });
      await t.insert(automationEnrolments).values({ automationId: a!.id, automationVersionId: v!.id, personId, groupId: g!.id, source: "trigger", triggerEventId: ev!.id });
    };
    const { requestId, personId } = await dueErasure();
    await o.runNow(staff(), requestId);
    await drainPrivacy(h.db);
    expect(hooks.hookError).toBeNull();
    const row = await requestOf(h.db, requestId);
    expect(row.status).toBe("done");
    const left = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from automation_enrolments where person_id = ${personId}::uuid`));
    expect(left[0]!.n).toBe(0);
    const steps = (row.report as { steps: { module: string; table: string; rows: number; action: string }[] }).steps;
    expect(steps.filter((st) => st.module === "automation" && st.table === "automation_enrolments").reduce((n, st) => n + st.rows, 0)).toBeGreaterThanOrEqual(1);
  });

  it("a failing step retries and the rerun is idempotent (one report entry per table)", async () => {
    const { requestId } = await dueErasure();
    hooks.failures.forms = 2;
    await o.runNow(staff(), requestId);
    await drainPrivacy(h.db);
    const row = await requestOf(h.db, requestId);
    expect(row.status).toBe("done");
    expect(hooks.seen.filter((s) => s.module === "forms")).toHaveLength(3);
    // The same report shape as a clean run: the retried module's rows are recorded once.
    const clean = await dueErasure();
    await o.runNow(staff(), clean.requestId);
    await drainPrivacy(h.db);
    const shape = (r: unknown) => (r as { steps: { module: string; table: string; action: string }[] }).steps.map((s) => `${s.module}:${s.table}:${s.action}`);
    expect(shape(row.report)).toEqual(shape((await requestOf(h.db, clean.requestId)).report));
  });

  it("a step failing on its last attempt fails the request; run-now reruns from the externals with new keys", async () => {
    const { requestId } = await dueErasure();
    hooks.failures.booking = 6;
    await o.runNow(staff(), requestId);
    await drainPrivacy(h.db);
    const failed = await requestOf(h.db, requestId);
    expect(failed.status).toBe("failed");
    expect(hooks.seen.map((s) => s.module)).not.toContain("credits");

    hooks.seen.length = 0;
    await o.runNow(staff(), requestId);
    await drainPrivacy(h.db);
    const done = await requestOf(h.db, requestId);
    expect(done).toMatchObject({ status: "done", runAttempt: 2 });
    expect(hooks.seen.map((s) => s.module)).toEqual(CALLS);
    const keys = (await privacyJobs(h.db, requestId)).map((j) => j.key);
    expect(keys).toEqual(expect.arrayContaining([`privacy:${requestId}:r2:external:resend`, `privacy:${requestId}:r2:step:webinar`, `privacy:${requestId}:r2:finalise`]));
  });

  it("a cancelled request exits at its scheduled time without changes", async () => {
    const p = await makePerson(h.db);
    const { requestId } = await dueErasure(p.id);
    await o.cancelRequest(staff(), { requestId, reason: "changed mind" });
    await drainPrivacy(h.db, { includeScheduled: true });
    expect((await requestOf(h.db, requestId)).status).toBe("cancelled");
    expect(hooks.seen).toHaveLength(0);
  });

  it("the start waits until scheduled_for_at (24 hours after verification)", async () => {
    const { requestId } = await dueErasure();
    const row = await requestOf(h.db, requestId);
    expect(row.scheduledForAt!.getTime() - row.verifiedAt!.getTime()).toBe(86_400_000);
    await drainPrivacy(h.db, { includeScheduled: true });
    expect((await requestOf(h.db, requestId)).status).toBe("verified");
    await h.db.execute(`update privacy_requests set scheduled_for_at = now() - interval '1 second' where id = '${requestId}'`);
    await h.db.execute(`update jobs set status = 'pending', run_at = now() where idempotency_key = 'privacy:${requestId}:r1:start'`);
    await drainPrivacy(h.db);
    expect((await requestOf(h.db, requestId)).status).toBe("done");
  });

  it("an erase waits while an export of the same person runs (rule 63a)", async () => {
    const p = await makePerson(h.db);
    const exporting = await seedRequest(h.db, { personId: p.id, kind: "export", status: "running", verifiedAt: new Date() });
    const { requestId } = await dueErasure(p.id);
    await o.runNow(staff(), requestId);
    await drainPrivacy(h.db, { rounds: 3 });
    expect((await requestOf(h.db, requestId)).status).toBe("verified");
    const start = (await privacyJobs(h.db, requestId)).find((j) => j.key.endsWith(":start:now"))!;
    expect(start.status).toBe("pending");
    expect(start.attempts).toBeGreaterThan(0);

    await h.db.execute(`update privacy_requests set status = 'done' where id = '${exporting.id}'`);
    await drainPrivacy(h.db);
    expect((await requestOf(h.db, requestId)).status).toBe("done");
  });
});
