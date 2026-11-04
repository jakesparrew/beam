/**
 * webinar-P1: `mergePersons`, crm's merge hook (edge case 19). A lone loser registration moves to
 * the winner; a double one stays on the loser with its append-only rows; presenter rows are
 * settled so crm's generic repoint never meets the presenter identity index.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { persons, vWebinarWatch, watchSegments, webinarPresenters, webinarRegistrations } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { eq, inArray, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { mergePersons } from "./api";
import { makeRegistration, makeSegments, makeWebinar } from "./test/factories";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
}, 120_000);
afterAll(() => h.close());

describe("mergePersons (edge case 19)", () => {
  it("repoints a lone loser registration and keeps a double one on the loser", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    const both = await makeWebinar(h.db);
    const loserOnly = await makeWebinar(h.db);
    const rw = await makeRegistration(h.db, { webinarId: both.id, personId: winner.id });
    const rlBoth = await makeRegistration(h.db, { webinarId: both.id, personId: loser.id });
    const rlOnly = await makeRegistration(h.db, { webinarId: loserOnly.id, personId: loser.id });
    await makeSegments(h.db, rw, "live", [[0, 30]]);
    await makeSegments(h.db, rlBoth, "live", [[20, 50]]);
    await makeSegments(h.db, rlOnly, "replay", [[0, 10]]);
    const segmentsBefore = await h.db.select().from(watchSegments).where(inArray(watchSegments.registrationId, [rw.id, rlBoth.id, rlOnly.id]));

    const result = await h.db.transaction(async (tx) => {
      const out = await mergePersons(tx, winner.id, loser.id);
      const [setting] = rowsOf<{ v: string }>(await tx.execute(sql`select coalesce(current_setting('beam.allow_rewrite', true), '') as v`));
      expect(setting!.v).not.toBe("on");
      await tx.update(persons).set({ mergedIntoPersonId: winner.id }).where(eq(persons.id, loser.id));
      return out;
    });
    expect(result).toEqual({ moved: 1, collapsed: 1 });

    const regs = await h.db.select().from(webinarRegistrations).where(inArray(webinarRegistrations.id, [rw.id, rlBoth.id, rlOnly.id]));
    const owner = Object.fromEntries(regs.map((r) => [r.id, r.personId]));
    expect(owner).toEqual({ [rw.id]: winner.id, [rlBoth.id]: loser.id, [rlOnly.id]: winner.id });
    const segmentsAfter = await h.db.select().from(watchSegments).where(inArray(watchSegments.registrationId, [rw.id, rlBoth.id, rlOnly.id]));
    expect(segmentsAfter).toEqual(segmentsBefore);

    const watch = await h.db.select().from(vWebinarWatch).where(eq(vWebinarWatch.personId, winner.id));
    expect(watch.map((w) => [w.webinarId, w.mode, w.watchedSec, w.registrationId]).sort()).toEqual(
      [
        [both.id, "live", 50, rw.id],
        [loserOnly.id, "replay", 10, rlOnly.id],
      ].sort(),
    );
  });

  it("moves the loser's presenter rows, dropping one the winner already holds", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    const w1 = await makeWebinar(h.db);
    const w2 = await makeWebinar(h.db);
    await h.db.insert(webinarPresenters).values([
      { webinarId: w1.id, personId: winner.id, displayName: "Winnaar" },
      { webinarId: w1.id, personId: loser.id, displayName: "Verliezer" },
      { webinarId: w2.id, personId: loser.id, displayName: "Verliezer" },
    ]);
    await h.db.transaction((tx) => mergePersons(tx, winner.id, loser.id));
    const rows = await h.db.select().from(webinarPresenters).where(inArray(webinarPresenters.webinarId, [w1.id, w2.id]));
    expect(rows.map((r) => [r.webinarId, r.personId, r.displayName]).sort()).toEqual(
      [
        [w1.id, winner.id, "Winnaar"],
        [w2.id, winner.id, "Verliezer"],
      ].sort(),
    );
  });

  it("is a no-op without webinar rows and for the same id", async () => {
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    expect(await h.db.transaction((tx) => mergePersons(tx, a.id, b.id))).toEqual({ moved: 0, collapsed: 0 });
    expect(await h.db.transaction((tx) => mergePersons(tx, a.id, a.id))).toEqual({ moved: 0, collapsed: 0 });
  });
});
