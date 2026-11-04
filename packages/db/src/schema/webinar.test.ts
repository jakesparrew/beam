import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { factsReached, mergeIntervals } from "@beam/core/webinar";
import type { DbHandle } from "../client";
import { createTestDb, makePerson, makeSession, makeUser } from "../testing";
import { makeOrder } from "../testing/commerce-factories";
import { bookings } from "./booking";
import { persons } from "./crm";
import { importedHistory, imports } from "./ops";
import { files } from "./platform";
import {
  watchSegments,
  webinarCtas,
  webinarInteractions,
  webinarModerationActions,
  webinarPolls,
  webinarPresenters,
  webinarRegistrations,
  webinars,
} from "./webinar";
import { vPersonWebinarStats, vWebinarConversions, vWebinarRegistrationFacts, vWebinarWatch } from "./webinar.views";

/** The Postgres error behind a failed query (message and SQLSTATE). */
async function pgError(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string; code?: string } }).cause ?? (error as { message?: string; code?: string });
    return { message: String(cause.message ?? error), code: cause.code };
  }
  throw new Error("expected the query to fail");
}
async function expectCheck(promise: Promise<unknown>, constraint: string) {
  const err = await pgError(promise);
  expect(err.code, err.message).toBe("23514");
  expect(err.message).toContain(constraint);
}
async function expectUnique(promise: Promise<unknown>, index: string) {
  const err = await pgError(promise);
  expect(err.code, err.message).toBe("23505");
  expect(err.message).toContain(index);
}

