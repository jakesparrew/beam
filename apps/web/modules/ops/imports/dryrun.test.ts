import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { tags } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import type { ImportKind, ImportMapping } from "@beam/core/ops";

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
const { setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { baseOptions, drain, dryRun, identityMapping, importOf, rowsOf, seedImport, signInStaff, tableCounts } = await import("./ops-p4.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await makeProduct(h.db, { kind: "package", sku: "DRY-PKG", creditKind: "day", creditUnits: 5 });
  await h.db.insert(tags).values({ key: "dry_tag", name: { "nl-BE": "Dry", "fr-BE": "Dry", en: "Dry" } });
  await makePerson(h.db, { email: "known-dry@example.com" });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** Every table an import may write outside `imports` and `import_rows`. */
const WATCHED = [
  "persons",
  "consent_records",
  "suppressions",
  "person_tags",
  "companies",
  "company_contacts",
  "credit_grants",
  "credit_entries",
  "memberships",
  "bookings",
  "imported_history",
  "import_external_ids",
  "activity_events",
  "audit_log",
  "cutover_checklist_items",
];

const FILES: { kind: ImportKind; csv: string; mapping: ImportMapping }[] = [
  { kind: "persons", csv: "external_id,email,first_name\nP-1,new-dry@example.com,Ann\nP-2,known-dry@example.com,Bo\nP-3,bad-address,Cy\n", mapping: identityMapping(["external_id", "email", "first_name"]) },
  { kind: "suppressions", csv: "email,scope\nsupp-dry@example.com,all\n", mapping: identityMapping(["email", "scope"]) },
  { kind: "consents", csv: "email,status\nconsent-dry@example.com,granted\n", mapping: identityMapping(["email", "status"], { consentPurpose: "newsletter" }) },
  { kind: "tags", csv: "email,tag_key\nknown-dry@example.com,dry_tag\n", mapping: identityMapping(["email", "tag_key"]) },
  { kind: "companies", csv: "name,contact_email\nDry Run BV,contact-dry@example.com\n", mapping: identityMapping(["name", "contact_email"]) },
  { kind: "packages", csv: "external_id,email,product_sku,units_remaining,expires_on\nG-1,known-dry@example.com,DRY-PKG,3,2027-01-31\nG-2,pkg-dry@example.com,NOPE,1,2027-01-31\n", mapping: identityMapping(["external_id", "email", "product_sku", "units_remaining", "expires_on"]) },
  { kind: "history", csv: "external_id,email,history_kind,occurred_at\nH-1,known-dry@example.com,visit,2025-05-01T10:00:00Z\n", mapping: identityMapping(["external_id", "email", "history_kind", "occurred_at"]) },
];

describe("dry runs (ops rule 44)", () => {
  it("R44 a dry run of every kind changes nothing outside imports and import_rows", async () => {
    for (const f of FILES) {
      const id = await seedImport(h.db, { kind: f.kind, source: "simplybook", csv: f.csv, mapping: f.mapping });
      const before = await tableCounts(h.db, WATCHED);
      await dryRun(h.db, id);
      expect({ kind: f.kind, counts: await tableCounts(h.db, WATCHED) }).toEqual({ kind: f.kind, counts: before });
      const rows = await rowsOf(h.db, id);
      expect(rows.every((r) => r.dryRunStatus !== null && r.status === "pending")).toBe(true);
      expect((await importOf(h.db, id)).status).toBe("dry_run");
    }
  });

  it("R44 the dry-run report lists outcomes, new versus matched persons, invalid emails and unknown products", async () => {
    const persons = await seedImport(h.db, { kind: "persons", csv: FILES[0]!.csv, mapping: FILES[0]!.mapping });
    await dryRun(h.db, persons);
    expect((await importOf(h.db, persons)).report).toMatchObject({ dry_run: { new_persons: 1, matched_persons: 1, invalid_emails: [3], rows: { imported: 1, updated: 1, error: 1 } } });
    const packages = await seedImport(h.db, { kind: "packages", csv: FILES[5]!.csv, mapping: FILES[5]!.mapping });
    await dryRun(h.db, packages);
    const imp = await importOf(h.db, packages);
    expect(imp.report).toMatchObject({ dry_run: { unknown_products: [2] } });
    expect(imp.reconciliation).toMatchObject({ kind: "packages", mode: "dry", totals: { rows: 2, unitsInFile: 4, unitsGranted: 3, difference: 1 } });
  });

  it("R44 a real run is refused without a dry run of the same mapping hash", async () => {
    await signInStaff(h.db, jar, ["persons.write", "settings.write"]);
    const id = await seedImport(h.db, { kind: "companies", csv: "name\nHash Check BV\n", mapping: identityMapping(["name"]) });
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: false, error: { code: "conflict", message: "dry_run_first" } });
    expect(await actions.startDryRun({ importId: id })).toMatchObject({ ok: true });
    await drain(h.db);
    const other: ImportMapping = { columns: { name: "name" }, options: baseOptions({ overwrite: true }) };
    expect(await actions.saveImportMapping({ importId: id, mapping: other })).toMatchObject({ ok: true });
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: false, error: { code: "conflict", message: "dry_run_first" } });
    expect(await actions.saveImportMapping({ importId: id, mapping: identityMapping(["name"]) })).toMatchObject({ ok: true });
    expect(await actions.startImport({ importId: id })).toMatchObject({ ok: true });
    await drain(h.db);
    expect((await importOf(h.db, id)).status).toBe("done");
  });
});
