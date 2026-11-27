/** `/admin/waitlist` search (owner review November 2026, list toolbar): name, email or session title, case-insensitive, `%` literal. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession } from "@beam/db/testing";

const { listWaitlistRows } = await import("./waitlist");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("listWaitlistRows q", () => {
  it("matches the person's name or email and the session title, and nothing else", async () => {
    const session = await makeSession(h.db, { title: { "nl-BE": "Ochtendsauna", en: "Morning sauna" } });
    const other = await makeSession(h.db, { title: { "nl-BE": "Avondyoga" } });
    const ann = await makePerson(h.db, { firstName: "Annelies", lastName: "Peeters", email: "annelies@example.com" });
    const bob = await makePerson(h.db, { firstName: "Bob", lastName: "Maes" });
    await h.db.insert(waitlistEntries).values([
      { sessionId: session.id, personId: ann.id },
      { sessionId: other.id, personId: bob.id },
    ]);
    const ids = async (q: string) => (await listWaitlistRows(h.db, { q })).rows.map((r) => r.personId).sort();
    expect(await ids("annelies peeters")).toEqual([ann.id]);
    expect(await ids("ANNELIES@")).toEqual([ann.id]);
    expect(await ids("morning")).toEqual([ann.id]);
    expect(await ids("avondyoga")).toEqual([bob.id]);
    expect(await ids("100%")).toEqual([]);
  });
});
