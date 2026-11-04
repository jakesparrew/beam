import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { importExternalIds, persons } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { matchPerson } from "./match";
import { dryRun, identityMapping, rowsOf, seedImport, staffUser } from "./ops-p4.fixtures";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const persRow = (data: Record<string, string | null>, source: "spreadsheet" | "simplybook" = "spreadsheet") => ({ source, kind: "persons" as const, data });

describe("matchPerson (ops rule 45)", () => {
  it("R45 matches by lower(trim(email)) whatever the case and whitespace", async () => {
    const p = await makePerson(h.db, { email: "ann.peeters@example.com" });
    expect(await matchPerson(h.db as never, persRow({ email: "  Ann.Peeters@EXAMPLE.com " }))).toEqual({ personId: p.id, how: "email" });
    expect(await matchPerson(h.db as never, persRow({ email: "other@example.com" }))).toEqual({ personId: null, how: "none" });
  });

  it("R45 without email: E.164 phone plus lower(last_name); a phone alone never matches", async () => {
    const p = await makePerson(h.db, { email: null, emailHash: null, phone: "0470 12 34 56", phoneE164: "+32470123456", lastName: "Janssens" });
    expect(await matchPerson(h.db as never, persRow({ phone: "+32 470 12 34 56", last_name: "JANSSENS" }))).toEqual({ personId: p.id, how: "phone_name" });
    expect(await matchPerson(h.db as never, persRow({ phone: "+32 470 12 34 56", last_name: "Other" }))).toEqual({ personId: null, how: "none" });
    expect(await matchPerson(h.db as never, persRow({ phone: "+32 470 12 34 56" }))).toEqual({ personId: null, how: "none" });
  });

  it("R45 an import_external_ids row of the same source matches first, before the email", async () => {
    const byId = await makePerson(h.db);
    const byEmail = await makePerson(h.db, { email: "first-ext@example.com" });
    const importId = await seedImport(h.db, { kind: "persons", source: "simplybook", csv: "email\n", mapping: identityMapping(["email"]) });
    await h.db.insert(importExternalIds).values({ source: "simplybook", entityType: "person", externalId: "SB-1", entityId: byId.id, importId });
    expect(await matchPerson(h.db as never, persRow({ external_id: "SB-1", email: "first-ext@example.com" }, "simplybook"))).toEqual({ personId: byId.id, how: "external_id" });
    // Another source's id does not match; the email does.
    expect(await matchPerson(h.db as never, persRow({ external_id: "SB-1", email: "first-ext@example.com" }))).toEqual({ personId: byEmail.id, how: "email" });
  });

  it("R45 erased persons never match; a merged person resolves to its winner", async () => {
    await makePerson(h.db, { email: "gone@example.com", erasedAt: new Date() });
    expect((await matchPerson(h.db as never, persRow({ email: "gone@example.com" }))).personId).toBeNull();
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    await h.db.update(persons).set({ mergedIntoPersonId: winner.id }).where(eq(persons.id, loser.id));
    const importId = await seedImport(h.db, { kind: "persons", source: "lightspeed", csv: "email\n", mapping: identityMapping(["email"]) });
    await h.db.insert(importExternalIds).values({ source: "lightspeed", entityType: "person", externalId: "LS-9", entityId: loser.id, importId });
    expect(await matchPerson(h.db as never, { source: "lightspeed", kind: "persons", data: { external_id: "LS-9" } })).toEqual({ personId: winner.id, how: "external_id" });
  });

  it("R45 a second row with the same email in the file is merged into the first (updated, duplicate_in_file)", async () => {
    const userId = await staffUser(h.db);
    const csv = "email,first_name\nnew-dup@example.com,Ann\n NEW-DUP@example.com ,Anna\nsolo@example.com,Bo\n";
    const importId = await seedImport(h.db, { kind: "persons", csv, mapping: identityMapping(["email", "first_name"]), userId });
    await dryRun(h.db, importId);
    const rows = await rowsOf(h.db, importId);
    expect(rows.map((r) => [r.rowNumber, r.dryRunStatus, r.message])).toEqual([
      [1, "imported", "new"],
      [2, "updated", "duplicate_in_file"],
      [3, "imported", "new"],
    ]);
  });
});
