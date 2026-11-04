import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, dataExports, retentionPolicies } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", async () => (await import("../imports/ops-p4.fixtures")).headersMock(jar));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const download = await import("@/app/(admin)/admin/reports/exports/[id]/download/route");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { signInStaff } = await import("../imports/ops-p4.fixtures");
const { drainExports, unzip } = await import("./ops-p6.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await h.db.insert(retentionPolicies).values([
    { key: "ops.import_rows", tableName: "import_rows", days: 30, action: "delete", description: "Import rows" },
    { key: "crm.suppressions", tableName: "suppressions", days: null, action: "keep", description: "Suppressions" },
    { key: "finance.invoices", tableName: "invoices", days: 3653, action: "anonymise", description: "Invoices" },
  ]);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

const forbidden = { ok: false, error: { code: "forbidden" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };
const get = (id: string) => download.GET(new Request(`http://localhost/admin/reports/exports/${id}/download`), { params: Promise.resolve({ id }) });

describe("exports, retention and DPIA permissions (ops spec section 7)", () => {
  it("entity exports need persons.export; invoices, payments and refunds also invoices.read; full exports also users.manage", async () => {
    expect(await actions.createExport({ kind: "entity", entity: "persons" })).toMatchObject(unauthorized);

    await signInStaff(h.db, jar, ["persons.read", "reports.read"], "sales");
    expect(await actions.createExport({ kind: "entity", entity: "persons" })).toMatchObject(forbidden);

    jar.clear();
    await signInStaff(h.db, jar, [], "external_partner");
    expect(await actions.createExport({ kind: "entity", entity: "persons" })).toMatchObject(forbidden);
    expect(await actions.updateRetentionPolicy({ key: "ops.import_rows", days: 20 })).toMatchObject(forbidden);
    expect(await actions.updateDpiaRecord({ key: "voice_ai", status: "in_progress" })).toMatchObject(forbidden);

    jar.clear();
    await signInStaff(h.db, jar, ["persons.export"], "management");
    expect(await actions.createExport({ kind: "entity", entity: "tags" })).toMatchObject({ ok: true });
    for (const entity of ["invoices", "payments", "refunds"] as const) expect(await actions.createExport({ kind: "entity", entity }), entity).toMatchObject(forbidden);
    expect(await actions.createExport({ kind: "full" })).toMatchObject(forbidden);

    jar.clear();
    await signInStaff(h.db, jar, ["persons.export", "invoices.read"], "finance" as never);
    expect(await actions.createExport({ kind: "entity", entity: "invoices" })).toMatchObject({ ok: true });
    expect(await actions.createExport({ kind: "entity", entity: "tags", filters: { segmentId: "00000000-0000-4000-8000-000000000000" } })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.createExport({ kind: "entity" } as never)).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("retention policies need privacy.run; keep has no days, accounting keys stay at 3653 days; changes are audited", async () => {
    await signInStaff(h.db, jar, ["settings.write", "persons.export"], "management");
    expect(await actions.updateRetentionPolicy({ key: "ops.import_rows", days: 20 })).toMatchObject(forbidden);

    jar.clear();
    await signInStaff(h.db, jar, ["privacy.run"], "technical_admin");
    expect(await actions.updateRetentionPolicy({ key: "crm.suppressions", days: 10 })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.updateRetentionPolicy({ key: "finance.invoices", days: 365 })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.updateRetentionPolicy({ key: "ops.unknown_key", days: 10 })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await actions.updateRetentionPolicy({ key: "ops.import_rows", days: 20, isActive: false })).toMatchObject({ ok: true });
    const [p] = await h.db.select().from(retentionPolicies).where(eq(retentionPolicies.key, "ops.import_rows"));
    expect(p).toMatchObject({ days: 20, isActive: false });
    expect(p!.updatedByUserId).not.toBeNull();
    const [a] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "retention_policy.updated"), eq(auditLog.entityId, p!.id)));
    expect(a).toMatchObject({ oldValue: { days: 30, isActive: true }, newValue: { days: 20, isActive: false } });
  });

  it("the DPIA register needs settings.write", async () => {
    await signInStaff(h.db, jar, ["privacy.run", "users.manage"], "technical_admin");
    expect(await actions.updateDpiaRecord({ key: "voice_ai", status: "in_progress" })).toMatchObject(forbidden);
    jar.clear();
    await signInStaff(h.db, jar, ["settings.write"], "management");
    expect(await actions.updateDpiaRecord({ key: "voice_ai", status: "in_progress" })).toMatchObject({ ok: true });
  });

  it("downloads: the creator or users.manage; only a done, unexpired export; audited as export.downloaded", async () => {
    await makePerson(h.db, { email: "download@example.com" });
    const creator = await signInStaff(h.db, jar, ["persons.export"], "management");
    const created = await actions.createExport({ kind: "entity", entity: "persons" });
    if (!created.ok) throw new Error("export not created");
    const id = created.data.exportId;
    expect((await get(id)).status).toBe(410); // still queued
    await drainExports(h.db);

    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const entries = unzip(new Uint8Array(await res.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(["persons-1.csv"]);
    expect(entries[0]!.text).toContain("download@example.com");
    const audits = await h.db.select({ actor: auditLog.actor }).from(auditLog).where(and(eq(auditLog.action, "export.downloaded"), eq(auditLog.entityId, id)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.actor)).toContain(creator.id);

    jar.clear();
    expect((await get(id)).status).toBe(401);
    await signInStaff(h.db, jar, ["persons.export"], "sales");
    expect((await get(id)).status).toBe(403);
    jar.clear();
    await signInStaff(h.db, jar, ["users.manage"], "technical_admin");
    expect((await get(id)).status).toBe(200);

    await h.db.update(dataExports).set({ status: "failed" }).where(eq(dataExports.id, id));
    expect((await get(id)).status).toBe(410);
    await h.db.update(dataExports).set({ status: "expired" }).where(eq(dataExports.id, id));
    expect((await get(id)).status).toBe(410);
    expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});
