/**
 * Rule 59a: every transition of `privacy_requests.status` and the refused ones (ops-P5).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";

vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/finance/api", async (importOriginal) => ({ ...(await importOriginal<object>()), resyncCustomer: vi.fn(async () => undefined) }));

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

const staff = () => makeCtx(h.db, staffActor({ userId: staffId, permissions: ["privacy.run", "persons.erase", "persons.export", "persons.write"] }));
const HOUR = 3_600_000;

describe("privacy request states (rule 59a)", () => {
  it("staff: received → verified → (24 h later) running → done; the start job is scheduled at scheduled_for_at", async () => {
    const p = await makePerson(h.db);
    const created = await o.createRequest(staff(), { personId: p.id, kind: "erase", requestedBy: "staff" });
    expect(created.status).toBe("received");
    expect(created.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const verified = await o.verifyRequest(staff(), { requestId: created.id, verificationNote: "ID card checked at the desk", acknowledgeWarnings: false });
    expect(verified.status).toBe("verified");
    expect(verified.scheduledForAt!.getTime() - verified.verifiedAt!.getTime()).toBe(24 * HOUR);
    const [start] = await privacyJobs(h.db, created.id);
    expect(start).toMatchObject({ kind: "privacy.erase", key: `privacy:${created.id}:r1:start` });
    expect(new Date(start!.run_at).getTime()).toBe(verified.scheduledForAt!.getTime());

    await drainPrivacy(h.db); // not due yet
    expect((await requestOf(h.db, created.id)).status).toBe("verified");
    await drainPrivacy(h.db, { includeScheduled: true });
    // The job ran before scheduled_for_at only because the test moved run_at: the handler re-checks the time.
    expect((await requestOf(h.db, created.id)).status).toBe("verified");
    await h.db.execute(`update privacy_requests set scheduled_for_at = now() - interval '1 minute' where id = '${created.id}'`);
    await o.runNow(staff(), created.id);
    await drainPrivacy(h.db);
    expect((await requestOf(h.db, created.id)).status).toBe("done");
  });

  it("received or verified → cancelled; cancelling a running or done request is refused", async () => {
    const p = await makePerson(h.db);
    const a = await o.createRequest(staff(), { personId: p.id, kind: "export", requestedBy: "staff" });
    await o.cancelRequest(staff(), { requestId: a.id, reason: "duplicate" });
    expect((await requestOf(h.db, a.id)).status).toBe("cancelled");

    const b = await o.createRequest(staff(), { personId: p.id, kind: "erase", requestedBy: "staff" });
    await o.verifyRequest(staff(), { requestId: b.id, verificationNote: "checked", acknowledgeWarnings: true });
    await o.cancelRequest(staff(), { requestId: b.id, reason: "customer changed their mind" });
    expect((await requestOf(h.db, b.id)).status).toBe("cancelled");
    // The scheduled start job finds `cancelled` and exits without changes.
    await drainPrivacy(h.db, { includeScheduled: true });
    expect((await requestOf(h.db, b.id)).status).toBe("cancelled");

    const running = await seedRequest(h.db, { personId: p.id, kind: "export", status: "running" });
    await expect(o.cancelRequest(staff(), { requestId: running.id, reason: "x" })).rejects.toMatchObject({ code: "conflict" });
    const done = await seedRequest(h.db, { personId: (await makePerson(h.db)).id, kind: "export", status: "done" });
    await expect(o.cancelRequest(staff(), { requestId: done.id, reason: "x" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("verifying anything but a received request is refused; done and cancelled are final", async () => {
    const p = await makePerson(h.db);
    for (const status of ["verified", "running", "done", "failed", "cancelled"] as const) {
      const r = await seedRequest(h.db, { personId: p.id, kind: "rectify", status, rectifyFields: ["phone"] });
      await expect(o.verifyRequest(staff(), { requestId: r.id, verificationNote: "n", acknowledgeWarnings: true }), status).rejects.toMatchObject({ code: "conflict" });
      if (status !== "verified") await h.db.execute(`update privacy_requests set status = 'cancelled' where id = '${r.id}'`);
      else await o.cancelRequest(staff(), { requestId: r.id, reason: "cleanup" });
    }
  });

  it("an erasure with warnings needs them acknowledged", async () => {
    const p = await makePerson(h.db);
    await makeOrder(h.db, { personId: p.id, status: "pending_payment" });
    const r = await o.createRequest(staff(), { personId: p.id, kind: "erase", requestedBy: "staff" });
    expect(r.warnings).toContain("open_orders");
    await expect(o.verifyRequest(staff(), { requestId: r.id, verificationNote: "n", acknowledgeWarnings: false })).rejects.toMatchObject({ code: "validation" });
    await expect(o.verifyRequest(staff(), { requestId: r.id, verificationNote: "n", acknowledgeWarnings: true })).resolves.toMatchObject({ status: "verified" });
  });

  it("the customer cancels before scheduled_for_at only", async () => {
    const p = await makePerson(h.db);
    const customer = { kind: "customer" as const, userId: "00000000-0000-4000-8000-000000000001", personId: p.id };
    const r = await o.createRequest(makeCtx(h.db, customer), { personId: p.id, kind: "erase", requestedBy: "customer" });
    expect(r.status).toBe("verified");
    const late = makeCtx(h.db, { actor: customer, now: new Date(r.scheduledForAt!.getTime() + 60_000) });
    await expect(o.cancelOwnErasure(late, { requestId: r.id, personId: p.id })).rejects.toMatchObject({ code: "conflict" });
    const other = await makePerson(h.db);
    await expect(o.cancelOwnErasure(makeCtx(h.db, customer), { requestId: r.id, personId: other.id })).rejects.toMatchObject({ code: "not_found" });
    await o.cancelOwnErasure(makeCtx(h.db, customer), { requestId: r.id, personId: p.id });
    expect((await requestOf(h.db, r.id)).status).toBe("cancelled");
  });

  it("export: verified → running at once → done by the export job", async () => {
    const p = await makePerson(h.db);
    const r = await o.createRequest(staff(), { personId: p.id, kind: "export", requestedBy: "staff" });
    const v = await o.verifyRequest(staff(), { requestId: r.id, verificationNote: "checked", acknowledgeWarnings: false });
    expect(v.status).toBe("running");
    await drainPrivacy(h.db);
    expect((await requestOf(h.db, r.id)).status).toBe("done");
  });

  it("restrict and object: verified → done in the verifying transaction; rectify → done by completeRectification", async () => {
    const p = await makePerson(h.db);
    for (const kind of ["restrict", "object"] as const) {
      const r = await o.createRequest(staff(), { personId: p.id, kind, requestedBy: "staff" });
      const v = await o.verifyRequest(staff(), { requestId: r.id, verificationNote: "checked", acknowledgeWarnings: false });
      expect(v.status, kind).toBe("done");
    }
    const rect = await o.createRequest(staff(), { personId: p.id, kind: "rectify", requestedBy: "staff", rectifyFields: ["last_name"] });
    expect((await o.verifyRequest(staff(), { requestId: rect.id, verificationNote: "checked", acknowledgeWarnings: false })).status).toBe("verified");
    await o.completeRectification(staff(), rect.id);
    expect((await requestOf(h.db, rect.id)).status).toBe("done");
    await expect(o.completeRectification(staff(), rect.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("failed → running by run-now with run_attempt + 1 and new job keys; run-now of a done request is refused", async () => {
    const p = await makePerson(h.db);
    const r = await seedRequest(h.db, { personId: p.id, kind: "erase", status: "failed", verifiedAt: new Date(), scheduledForAt: new Date() });
    const { jobId } = await o.runNow(staff(), r.id);
    expect(jobId).toBeTruthy();
    const after = await requestOf(h.db, r.id);
    expect(after).toMatchObject({ status: "running", runAttempt: 2 });
    expect((await privacyJobs(h.db, r.id)).map((j) => j.key)).toContain(`privacy:${r.id}:r2:start:now`);
    await drainPrivacy(h.db);
    expect((await requestOf(h.db, r.id)).status).toBe("done");
    await expect(o.runNow(staff(), r.id)).rejects.toMatchObject({ code: "conflict" });
    // Run-now of an erasure also needs persons.erase.
    const q = await seedRequest(h.db, { personId: (await makePerson(h.db)).id, kind: "erase", status: "failed" });
    await expect(o.runNow(makeCtx(h.db, staffActor({ userId: staffId, permissions: ["privacy.run"] })), q.id)).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("one open request per person and kind", async () => {
    const p = await makePerson(h.db);
    await o.createRequest(staff(), { personId: p.id, kind: "export", requestedBy: "staff" });
    await expect(o.createRequest(staff(), { personId: p.id, kind: "export", requestedBy: "staff" })).rejects.toMatchObject({ code: "conflict" });
  });
});
