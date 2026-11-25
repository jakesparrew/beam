/**
 * "Fill this session" (owner requirements 6): the audience of a session with free places (unused
 * credits of its kind, lapsed regulars, waiting lists) respects marketing consent and
 * suppressions, leaves out testers and people already booked, and the draft it makes is a static
 * segment plus a draft campaign aimed at it; nothing is queued or sent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, campaignRecipients, campaigns, emailMessages, persons, roles, segmentMembers, segments, waitlistEntries } from "@beam/db/schema";
import { seed as crmDefaults } from "@beam/db/seed/crm";
import { createTestDb, makePerson, makeSession, makeUser } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import { emailHash } from "@beam/core/crm";
import type { MarketingPurpose } from "@beam/core/email";
import { createAuthSession, SESSION_COOKIE } from "@/lib/auth";
import { eq, setAppDb, type Tx } from "@/lib/ctx";
import { makeCtx, resetRuntime, staffActor } from "@/lib/testing";
import { recordConsent, unsubscribe } from "@/modules/crm/api";
import { previewFillSession } from "./actions";
import { createFillDraft, fillPurpose, getFillAudience } from "./fill-session";
import { makeCustomer } from "./ops-p3.fixtures";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.31" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

let h: DbHandle;
const DAY = 86_400_000;
const NOW = new Date();
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await crmDefaults.run(h.db, {});
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** A real (non-tester) person with an email hash, optionally with marketing consent for `purpose`. */
async function person(opts: { consent?: MarketingPurpose; tester?: boolean } = {}) {
  const make = opts.tester ? makePerson : makeCustomer;
  const p = await make(h.db);
  await h.db.update(persons).set({ emailHash: emailHash(p.email!) }).where(eq(persons.id, p.id));
  if (opts.consent) {
    await recordConsent(h.db as unknown as Tx, makeCtx(h.db), { personId: p.id, purpose: opts.consent, status: "granted", method: "form", source: "test:form", wordingVersion: `${opts.consent}@1` });
  }
  return p;
}

async function book(sessionId: string, personId: string, status: "confirmed" | "attended" = "confirmed") {
  await h.db.insert(bookings).values({ sessionId, personId, status, paidWith: "free", source: "admin", ...(status === "attended" ? { attendedAt: NOW } : {}) });
}

async function staffCtx() {
  const user = await makeUser(h.db, { roleKey: "marketing" });
  return makeCtx(h.db, staffActor({ userId: user.id, roleKey: "marketing", permissions: ["email.write"] }));
}

// First, while the database holds nobody to invite.
describe("createFillDraft refusals", () => {
  it("refuses a session that already started and an empty audience", async () => {
    const ctx = await staffCtx();
    const started = await makeSession(h.db, { startsAt: new Date(NOW.getTime() - 3_600_000) });
    await expect(createFillDraft(ctx.tx, ctx, { sessionId: started.id, locale: "en" })).rejects.toThrow(/session_not_open/);
    const nobody = await makeSession(h.db, { startsAt: inDays(30) });
    expect((await getFillAudience(h.db, { sessionId: nobody.id, now: NOW })).total).toBe(0);
    await expect(createFillDraft(ctx.tx, ctx, { sessionId: nobody.id, locale: "en" })).rejects.toThrow(/audience_empty/);
  });
});

