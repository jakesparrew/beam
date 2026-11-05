/**
 * webinar-P8: the R4 AI and summary hooks (`v_webinar_performance_daily`, `getWebinarWeeklyFacts`).
 *
 * The seeded week is Monday 23 to Sunday 29 March 2026 in Brussels; it holds the change to summer
 * time (29 March), and every instant is written with its Brussels offset, so the test does not
 * depend on the clock or the host's time zone. Around it: a registration minutes before the
 * week (Sunday 23:50, the 22nd in Brussels) and minutes after it (Monday 30 March 00:10), and a
 * replay watched the day after the week. Never counted: a tester's registration, watch time and
 * clicks, and a cancelled registration. A merged loser's registration and its overlapping watch
 * time are folded into the winner's (one registration, one attendee, 600 s).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getViewConfig } from "drizzle-orm/pg-core";
import type { DbHandle, DbOrTx } from "@beam/db";
import { bookings, persons, SENSITIVE_COLUMNS, vWebinarPerformanceDaily, WEBINAR_PERFORMANCE_DAILY_COLUMNS, webinarInteractions } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { getWebinarWeeklyFacts } from "./api";
import { WEBINAR_WEEKLY_FACTS } from "./server/ai-facts";
import { heartbeatSpans, makeCta, makePoll, makeRegistration, makeSegments, makeWebinar, type CtaRow, type RegistrationRow, type WebinarRow } from "./test/factories";

let h: DbHandle;
let live: WebinarRow;
let onDemand: WebinarRow;
const DAY = 86_400_000;
/** Brussels wall-clock instants (CET before 29 March 2026 02:00, CEST after). */
const cet = (local: string) => new Date(`${local}+01:00`);
const cest = (local: string) => new Date(`${local}+02:00`);
const WEEK = cet("2026-03-23T00:00:00");
const START = cet("2026-03-25T19:00:00");

const real = () => makePerson(h.db, { isTester: false });
const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));

async function bookingAt(db: DbOrTx, personId: string, createdAt: Date) {
  const session = await makeSession(db, { kind: "day", startsAt: new Date(createdAt.getTime() + 2 * DAY) });
  await db.insert(bookings).values({ sessionId: session.id, personId, status: "confirmed", paidWith: "free", source: "admin", createdAt });
}

async function clicks(reg: RegistrationRow, cta: CtaRow, at: Date, n = 1, mode: "live" | "replay" | "on_demand" = "live") {
  for (let i = 0; i < n; i++)
    await h.db.insert(webinarInteractions).values({ registrationId: reg.id, webinarId: reg.webinarId, mode, kind: "cta_clicked", ctaId: cta.id, payload: { url: cta.url }, atSec: 100 + i, occurredAt: new Date(at.getTime() + i * 1000) });
}

