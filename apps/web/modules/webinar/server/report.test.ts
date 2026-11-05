/**
 * Webinar report (webinar spec rules 39-41; webinar-P6): seeded lead, customer and member
 * registrants of one live webinar 40 days ago; registered is never counted as attended; a booking
 * 10 days after the start counts in the 14- and 30-day periods but not in 7; a purchase before
 * the webinar is not counted; the CTA's "booked after" counts only bookings after the click;
 * the aggregate CSV holds no email or name; poll results per option per mode; UTM table; the
 * "webinar leads have not booked" count equals its rows; person stats and the upcoming health.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, DbOrTx } from "@beam/db";
import { bookings, webinarInteractions } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { countWebinarLeadsWithoutBooking, getPersonWebinarStats, listUpcomingWebinarHealth, listWebinarLeadsWithoutBooking } from "../api";
import { heartbeatSpans, makeCta, makePoll, makeRegistration, makeSegments, makeWebinar, type CtaRow, type PollRow, type WebinarRow } from "../test/factories";
import { buildRegistrantsCsv, buildReportCsv, csvCell, getWebinarReport, listRegistrantExportRows, type WebinarReport } from "./report";

let h: DbHandle;
const DAY = 86_400_000;
const NOW = Date.now();
/** The webinar started 40 days ago (fractional offsets keep the test clear of midnight and DST). */
const START = new Date(NOW - 40 * DAY);
const after = (days: number) => new Date(START.getTime() + days * DAY);

let w: WebinarRow;
let poll: PollRow;
let cta: CtaRow;
const people: Record<"lead" | "lead2" | "customer" | "member", { personId: string; email: string; registrationId: string }> = {} as never;

async function makeBookingAt(db: DbOrTx, personId: string, createdAt: Date, status: "confirmed" | "attended" | "cancelled" = "confirmed") {
  const session = await makeSession(db, { kind: "day", startsAt: new Date(createdAt.getTime() + 2 * DAY) });
  await db.insert(bookings).values({
    sessionId: session.id,
    personId,
    status,
    paidWith: "free",
    source: "admin",
    createdAt,
    ...(status === "cancelled" ? { cancelledAt: createdAt, cancelReasonCode: "customer" as const } : {}),
  });
}

async function interaction(registrationId: string, kind: "started" | "poll_answer" | "cta_shown" | "cta_clicked", mode: "live" | "replay", occurredAt: Date, extra: Record<string, unknown> = {}) {
  await h.db.insert(webinarInteractions).values({ registrationId, webinarId: w.id, kind, mode, occurredAt, viewId: randomUUID(), payload: {}, ...extra });
}

beforeAll(async () => {
  h = await createTestDb();
  const owner = await makeUser(h.db);
  w = await makeWebinar(h.db, { ownerUserId: owner.id, startsAt: START, conversionWindowDays: 30 }, { published: true });
  poll = await makePoll(h.db, { webinarId: w.id });
  cta = await makeCta(h.db, { webinarId: w.id });
  const register = async (key: keyof typeof people, personStatus: "lead" | "customer" | "member", utm: Record<string, string> = {}) => {
    const p = await makePerson(h.db);
    const r = await makeRegistration(h.db, { webinarId: w.id, personId: p.id, personStatus, utm, createdAt: new Date(START.getTime() - 5 * DAY) });
    people[key] = { personId: p.id, email: p.email!, registrationId: r.id };
    return r;
  };
  const lead = await register("lead", "lead", { source: "newsletter", campaign: "spring" });
  await register("lead2", "lead", { source: "newsletter", campaign: "spring" });
  await register("customer", "customer");
  const member = await register("member", "member", { source: "instagram" });
  // A cancelled registration is left out of every count.
  const gone = await makePerson(h.db);
  await makeRegistration(h.db, { webinarId: w.id, personId: gone.id, status: "cancelled", personStatus: "lead", createdAt: new Date(START.getTime() - 4 * DAY) });

  // Lead: 10 minutes live (attended at 300 s), a live poll answer, booked 10 days after the start,
  // clicked the CTA only after that booking.
  await interaction(lead.id, "started", "live", START);
  await makeSegments(h.db, lead, "live", heartbeatSpans(0, 600), { recordedAt: START });
  await interaction(lead.id, "poll_answer", "live", after(0.01), { pollId: poll.id, payload: { option_keys: ["yes"] } });
  await interaction(lead.id, "cta_shown", "live", after(0.02), { ctaId: cta.id });
  await makeBookingAt(h.db, lead.personId, after(10));
  await interaction(lead.id, "cta_clicked", "live", after(11), { ctaId: cta.id, payload: { url: cta.url } });

  // Customer: registered only (never started, never watched); bought before the webinar.
  await makePaidOrder(h.db, { personId: people.customer.personId, order: { paidAt: new Date(START.getTime() - 2 * DAY) } });

  // Member: 20 minutes of replay, a replay poll answer, clicked the CTA a day after the start,
  // then bought (3 days, € 90) and booked (5 days).
  await interaction(member.id, "started", "replay", after(1));
  await makeSegments(h.db, member, "replay", heartbeatSpans(0, 1200), { recordedAt: after(1) });
  await interaction(member.id, "poll_answer", "replay", after(1.01), { pollId: poll.id, payload: { option_keys: ["no"] } });
  await interaction(member.id, "cta_shown", "replay", after(1.02), { ctaId: cta.id });
  await interaction(member.id, "cta_clicked", "replay", after(1.03), { ctaId: cta.id, payload: { url: cta.url } });
  await makePaidOrder(h.db, { personId: people.member.personId, lines: [{ unitAmountCents: 9000 }], order: { paidAt: after(3) } });
  await makeBookingAt(h.db, people.member.personId, after(5));
}, 120_000);
afterAll(() => h.close());