describe("fill-session audience", () => {
  it("credits of the right kind, lapsed regulars and waiting lists; consent, suppression, testers and booked people respected", async () => {
    const target = await makeSession(h.db, { startsAt: inDays(2), capacitySeats: 14 });

    const credits = await person({ consent: "newsletter" });
    await makeCreditGrant(h.db, { personId: credits.id, creditKind: "day", units: 3 });

    const noConsent = await person();
    await makeCreditGrant(h.db, { personId: noConsent.id, creditKind: "day", units: 3 });

    const unsubscribed = await person({ consent: "newsletter" });
    await makeCreditGrant(h.db, { personId: unsubscribed.id, creditKind: "day", units: 3 });
    await unsubscribe(h.db as unknown as Tx, makeCtx(h.db), { personId: unsubscribed.id, purpose: "newsletter", method: "unsubscribe_link", source: "test" });

    const nightOnly = await person({ consent: "newsletter" });
    await makeCreditGrant(h.db, { personId: nightOnly.id, creditKind: "night", units: 2 });

    const lapsed = await person({ consent: "newsletter" });
    for (const d of [-120, -90, -60]) await book((await makeSession(h.db, { startsAt: inDays(d) })).id, lapsed.id, "attended");

    const stillComing = await person({ consent: "newsletter" });
    for (const d of [-120, -90, -10]) await book((await makeSession(h.db, { startsAt: inDays(d) })).id, stillComing.id, "attended");

    const waiting = await person({ consent: "newsletter" });
    const full = await makeSession(h.db, { startsAt: inDays(4) });
    await h.db.insert(waitlistEntries).values({ sessionId: full.id, personId: waiting.id });

    const alreadyBooked = await person({ consent: "newsletter" });
    await makeCreditGrant(h.db, { personId: alreadyBooked.id, creditKind: "day", units: 3 });
    await book(target.id, alreadyBooked.id);

    const tester = await person({ consent: "newsletter", tester: true });
    await makeCreditGrant(h.db, { personId: tester.id, creditKind: "day", units: 3 });

    const a = await getFillAudience(h.db, { sessionId: target.id, now: NOW });
    expect(a).toEqual({ sessionId: target.id, purpose: "newsletter", total: 3, byReason: { credits: 1, lapsed_regular: 1, waitlist: 1 } });

    // A night session reaches the night-credit holder only (no night regulars or waiting lists here).
    const night = await makeSession(h.db, { kind: "night", startsAt: inDays(3) });
    expect(await getFillAudience(h.db, { sessionId: night.id, now: NOW })).toMatchObject({ total: 1, byReason: { credits: 1, lapsed_regular: 0, waitlist: 0 } });
  });

  it("events use the events consent", async () => {
    expect(fillPurpose("event")).toBe("events");
    expect(fillPurpose("day")).toBe("newsletter");
    const event = await makeSession(h.db, { kind: "event", startsAt: inDays(5) });
    const newsletterOnly = await person({ consent: "newsletter" });
    const eventsFan = await person({ consent: "events" });
    for (const p of [newsletterOnly, eventsFan]) await h.db.insert(waitlistEntries).values({ sessionId: (await makeSession(h.db, { kind: "event", startsAt: inDays(6) })).id, personId: p.id });
    expect(await getFillAudience(h.db, { sessionId: event.id, now: NOW })).toMatchObject({ purpose: "events", total: 1, byReason: { waitlist: 1 } });
  });
});

describe("createFillDraft", () => {
  it("makes a static segment of the audience and a draft campaign aimed at it, without sending", async () => {
    const target = await makeSession(h.db, { startsAt: inDays(2), capacitySeats: 14 });
    const p = await person({ consent: "newsletter" });
    await makeCreditGrant(h.db, { personId: p.id, creditKind: "day", units: 5 });
    const expected = await getFillAudience(h.db, { sessionId: target.id, now: NOW });
    const messagesBefore = (await h.db.select().from(emailMessages)).length;

    const ctx = await staffCtx();
    const r = await createFillDraft(ctx.tx, ctx, { sessionId: target.id, locale: "en" });

    expect(r.recipients).toBe(expected.total);
    const [seg] = await h.db.select().from(segments).where(eq(segments.id, r.segmentId));
    expect(seg).toMatchObject({ kind: "static", lastCount: expected.total });
    expect(seg!.name).toContain("Test session");
    const members = await h.db.select().from(segmentMembers).where(eq(segmentMembers.segmentId, r.segmentId));
    expect(members.map((m) => m.personId)).toContain(p.id);
    const [c] = await h.db.select().from(campaigns).where(eq(campaigns.id, r.campaignId));
    expect(c).toMatchObject({ status: "draft", segmentId: r.segmentId, purpose: "newsletter", scheduledAt: null, name: seg!.name });
    expect(await h.db.select().from(campaignRecipients).where(eq(campaignRecipients.campaignId, r.campaignId))).toEqual([]);
    expect((await h.db.select().from(emailMessages)).length).toBe(messagesBefore);
  });

});

describe("the fill actions need email.write", () => {
  it("Front Desk cannot preview; a marketer can", async () => {
    const s = await makeSession(h.db, { startsAt: inDays(2) });
    const as = async (permissions: string[]) => {
      const user = await makeUser(h.db, { roleKey: "reception" });
      await h.db.update(roles).set({ permissions }).where(eq(roles.key, "reception"));
      const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
      jar.set(SESSION_COOKIE, token);
    };
    await as(["persons.read", "tasks.all", "bookings.write"]);
    const desk = await previewFillSession({ sessionId: s.id });
    expect(desk.ok).toBe(false);
    if (!desk.ok) expect(desk.error.code).toBe("forbidden");
    await as(["email.write"]);
    const marketer = await previewFillSession({ sessionId: s.id });
    expect(marketer.ok).toBe(true);
  });
});
