/**
 * The conflict report (automation-P7, spec 4.2, A-15): per (blocked, blocking) pair it counts the
 * `skipped_exclusive` entries and the `superseded` exits the engine wrote, with sample persons;
 * staff moves are not conflicts; the window is 7 or 30 days; person names only when asked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { createTestDb, makePerson } from "@beam/db/testing";
import { resetRuntime } from "@/lib/testing";

const f = await import("./engine/automation-p3.fixtures");
const { enrol } = await import("./engine/enrol");
const { getConflictReport } = await import("./queries");

let h: DbHandle;
const DAY = 86_400_000;
const tx = () => h.db as unknown as Tx;

async function tryEnrol(automationId: string, personId: string, override = false) {
  return enrol(tx(), { automation: automationId, personId, source: override ? "staff" : "trigger", actor: f.SYSTEM, now: new Date(), ...(override ? { override: true } : {}) });
}

let win: { id: string; slug: string };
let lose: { id: string; slug: string };
let other: { id: string; slug: string };
let otherWin: { id: string; slug: string };
const sample: string[] = [];

beforeAll(async () => {
  h = await createTestDb();
  await f.makeTag(h.db, "engaged");
  const high = await f.makeGroup(h.db, { isExclusive: true, lane: "p7_lane", priority: 10 });
  const low = await f.makeGroup(h.db, { isExclusive: true, lane: "p7_lane", priority: 30 });
  win = await f.makeAutomation(h.db, { group: high, isMarketing: false, slug: "p7-win" });
  lose = await f.makeAutomation(h.db, { group: low, isMarketing: false, slug: "p7-lose" });
  const solo = await f.makeGroup(h.db, { isExclusive: true, priority: 50 });
  otherWin = await f.makeAutomation(h.db, { group: solo, isMarketing: false, slug: "p7-solo-a", priority: 10 });
  other = await f.makeAutomation(h.db, { group: solo, isMarketing: false, slug: "p7-solo-b", priority: 20 });

  // Person 1: in the losing journey, then superseded by the winner.
  const p1 = await makePerson(h.db, { firstName: "Ada", lastName: "Peeters" });
  expect(await tryEnrol(lose.id, p1.id)).toMatchObject({ status: "enrolled" });
  expect(await tryEnrol(win.id, p1.id)).toMatchObject({ status: "enrolled" });
  // Persons 2 and 3: in the winner; the losing journey is refused (skipped_exclusive).
  for (const name of ["Bram", "Chloe"]) {
    const p = await makePerson(h.db, { firstName: name, lastName: "Janssens" });
    sample.push(p.id);
    expect(await tryEnrol(win.id, p.id)).toMatchObject({ status: "enrolled" });
    expect(await tryEnrol(lose.id, p.id)).toMatchObject({ status: "skipped", outcome: "skipped_exclusive" });
  }
  sample.push(p1.id);
  // A staff enrolment moves the holder out (`moved`): not a conflict.
  const p4 = await makePerson(h.db);
  expect(await tryEnrol(win.id, p4.id)).toMatchObject({ status: "enrolled" });
  expect(await tryEnrol(lose.id, p4.id, true)).toMatchObject({ status: "enrolled" });
  // Another domain: one refusal.
  const p5 = await makePerson(h.db);
  expect(await tryEnrol(otherWin.id, p5.id)).toMatchObject({ status: "enrolled" });
  expect(await tryEnrol(other.id, p5.id)).toMatchObject({ status: "skipped", outcome: "skipped_exclusive" });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

describe("getConflictReport", () => {
  it("counts skipped_exclusive and superseded per (blocked, blocking) pair, most conflicts first", async () => {
    const r = await getConflictReport(h.db, { days: 7, includePersons: true });
    expect(r.days).toBe(7);
    expect(r.pairs.map((p) => [p.blocked.slug, p.blocking.slug, p.skippedExclusive, p.superseded, p.total])).toEqual([
      ["p7-lose", "p7-win", 2, 1, 3],
      ["p7-solo-b", "p7-solo-a", 1, 0, 1],
    ]);
    expect(r.totals).toEqual({ skippedExclusive: 3, superseded: 1 });
    const first = r.pairs[0]!;
    expect(first.blocked).toMatchObject({ id: lose.id, groupKey: expect.any(String) });
    expect(first.blocking.id).toBe(win.id);
    expect(first.lastAt).toBeInstanceOf(Date);
  });

  it("lists up to five sample persons, newest first, with their names", async () => {
    const r = await getConflictReport(h.db, { days: 7, includePersons: true });
    const persons = r.pairs[0]!.samplePersons;
    expect(persons.map((p) => p.id).sort()).toEqual([...sample].sort());
    expect(persons.map((p) => p.name)).toContain("Ada Peeters");
    expect(persons.length).toBeLessThanOrEqual(5);
  });

  it("without person access the samples are empty", async () => {
    const r = await getConflictReport(h.db, { days: 7 });
    expect(r.pairs.every((p) => p.samplePersons.length === 0)).toBe(true);
    expect(r.pairs[0]!.total).toBe(3);
  });

  it("the window is 7 or 30 days", async () => {
    const later = new Date(Date.now() + 10 * DAY);
    expect((await getConflictReport(h.db, { days: 7 }, later)).pairs).toEqual([]);
    expect((await getConflictReport(h.db, { days: 30 }, later)).pairs).toHaveLength(2);
    const empty = await getConflictReport(h.db, { days: 30 }, new Date(Date.now() + 40 * DAY));
    expect(empty).toMatchObject({ pairs: [], totals: { skippedExclusive: 0, superseded: 0 } });
  });
});
