import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { cutoverChecklistItems } from "@beam/db/schema";
import { createTestDb, makeGrant, makePerson, makeProduct } from "@beam/db/testing";

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
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { reconcilePackages } = await import("./reconcile");
const { dryRun, identityMapping, importOf, realRun, seedImport, signInStaff } = await import("./ops-p4.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await makeProduct(h.db, { kind: "package", sku: "REC-DAY10", creditKind: "day", creditUnits: 10 });
  await makeProduct(h.db, { kind: "package", sku: "REC-NIGHT5", creditKind: "night", creditUnits: 5 });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const mapping = () => identityMapping(["external_id", "email", "product_sku", "units_remaining", "expires_on"]);
let n = 0;
async function packagesImport(lines: string[]) {
  const id = await seedImport(h.db, { kind: "packages", source: "simplybook", csv: `external_id,email,product_sku,units_remaining,expires_on\n${lines.join("\n")}\n`, mapping: mapping(), name: `Balances ${++n}` });
  await dryRun(h.db, id);
  await realRun(h.db, id);
  return id;
}

describe("reconciliation of opening balances (ops rule 48)", () => {
  it("R48 a matching file reconciles to zero difference per credit kind and product", async () => {
    const id = await packagesImport(["R-1,rec-a@example.com,REC-DAY10,4,2027-06-30", "R-2,rec-b@example.com,REC-DAY10,6,2027-06-30", "R-3,rec-a@example.com,REC-NIGHT5,2,2027-06-30"]);
    const rec = await reconcilePackages(h.db, id);
    expect(rec).toMatchObject({ kind: "packages", mode: "run", totals: { rows: 3, unitsInFile: 12, unitsGranted: 12, difference: 0 }, mismatches: [] });
    expect(rec.lines).toEqual([
      expect.objectContaining({ creditKind: "day", productSku: "REC-DAY10", rows: 2, unitsInFile: 10, unitsGranted: 10, difference: 0 }),
      expect.objectContaining({ creditKind: "night", productSku: "REC-NIGHT5", rows: 1, unitsInFile: 2, unitsGranted: 2, difference: 0 }),
    ]);
    expect((await importOf(h.db, id)).reconciliation).toMatchObject({ totals: { difference: 0 } });
  });

  it("R48 a grant that existed before the import shows as a mismatch of that row; the dry run already reports it", async () => {
    const p = await makePerson(h.db, { email: "rec-existing@example.com" });
    await makeGrant(h.db, { personId: p.id, creditKind: "day", units: 5 });
    const id = await seedImport(h.db, { kind: "packages", source: "simplybook", csv: "external_id,email,product_sku,units_remaining,expires_on\nR-9,rec-existing@example.com,REC-DAY10,3,2027-06-30\nR-10,rec-clean@example.com,REC-DAY10,2,2027-06-30\n", mapping: mapping() });
    await dryRun(h.db, id);
    expect((await importOf(h.db, id)).reconciliation).toMatchObject({ mode: "dry", mismatches: [{ row: 1, creditKind: "day", expected: 3, balance: 8 }] });
    await realRun(h.db, id);
    const rec = await reconcilePackages(h.db, id);
    expect(rec.totals).toMatchObject({ unitsInFile: 5, unitsGranted: 5, difference: 0 });
    expect(rec.mismatches).toEqual([{ row: 1, creditKind: "day", expected: 3, balance: 8 }]);
  });

  it("R48 sign-off needs settings.write and a note; it ticks packages_reconciled once", async () => {
    const id = await packagesImport(["R-20,rec-sign@example.com,REC-DAY10,1,2027-06-30"]);
    await signInStaff(h.db, jar, ["persons.write"], "reception");
    expect(await actions.signOffReconciliation({ importId: id, note: "Checked against SimplyBook" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const user = await signInStaff(h.db, jar, ["settings.write", "persons.write"]);
    expect(await actions.signOffReconciliation({ importId: id, note: "  " })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.signOffReconciliation({ importId: id, note: "Checked against SimplyBook" })).toMatchObject({ ok: true });
    const imp = await importOf(h.db, id);
    expect(imp).toMatchObject({ signedOffByUserId: user.id, reconciliation: { signOffNote: "Checked against SimplyBook" } });
    expect(imp.signedOffAt).toBeInstanceOf(Date);
    const [step] = await h.db.select().from(cutoverChecklistItems).where(eq(cutoverChecklistItems.key, "packages_reconciled"));
    expect(step?.doneAt).toBeInstanceOf(Date);
    expect(await actions.signOffReconciliation({ importId: id, note: "Again" })).toMatchObject({ ok: false, error: { code: "conflict", message: "already_signed_off" } });
  });
});
