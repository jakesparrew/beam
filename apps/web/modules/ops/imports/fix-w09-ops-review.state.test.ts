import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { importRows, imports } from "@beam/db/schema";
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
const { sweepImportRows } = await import("../exports/sweep");
const { eq, setAppDb, sql } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { drain, identityMapping, importOf, rowsOf, seedImport, signInStaff } = await import("./ops-p4.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await signInStaff(h.db, jar, ["persons.write", "settings.write"]);
});

let n = 0;
const CSV = () => `name,city\nAcme ${++n} BV,Gent\nBeta ${n} NV,Brugge\n`;
const mapping = () => identityMapping(["name", "city"]);
const conflict = (message: string) => ({ ok: false, error: { code: "conflict", message } });
const DAY = 86_400_000;

async function dryRunDone() {
  const id = await seedImport(h.db, { kind: "companies", csv: CSV(), mapping: mapping() });
  expect(await actions.startDryRun({ importId: id })).toMatchObject({ ok: true });
  await drain(h.db);
  return id;
}

describe("import_rows retention (review finding 1, rule 52)", () => {
  it("the sweep purges rows of an import finished before the cutoff; startImport then refuses with dry_run_stale", async () => {
    const id = await dryRunDone();
    const imp = await importOf(h.db, id);
    expect(imp.finishedAt).toBeInstanceOf(Date);
    await h.db.transaction(async (tx) => {
      expect(await sweepImportRows(tx, new Date(imp.finishedAt!.getTime() + DAY))).toBe(2);
    });
    expect(await rowsOf(h.db, id)).toHaveLength(0);
    expect(await actions.startImport({ importId: id })).toMatchObject(conflict("dry_run_stale"));
    expect((await importOf(h.db, id)).status).toBe("dry_run");
    // A new dry run parses the parts again and the run can start.
    expect(await actions.startDryRun({ importId: id })).toMatchObject({ ok: true });
    await drain(h.db);
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: true });
  });

  it("rows of an unfinished dry run or a running import stay, whatever their age; a recent finish keeps its rows", async () => {
    const running = await dryRunDone();
    await h.db.update(imports).set({ status: "running", finishedAt: new Date(Date.now() - 90 * DAY) }).where(eq(imports.id, running));
    const parsing = await seedImport(h.db, { kind: "companies", csv: CSV(), mapping: mapping() });
    expect(await actions.startDryRun({ importId: parsing })).toMatchObject({ ok: true });
    await drain(h.db);
    await h.db.update(imports).set({ finishedAt: null }).where(eq(imports.id, parsing));
    const recent = await dryRunDone();
    await h.db.execute(sql`update import_rows set created_at = now() - interval '90 days' where import_id in (${running}::uuid, ${parsing}::uuid, ${recent}::uuid)`);

    await h.db.transaction(async (tx) => {
      await sweepImportRows(tx, new Date(Date.now() - 30 * DAY));
    });
    for (const id of [running, parsing, recent]) expect(await rowsOf(h.db, id)).toHaveLength(2);
  });

  it("an abandoned dry run finished more than 30 days ago is still purged", async () => {
    const id = await dryRunDone();
    await h.db.update(imports).set({ finishedAt: new Date(Date.now() - 40 * DAY) }).where(eq(imports.id, id));
    await h.db.transaction(async (tx) => {
      await sweepImportRows(tx, new Date(Date.now() - 30 * DAY));
    });
    expect(await h.db.select().from(importRows).where(eq(importRows.importId, id))).toHaveLength(0);
  });
});

describe("mapping changes during a dry run (review finding 3, rule 44)", () => {
  it("saving a mapping while the dry run still runs is refused with dry_run_in_progress", async () => {
    const id = await seedImport(h.db, { kind: "companies", csv: CSV(), mapping: mapping() });
    expect(await actions.startDryRun({ importId: id })).toMatchObject({ ok: true });
    const changed = { ...mapping(), columns: { name: "name", city: null } };
    expect(await actions.saveImportMapping({ importId: id, mapping: changed })).toMatchObject(conflict("dry_run_in_progress"));
    await drain(h.db);
    // Once the dry run finished, a change is accepted again and asks for a new dry run.
    expect(await actions.saveImportMapping({ importId: id, mapping: changed })).toMatchObject({ ok: true });
    expect(await actions.startImport({ importId: id })).toMatchObject(conflict("dry_run_first"));
  });

  it("the dry run records the hash of the mapping it parsed with, so a mid-run remap still needs a new dry run", async () => {
    const id = await seedImport(h.db, { kind: "companies", csv: CSV(), mapping: mapping() });
    expect(await actions.startDryRun({ importId: id })).toMatchObject({ ok: true });
    // A remap that bypasses the action (the guard above refuses it) while the chunks run.
    await h.db.update(imports).set({ mapping: { ...mapping(), columns: { name: "name", city: null } } }).where(eq(imports.id, id));
    await drain(h.db);
    const imp = await importOf(h.db, id);
    expect(imp.finishedAt).toBeInstanceOf(Date);
    expect(imp.report).not.toHaveProperty("dry_run_mapping_hash");
    expect(await actions.startImport({ importId: id })).toMatchObject(conflict("dry_run_first"));
  });
});

describe("webinar attendance targets (request ops-P4 -> ops)", () => {
  it("mode and watched_minutes are mapping targets of webinar_tool history imports only", async () => {
    const { allowedTargets } = await import("./jobs");
    const webinar = allowedTargets("history", "webinar_tool");
    expect(webinar).toEqual(expect.arrayContaining(["mode", "watched_minutes"]));
    expect(new Set(webinar).size).toBe(webinar.length);
    for (const source of ["spreadsheet", "lightspeed"] as const) {
      expect(allowedTargets("history", source)).not.toContain("watched_minutes");
      expect(allowedTargets("history", source)).not.toContain("mode");
    }
  });
});