beforeAll(async () => {
  h = await createTestDb();
  const owner = await makeUser(h.db);
  live = await makeWebinar(h.db, { ownerUserId: owner.id, startsAt: START }, { published: true });
  onDemand = await makeWebinar(h.db, { ownerUserId: owner.id, mode: "on_demand" }, { published: true });
  const cta = await makeCta(h.db, { webinarId: live.id });
  const poll = await makePoll(h.db, { webinarId: live.id });

  // Lead 1: registered the week before; 10 minutes live (attended), a poll answer and two CTA
  // clicks on the day; booked 6 days after the start (a conversion of the anchor day, 25 March).
  const l1 = await real();
  const r1 = await makeRegistration(h.db, { webinarId: live.id, personId: l1.id, createdAt: cet("2026-03-20T10:00:00") });
  await makeSegments(h.db, r1, "live", heartbeatSpans(0, 600), { recordedAt: START });
  await h.db.insert(webinarInteractions).values({ registrationId: r1.id, webinarId: live.id, mode: "live", kind: "poll_answer", pollId: poll.id, payload: { option_keys: ["yes"] }, atSec: 200, occurredAt: new Date(START.getTime() + 200_000) });
  await clicks(r1, cta, new Date(START.getTime() + 300_000), 2);
  await bookingAt(h.db, l1.id, cest("2026-03-31T09:00:00"));

  // Lead 2: registered at 00:30 on the week's Monday (still the 22nd in UTC); 100 s live (a
  // watcher, not an attendee); booked 40 days after the start (outside the 30 days).
  const l2 = await real();
  const r2 = await makeRegistration(h.db, { webinarId: live.id, personId: l2.id, createdAt: cet("2026-03-23T00:30:00") });
  await makeSegments(h.db, r2, "live", heartbeatSpans(0, 100), { recordedAt: START });
  await bookingAt(h.db, l2.id, new Date(START.getTime() + 40 * DAY));

  // Lead 3: registered for the replay at 23:30 on the week's last day (after the DST change);
  // watched 20 minutes of replay and clicked the next day (next week).
  const r3 = await makeRegistration(h.db, { webinarId: live.id, personId: (await real()).id, registeredMode: "replay", createdAt: cest("2026-03-29T23:30:00") });
  await makeSegments(h.db, r3, "replay", heartbeatSpans(0, 1200), { recordedAt: cest("2026-03-30T20:00:00") });
  await clicks(r3, cta, cest("2026-03-30T20:10:00"), 1, "replay");

  // A customer on demand: registered and watched 400 s on Tuesday, paid two days later.
  const c = await real();
  const r4 = await makeRegistration(h.db, { webinarId: onDemand.id, personId: c.id, registeredMode: "on_demand", personStatus: "customer", createdAt: cet("2026-03-24T12:00:00") });
  await makeSegments(h.db, r4, "on_demand", heartbeatSpans(0, 400), { recordedAt: cet("2026-03-24T12:05:00") });
  await makePaidOrder(h.db, { personId: c.id, lines: [{ unitAmountCents: 9000 }], order: { paidAt: cet("2026-03-26T10:00:00") } });

  // A merged pair: both registered on Tuesday and watched the same 10 minutes in two tabs.
  const winner = await real();
  const loser = await real();
  const rw = await makeRegistration(h.db, { webinarId: live.id, personId: winner.id, createdAt: cet("2026-03-24T09:00:00") });
  const rl = await makeRegistration(h.db, { webinarId: live.id, personId: loser.id, createdAt: cet("2026-03-24T09:05:00") });
  await makeSegments(h.db, rw, "live", heartbeatSpans(0, 600), { recordedAt: START });
  await makeSegments(h.db, rl, "live", heartbeatSpans(0, 600), { recordedAt: START });
  await h.db.update(persons).set({ mergedIntoPersonId: winner.id }).where(eq(persons.id, loser.id));

  // Never counted: a tester (registration, 15 minutes live, a click) and a cancelled registration.
  const tester = await makePerson(h.db, { isTester: true });
  const rt = await makeRegistration(h.db, { webinarId: live.id, personId: tester.id, createdAt: cet("2026-03-24T10:00:00") });
  await makeSegments(h.db, rt, "live", heartbeatSpans(0, 900), { recordedAt: START });
  await clicks(rt, cta, new Date(START.getTime() + 400_000));
  await makeRegistration(h.db, { webinarId: live.id, personId: (await real()).id, status: "cancelled", createdAt: cet("2026-03-24T11:00:00") });

  // Just outside the week on both sides.
  await makeRegistration(h.db, { webinarId: live.id, personId: (await real()).id, createdAt: cet("2026-03-22T23:50:00") });
  await makeRegistration(h.db, { webinarId: live.id, personId: (await real()).id, createdAt: cest("2026-03-30T00:10:00") });
}, 120_000);
afterAll(() => h.close());

const asMap = (facts: Array<{ fact: string; value: number }>) => Object.fromEntries(facts.map((f) => [f.fact, f.value]));

describe("getWebinarWeeklyFacts", () => {
  it("returns the facts of the seeded week, in the documented order", async () => {
    const facts = await getWebinarWeeklyFacts(h.db, WEEK);
    expect(facts.map((f) => f.fact)).toEqual([...WEBINAR_WEEKLY_FACTS]);
    expect(asMap(facts)).toEqual({
      // Lead 2, lead 3, the customer and the merged pair once.
      registrations: 4,
      // Lead 1 and the merged winner; lead 2's 100 s is under the 300 s threshold.
      live_attendees: 2,
      replay_viewers: 0,
      on_demand_viewers: 1,
      // (600 + 100 + 600) s over three live watchers = 7.22 min.
      avg_live_watch_min: 7.2,
      cta_clicks: 2,
      // Lead 1 (booked 6 days after the start) and the customer (paid 2 days after registering).
      conversions_30d: 2,
    });
  });

  it("takes the Brussels date of any instant of the first day as the week", async () => {
    const base = await getWebinarWeeklyFacts(h.db, WEEK);
    expect(await getWebinarWeeklyFacts(h.db, new Date("2026-03-23"))).toEqual(base);
    expect(await getWebinarWeeklyFacts(h.db, cet("2026-03-23T23:59:00"))).toEqual(base);
  });

  it("puts what happened just outside the week into the neighbouring weeks", async () => {
    const before = asMap(await getWebinarWeeklyFacts(h.db, cet("2026-03-16T00:00:00")));
    expect(before).toMatchObject({ registrations: 2, live_attendees: 0, cta_clicks: 0, conversions_30d: 0 });
    const after = asMap(await getWebinarWeeklyFacts(h.db, cest("2026-03-30T00:00:00")));
    expect(after).toMatchObject({ registrations: 1, live_attendees: 0, replay_viewers: 1, cta_clicks: 1, avg_live_watch_min: 0, conversions_30d: 0 });
  });

  it("gives zeros for a week without webinar activity", async () => {
    const facts = await getWebinarWeeklyFacts(h.db, cet("2026-01-05T00:00:00"));
    expect(facts.every((f) => f.value === 0)).toBe(true);
  });
});

