/**
 * Polls, CTAs, chat, questions and moderation (webinar-P5; spec rules 21, 33-38, edge cases 14,
 * 16, 17, 23, 26). "Now" is pinned (CONVENTIONS item 11): server functions get an explicit
 * instant, the route tests fake only `Date`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, auditLog, personTags, tags, tasks, webinarInteractions, webinarModerationActions, webinarPolls, webinarRegistrations, webinars } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { deriveCtaKey, signCtaClick } from "@beam/core/webinar";
import { webinarAuthSecret } from "@beam/email/templates/webinar";
import { and, createCtx, eq, setAppDb, type Ctx } from "@/lib/ctx";
import { POST as interactRoute } from "@/app/api/webinar/interact/route";
import { GET as stateRoute } from "@/app/api/webinar/state/route";
import { GET as ctaRoute } from "@/app/api/webinar/cta/[ctaId]/route";
import { makeCta, makePoll, makeRegistration, makeWebinar, type RegistrationRow, type WebinarRow } from "../test/factories";
import { TOKEN_HEADER, type Viewer } from "./viewer";
import { ctaClickPath } from "./watch";
import {
  MESSAGE_LIMITS,
  QUESTION_TASK_TITLE,
  answerPoll,
  closePoll,
  ctaRedirectUrl,
  getHostConsoleState,
  getLiveState,
  hideCta,
  launchPoll,
  moderate,
  postMessage,
  recordCtaClick,
  recordCtaShown,
  showCta,
} from "./interactions";

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
afterEach(() => {
  vi.useRealTimers();
});

/** A pinned instant: a Tuesday evening in March (no DST change nearby). */
const T0 = new Date("2026-03-10T19:00:00.000Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

const liveWebinar = (o: Partial<WebinarRow> = {}) =>
  makeWebinar(h.db, { ownerUserId: ownerId, startsAt: T0, status: "live", liveStartedAt: T0, ...o }, { published: true });
/** The live webinar of `w` ends at `endSec` and its one-hour recording is the replay. */
const endWebinar = (w: WebinarRow, endSec = 3600) =>
  h.db.update(webinars).set({ status: "ended", liveEndedAt: at(endSec), recordingVideoId: "rec_video01", durationSec: 3600 }).where(eq(webinars.id, w.id));

const viewerOf = async (r: { id: string }): Promise<Viewer> => {
  const [row] = await h.db
    .select({ r: webinarRegistrations, w: webinars })
    .from(webinarRegistrations)
    .innerJoin(webinars, eq(webinars.id, webinarRegistrations.webinarId))
    .where(eq(webinarRegistrations.id, r.id));
  return { registration: row!.r, webinar: row!.w, via: "token" };
};
const inTx = <T>(fn: (tx: Tx) => Promise<T>) => h.db.transaction(fn);
const staffCtx = (tx: Tx, now: Date, userId = ownerId): Ctx =>
  createCtx({ tx, actor: { kind: "staff", userId, roleKey: "marketing", permissions: new Set(["webinars.host"]), mfaAt: now }, now, durableMode: "immediate" });
const asStaff = <T>(now: Date, fn: (ctx: Ctx) => Promise<T>) => inTx((tx) => fn(staffCtx(tx, now)));

// The viewer is read before the transaction: PGlite has one connection, so a read outside the
// open transaction would wait for it.
const answer = async (r: { id: string }, pollId: string, optionKeys: string[], now: Date, atSec?: number) => {
  const v = await viewerOf(r);
  return inTx((tx) => answerPoll(tx, v, { pollId, optionKeys, atSec, viewId: randomUUID() }, now));
};
const say = async (r: { id: string }, kind: "chat" | "question", text: string, now: Date, atSec?: number) => {
  const v = await viewerOf(r);
  return inTx((tx) => postMessage(tx, v, { kind, text, atSec }, now));
};

const interactionsOf = (r: { id: string }) => h.db.select().from(webinarInteractions).where(eq(webinarInteractions.registrationId, r.id));
const eventsOf = async (r: { id: string }, kind?: string) =>
  (await h.db.select().from(activityEvents).where(and(eq(activityEvents.refType, "webinar_registration"), eq(activityEvents.refId, r.id)))).filter(
    (e) => !kind || e.kind === kind,
  );
const tagKeysOf = async (personId: string) =>
  (await h.db.select({ key: tags.key }).from(personTags).innerJoin(tags, eq(tags.id, personTags.tagId)).where(eq(personTags.personId, personId))).map((t) => t.key).sort();

async function makeTag(key: string) {
  await h.db.insert(tags).values({ key, name: { "nl-BE": key, "fr-BE": key, en: key } }).onConflictDoNothing();
}

/** A live webinar, a registration and a poll the host launched at 10 minutes. */
async function launchedPoll(o: Partial<typeof webinarPolls.$inferInsert> = {}) {
  const w = await liveWebinar();
  const r = await makeRegistration(h.db, { webinarId: w.id });
  const poll = await makePoll(h.db, { webinarId: w.id, ...o });
  await asStaff(at(600), (ctx) => launchPoll(ctx, { pollId: poll.id }));
  return { w, r, poll };
}

describe("polls (rules 33-35, edge cases 14 and 16)", () => {
  it("accepts one answer per registration per mode; a second one is already_answered and writes nothing", async () => {
    const { r, poll } = await launchedPoll();
    expect(await answer(r, poll.id, ["yes"], at(610))).toEqual({ ok: true });
    expect(await answer(r, poll.id, ["no"], at(615))).toEqual({ ok: false, code: "already_answered" });
    const rows = (await interactionsOf(r)).filter((i) => i.kind === "poll_answer");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: "live", payload: { option_keys: ["yes"] }, atSec: 610 });
    expect(await eventsOf(r, "webinar.poll_answered")).toHaveLength(1);
  });

  it("stores a live and a replay answer of the same person as two rows with their own modes", async () => {
    const { w, r, poll } = await launchedPoll();
    expect(await answer(r, poll.id, ["yes"], at(620))).toEqual({ ok: true });
    await endWebinar(w);
    expect(await answer(r, poll.id, ["no"], at(7200), 610)).toEqual({ ok: true });
    const rows = (await interactionsOf(r)).filter((i) => i.kind === "poll_answer");
    expect(rows.map((i) => [i.mode, (i.payload as { option_keys: string[] }).option_keys]).sort()).toEqual([
      ["live", ["yes"]],
      ["replay", ["no"]],
    ]);
    expect((await eventsOf(r, "webinar.poll_answered")).map((e) => e.mode).sort()).toEqual(["live", "replay"]);
  });

  it("refuses unknown options, several keys on a single-choice poll, and a poll that is not open", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const poll = await makePoll(h.db, { webinarId: w.id });
    expect(await answer(r, poll.id, ["yes"], at(30))).toEqual({ ok: false, code: "closed" });
    await asStaff(at(40), (ctx) => launchPoll(ctx, { pollId: poll.id }));
    expect(await answer(r, poll.id, ["maybe"], at(50))).toEqual({ ok: false, code: "invalid" });
    expect(await answer(r, poll.id, ["yes", "no"], at(50))).toEqual({ ok: false, code: "invalid" });
    await asStaff(at(60), (ctx) => closePoll(ctx, { pollId: poll.id }));
    expect(await answer(r, poll.id, ["yes"], at(70))).toEqual({ ok: false, code: "closed" });
    expect(await interactionsOf(r)).toEqual([]);
  });

  it("`webinar.poll_answered` carries option_key for one choice and null for two keys", async () => {
    const { w, r, poll } = await launchedPoll({ allowMultiple: true });
    const r2 = await makeRegistration(h.db, { webinarId: w.id });
    await answer(r, poll.id, ["no"], at(610));
    await answer(r2, poll.id, ["no", "yes"], at(611));
    expect((await eventsOf(r, "webinar.poll_answered"))[0]!.data).toMatchObject({ poll_key: poll.key, option_keys: ["no"], option_key: "no" });
    expect((await eventsOf(r2, "webinar.poll_answered"))[0]!.data).toMatchObject({ option_keys: ["yes", "no"], option_key: null });
  });

  it("applies the tag rules whose options match and whose modes include the answer's mode", async () => {
    await makeTag("sleep_interest");
    await makeTag("sleep_replay");
    const { w, r, poll } = await launchedPoll({
      tagRules: [
        { option_keys: ["yes"], tag_key: "sleep_interest", modes: ["live"] },
        { option_keys: ["yes"], tag_key: "sleep_replay", modes: ["replay"] },
      ],
    });
    await answer(r, poll.id, ["yes"], at(610));
    expect(await tagKeysOf(r.personId)).toEqual(["sleep_interest"]);
    const r2 = await makeRegistration(h.db, { webinarId: w.id });
    await answer(r2, poll.id, ["no"], at(612));
    expect(await tagKeysOf(r2.personId)).toEqual([]);
    await endWebinar(w);
    const r3 = await makeRegistration(h.db, { webinarId: w.id });
    await answer(r3, poll.id, ["yes"], at(7200), 620);
    expect(await tagKeysOf(r3.personId)).toEqual(["sleep_replay"]);
  });

  it("an unknown tag in a rule does not abort the answer (edge case 16)", async () => {
    await makeTag("known_tag");
    const { r, poll } = await launchedPoll({
      tagRules: [
        { option_keys: ["yes"], tag_key: "deleted_tag", modes: ["live"] },
        { option_keys: ["yes"], tag_key: "known_tag", modes: ["live"] },
      ],
    });
    expect(await answer(r, poll.id, ["yes"], at(610))).toEqual({ ok: true });
    expect(await tagKeysOf(r.personId)).toEqual(["known_tag"]);
  });

  it("launch in live sets show_at_sec to the launch position when empty and keeps a set one", async () => {
    const { poll } = await launchedPoll();
    const [row] = await h.db.select().from(webinarPolls).where(eq(webinarPolls.id, poll.id));
    expect(row).toMatchObject({ showAtSec: 600, liveLaunchedAt: at(600), liveClosedAt: null });
    const w = await liveWebinar();
    const fixed = await makePoll(h.db, { webinarId: w.id, showAtSec: 90 });
    await asStaff(at(300), (ctx) => launchPoll(ctx, { pollId: fixed.id }));
    expect((await h.db.select().from(webinarPolls).where(eq(webinarPolls.id, fixed.id)))[0]!.showAtSec).toBe(90);
  });

  it("launching outside a live webinar is a conflict", async () => {
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, startsAt: at(3600) }, { published: true });
    const poll = await makePoll(h.db, { webinarId: w.id });
    await expect(asStaff(at(0), (ctx) => launchPoll(ctx, { pollId: poll.id }))).rejects.toMatchObject({ code: "conflict" });
  });

  it("a replay shows the poll at show_at_sec; a poll without it never appears outside live", async () => {
    const w = await liveWebinar();
    const timed = await makePoll(h.db, { webinarId: w.id, showAtSec: 120 });
    const liveOnly = await makePoll(h.db, { webinarId: w.id });
    await endWebinar(w);
    const r = await makeRegistration(h.db, { webinarId: w.id, registeredMode: "replay" });
    expect(await answer(r, timed.id, ["yes"], at(7200), 130)).toEqual({ ok: true });
    expect(await answer(r, liveOnly.id, ["yes"], at(7200), 130)).toEqual({ ok: false, code: "closed" });
  });
});

