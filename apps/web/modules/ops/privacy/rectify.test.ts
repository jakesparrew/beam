/**
 * Rule 67 (ops-P5): rectification stores field names only; `completeRectification` calls
 * finance's `resyncCustomer` (mocked to its contract) once, in its own transaction.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";

const resync = vi.hoisted(() => ({ calls: [] as { tx: unknown; personId: string }[] }));

vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resyncCustomer: vi.fn((tx: unknown, _ctx: unknown, personId: string) => {
    resync.calls.push({ tx, personId });
    return Promise.resolve();
  }),
}));

const { and, createCtx, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime, staffActor } = await import("@/lib/testing");
const o = await import("./orchestrator");
const { requestOf, useTestKey } = await import("./ops-p5.fixtures");

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

describe("rectification (rule 67)", () => {
  it("stores field names only and completeRectification resyncs the finance customer once in its transaction", async () => {
    const p = await makePerson(h.db, { lastName: "Wrongname" });
    const actor = staffActor({ userId: staffId, permissions: ["privacy.run", "persons.write"] });
    let requestId = "";
    await h.db.transaction(async (tx) => {
      const ctx = createCtx({ tx, actor });
      const r = await o.createRequest(ctx, { personId: p.id, kind: "rectify", requestedBy: "staff", rectifyFields: ["last_name", "phone", "last_name"] });
      await o.verifyRequest(ctx, { requestId: r.id, verificationNote: "called back on the known number", acknowledgeWarnings: false });
      requestId = r.id;
    });
    const verified = await requestOf(h.db, requestId);
    expect(verified).toMatchObject({ status: "verified", rectifyFields: ["last_name", "phone"] });
    expect(JSON.stringify(verified)).not.toContain("Wrongname");
    expect(resync.calls).toHaveLength(0);

    let txSeen: unknown;
    await h.db.transaction(async (tx) => {
      txSeen = tx;
      await o.completeRectification(createCtx({ tx, actor }), requestId);
    });
    expect(resync.calls).toEqual([{ tx: txSeen, personId: p.id }]);
    expect((await requestOf(h.db, requestId)).status).toBe("done");
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "privacy.rectified"), eq(auditLog.entityId, requestId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.newValue).toEqual({ fields: ["last_name", "phone"] });
  });

  it("a rectification needs at least one field", async () => {
    const p = await makePerson(h.db);
    const ctx = createCtx({ tx: h.db as never, actor: staffActor({ userId: staffId, permissions: ["persons.write"] }) });
    await expect(o.createRequest(ctx, { personId: p.id, kind: "rectify", requestedBy: "staff", rectifyFields: [] })).rejects.toMatchObject({ code: "validation" });
  });
});