describe("v_webinar_performance_daily", () => {
  it("holds per webinar and Brussels day aggregates", async () => {
    const rows = await h.db.select().from(vWebinarPerformanceDaily).where(eq(vWebinarPerformanceDaily.webinarId, live.id));
    const day = (d: string) => rows.find((r) => r.dayOn === d);
    expect(day("2026-03-25")).toMatchObject({ registrations: 0, liveAttendees: 2, liveWatchers: 3, liveWatchSec: 1300, avgLiveWatchMin: 7.2, pollAnswers: 1, ctaClicks: 2, conversions30d: 1 });
    expect(day("2026-03-23")).toMatchObject({ registrations: 1, liveWatchers: 0, avgLiveWatchMin: null });
    expect(day("2026-03-24")).toMatchObject({ registrations: 1 });
    expect(day("2026-03-30")).toMatchObject({ registrations: 1, replayViewers: 1, replayWatchSec: 1200, avgReplayWatchMin: 20, ctaClicks: 1 });
    const od = await h.db.select().from(vWebinarPerformanceDaily).where(eq(vWebinarPerformanceDaily.webinarId, onDemand.id));
    expect(od).toEqual([expect.objectContaining({ dayOn: "2026-03-24", registrations: 1, onDemandViewers: 1, onDemandWatchSec: 400, conversions30d: 1 })]);
  });

  it("has no person id, e-mail or text column (information_schema)", async () => {
    const cols = rowsOf<{ column_name: string; data_type: string }>(
      await h.db.execute(sql`select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'v_webinar_performance_daily' order by ordinal_position`),
    );
    expect(cols.map((c) => c.column_name)).toEqual([...WEBINAR_PERFORMANCE_DAILY_COLUMNS]);
    expect(cols.map((c) => c.column_name)).toEqual(Object.values(getViewConfig(vWebinarPerformanceDaily).selectedFields).map((f) => (f as { name: string }).name));
    for (const c of cols) {
      expect(c.column_name).not.toMatch(/person|email|name|phone/);
      expect(["text", "character varying", "character", "json", "jsonb", "ARRAY", "USER-DEFINED"]).not.toContain(c.data_type);
    }
  });

  it("reads no SENSITIVE_COLUMNS member and no message text, through every view it builds on", async () => {
    expect(SENSITIVE_COLUMNS.length).toBeGreaterThan(0);
    const views = new Set(["v_webinar_performance_daily"]);
    for (let grew = true; grew; ) {
      grew = false;
      const used = rowsOf<{ table_name: string }>(
        await h.db.execute(sql`select distinct table_name from information_schema.view_table_usage
          where view_schema = 'public' and view_name in (${sql.join([...views].map((v) => sql`${v}`), sql`, `)})`),
      );
      for (const u of used)
        if (u.table_name.startsWith("v_") && !views.has(u.table_name)) {
          views.add(u.table_name);
          grew = true;
        }
    }
    expect([...views]).toEqual(expect.arrayContaining(["v_webinar_watch", "v_webinar_registration_facts", "v_webinar_conversions"]));
    const columns = rowsOf<{ table_name: string; column_name: string }>(
      await h.db.execute(sql`select distinct table_name, column_name from information_schema.view_column_usage
        where view_schema = 'public' and view_name in (${sql.join([...views].map((v) => sql`${v}`), sql`, `)})`),
    );
    expect(columns.length).toBeGreaterThan(10);
    const read = new Set(columns.map((c) => `${c.table_name}.${c.column_name}`));
    for (const s of SENSITIVE_COLUMNS) expect(read.has(`${s.table}.${s.column}`), `${s.table}.${s.column}`).toBe(false);
    for (const c of ["webinar_interactions.payload", "persons.email", "persons.first_name", "persons.last_name", "persons.phone"]) expect(read.has(c), c).toBe(false);
  });
});
