/**
 * Scenario 5 (proposal section 12, webinar spec rules 26, 33, 36; webinar-P5): replay activity and
 * replay polls are stored apart from live. One person watches live, answers a poll and clicks a
 * CTA, then watches the replay, answers the same poll and clicks the same CTA again. Every row
 * and event carries its mode, `v_webinar_registration_facts` counts one poll answer and one CTA
 * click in each mode, and the live watch time is not increased by the replay. PGlite, pinned
 * clock (CONVENTIONS item 11).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, vWebinarRegistrationFacts, webinarInteractions, webinarRegistrations, webinars } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { and, createCtx, eq, setAppDb } from "@/lib/ctx";
import { GET as ctaRoute } from "@/app/api/webinar/cta/[ctaId]/route";
import { heartbeatSpans, makeCta, makePoll, makeRegistration, makeSegments, makeWebinar } from "./test/factories";
import { answerPoll, launchPoll, recordCtaShown, showCta } from "./server/interactions";
import type { Viewer } from "./server/viewer";
import { ctaClickPath } from "./server/watch";

let h: DbHandle;
let ownerId: string;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  ownerId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(async () => {
  setAppDb(undefined);
  await h.close();
});

const T0 = new Date("2026-03-10T19:00:00.000Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

const viewerOf = async (id: string): Promise<Viewer> => {
  const [row] = await h.db
    .select({ r: webinarRegistrations, w: webinars })
    .from(webinarRegistrations)
    .innerJoin(webinars, eq(webinars.id, webinarRegistrations.webinarId))
    .where(eq(webinarRegistrations.id, id));
  return { registration: row!.r, webinar: row!.w, via: "token" };
};
const staff = <T>(now: Date, fn: (ctx: ReturnType<typeof createCtx>) => Promise<T>) =>
  h.db.transaction((tx: Tx) =>
    fn(createCtx({ tx, actor: { kind: "staff", userId: ownerId, roleKey: "marketing", permissions: new Set(["webinars.host"]), mfaAt: now }, now, durableMode: "immediate" })),
  );

describe("scenario 5: replay and replay polls are stored apart from live", () => {
  it("keeps the mode on every row and event and counts each mode on its own", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: T0, status: "live", liveStartedAt: T0 }, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const poll = await makePoll(h.db, { webinarId: w.id });
    const cta = await makeCta(h.db, { webinarId: w.id });
    const click = (mode: "live" | "replay") =>
      ctaRoute(new Request(`http://localhost${ctaClickPath(r.id, cta.id, mode)}`, { headers: { "x-forwarded-for": "192.0.2.120" } }), {
        params: Promise.resolve({ ctaId: cta.id }),
      });

    // Live: 20 minutes watched, the host launches the poll and shows the CTA.
    await makeSegments(h.db, r, "live", heartbeatSpans(0, 1200));
    await staff(at(600), (ctx) => launchPoll(ctx, { pollId: poll.id }));
    await staff(at(900), (ctx) => showCta(ctx, { ctaId: cta.id }));
    let v = await viewerOf(r.id);
    expect(await h.db.transaction((tx) => answerPoll(tx, v, { pollId: poll.id, optionKeys: ["yes"], viewId: randomUUID() }, at(610)))).toEqual({ ok: true });
    expect(await h.db.transaction((tx) => recordCtaShown(tx, v, { ctaId: cta.id }, at(905)))).toEqual({ ok: true, recorded: true });
    expect((await click("live")).status).toBe(302);

    // The live webinar ends; the recording is the replay.
    await h.db.update(webinars).set({ status: "ended", liveEndedAt: at(3600), recordingVideoId: "rec_video01", durationSec: 3600 }).where(eq(webinars.id, w.id));

    // Replay the next day: 20 more minutes, the same poll (shown at 10:00) and the same CTA again.
    await makeSegments(h.db, r, "replay", heartbeatSpans(0, 1200));
    v = await viewerOf(r.id);
    expect(await h.db.transaction((tx) => answerPoll(tx, v, { pollId: poll.id, optionKeys: ["no"], atSec: 605, viewId: randomUUID() }, at(86_400)))).toEqual({ ok: true });
    expect(await h.db.transaction((tx) => recordCtaShown(tx, v, { ctaId: cta.id, atSec: 905 }, at(86_405)))).toEqual({ ok: true, recorded: true });
    expect((await click("replay")).status).toBe(302);

    const rows = await h.db.select().from(webinarInteractions).where(eq(webinarInteractions.registrationId, r.id));
    expect(rows.map((i) => `${i.kind}:${i.mode}`).sort()).toEqual([
      "cta_clicked:live",
      "cta_clicked:replay",
      "cta_shown:live",
      "cta_shown:replay",
      "poll_answer:live",
      "poll_answer:replay",
    ]);

    const [facts] = await h.db.select().from(vWebinarRegistrationFacts).where(eq(vWebinarRegistrationFacts.registrationId, r.id));
    expect(facts).toMatchObject({
      pollAnswersLive: 1,
      pollAnswersReplay: 1,
      pollAnswersOd: 0,
      ctaClicksLive: 1,
      ctaClicksReplay: 1,
      ctaClicksOd: 0,
      // 20 live minutes plus 20 replay minutes: 30 minutes in neither mode (rule 26).
      liveWatchedSec: 1200,
      replayWatchedSec: 1200,
      liveIs30m: false,
      replayIs30m: false,
    });

    const events = await h.db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.refType, "webinar_registration"), eq(activityEvents.refId, r.id)));
    const byKind = (kind: string) => events.filter((e) => e.kind === kind).map((e) => e.mode).sort();
    expect(byKind("webinar.poll_answered")).toEqual(["live", "replay"]);
    expect(byKind("webinar.cta_clicked")).toEqual(["live", "replay"]);
    const replayAnswer = events.find((e) => e.kind === "webinar.poll_answered" && e.mode === "replay");
    expect(replayAnswer!.data).toMatchObject({ poll_key: poll.key, option_key: "no" });
    // No live journey can see the replay: every native event of this person carries a mode.
    expect(events.filter((e) => e.kind !== "webinar.registered").every((e) => e.mode === "live" || e.mode === "replay")).toBe(true);
  });
});