describe("CTAs (rule 36, edge case 26)", () => {
  it("records cta_shown once per registration, CTA and mode, without a timeline event", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const cta = await makeCta(h.db, { webinarId: w.id });
    const shown = async (now: Date, atSec?: number) => {
      const v = await viewerOf(r);
      return inTx((tx) => recordCtaShown(tx, v, { ctaId: cta.id, atSec }, now));
    };
    expect(await shown(at(10))).toEqual({ ok: false, code: "closed" });
    await asStaff(at(100), (ctx) => showCta(ctx, { ctaId: cta.id }));
    expect(await shown(at(110))).toEqual({ ok: true, recorded: true });
    expect(await shown(at(120))).toEqual({ ok: true, recorded: false });
    await endWebinar(w);
    expect(await shown(at(7200), 105)).toEqual({ ok: true, recorded: true });
    expect((await interactionsOf(r)).map((i) => `${i.kind}:${i.mode}`).sort()).toEqual(["cta_shown:live", "cta_shown:replay"]);
    expect(await eventsOf(r)).toEqual([]);
    await expect(asStaff(at(7300), (ctx) => hideCta(ctx, { ctaId: cta.id }))).resolves.toEqual({});
  });

  it("adds the UTM parameters that are absent and never overwrites existing ones", () => {
    const plain = new URL(ctaRedirectUrl("https://beam.example.com/book", { mode: "replay", slug: "sleep-better", ctaKey: "book" }));
    expect(Object.fromEntries(plain.searchParams)).toEqual({ utm_source: "beam-webinar", utm_medium: "replay", utm_campaign: "sleep-better", utm_content: "book" });
    const tagged = new URL(ctaRedirectUrl("https://beam.example.com/book?utm_source=newsletter&x=1", { mode: "live", slug: "s", ctaKey: "k" }));
    expect(tagged.searchParams.get("utm_source")).toBe("newsletter");
    expect(tagged.searchParams.get("utm_medium")).toBe("live");
    expect(tagged.searchParams.get("x")).toBe("1");
  });

  it("a signed click redirects with UTM, records every click and writes one event per mode", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const cta = await makeCta(h.db, { webinarId: w.id, url: "https://beam.example.com/book?utm_campaign=spring" });
    const path = ctaClickPath(r.id, cta.id, "live");
    const click = (p: string) => ctaRoute(new Request(`http://localhost${p}`, { headers: { "x-forwarded-for": "192.0.2.80" } }), { params: Promise.resolve({ ctaId: cta.id }) });
    for (let i = 0; i < 2; i++) {
      const res = await click(path);
      expect(res.status).toBe(302);
      const target = new URL(res.headers.get("location")!);
      expect(target.origin + target.pathname).toBe("https://beam.example.com/book");
      expect(target.searchParams.get("utm_campaign")).toBe("spring");
      expect(target.searchParams.get("utm_content")).toBe(cta.key);
      expect(target.searchParams.get("utm_medium")).toBe("live");
      expect(target.toString()).not.toContain(r.token);
    }
    expect((await interactionsOf(r)).filter((i) => i.kind === "cta_clicked")).toHaveLength(2);
    const events = await eventsOf(r, "webinar.cta_clicked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ mode: "live", data: { cta_key: cta.key, url: cta.url } });
  });

  it("a click with a bad signature redirects and records nothing", async () => {
    const w = await liveWebinar();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const cta = await makeCta(h.db, { webinarId: w.id });
    const forged = signCtaClick(deriveCtaKey("not-the-secret"), r.id, cta.id, "live");
    const res = await ctaRoute(new Request(`http://localhost/api/webinar/cta/${cta.id}?r=${r.id}&m=live&s=${forged}`), { params: Promise.resolve({ ctaId: cta.id }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("utm_source=beam-webinar");
    const tampered = await inTx((tx) => recordCtaClick(tx, { registrationId: r.id, ctaId: cta.id, mode: "replay", sig: signCtaClick(deriveCtaKey(webinarAuthSecret()), r.id, cta.id, "live") }, at(10)));
    expect(tampered.recorded).toBe(false);
    expect(await interactionsOf(r)).toEqual([]);
    expect(await eventsOf(r)).toEqual([]);
  });
});
