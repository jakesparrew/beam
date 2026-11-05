/**
 * The person merge (webinar-P3; edge case 19, cross-module decision 19): `mergePersons` repoints
 * a lone loser registration (`moved`) and leaves a double one on the loser with its append-only
 * segments and interactions (`collapsed`), never updating or deleting an append-only row and
 * never setting `beam.allow_rewrite`. After crm sets `merged_into_person_id`, the views report one
 * person: watch intervals merged across both registrations per mode, a duplicate poll answer in
 * one mode counted once (the earliest), and `listPersonWebinars` shows one row per webinar.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { persons, vPersonWebinarStats, vWebinarWatch, watchSegments, webinarInteractions, webinarRegistrations } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { asc, eq, inArray, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { listPersonWebinars, mergePersons } from "./api";
import { makePoll, makeRegistration, makeSegments, makeWebinar } from "./test/factories";

let h: DbHandle;
let ownerId: string;
beforeAll(async () => {
  h = await createTestDb();
  ownerId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(() => h.close());

const allowRewrite = async (tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }) =>
  rowsOf<{ v: string }>(await tx.execute(sql`select coalesce(current_setting('beam.allow_rewrite', true), '') as v`))[0]!.v;

describe("mergePersons (edge case 19)", () => {
  it("moves a lone loser registration, keeps a double one on the loser and touches no append-only row", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    const both = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const loserOnly = await makeWebinar(h.db, { ownerUserId: ownerId }, { published: true });
    const poll = await makePoll(h.db, { webinarId: both.id });

    const rw = await makeRegistration(h.db, { webinarId: both.id, personId: winner.id });
    const rl = await makeRegistration(h.db, { webinarId: both.id, personId: loser.id });
    const rlOnly = await makeRegistration(h.db, { webinarId: loserOnly.id, personId: loser.id });
    await makeSegments(h.db, rw, "live", [
      [0, 30],
      [30, 60],
    ]);
    await makeSegments(h.db, rl, "live", [[45, 75]]);
    await makeSegments(h.db, rl, "replay", [[0, 20]]);
    const t0 = new Date(Date.now() - 3600_000);
    const answer = (registrationId: string, mode: "live" | "replay", keys: string[], at: Date) =>
      h.db.insert(webinarInteractions).values({ registrationId, webinarId: both.id, mode, kind: "poll_answer", pollId: poll.id, payload: { option_keys: keys }, occurredAt: at });
    await answer(rw.id, "live", ["yes"], t0);
    await answer(rl.id, "live", ["no"], new Date(t0.getTime() + 60_000));
    await answer(rl.id, "replay", ["yes"], new Date(t0.getTime() + 120_000));

    const regIds = [rw.id, rl.id, rlOnly.id];
    const snapshot = async () => ({
      segments: await h.db.select().from(watchSegments).where(inArray(watchSegments.registrationId, regIds)).orderBy(asc(watchSegments.id)),
      interactions: await h.db.select().from(webinarInteractions).where(inArray(webinarInteractions.registrationId, regIds)).orderBy(asc(webinarInteractions.id)),
    });
    const before = await snapshot();

    const result = await h.db.transaction(async (tx) => {
      const out = await mergePersons(tx, winner.id, loser.id);
      expect(await allowRewrite(tx)).not.toBe("on");
      // crm's merge then marks the loser.
      await tx.update(persons).set({ mergedIntoPersonId: winner.id }).where(eq(persons.id, loser.id));
      return out;
    });
    expect(result).toEqual({ moved: 1, collapsed: 1 });

    const owners = Object.fromEntries(
      (await h.db.select({ id: webinarRegistrations.id, personId: webinarRegistrations.personId }).from(webinarRegistrations).where(inArray(webinarRegistrations.id, regIds))).map((r) => [r.id, r.personId]),
    );
    expect(owners).toEqual({ [rw.id]: winner.id, [rl.id]: loser.id, [rlOnly.id]: winner.id });
    expect(await snapshot()).toEqual(before);

    // One person in the views: live intervals merged across both registrations (0-75 s), replay apart.
    const watch = await h.db.select().from(vWebinarWatch).where(eq(vWebinarWatch.personId, winner.id));
    expect(watch.map((w) => [w.webinarId, w.mode, w.watchedSec, w.registrationId]).sort()).toEqual(
      [
        [both.id, "live", 75, rw.id],
        [both.id, "replay", 20, rw.id],
      ].sort(),
    );
    expect(await h.db.select().from(vWebinarWatch).where(eq(vWebinarWatch.personId, loser.id))).toEqual([]);

    const [stats] = await h.db.select().from(vPersonWebinarStats).where(eq(vPersonWebinarStats.personId, winner.id));
    expect(stats).toMatchObject({ webinarsRegistered: 2, watchSecTotal: 95, pollAnswers: 2 });
    expect(await h.db.select().from(vPersonWebinarStats).where(eq(vPersonWebinarStats.personId, loser.id))).toEqual([]);

    const rows = await listPersonWebinars(h.db, winner.id);
    expect(rows.map((r) => r.webinarId).sort()).toEqual([both.id, loserOnly.id].sort());
    expect(rows.find((r) => r.webinarId === both.id)).toMatchObject({ registrationId: rw.id, watchedSec: { live: 75, replay: 20, on_demand: 0 } });
  });

  it("is a no-op for the same id and for persons without registrations", async () => {
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    expect(await h.db.transaction((tx) => mergePersons(tx, a.id, a.id))).toEqual({ moved: 0, collapsed: 0 });
    expect(await h.db.transaction((tx) => mergePersons(tx, a.id, b.id))).toEqual({ moved: 0, collapsed: 0 });
  });
});
