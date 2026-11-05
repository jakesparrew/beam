import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { sessionExceptions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { resetRuntime } from "@/lib/testing";
import { listClosedDays } from "../api";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.delete(sessionExceptions);
});

const name = { "nl-BE": "Gesloten", "fr-BE": "Fermé", en: "Closed" };

describe("listClosedDays (ops-P3 request)", () => {
  it("lists closed and holiday dates for every template inside the range, once each and sorted", async () => {
    await h.db.insert(sessionExceptions).values([
      { onDate: "2027-05-10", kind: "holiday", name },
      { onDate: "2027-05-03", kind: "closed", name },
      { onDate: "2027-05-03", kind: "holiday", name, templateIds: [] },
      // one template only: the centre stays open
      { onDate: "2027-05-05", kind: "closed", name, templateIds: [randomUUID()] },
      // special hours are open hours
      { onDate: "2027-05-06", kind: "special_hours", name, opensAt: "10:00", closesAt: "14:00" },
      // outside the range
      { onDate: "2027-04-30", kind: "closed", name },
      { onDate: "2027-05-12", kind: "closed", name },
    ]);
    expect(await listClosedDays(h.db, "2027-05-01", "2027-05-11")).toEqual(["2027-05-03", "2027-05-10"]);
    expect(await listClosedDays(h.db, "2027-05-12", "2027-05-12")).toEqual(["2027-05-12"]);
    expect(await listClosedDays(h.db, "2027-05-11", "2027-05-01")).toEqual([]);
  });
});
