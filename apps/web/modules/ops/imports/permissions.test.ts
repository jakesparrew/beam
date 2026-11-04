import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, files, imports } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.10" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const upload = await import("@/app/(admin)/admin/imports/upload/route");
const rowsCsv = await import("@/app/(admin)/admin/imports/[id]/rows.csv/route");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { drain, identityMapping, seedImport, signInStaff } = await import("./ops-p4.fixtures");

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

const forbidden = { ok: false, error: { code: "forbidden" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };
let n = 0;
const companies = () => seedImport(h.db, { kind: "companies", csv: `name\nPerm ${++n} BV\n`, mapping: identityMapping(["name"]) });

function uploadRequest(text = "name\nAcme\n", fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("part", new Blob([text], { type: "text/csv" }), "file.csv");
  form.set("index", fields.index ?? "0");
  form.set("total", fields.total ?? "1");
  form.set("name", fields.name ?? "clients.csv");
  return new Request("http://localhost/admin/imports/upload", { method: "POST", body: form });
}

describe("imports permissions (ops spec section 7)", () => {
  it("upload, map and dry run need persons.write; signed-out users and customers are unauthorized", async () => {
    const id = await companies();
    const mapping = identityMapping(["name"]);
    expect(await actions.startDryRun({ importId: id })).toMatchObject(unauthorized);
    expect((await upload.POST(uploadRequest())).status).toBe(401);

    await signInStaff(h.db, jar, ["persons.read", "reports.read"], "sales");
    expect(await actions.createImport({ kind: "companies", source: "b2b_list", name: "Leads", fileIds: [id] })).toMatchObject(forbidden);
    expect(await actions.saveImportMapping({ importId: id, mapping })).toMatchObject(forbidden);
    expect(await actions.startDryRun({ importId: id })).toMatchObject(forbidden);
    expect(await actions.cancelImport({ importId: id })).toMatchObject(forbidden);
    expect((await upload.POST(uploadRequest())).status).toBe(403);
    expect((await rowsCsv.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id }) })).status).toBe(403);

    await signInStaff(h.db, jar, ["persons.write"], "reception");
    const res = await upload.POST(uploadRequest("name,city\nAcme BV,Gent\n"));
    expect(res.status).toBe(200);
    const { fileId } = (await res.json()) as { fileId: string };
    const [file] = await h.db.select().from(files).where(eq(files.id, fileId));
    expect(file).toMatchObject({ kind: "import", name: "clients.csv.part1of1" });
    expect(file!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 86_400_000);
    const created = await actions.createImport({ kind: "companies", source: "b2b_list", name: "Leads", fileIds: [fileId] });
    expect(created).toMatchObject({ ok: true, data: { header: ["name", "city"], sample: [{ name: "Acme BV", city: "Gent" }] } });
    const importId = (created as { data: { importId: string } }).data.importId;
    expect((await h.db.select().from(files).where(eq(files.id, fileId)))[0]!.expiresAt).toBeNull();
    expect(await actions.saveImportMapping({ importId, mapping: identityMapping(["name", "city"]) })).toMatchObject({ ok: true, data: { ok: true } });
    expect(await actions.startDryRun({ importId })).toMatchObject({ ok: true });
    await drain(h.db);
    expect((await rowsCsv.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: importId }) })).status).toBe(200);
    const audits = (await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, importId))).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(["import.created", "import.mapped", "import.dry_run_started"]));
  });

  it("the upload route refuses parts over 3 MB and more than 17 parts", async () => {
    await signInStaff(h.db, jar, ["persons.write"], "reception");
    expect((await upload.POST(uploadRequest("x".repeat(3 * 1024 * 1024 + 1)))).status).toBe(400);
    expect((await upload.POST(uploadRequest("name\n", { total: "18", index: "0" }))).status).toBe(400);
    expect((await upload.POST(uploadRequest("name\n", { total: "2", index: "2" }))).status).toBe(400);
  });

  it("the real run, the sign-off and the cut-over need settings.write", async () => {
    const id = await companies();
    await signInStaff(h.db, jar, ["persons.write"], "reception");
    expect(await actions.startDryRun({ importId: id })).toMatchObject({ ok: true });
    await drain(h.db);
    expect(await actions.startImport({ importId: id })).toMatchObject(forbidden);
    expect(await actions.signOffReconciliation({ importId: id, note: "ok" })).toMatchObject(forbidden);
    expect(await actions.setCutoverStep({ key: "dns_switched", done: true })).toMatchObject(forbidden);

    await signInStaff(h.db, jar, ["settings.write"], "technical_admin");
    expect(await actions.startImport({ importId: id })).toMatchObject(forbidden); // also needs persons.write
    await signInStaff(h.db, jar, ["persons.write", "settings.write"], "management");
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: true });
    await drain(h.db);
    expect(await actions.setCutoverStep({ key: "dns_switched", done: true })).toMatchObject({ ok: true });
    const audits = (await h.db.select({ action: auditLog.action }).from(auditLog)).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(["import.started", "cutover.updated"]));
  });

  it("an external partner holds none of the import permissions", async () => {
    const id = await companies();
    await signInStaff(h.db, jar, [], "external_partner");
    expect(await actions.startDryRun({ importId: id })).toMatchObject(forbidden);
    expect(await actions.setCutoverStep({ key: "dns_switched", done: true })).toMatchObject(forbidden);
    expect((await h.db.select({ status: imports.status }).from(imports).where(eq(imports.id, id)))[0]!.status).toBe("uploaded");
  });
});
