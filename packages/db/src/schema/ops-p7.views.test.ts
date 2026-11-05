/**
 * ops-P7 (ops spec 2.4, rule 70, cross-module decision 58): the R2 webinar columns of
 * `v_person_profile`. They come from webinar's `v_person_webinar_stats` (native counts exclude
 * imported history), the two totals add the imported counts, and `watch_sec_total` is null
 * until the `watch_time_profiling` DPIA is approved or not required.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERSON_PROFILE_COLUMNS } from "@beam/core/ops";
import type { DbHandle } from "../client";
import { createTestDb, makePerson, makeUser } from "../testing";
import { dpiaRecords, importedHistory, imports } from "./ops";
import { vPersonProfile } from "./ops.views";
import { files } from "./platform";
import { watchSegments, webinarRegistrations, webinars } from "./webinar";

const title = { "nl-BE": "Slaap beter", "fr-BE": "Mieux dormir", en: "Sleep better" };
const T0 = new Date("2026-10-20T19:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
let seq = 0;
const next = () => ++seq;

let h: DbHandle;
let userId: string;
let importId: string;

beforeAll(async () => {
  h = await createTestDb();
  userId = (await makeUser(h.db)).id;
  const [file] = await h.db
    .insert(files)
    .values({ kind: "import", name: "webinars.csv", mime: "text/csv", sizeBytes: 1, bytes: Buffer.from("a"), sha256: "1".repeat(64) })
    .returning();
  const [imp] = await h.db.insert(imports).values({ kind: "history", source: "webinar_tool", name: "Old webinar tool", fileId: file!.id, createdByUserId: userId }).returning();
  importId = imp!.id;
}, 120_000);
afterAll(() => h.close());

async function webinar() {
  const [row] = await h.db
    .insert(webinars)
    .values({ slug: `ops-p7-webinar-${next()}`, title, mode: "live", startsAt: T0, attendedMinSec: 60, ownerUserId: userId, createdByUserId: userId })
    .returning();
  return row!;
}
async function registration(webinarId: string, personId: string) {
  const [row] = await h.db
    .insert(webinarRegistrations)
    .values({ webinarId, personId, accessTokenHash: `ops-p7-hash-${next()}`, registeredMode: "live", source: "site", locale: "nl-BE", personStatus: "lead", createdAt: at(-60) })
    .returning();
  return row!;
}
async function imported(personId: string, kind: "webinar_registration" | "webinar_attendance") {
  await h.db.insert(importedHistory).values({ personId, importId, source: "webinar_tool", kind, occurredAt: new Date("2026-03-01T10:00:00Z"), externalId: `ops-p7:${next()}`, data: {} });
}
const profile = async (personId: string) => (await h.db.select().from(vPersonProfile).where(eq(vPersonProfile.personId, personId)))[0]!;

describe("v_person_profile R2 webinar columns", () => {
  it("has every column of PERSON_PROFILE_COLUMNS in order", async () => {
    const cols = (
      await h.db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_name = 'v_person_profile' order by ordinal_position`,
      )
    ).rows.map((c) => c.column_name);
    expect(cols).toEqual(PERSON_PROFILE_COLUMNS.map((c) => c.name));
  });

  it("is zero for a person without any webinar data", async () => {
    const p = await makePerson(h.db);
    expect(await profile(p.id)).toMatchObject({
      webinarsRegistered: 0,
      webinarsAttendedLive: 0,
      lastWebinarAttendedAt: null,
      webinarsWatchedReplay: 0,
      webinarsWatchedOnDemand: 0,
      webinarPollAnswers: 0,
      webinarCtaClicks: 0,
      webinarsRegisteredTotal: 0,
      webinarsAttendedTotal: 0,
      importedWebinarsRegistered: 0,
      importedWebinarsAttended: 0,
    });
  });

  it("native counts from v_person_webinar_stats, imported apart, totals add both", async () => {
    const p = await makePerson(h.db);
    const w = await webinar();
    const r = await registration(w.id, p.id);
    await h.db.insert(watchSegments).values(
      [0, 30, 60].map((f) => ({ registrationId: r.id, webinarId: w.id, mode: "live" as const, viewId: crypto.randomUUID(), fromSec: f, toSec: f + 30, recordedAt: at(f / 30) })),
    );
    await imported(p.id, "webinar_registration");
    await imported(p.id, "webinar_registration");
    await imported(p.id, "webinar_attendance");
    const row = await profile(p.id);
    expect(row).toMatchObject({
      webinarsRegistered: 1,
      webinarsAttendedLive: 1,
      importedWebinarsRegistered: 2,
      importedWebinarsAttended: 1,
      webinarsRegisteredTotal: 3,
      webinarsAttendedTotal: 2,
    });
    expect(row.lastWebinarAttendedAt).toEqual(at(2));
  });

  it("watch_sec_total is null until the watch_time_profiling DPIA is approved or not required (rule 70)", async () => {
    const p = await makePerson(h.db);
    const w = await webinar();
    const r = await registration(w.id, p.id);
    await h.db.insert(watchSegments).values(
      [0, 30, 60, 90].map((f) => ({ registrationId: r.id, webinarId: w.id, mode: "live" as const, viewId: crypto.randomUUID(), fromSec: f, toSec: f + 30, recordedAt: at(f / 30) })),
    );
    await h.db.delete(dpiaRecords).where(eq(dpiaRecords.key, "watch_time_profiling"));
    expect((await profile(p.id)).watchSecTotal).toBeNull();
    await h.db.insert(dpiaRecords).values({ key: "watch_time_profiling", status: "in_progress" });
    expect((await profile(p.id)).watchSecTotal).toBeNull();
    for (const status of ["approved", "not_required"] as const) {
      await h.db.update(dpiaRecords).set({ status, decisionNote: "Reviewed" }).where(eq(dpiaRecords.key, "watch_time_profiling"));
      expect((await profile(p.id)).watchSecTotal).toBe(120);
    }
    expect((await profile((await makePerson(h.db)).id)).watchSecTotal).toBe(0);
  });
});