const title = { "nl-BE": "Slaap beter", "fr-BE": "Mieux dormir", en: "Sleep better" };
const T0 = new Date("2026-11-20T19:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
let seq = 0;
const next = () => ++seq;

let h: DbHandle;
let userId: string;
beforeAll(async () => {
  h = await createTestDb();
  userId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(() => h.close());

type WebinarInsert = typeof webinars.$inferInsert;
async function makeWebinar(over: Partial<WebinarInsert> = {}) {
  const [row] = await h.db
    .insert(webinars)
    .values({ slug: `webinar-${next()}`, title, mode: "live", startsAt: T0, ownerUserId: userId, createdByUserId: userId, ...over })
    .returning();
  return row!;
}
async function makeRegistration(webinarId: string, over: Partial<typeof webinarRegistrations.$inferInsert> = {}) {
  const personId = over.personId ?? (await makePerson(h.db)).id;
  const [row] = await h.db
    .insert(webinarRegistrations)
    .values({
      webinarId,
      personId,
      accessTokenHash: `hash-${next()}`,
      registeredMode: "live",
      source: "site",
      locale: "nl-BE",
      personStatus: "lead",
      ...over,
    })
    .returning();
  return row!;
}
const viewId = () => crypto.randomUUID();
async function addSegments(reg: { id: string; webinarId: string }, mode: "live" | "replay" | "on_demand", segs: Array<[number, number]>) {
  if (!segs.length) return;
  const v = viewId();
  await h.db.insert(watchSegments).values(segs.map(([fromSec, toSec]) => ({ registrationId: reg.id, webinarId: reg.webinarId, mode, viewId: v, fromSec, toSec })));
}
async function makePoll(webinarId: string, key = `poll_${next()}`) {
  const label = { "nl-BE": "Ja", "fr-BE": "Oui", en: "Yes" };
  const [row] = await h.db
    .insert(webinarPolls)
    .values({ webinarId, key, question: title, options: [{ key: "a", label }, { key: "b", label }] })
    .returning();
  return row!;
}
async function makeCta(webinarId: string) {
  const [row] = await h.db
    .insert(webinarCtas)
    .values({ webinarId, key: `cta_${next()}`, label: title, url: "https://beam.example.com/book" })
    .returning();
  return row!;
}

describe("webinars checks", () => {
  it("accepts a minimal draft with the defaults", async () => {
    const w = await makeWebinar({ startsAt: null });
    expect(w).toMatchObject({ status: "draft", plannedDurationMinutes: 60, attendedMinSec: 300, conversionWindowDays: 30, version: 1, spokenLocale: "nl-BE" });
    expect(w.locales).toEqual(["nl-BE", "fr-BE", "en"]);
    expect(w.isReplayEnabled && w.isReplayGated && w.isChatEnabled && w.isQuestionsEnabled).toBe(true);
  });

  it("rejects bad column values", async () => {
    await expectCheck(makeWebinar({ slug: "Bad Slug" }), "webinars_slug_ck");
    await expectCheck(makeWebinar({ slug: `a-${"x".repeat(80)}` }), "webinars_slug_ck");
    await expectUnique(makeWebinar({ slug: "same-slug" }).then(() => makeWebinar({ slug: "same-slug" })), "webinars_slug_uq");
    await expectCheck(makeWebinar({ seriesKey: "x" }), "webinars_series_key_ck");
    await expectCheck(makeWebinar({ locales: [] }), "webinars_locales_ck");
    await expectCheck(makeWebinar({ locales: ["de" as "en"] }), "webinars_locales_ck");
    await expectCheck(makeWebinar({ mode: "on_demand", startsAt: T0 }), "webinars_starts_at_ck");
    await expectCheck(makeWebinar({ plannedDurationMinutes: 4 }), "webinars_planned_duration_ck");
    await expectCheck(makeWebinar({ plannedDurationMinutes: 481 }), "webinars_planned_duration_ck");
    await expectCheck(makeWebinar({ durationSec: 0 }), "webinars_duration_sec_ck");
    await expectCheck(makeWebinar({ youtubeVideoId: "short" }), "webinars_youtube_video_id_ck");
    await expectCheck(makeWebinar({ recordingVideoId: "has spaces!" }), "webinars_recording_video_id_ck");
    await expectCheck(makeWebinar({ hostMeetUrl: "https://zoom.us/j/1" }), "webinars_host_meet_url_ck");
    await expectCheck(makeWebinar({ replayUntilAt: at(-1) }), "webinars_replay_until_ck");
    await expectCheck(makeWebinar({ replayViewLimit: 0 }), "webinars_replay_view_limit_ck");
    await expectCheck(makeWebinar({ onDemandAccessDays: 366 }), "webinars_on_demand_access_days_ck");
    await expectCheck(makeWebinar({ attendedMinSec: 59 }), "webinars_attended_min_sec_ck");
    await expectCheck(makeWebinar({ conversionWindowDays: 0 }), "webinars_conversion_window_days_ck");
  });

  it("a live or simulive webinar out of draft needs starts_at and a session", async () => {
    await expectCheck(makeWebinar({ status: "published", youtubeVideoId: "abcdefghijk" }), "ck_webinars_scheduled");
    const session = await makeSession(h.db, { kind: "event", creditKind: null, eventCategory: "webinar", capacitySeats: 0 });
    const ok = await makeWebinar({ status: "published", youtubeVideoId: "abcdefghijk", sessionId: session.id });
    expect(ok.status).toBe("published");
    await expectUnique(makeWebinar({ sessionId: session.id }), "webinars_session_uq");
    expect((await makeWebinar({ status: "cancelled" })).status).toBe("cancelled");
    expect((await makeWebinar({ mode: "on_demand", startsAt: null, status: "published", recordingVideoId: "abcdefghijk" })).status).toBe("published");
  });

  it("simulive and on-demand need a recording once published; live needs its broadcast", async () => {
    await expectCheck(makeWebinar({ mode: "on_demand", startsAt: null, status: "published" }), "ck_webinars_video");
    const session = await makeSession(h.db, { kind: "event", creditKind: null, eventCategory: "webinar", capacitySeats: 0 });
    await expectCheck(makeWebinar({ status: "published", sessionId: session.id }), "ck_webinars_live_video");
    await expectCheck(makeWebinar({ mode: "simulive", status: "published", sessionId: session.id }), "ck_webinars_video");
  });
});

describe("webinar_presenters", () => {
  it("is a staff user or a person, never both or neither", async () => {
    const w = await makeWebinar();
    const person = await makePerson(h.db);
    await expectCheck(h.db.insert(webinarPresenters).values({ webinarId: w.id, displayName: "Nobody" }), "webinar_presenters_identity_ck");
    await expectCheck(
      h.db.insert(webinarPresenters).values({ webinarId: w.id, userId, personId: person.id, displayName: "Both" }),
      "webinar_presenters_identity_ck",
    );
    await expectCheck(h.db.insert(webinarPresenters).values({ webinarId: w.id, userId, displayName: "" }), "webinar_presenters_display_name_ck");
    await h.db.insert(webinarPresenters).values({ webinarId: w.id, userId, displayName: "Host" });
    await expectUnique(h.db.insert(webinarPresenters).values({ webinarId: w.id, userId, displayName: "Again" }), "webinar_presenters_user_uq");
    const [p] = await h.db.insert(webinarPresenters).values({ webinarId: w.id, personId: person.id, displayName: "Guest" }).returning();
    expect(p!.role).toBe("presenter");
  });
});

describe("webinar_registrations", () => {
  it("one registration per person per webinar, unique token hash", async () => {
    const w = await makeWebinar();
    const r = await makeRegistration(w.id);
    await expectUnique(makeRegistration(w.id, { personId: r.personId }), "webinar_registrations_webinar_person_uq");
    const other = await makeWebinar();
    await expectUnique(makeRegistration(other.id, { accessTokenHash: r.accessTokenHash }), "webinar_registrations_token_hash_uq");
    expect(r).toMatchObject({ status: "registered", tokenVersion: 1, accessEmailsSent: 0, utm: {} });
  });

  it("blocked needs blocked_at and cancelled needs cancelled_at", async () => {
    const w = await makeWebinar();
    await expectCheck(makeRegistration(w.id, { status: "blocked" }), "webinar_registrations_blocked_ck");
    await expectCheck(makeRegistration(w.id, { status: "cancelled" }), "webinar_registrations_cancelled_ck");
    expect((await makeRegistration(w.id, { status: "blocked", blockedAt: new Date(), blockedByUserId: userId })).status).toBe("blocked");
    expect((await makeRegistration(w.id, { status: "cancelled", cancelledAt: new Date() })).status).toBe("cancelled");
  });
});

describe("webinar_polls and webinar_ctas", () => {
  it("validates keys, options, timing and URLs", async () => {
    const w = await makeWebinar();
    const label = { en: "x" };
    await expectCheck(h.db.insert(webinarPolls).values({ webinarId: w.id, key: "Bad-Key", question: title, options: [{ key: "a", label }, { key: "b", label }] }), "webinar_polls_key_ck");
    await expectCheck(h.db.insert(webinarPolls).values({ webinarId: w.id, key: "one", question: title, options: [{ key: "a", label }] }), "webinar_polls_options_ck");
    await expectCheck(
      h.db.insert(webinarPolls).values({ webinarId: w.id, key: "late", question: title, options: [{ key: "a", label }, { key: "b", label }], showForSec: 10 }),
      "webinar_polls_show_for_ck",
    );
    await makePoll(w.id, "same");
    await expectUnique(makePoll(w.id, "same"), "webinar_polls_webinar_key_uq");
    await expectCheck(h.db.insert(webinarCtas).values({ webinarId: w.id, key: "book", label: title, url: "http://beam.example.com" }), "webinar_ctas_url_ck");
    await expectCheck(h.db.insert(webinarCtas).values({ webinarId: w.id, key: "book", label: title, url: "https://beam.example.com", showForSec: 7201 }), "webinar_ctas_show_for_ck");
    await expectCheck(h.db.insert(webinarCtas).values({ webinarId: w.id, key: "book", label: title, url: "https://beam.example.com", showAtSec: -1 }), "webinar_ctas_show_at_ck");
  });
});

describe("watch_segments, webinar_interactions, webinar_moderation_actions", () => {
  it("segments are 1 to 30 seconds from position 0 on", async () => {
    const w = await makeWebinar();
    const r = await makeRegistration(w.id);
    const seg = (fromSec: number, toSec: number) => h.db.insert(watchSegments).values({ registrationId: r.id, webinarId: w.id, mode: "live", viewId: viewId(), fromSec, toSec });
    await expectCheck(seg(-1, 10), "watch_segments_from_ck");
    await expectCheck(seg(10, 10), "watch_segments_span_ck");
    await expectCheck(seg(0, 31), "watch_segments_span_ck");
    await seg(0, 30);
  });

  it("interaction kinds carry exactly their poll or CTA, and message text is 1-500 characters", async () => {
    const w = await makeWebinar();
    const r = await makeRegistration(w.id);
    const poll = await makePoll(w.id);
    const cta = await makeCta(w.id);
    const base = { registrationId: r.id, webinarId: w.id, mode: "live" as const };
    await expectCheck(h.db.insert(webinarInteractions).values({ ...base, kind: "poll_answer" }), "webinar_interactions_poll_ck");
    await expectCheck(h.db.insert(webinarInteractions).values({ ...base, kind: "chat", pollId: poll.id, payload: { text: "hi" } }), "webinar_interactions_poll_ck");
    await expectCheck(h.db.insert(webinarInteractions).values({ ...base, kind: "cta_clicked" }), "webinar_interactions_cta_ck");
    await expectCheck(h.db.insert(webinarInteractions).values({ ...base, kind: "started", ctaId: cta.id }), "webinar_interactions_cta_ck");
    await expectCheck(h.db.insert(webinarInteractions).values({ ...base, kind: "chat", payload: { text: "" } }), "webinar_interactions_text_ck");
    await expectCheck(h.db.insert(webinarInteractions).values({ ...base, kind: "question", payload: { text: "x".repeat(501) } }), "webinar_interactions_text_ck");
    await expectCheck(h.db.insert(webinarInteractions).values({ ...base, kind: "started", atSec: -1 }), "webinar_interactions_at_sec_ck");
    await h.db.insert(webinarInteractions).values({ ...base, kind: "chat", payload: { text: "Hallo" } });
  });

  it("one poll answer per registration and mode; a live and a replay answer coexist", async () => {
    const w = await makeWebinar();
    const r = await makeRegistration(w.id);
    const poll = await makePoll(w.id);
    const answer = (mode: "live" | "replay") =>
      h.db.insert(webinarInteractions).values({ registrationId: r.id, webinarId: w.id, mode, kind: "poll_answer", pollId: poll.id, payload: { option_keys: ["a"] } });
    await answer("live");
    await expectUnique(answer("live"), "uq_poll_answer_once");
    await answer("replay");
    const rows = await h.db.select().from(webinarInteractions).where(eq(webinarInteractions.pollId, poll.id));
    expect(rows.map((x) => x.mode).sort()).toEqual(["live", "replay"]);
  });

  it("cta_shown once per mode; every click is its own row", async () => {
    const w = await makeWebinar();
    const r = await makeRegistration(w.id);
    const cta = await makeCta(w.id);
    const row = (kind: "cta_shown" | "cta_clicked", mode: "live" | "replay" = "live") =>
      h.db.insert(webinarInteractions).values({ registrationId: r.id, webinarId: w.id, mode, kind, ctaId: cta.id });
    await row("cta_shown");
    await expectUnique(row("cta_shown"), "uq_cta_shown_once");
    await row("cta_shown", "replay");
    await row("cta_clicked");
    await row("cta_clicked");
    const clicks = await h.db.select().from(webinarInteractions).where(eq(webinarInteractions.ctaId, cta.id));
    expect(clicks.filter((x) => x.kind === "cta_clicked")).toHaveLength(2);
  });

  it("message moderation actions need the interaction", async () => {
    const w = await makeWebinar();
    const r = await makeRegistration(w.id);
    await expectCheck(
      h.db.insert(webinarModerationActions).values({ webinarId: w.id, registrationId: r.id, action: "hide_message", byUserId: userId }),
      "webinar_moderation_actions_message_ck",
    );
    await h.db.insert(webinarModerationActions).values({ webinarId: w.id, registrationId: r.id, action: "mute_viewer", byUserId: userId });
  });
});

describe("append-only (watch_segments, webinar_interactions, webinar_moderation_actions)", () => {
  it("rejects UPDATE and DELETE unless beam.allow_rewrite = 'on'", async () => {
    const w = await makeWebinar();
    const r = await makeRegistration(w.id);
    await addSegments(r, "live", [[0, 15]]);
    const [i] = await h.db.insert(webinarInteractions).values({ registrationId: r.id, webinarId: w.id, mode: "live", kind: "chat", payload: { text: "hoi" } }).returning();
    await h.db.insert(webinarModerationActions).values({ webinarId: w.id, registrationId: r.id, interactionId: i!.id, action: "hide_message", byUserId: userId });

    for (const update of [
      h.db.update(watchSegments).set({ toSec: 20 }).where(eq(watchSegments.registrationId, r.id)),
      h.db.update(webinarInteractions).set({ atSec: 5 }).where(eq(webinarInteractions.registrationId, r.id)),
      h.db.update(webinarModerationActions).set({ action: "unhide_message" }).where(eq(webinarModerationActions.registrationId, r.id)),
    ]) {
      expect((await pgError(update)).message).toMatch(/append-only/);
    }
    for (const del of [
      h.db.delete(webinarModerationActions).where(eq(webinarModerationActions.registrationId, r.id)),
      h.db.delete(webinarInteractions).where(eq(webinarInteractions.registrationId, r.id)),
      h.db.delete(watchSegments).where(eq(watchSegments.registrationId, r.id)),
    ]) {
      expect((await pgError(del)).message).toMatch(/append-only/);
    }
    // a registration delete cascades into the APPEND tables, which refuse it as well
    expect((await pgError(h.db.delete(webinarRegistrations).where(eq(webinarRegistrations.id, r.id)))).message).toMatch(/append-only/);

    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.delete(webinarRegistrations).where(eq(webinarRegistrations.id, r.id));
    });
    expect(await h.db.select().from(watchSegments).where(eq(watchSegments.registrationId, r.id))).toEqual([]);
    expect(await h.db.select().from(webinarInteractions).where(eq(webinarInteractions.registrationId, r.id))).toEqual([]);
    expect(await h.db.select().from(webinarModerationActions).where(eq(webinarModerationActions.registrationId, r.id))).toEqual([]);
  });
});

/** Deterministic PRNG (mulberry32) so the random sets are the same on every run. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("v_webinar_watch", () => {
  it("equals mergeIntervals and factsReached on 200 random segment sets", async () => {
    const rand = prng(20261120);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const w = await makeWebinar({ durationSec: 700, attendedMinSec: 60 });
    const people = await h.db
      .insert(persons)
      .values(
        Array.from({ length: 200 }, (_, i) => ({
          email: `watch-${i}-${next()}@example.com`,
          locale: "nl-BE" as const,
          isTester: true,
          acquisition: { source: "manual" as const },
        })),
      )
      .returning({ id: persons.id });
    const regs = await h.db
      .insert(webinarRegistrations)
      .values(
        people.map((p) => ({
          webinarId: w.id,
          personId: p.id,
          accessTokenHash: `rand-${p.id}`,
          registeredMode: "live" as const,
          source: "site" as const,
          locale: "nl-BE" as const,
          personStatus: "lead" as const,
        })),
      )
      .returning({ id: webinarRegistrations.id, personId: webinarRegistrations.personId });
    const expected = new Map<string, Array<{ fromSec: number; toSec: number }>>();
    const rows: Array<typeof watchSegments.$inferInsert> = [];
    for (const r of regs) {
      const mode = (["live", "replay", "on_demand"] as const)[int(0, 2)]!;
      const segs = Array.from({ length: int(1, 14) }, () => {
        const fromSec = int(0, 680);
        return { fromSec, toSec: fromSec + int(1, 30) };
      });
      expected.set(`${r.personId}:${mode}`, segs);
      const v = viewId();
      for (const s of segs) rows.push({ registrationId: r.id, webinarId: w.id, mode, viewId: v, ...s });
    }
    await h.db.insert(watchSegments).values(rows);

    const view = await h.db.select().from(vWebinarWatch).where(eq(vWebinarWatch.webinarId, w.id));
    expect(view).toHaveLength(200);
    for (const row of view) {
      const merged = mergeIntervals(expected.get(`${row.personId}:${row.mode}`)!);
      expect({ watchedSec: row.watchedSec, maxPositionSec: row.maxPositionSec }, row.personId).toEqual(merged);
      const facts = factsReached({ ...merged, durationSec: 700, attendedMinSec: 60 });
      expect({ attended: row.isAttended, m15: row.is15m, m30: row.is30m, half: row.isHalf, end: row.isEnd }).toEqual({
        attended: facts.includes("attended"),
        m15: facts.includes("15m"),
        m30: facts.includes("30m"),
        half: facts.includes("50pct"),
        end: facts.includes("end"),
      });
      expect(row.registrationId).toBe(regs.find((r) => r.personId === row.personId)!.id);
      expect(row.durationSec).toBe(700);
    }
  });

  it("keeps modes apart and uses the planned duration while the real one is unknown", async () => {
    const w = await makeWebinar({ plannedDurationMinutes: 30 });
    const r = await makeRegistration(w.id);
    await addSegments(r, "live", [
      [0, 30],
      [30, 60],
    ]);
    await addSegments(r, "replay", [[10, 40]]);
    const rows = await h.db.select().from(vWebinarWatch).where(eq(vWebinarWatch.webinarId, w.id));
    const byMode = Object.fromEntries(rows.map((x) => [x.mode, x]));
    expect(byMode.live).toMatchObject({ watchedSec: 60, maxPositionSec: 60, durationSec: 1800 });
    expect(byMode.replay).toMatchObject({ watchedSec: 30, maxPositionSec: 40 });
  });
});

describe("merged persons (edge case 19)", () => {
  it("folds a loser's registration into the winner: one row, merged intervals, one poll answer per mode", async () => {
    const w = await makeWebinar();
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    const rw = await makeRegistration(w.id, { personId: winner.id });
    const rl = await makeRegistration(w.id, { personId: loser.id, personStatus: "customer" });
    await addSegments(rw, "live", [
      [0, 30],
      [30, 60],
      [60, 90],
    ]);
    await addSegments(rl, "live", [
      [80, 110],
      [110, 120],
    ]);
    const poll = await makePoll(w.id);
    for (const r of [rw, rl]) {
      await h.db
        .insert(webinarInteractions)
        .values({ registrationId: r.id, webinarId: w.id, mode: "live", kind: "poll_answer", pollId: poll.id, payload: { option_keys: ["a"] } });
    }
    await h.db.update(persons).set({ mergedIntoPersonId: winner.id }).where(eq(persons.id, loser.id));

    const watch = await h.db.select().from(vWebinarWatch).where(eq(vWebinarWatch.webinarId, w.id));
    expect(watch).toHaveLength(1);
    expect(watch[0]).toMatchObject({ personId: winner.id, registrationId: rw.id, mode: "live", watchedSec: 120 });

    const facts = await h.db.select().from(vWebinarRegistrationFacts).where(eq(vWebinarRegistrationFacts.webinarId, w.id));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ registrationId: rw.id, personId: winner.id, personStatus: "lead", liveWatchedSec: 120, pollAnswersLive: 1 });

    const [stats] = await h.db.select().from(vPersonWebinarStats).where(eq(vPersonWebinarStats.personId, winner.id));
    expect(stats).toMatchObject({ webinarsRegistered: 1, watchSecTotal: 120, pollAnswers: 1 });
    expect(await h.db.select().from(vPersonWebinarStats).where(eq(vPersonWebinarStats.personId, loser.id))).toEqual([]);
  });
});

describe("v_webinar_registration_facts", () => {
  it("keeps per-mode facts apart and anchors live registrations on starts_at", async () => {
    const w = await makeWebinar({ attendedMinSec: 60 });
    const r = await makeRegistration(w.id, { createdAt: at(-60 * 24) });
    const replayOnly = await makeRegistration(w.id, { registeredMode: "replay", createdAt: at(120) });
    const poll = await makePoll(w.id);
    const cta = await makeCta(w.id);
    const live = { registrationId: r.id, webinarId: w.id, mode: "live" as const };
    await h.db.insert(webinarInteractions).values([
      { ...live, kind: "started" },
      { ...live, kind: "poll_answer", pollId: poll.id, payload: { option_keys: ["a"] } },
      { ...live, mode: "replay", kind: "poll_answer", pollId: poll.id, payload: { option_keys: ["b"] } },
      { ...live, kind: "cta_clicked", ctaId: cta.id, occurredAt: at(30) },
      { ...live, mode: "replay", kind: "cta_clicked", ctaId: cta.id, occurredAt: at(200) },
      { ...live, kind: "chat", payload: { text: "Hallo" } },
      { ...live, kind: "question", payload: { text: "Vraag?" } },
    ]);
    await addSegments(r, "live", [
      [0, 30],
      [30, 60],
      [60, 90],
    ]);

    const rows = await h.db.select().from(vWebinarRegistrationFacts).where(eq(vWebinarRegistrationFacts.webinarId, w.id));
    expect(rows.find((x) => x.registrationId === r.id)).toMatchObject({
      anchorAt: T0,
      liveStarted: true,
      liveWatchedSec: 90,
      liveAttended: true,
      replayStarted: false,
      replayWatchedSec: 0,
      replayAttended: false,
      pollAnswersLive: 1,
      pollAnswersReplay: 1,
      pollAnswersOd: 0,
      ctaClicksLive: 1,
      ctaClicksReplay: 1,
      questions: 1,
      chats: 1,
      firstCtaClickAt: at(30),
    });
    expect(rows.find((x) => x.registrationId === replayOnly.id)).toMatchObject({
      anchorAt: at(120),
      liveStarted: false,
      liveAttended: false,
      pollAnswersLive: 0,
      firstCtaClickAt: null,
    });
  });
});

describe("v_webinar_conversions", () => {
  it("picks the first confirmed or attended booking and the first paid order after the anchor only", async () => {
    const w = await makeWebinar();
    const person = await makePerson(h.db);
    const r = await makeRegistration(w.id, { personId: person.id, createdAt: at(-60 * 24 * 3) });
    const book = async (status: "confirmed" | "attended" | "reserved", createdAt: Date) => {
      const session = await makeSession(h.db);
      await h.db.insert(bookings).values({
        sessionId: session.id,
        personId: person.id,
        status,
        paidWith: "free",
        source: "admin",
        createdAt,
        ...(status === "attended" ? { attendedAt: createdAt } : {}),
        ...(status === "reserved" ? { reservedUntil: at(60 * 24 * 2) } : {}),
      });
    };
    await book("confirmed", at(-30));
    await book("reserved", at(60 * 24));
    await book("attended", at(60 * 24 * 2));
    await book("confirmed", at(60 * 24 * 5));
    await makeOrder(h.db, { personId: person.id, status: "paid", paidAt: at(-10), totalCents: 1000, subtotalCents: 1000 });
    await makeOrder(h.db, { personId: person.id, status: "paid", paidAt: at(60 * 24 * 10), totalCents: 4500, subtotalCents: 4500 });
    await makeOrder(h.db, { personId: person.id, status: "paid", paidAt: at(60 * 24 * 400), totalCents: 9900, subtotalCents: 9900 });
    await makeOrder(h.db, { personId: person.id, status: "pending_payment", totalCents: 700, subtotalCents: 700 });

    const [row] = await h.db.select().from(vWebinarConversions).where(eq(vWebinarConversions.registrationId, r.id));
    expect(row).toMatchObject({
      anchorAt: T0,
      firstBookingAt: at(60 * 24 * 2),
      firstPaidOrderAt: at(60 * 24 * 10),
      firstPaidOrderCents: 4500,
      revenue365dCents: 4500,
    });
  });

  it("has no booking or order when none follows the anchor", async () => {
    const w = await makeWebinar();
    const r = await makeRegistration(w.id);
    const [row] = await h.db.select().from(vWebinarConversions).where(eq(vWebinarConversions.registrationId, r.id));
    expect(row).toMatchObject({ firstBookingAt: null, firstPaidOrderAt: null, firstPaidOrderCents: null, revenue365dCents: 0 });
  });
});

describe("v_person_webinar_stats", () => {
  it("counts native facts and imported history apart; last_* consider both", async () => {
    const person = await makePerson(h.db);
    const [file] = await h.db
      .insert(files)
      .values({ kind: "import", name: "webinargeek.csv", mime: "text/csv", sizeBytes: 1, bytes: Buffer.from("a"), sha256: "0".repeat(64) })
      .returning();
    const [imp] = await h.db
      .insert(imports)
      .values({ kind: "history", source: "webinar_tool", name: "WebinarGeek attendees", fileId: file!.id, createdByUserId: userId })
      .returning();
    const history = (kind: "webinar_registration" | "webinar_attendance", occurredAt: Date) =>
      h.db
        .insert(importedHistory)
        .values({ personId: person.id, importId: imp!.id, source: "webinar_tool", kind, occurredAt, externalId: `webinargeek:${next()}:abcd`, data: {} });
    await history("webinar_registration", new Date("2026-03-01T10:00:00Z"));
    await history("webinar_registration", new Date("2026-05-01T10:00:00Z"));
    await history("webinar_attendance", new Date("2026-05-02T10:00:00Z"));

    const [onlyImported] = await h.db.select().from(vPersonWebinarStats).where(eq(vPersonWebinarStats.personId, person.id));
    expect(onlyImported).toMatchObject({
      webinarsRegistered: 0,
      webinarsAttendedLive: 0,
      watchSecTotal: 0,
      importedWebinarsRegistered: 2,
      importedWebinarsAttended: 1,
      lastWebinarRegisteredAt: new Date("2026-05-01T10:00:00Z"),
      lastWebinarAttendedAt: new Date("2026-05-02T10:00:00Z"),
    });

    const w = await makeWebinar({ attendedMinSec: 60 });
    const r = await makeRegistration(w.id, { personId: person.id, createdAt: at(-60) });
    await h.db.insert(watchSegments).values(
      [0, 30, 60].map((f) => ({ registrationId: r.id, webinarId: w.id, mode: "live" as const, viewId: viewId(), fromSec: f, toSec: f + 30, recordedAt: at(f / 30) })),
    );
    const cancelled = await makeWebinar();
    await makeRegistration(cancelled.id, { personId: person.id, status: "cancelled", cancelledAt: at(-5), createdAt: at(-10) });

    const [stats] = await h.db.select().from(vPersonWebinarStats).where(eq(vPersonWebinarStats.personId, person.id));
    expect(stats).toMatchObject({
      webinarsRegistered: 1,
      webinarsAttendedLive: 1,
      replaysWatched: 0,
      onDemandWatched: 0,
      watchSecTotal: 90,
      importedWebinarsRegistered: 2,
      importedWebinarsAttended: 1,
      lastWebinarRegisteredAt: at(-60),
      lastWebinarAttendedAt: at(2),
    });
    const rows = await h.db.select({ id: vPersonWebinarStats.personId }).from(vPersonWebinarStats).where(inArray(vPersonWebinarStats.personId, [person.id]));
    expect(rows).toHaveLength(1);
  });
});