const report = (periodDays: 7 | 14 | 30) => getWebinarReport(h.db, w.id, { periodDays });

describe("segments and modes (rule 39)", () => {
  let r: WebinarReport;
  beforeAll(async () => {
    r = await report(30);
  });

  it("splits by the status snapshot and leaves the cancelled registration out", () => {
    expect(r.bySegment.lead.registrations).toBe(2);
    expect(r.bySegment.customer.registrations).toBe(1);
    expect(r.bySegment.member.registrations).toBe(1);
    expect(r.totals.registrations).toBe(4);
    expect(r.totals.modes.live.registered).toBe(4);
  });

  it("registered is never counted as started or attended", () => {
    for (const m of ["live", "replay", "on_demand"] as const) {
      expect(r.bySegment.customer.modes[m]).toMatchObject({ started: 0, attended: 0, viewers: 0, watched15m: 0 });
    }
    expect(r.byMode.live).toMatchObject({ started: 1, attended: 1, viewers: 1, watched15m: 0, avgWatchMinutes: 10 });
    expect(r.byMode.replay).toMatchObject({ started: 1, attended: 1, watched15m: 1, watched30m: 0, avgWatchMinutes: 20 });
    expect(r.bySegment.lead.modes.live.attended).toBe(1);
    expect(r.bySegment.lead.modes.replay.attended).toBe(0);
    expect(r.bySegment.member.modes.replay.attended).toBe(1);
    expect(r.bySegment.member.modes.live.attended).toBe(0);
  });

  it("counts poll responses and CTA shown and clicked per mode", () => {
    expect(r.byMode.live).toMatchObject({ pollResponses: 1, ctaShown: 1, ctaClicked: 1 });
    expect(r.byMode.replay).toMatchObject({ pollResponses: 1, ctaShown: 1, ctaClicked: 1 });
    expect(r.bySegment.member.modes.replay.ctaClicked).toBe(1);
  });
});

describe("conversion within the period (rule 40)", () => {
  it("a booking 10 days after the start counts in 14 and 30 days but not in 7", async () => {
    const [d7, d14, d30] = [await report(7), await report(14), await report(30)];
    expect(d7.bySegment.lead).toMatchObject({ booked: 0, converted: 0 });
    expect(d14.bySegment.lead).toMatchObject({ booked: 1, converted: 1 });
    expect(d30.bySegment.lead).toMatchObject({ booked: 1, converted: 1 });
    expect(d7.periodDays).toBe(7);
    expect(d7.totals.converted).toBe(1);
    expect(d14.totals.converted).toBe(2);
    expect(d14.totals.conversionRate).toBeCloseTo(2 / 4);
  });

  it("a purchase before the webinar is not counted; one after it is, with its revenue", async () => {
    const d7 = await report(7);
    expect(d7.bySegment.customer).toMatchObject({ purchased: 0, converted: 0, revenueCents: 0 });
    expect(d7.bySegment.member).toMatchObject({ purchased: 1, booked: 1, converted: 1, revenueCents: 9000 });
    expect(d7.totals.revenueCents).toBe(9000);
  });
});

describe("polls, CTAs and UTM", () => {
  it("poll results per option per mode", async () => {
    const r = await report(30);
    const p = r.polls.find((x) => x.pollId === poll.id)!;
    expect(p.respondents).toEqual({ live: 1, replay: 1, on_demand: 0 });
    expect(p.options.find((o) => o.key === "yes")!.counts).toEqual({ live: 1, replay: 0, on_demand: 0 });
    expect(p.options.find((o) => o.key === "no")!.counts).toEqual({ live: 0, replay: 1, on_demand: 0 });
  });

  it("CTA 'booked after' counts only bookings after the click", async () => {
    const r = await report(30);
    const c = r.ctas.find((x) => x.ctaId === cta.id)!;
    expect(c.shown).toEqual({ live: 1, replay: 1, on_demand: 0 });
    expect(c.clicked).toEqual({ live: 1, replay: 1, on_demand: 0 });
    expect(c.ctr).toBe(1);
    // The lead booked at day 10 and clicked at day 11; the member clicked at day 1 and booked at day 5.
    expect(c.bookedAfter).toBe(1);
    expect(c.purchasedAfter).toBe(1);
  });

  it("the UTM table groups registrations by source and campaign", async () => {
    const r = await report(30);
    expect(r.utm).toContainEqual({ source: "newsletter", campaign: "spring", registrations: 2, attended: 1, converted: 1, spendCents: null, costPerRegistrationCents: null, clickToRegistrationRate: null });
    expect(r.utm).toContainEqual({ source: "instagram", campaign: null, registrations: 1, attended: 1, converted: 1, spendCents: null, costPerRegistrationCents: null, clickToRegistrationRate: null });
    expect(r.utm).toContainEqual({ source: null, campaign: null, registrations: 1, attended: 0, converted: 0, spendCents: null, costPerRegistrationCents: null, clickToRegistrationRate: null });
  });
});

