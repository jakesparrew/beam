/**
 * Rules 63-64 (ops-P5): the erasure report and its audit row hold no personal value; every
 * payment provider the person used and Anthropic are `provider_retains`; a valid mandate is
 * revoked through commerce's `revokeMandatesForPerson` (mocked to its contract).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, payments } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";

const revoke = vi.hoisted(() => ({ calls: [] as { personId: string; isTx: boolean }[] }));

vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/commerce/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revokeMandatesForPerson: vi.fn(async (tx: { execute?: unknown }, _ctx: unknown, personId: string) => {
    revoke.calls.push({ personId, isTx: typeof tx?.execute === "function" });
    return { revoked: 1 };
  }),
}));

const { and, eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, staffActor } = await import("@/lib/testing");
const o = await import("./orchestrator");
const report = await import("./report");
const { drainPrivacy, requestOf, useTestKey } = await import("./ops-p5.fixtures");

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

const staff = () => makeCtx(h.db, staffActor({ userId: staffId, permissions: ["privacy.run", "persons.erase"] }));

describe("erasure report", () => {
  it("contains no personal value; payment providers and Anthropic retain; the mandate is revoked through commerce", async () => {
    const person = await makePerson(h.db, { email: "report-subject@example.com", firstName: "Annelies", lastName: "Vandersmissen", phone: "+32470123456" });
    const order = await makeOrder(h.db, { personId: person.id, status: "paid" });
    await h.db.insert(payments).values([
      { orderId: order.id, provider: "mollie", amountCents: 1000, status: "paid" },
      { orderId: order.id, provider: "stripe", amountCents: 500, status: "paid" },
      { orderId: order.id, provider: "cash", amountCents: 100, status: "paid" },
    ]);
    const r = await o.createRequest(staff(), { personId: person.id, kind: "erase", requestedBy: "staff" });
    await o.verifyRequest(staff(), { requestId: r.id, verificationNote: "ID checked", acknowledgeWarnings: true });
    await o.runNow(staff(), r.id);
    await drainPrivacy(h.db);

    const row = await requestOf(h.db, r.id);
    expect(row.status).toBe("done");
    const rep = row.report as { external: { provider: string; outcome: string }[]; steps: unknown[]; retained: { table: string; legal_basis: string }[] };
    const retains = rep.external.filter((e) => e.outcome === "provider_retains").map((e) => e.provider).sort();
    expect(retains).toEqual(["anthropic", "mollie", "stripe"]);
    expect(rep.external).toContainEqual({ provider: "mandates", outcome: "done" });
    expect(revoke.calls).toEqual([{ personId: person.id, isTx: true }]);
    expect(rep.retained).toEqual(expect.arrayContaining([{ table: "privacy_requests", legal_basis: "accountability" }, { table: "suppressions", legal_basis: "suppression" }]));

    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "privacy.erased"), eq(auditLog.entityId, r.id)));
    expect(audit).toBeDefined();
    expect(audit!.newValue).toMatchObject({ rows_total: expect.any(Number), modules: expect.arrayContaining(["crm", "platform"]) });
    const texts = [JSON.stringify(row.report), JSON.stringify(audit!.newValue), JSON.stringify(audit!.oldValue ?? null), row.verificationNote ?? ""];
    for (const value of ["report-subject@example.com", "Annelies", "Vandersmissen", "+32470123456", "470123456"]) {
      for (const text of texts) expect(text).not.toContain(value);
    }
  });

  it("merges a module rerun and lists the legal bases from the steps", () => {
    const first = report.stepsOf("finance", [{ table: "invoices", rows: 2, action: "anonymised" }]);
    const again = report.stepsOf("finance", [{ table: "invoices", rows: 3, action: "anonymised" }]);
    const merged = report.mergeSteps(report.mergeSteps([], "finance", first), "finance", again);
    expect(merged).toEqual([{ module: "finance", table: "invoices", rows: 3, action: "retained_legal" }]);
    expect(report.retainedOf(merged)).toContainEqual({ table: "invoices", legal_basis: "accounting_law" });
    expect(report.erasedAuditValue({ steps: merged, external: [], retained: [] })).toEqual({ rows_total: 3, modules: ["finance"] });
  });
});
