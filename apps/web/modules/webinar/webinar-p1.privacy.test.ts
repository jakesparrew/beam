/**
 * webinar-P1: the privacy registration of the R2 tables (OD-9) and the retention sweeps of the
 * keys ops seeds (section 9.2, ops-P6 request). webinar-P6 completes `privacy.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { persons, watchSegments, webinarInteractions, webinarModerationActions, webinarPresenters, webinarRegistrations } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { OPS_RETENTION_POLICIES } from "@beam/db/seed/ops";
import { eq, inArray, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { GDPR_REGISTRY, NO_PII_TABLES } from "@/registry/privacy.generated";
import { noPiiTables, privacy, sweep, SWEEP_BATCH } from "./privacy";
import { makeCta, makePoll, makeRegistration, makeSegments, makeWebinar } from "./test/factories";

let h: DbHandle;
let staffId: string;
beforeAll(async () => {
  h = await createTestDb();
  staffId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(() => h.close());

const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
const inTx = <T>(fn: (tx: Tx) => Promise<T>) => h.db.transaction((tx) => fn(tx));
const count = async (table: "watch_segments" | "webinar_interactions" | "webinar_registrations" | "webinar_moderation_actions", ids: string[]) =>
  ids.length
    ? rowsOf<{ n: number }>(
        await h.db.execute(
          sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(table === "webinar_registrations" ? "id" : "registration_id")} in ${ids}`,
        ),
      )[0]!.n
    : 0;

describe("registration (OD-9)", () => {
  it("is collected under the module id with the five person tables", () => {
    expect(GDPR_REGISTRY.webinar).toBe(privacy);
    expect([...privacy.tables].sort()).toEqual(["watch_segments", "webinar_interactions", "webinar_moderation_actions", "webinar_presenters", "webinar_registrations"]);
    for (const t of noPiiTables) expect(NO_PII_TABLES).toContain(t);
  });

  it("every sweep key starts with webinar. and matches a retention row ops seeds", () => {
    const keys = Object.keys(sweep);
    expect(keys.every((k) => k.startsWith("webinar."))).toBe(true);
    const seeded = OPS_RETENTION_POLICIES.filter((p) => p.key.startsWith("webinar.")).map((p) => p.key);
    expect(seeded.length).toBeGreaterThan(0);
    for (const key of seeded) expect(keys, key).toContain(key);
    expect(privacy.sweep).toBe(sweep);
  });
});

describe("export and erase", () => {
  it("export lists the subject's and merged persons' rows; erase removes every row and reports counts; a second erase is a no-op", async () => {
    const subject = await makePerson(h.db);
    const merged = await makePerson(h.db);
    const w1 = await makeWebinar(h.db);
    const w2 = await makeWebinar(h.db);
    const r1 = await makeRegistration(h.db, { webinarId: w1.id, personId: subject.id });
    const r2 = await makeRegistration(h.db, { webinarId: w2.id, personId: merged.id, locale: "fr-BE" });
    await makeSegments(h.db, r1, "live", [
      [0, 15],
      [15, 30],
    ]);
    await makeSegments(h.db, r2, "replay", [[0, 20]]);
    const poll = await makePoll(h.db, { webinarId: w1.id });
    const cta = await makeCta(h.db, { webinarId: w1.id });
    const [chat] = await h.db
      .insert(webinarInteractions)
      .values([
        { registrationId: r1.id, webinarId: w1.id, mode: "live", kind: "poll_answer", pollId: poll.id, payload: { option_keys: ["yes"] } },
        { registrationId: r1.id, webinarId: w1.id, mode: "live", kind: "cta_clicked", ctaId: cta.id, payload: { url: cta.url } },
        { registrationId: r2.id, webinarId: w2.id, mode: "replay", kind: "question", payload: { text: "Une question" } },
      ])
      .returning();
    await h.db.insert(webinarModerationActions).values({ webinarId: w1.id, registrationId: r1.id, action: "mute_viewer", byUserId: staffId });
    await h.db.insert(webinarPresenters).values({ webinarId: w2.id, personId: subject.id, displayName: "Gast" });
    await h.db.update(persons).set({ mergedIntoPersonId: subject.id }).where(eq(persons.id, merged.id));
    expect(chat).toBeDefined();

    const exported = await inTx((tx) => privacy.export(tx, subject.id));
    const regs = exported["webinar/registrations.json"] as Array<Record<string, unknown>>;
    expect(regs).toHaveLength(2);
    expect(regs.map((r) => r.webinar_title).sort()).toEqual(["Beter slapen", "Mieux dormir"]);
    const watch = exported["webinar/watch.json"] as Array<Record<string, unknown>>;
    expect(watch.map((x) => [x.mode, x.watched_sec]).sort()).toEqual([
      ["live", 30],
      ["replay", 20],
    ]);
    expect(exported["webinar/watch_segments.json"]).toHaveLength(3);
    const interactions = exported["webinar/interactions.json"] as Array<Record<string, unknown>>;
    expect(interactions.find((i) => i.kind === "poll_answer")).toMatchObject({ poll_question: "Slaap je goed?", poll_answer: ["Ja"], mode: "live" });
    expect(interactions.find((i) => i.kind === "cta_clicked")).toMatchObject({ cta_label: "Boek een sessie" });
    expect(interactions.find((i) => i.kind === "question")).toMatchObject({ text: "Une question", mode: "replay" });
    expect(exported["webinar/moderation.json"]).toEqual([expect.objectContaining({ action: "mute_viewer" })]);
    expect(JSON.stringify(exported["webinar/moderation.json"])).not.toContain(staffId);
    expect(exported["webinar/presenters.json"]).toEqual([expect.objectContaining({ display_name: "Gast", role: "presenter" })]);

    const report = await inTx((tx) => privacy.erase(tx, subject.id));
    expect(Object.fromEntries(report.map((r) => [r.table, [r.rows, r.action]]))).toEqual({
      webinar_registrations: [2, "deleted"],
      watch_segments: [3, "deleted"],
      webinar_interactions: [3, "deleted"],
      webinar_moderation_actions: [1, "deleted"],
      webinar_presenters: [1, "deleted"],
    });
    const regIds = [r1.id, r2.id];
    expect(await count("webinar_registrations", regIds)).toBe(0);
    expect(await count("watch_segments", regIds)).toBe(0);
    expect(await count("webinar_interactions", regIds)).toBe(0);
    expect(await count("webinar_moderation_actions", regIds)).toBe(0);
    expect(await h.db.select().from(webinarPresenters).where(inArray(webinarPresenters.personId, [subject.id, merged.id]))).toEqual([]);

    const again = await inTx((tx) => privacy.erase(tx, subject.id));
    expect(again.every((r) => r.rows === 0)).toBe(true);
  });
});

describe("retention sweeps (section 9.2)", () => {
  it("watch_segments and webinar_interactions: delete only rows older than the cutoff, through the append-only trigger", async () => {
    const w = await makeWebinar(h.db);
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await makeSegments(h.db, r, "live", [[0, 15]], { recordedAt: daysAgo(800) });
    await makeSegments(h.db, r, "live", [[15, 30]], { recordedAt: daysAgo(10) });
    await h.db.insert(webinarInteractions).values([
      { registrationId: r.id, webinarId: w.id, mode: "live", kind: "chat", payload: { text: "oud" }, occurredAt: daysAgo(800) },
      { registrationId: r.id, webinarId: w.id, mode: "live", kind: "chat", payload: { text: "nieuw" }, occurredAt: daysAgo(10) },
    ]);
    const cutoff = daysAgo(730);

    const segs = await inTx((tx) => sweep["webinar.watch_segments"]!(tx, cutoff));
    expect(segs).toBeGreaterThanOrEqual(1);
    expect(typeof segs).toBe("number");
    const left = await h.db.select().from(watchSegments).where(eq(watchSegments.registrationId, r.id));
    expect(left.map((s) => s.fromSec)).toEqual([15]);
    expect(await inTx((tx) => sweep["webinar.watch_segments"]!(tx, cutoff))).toBe(0);

    expect(await inTx((tx) => sweep["webinar.webinar_interactions"]!(tx, cutoff))).toBeGreaterThanOrEqual(1);
    const msgs = await h.db.select().from(webinarInteractions).where(eq(webinarInteractions.registrationId, r.id));
    expect(msgs.map((m) => m.payload.text)).toEqual(["nieuw"]);
    expect(await inTx((tx) => sweep["webinar.webinar_interactions"]!(tx, cutoff))).toBe(0);
  });

  it("webinar_registrations: only old registrations of webinars that ended before the cutoff; cascades", async () => {
    const cutoff = daysAgo(1095);
    const ended = await makeWebinar(h.db, { startsAt: daysAgo(1200), status: "ended", liveStartedAt: daysAgo(1200), liveEndedAt: daysAgo(1199) }, { published: true });
    const recent = await makeWebinar(h.db, { startsAt: daysAgo(1100), status: "ended", liveStartedAt: daysAgo(1100), liveEndedAt: daysAgo(1090) }, { published: true });
    const oldReg = await makeRegistration(h.db, { webinarId: ended.id, createdAt: daysAgo(1210) });
    const keptReg = await makeRegistration(h.db, { webinarId: recent.id, createdAt: daysAgo(1100) });
    await makeSegments(h.db, oldReg, "live", [[0, 15]], { recordedAt: daysAgo(1200) });

    const n = await inTx((tx) => sweep["webinar.webinar_registrations"]!(tx, cutoff));
    expect(n).toBeGreaterThanOrEqual(1);
    const ids = (await h.db.select({ id: webinarRegistrations.id }).from(webinarRegistrations).where(inArray(webinarRegistrations.id, [oldReg.id, keptReg.id]))).map((x) => x.id);
    expect(ids).toEqual([keptReg.id]);
    expect(await count("watch_segments", [oldReg.id])).toBe(0);
    expect(await inTx((tx) => sweep["webinar.webinar_registrations"]!(tx, cutoff))).toBe(0);
  });

  it("deletes at most one batch per call", () => {
    expect(SWEEP_BATCH).toBe(5000);
  });
});