describe("CSV (rule 41)", () => {
  it("the aggregate CSV contains no email or name", async () => {
    const csv = buildReportCsv(await report(30));
    for (const p of Object.values(people)) expect(csv).not.toContain(p.email);
    expect(csv).not.toContain("@");
    expect(csv).not.toContain("Test Person");
    expect(csv.split("\r\n")[0]).toMatch(/^segment,registrations,live_registered,/);
    expect(csv).toContain("total,4,");
  });

  it("the registrant CSV lists each registrant with email and per-mode facts", async () => {
    const rows = await listRegistrantExportRows(h.db, w.id);
    expect(rows).toHaveLength(5);
    const csv = buildRegistrantsCsv(rows);
    expect(csv).toContain(people.lead.email);
    const header = csv.split("\r\n")[0]!.split(",");
    expect(header.slice(0, 4)).toEqual(["first_name", "last_name", "email", "status"]);
    const lead = rows.find((x) => x.email === people.lead.email)!;
    expect(lead.modes.live).toMatchObject({ started: true, attended: true, watchedSec: 600, pollAnswers: 1, ctaClicks: 1 });
    expect(rows.find((x) => x.email === people.customer.email)!.modes.live).toMatchObject({ started: false, attended: false, watchedSec: 0 });
  });

  it("cells are quoted and formula-like text is neutralised", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
  });
});

describe("ops-facing stats (section 4.7)", () => {
  it("countWebinarLeadsWithoutBooking counts the lead without a later booking, not the one who booked; the list has the same rows", async () => {
    const since = new Date(NOW - 60 * DAY);
    const n = await countWebinarLeadsWithoutBooking(h.db, { startedSince: since });
    const rows = await listWebinarLeadsWithoutBooking(h.db, { startedSince: since, limit: 1000 });
    expect(rows.filter((x) => x.webinarId === w.id).map((x) => x.personId)).toEqual([people.lead2.personId]);
    expect(rows).toHaveLength(n);
    // A window that starts after the webinar leaves it out.
    expect(await countWebinarLeadsWithoutBooking(h.db, { startedSince: new Date(NOW - 10 * DAY) })).toBe(0);
  });

  it("getPersonWebinarStats reads the person's stats; a person without history gets zeros", async () => {
    expect(await getPersonWebinarStats(h.db, people.lead.personId)).toMatchObject({ webinarsRegistered: 1, webinarsAttendedLive: 1, watchSecTotal: 600, pollAnswers: 1, ctaClicks: 1 });
    expect(await getPersonWebinarStats(h.db, people.member.personId)).toMatchObject({ webinarsAttendedLive: 0, replaysWatched: 1, watchSecTotal: 1200 });
    const nobody = await makePerson(h.db);
    expect(await getPersonWebinarStats(h.db, nobody.id)).toEqual({
      webinarsRegistered: 0,
      webinarsAttendedLive: 0,
      replaysWatched: 0,
      onDemandWatched: 0,
      watchSecTotal: 0,
      pollAnswers: 0,
      ctaClicks: 0,
      lastRegisteredAt: null,
      lastAttendedAt: null,
    });
  });

  it("listUpcomingWebinarHealth lists the next 48 hours with the broadcast state and registrations", async () => {
    const soon = await makeWebinar(h.db, { startsAt: new Date(NOW + 5 * 3600_000), youtubeLifecycle: "ready" }, { published: true });
    const far = await makeWebinar(h.db, { startsAt: new Date(NOW + 72 * 3600_000) }, { published: true });
    await makeRegistration(h.db, { webinarId: soon.id });
    const rows = await listUpcomingWebinarHealth(h.db, { hours: 48 });
    const mine = rows.find((x) => x.webinarId === soon.id);
    expect(mine).toMatchObject({ mode: "live", youtubeLifecycle: "ready", broadcastError: null, registrations: 1, title: "Beter slapen" });
    expect(rows.some((x) => x.webinarId === far.id)).toBe(false);
    expect(rows.some((x) => x.webinarId === w.id)).toBe(false);
  });
});
