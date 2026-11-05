/**
 * Registration and access links (webinar-P3; spec rules 14-20, the registration state table of
 * section 2.3, edge cases 10 and 11): the person and acquisition of a site registration, the
 * status snapshot, the `webinar.registered` event and its shape, consent only when ticked,
 * concurrency, the access email throttle, one case per arrow of the registration state table,
 * closed and replay registrations, the resend by customer service, revocation and the public
 * route (always 202, honeypot, referral code). site's `readReferralCode` and credits'
 * `resolveReferralCode` are mocked to their contracts (a code or null; a resolved code).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, consentRecords, emailMessages, persons, webinarRegistrations } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { isCurrentToken, verifyAccessToken } from "@beam/core/webinar";
import { webinarAccessKey, webinarAccessToken } from "@beam/email/templates/webinar";
import { ConflictError, NotFoundError, and, asc, createCtx, eq, sql, type Actor, type Ctx } from "@/lib/ctx";
import { makeCtx, staffActor } from "@/lib/testing";
import { readReferralCode } from "@/modules/site/api";
import { POST } from "@/app/api/public/webinars/[slug]/register/route";
import { FAKE_VIDEO_ID, makeRegistration, makeWebinar, type WebinarRow } from "../test/factories";
import {
  ACCESS_EMAILS_PER_HOUR,
  REGISTER_ERRORS,
  cancelMyRegistration,
  cancelRegistration,
  consentWordingVersion,
  registerByEmail,
  registerPerson,
  registerPersonByStaff,
  resendAccessLink,
  revokeAccessLink,
} from "./registration";

vi.mock("@/modules/site/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readReferralCode: vi.fn(() => null) }));
// credits resolves a known code (its contract); crm keeps only resolved codes on the acquisition.
vi.mock("@/modules/credits/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveReferralCode: vi.fn((_db: unknown, code: string) => Promise.resolve(code === "ABCD2345" ? { codeId: "00000000-0000-4000-8000-0000000000c1", referrerPersonId: null, partnerCompanyId: null } : null)),
}));

let h: DbHandle;
let ownerId: string;

beforeAll(async () => {
  h = await createTestDb();
  ownerId = (await makeUser(h.db)).id;
}, 120_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  vi.mocked(readReferralCode).mockReset().mockReturnValue(null);
});

const PUBLIC: Actor = { kind: "public" };
const ctxOf = (actor: Actor = PUBLIC, now?: Date): Ctx => makeCtx(h.db, { actor, ...(now ? { now } : {}) });
const tx = () => h.db as unknown as Tx;
const published = (o: Partial<WebinarRow> = {}) => makeWebinar(h.db, { ownerUserId: ownerId, ...o }, { published: true });
const regOf = async (webinarId: string, personId: string) =>
  (await h.db.select().from(webinarRegistrations).where(and(eq(webinarRegistrations.webinarId, webinarId), eq(webinarRegistrations.personId, personId))))[0];
const eventsOf = (registrationId: string, kind = "webinar.registered") =>
  h.db.select().from(activityEvents).where(and(eq(activityEvents.refId, registrationId), eq(activityEvents.kind, kind))).orderBy(asc(activityEvents.id));
const accessEmails = (registrationId: string) => h.db.select().from(emailMessages).where(sql`${emailMessages.idempotencyKey} like ${`webinar_reg:${registrationId}:access:%`}`);
const reg = (w: WebinarRow, personId: string, extra: Partial<Parameters<typeof registerPerson>[2]> = {}) =>
  registerPerson(tx(), ctxOf(), { webinarId: w.id, personId, source: "site", locale: "nl-BE", utm: {}, ...extra });
const expectConflict = async (p: Promise<unknown>, message: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ConflictError);
  expect((e as Error).message).toBe(message);
};

describe("register from the site (rules 14, 16, 18)", () => {
  it("creates the person with acquisition webinar, snapshots lead and writes webinar.registered with the session", async () => {
    const w = await published();
    const email = `new-${Date.now()}@example.com`;
    const r = await registerByEmail(tx(), ctxOf(), w, { email, firstName: "Nina", lastName: "Peeters", locale: "nl-BE", utm: { source: "facebook", campaign: "spring" } });
    expect(r.created).toBe(true);
    const [p] = await h.db.select().from(persons).where(eq(persons.email, email));
    expect(p!.acquisition).toMatchObject({ source: "webinar", campaign: w.slug, webinar_id: w.id, utm: { source: "facebook", campaign: "spring" } });
    expect((p!.acquisition as Record<string, unknown>).referral_code).toBeUndefined();
    const row = (await regOf(w.id, p!.id))!;
    expect(row).toMatchObject({ status: "registered", source: "site", personStatus: "lead", registeredMode: "live", locale: "nl-BE", utm: { source: "facebook", campaign: "spring" } });
    const [e] = await eventsOf(row.id);
    expect(e).toMatchObject({ personId: p!.id, mode: "live", refType: "webinar_registration", refId: row.id, dedupeKey: `webinar_reg:${row.id}:registered:v${w.version}` });
    const data = e!.data as Record<string, unknown>;
    expect(data.session).toEqual({ id: w.sessionId, kind: "event" });
    expect(data.starts_at).toBe(w.startsAt!.toISOString());
    expect(data.ends_at).toBe(new Date(w.startsAt!.getTime() + 60 * 60_000).toISOString());
    expect(data).toMatchObject({ webinar_id: w.id, slug: w.slug, webinar_mode: "live", registration_id: row.id, person_status: "lead", source: "site" });
    // Registration is not attendance (rule 17) and grants no consent (rule 18).
    expect(await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, p!.id), sql`${activityEvents.kind} like 'webinar.%'`))).toHaveLength(1);
    expect(await h.db.select().from(consentRecords).where(eq(consentRecords.personId, p!.id))).toHaveLength(0);
    // The access email is queued at once with the ids in context.
    const [m] = await accessEmails(row.id);
    expect(m).toMatchObject({ personId: p!.id, locale: "nl-BE", idempotencyKey: `webinar_reg:${row.id}:access:1`, context: { webinar_id: w.id, registration_id: row.id } });
    expect((m!.props as { accessUrl: string }).accessUrl).toMatch(new RegExp(`/nl/w/${row.id}\\.1\\.`));
  });

  it.each(["customer", "member"] as const)("snapshots the status %s and never recomputes it", async (status) => {
    const w = await published();
    const p = await makePerson(h.db, { statusOverride: status, statusOverrideReason: "test" });
    await reg(w, p.id);
    expect((await regOf(w.id, p.id))!.personStatus).toBe(status);
    await h.db.update(persons).set({ statusOverride: "lead" }).where(eq(persons.id, p.id));
    await reg(w, p.id);
    expect((await regOf(w.id, p.id))!.personStatus).toBe(status);
  });

  it("a ticked box writes one consent_records row with the wording version shown", async () => {
    const w = await published();
    const p = await makePerson(h.db);
    const { registrationId } = await reg(w, p.id, { consents: { events: true, newsletter: false }, wordingVersion: "v1" });
    const rows = await h.db.select().from(consentRecords).where(eq(consentRecords.personId, p.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "events", status: "granted", method: "form", source: `webinar:${w.slug}`, wordingVersion: "events@1", refType: "webinar_registration", refId: registrationId });
  });

  it("maps the wording version per purpose", () => {
    expect(consentWordingVersion("events", "v2")).toBe("events@2");
    expect(consentWordingVersion("newsletter", "3")).toBe("newsletter@3");
    expect(consentWordingVersion("events", "events@4")).toBe("events@4");
    expect(() => consentWordingVersion("events", "newsletter@4")).toThrow();
  });

  it("two concurrent registrations of one person give one row and one event", async () => {
    const w = await published();
    const p = await makePerson(h.db);
    const run = () => h.db.transaction((t) => registerPerson(t, createCtx({ tx: t, actor: PUBLIC }), { webinarId: w.id, personId: p.id, source: "site", locale: "nl-BE", utm: {} }));
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.registrationId).toBe(b.registrationId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await h.db.select().from(webinarRegistrations).where(eq(webinarRegistrations.personId, p.id))).toHaveLength(1);
    expect(await eventsOf(a.registrationId)).toHaveLength(1);
  });

  it("registering again is the same row without a second event, and a 4th access email in an hour is not sent", async () => {
    const w = await published();
    const p = await makePerson(h.db);
    const first = await reg(w, p.id);
    for (let i = 0; i < 4; i++) expect((await reg(w, p.id, { source: "portal" })).registrationId).toBe(first.registrationId);
    expect(await eventsOf(first.registrationId)).toHaveLength(1);
    expect(await accessEmails(first.registrationId)).toHaveLength(ACCESS_EMAILS_PER_HOUR);
    const row = (await regOf(w.id, p.id))!;
    expect(row).toMatchObject({ source: "site", accessEmailsSent: 3 });
    // More than an hour later the counter restarts and the key stays unique.
    const later = new Date(row.lastAccessEmailAt!.getTime() + 61 * 60_000);
    await registerPerson(tx(), ctxOf(PUBLIC, later), { webinarId: w.id, personId: p.id, source: "site", locale: "nl-BE", utm: {} });
    expect(await accessEmails(first.registrationId)).toHaveLength(4);
    expect((await regOf(w.id, p.id))!.accessEmailsSent).toBe(1);
  });
});

describe("the registration state table (section 2.3)", () => {
  it("(none) -> registered, registered -> cancelled, cancelled -> registered with a fresh webinar.registered", async () => {
    const w = await published();
    const p = await makePerson(h.db);
    const { registrationId } = await reg(w, p.id);
    expect((await regOf(w.id, p.id))!.status).toBe("registered");

    expect(await cancelRegistration(tx(), ctxOf({ kind: "customer", userId: ownerId, personId: p.id }), registrationId, "customer")).toEqual({ cancelled: true });
    const cancelled = (await regOf(w.id, p.id))!;
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    const [c] = await eventsOf(registrationId, "webinar.registration_cancelled");
    expect(c).toMatchObject({ mode: "live", data: { webinar_id: w.id, registration_id: registrationId, by: "customer" } });
    // Cancelling twice changes nothing.
    expect(await cancelRegistration(tx(), ctxOf(), registrationId, "customer")).toEqual({ cancelled: false });

    const again = await reg(w, p.id);
    expect(again).toEqual({ registrationId, created: false });
    expect((await regOf(w.id, p.id))!).toMatchObject({ status: "registered", cancelledAt: null });
    const events = await eventsOf(registrationId);
    expect(events).toHaveLength(2);
    expect(events[1]!.dedupeKey).toBe(`webinar_reg:${registrationId}:registered:v${w.version}:after:${cancelled.cancelledAt!.toISOString().slice(0, 16)}`);
  });

  it("registered -> blocked and blocked -> registered belong to moderation; registering while blocked changes nothing", async () => {
    const w = await published();
    const blocked = await makeRegistration(h.db, { webinarId: w.id, status: "blocked" });
    const before = (await regOf(w.id, blocked.personId))!;
    await expectConflict(reg(w, blocked.personId), REGISTER_ERRORS.blocked);
    expect(await regOf(w.id, blocked.personId)).toEqual(before);
    expect(await accessEmails(blocked.id)).toHaveLength(0);
    // A cancelled registration cannot be cancelled into another state, and a blocked one cannot be cancelled.
    await expectConflict(cancelRegistration(tx(), ctxOf(), blocked.id, "staff"), "registration_blocked");
  });

  it("the customer cancels only their own registration", async () => {
    const w = await published();
    const mine = await makeRegistration(h.db, { webinarId: w.id });
    const other = await makePerson(h.db);
    const ctx = ctxOf({ kind: "customer", userId: ownerId, personId: other.id });
    await expect(cancelMyRegistration(ctx, other.id, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    const own = ctxOf({ kind: "customer", userId: ownerId, personId: mine.personId });
    expect(await cancelMyRegistration(own, mine.personId, mine.id)).toEqual({ cancelled: true });
  });
});

describe("closed and replay registrations (rule 15)", () => {
  it("a cancelled or archived webinar refuses a new registration", async () => {
    for (const status of ["cancelled", "archived"] as const) {
      const w = await makeWebinar(h.db, { ownerUserId: ownerId, status, cancelledReason: status === "cancelled" ? "test" : null }, { published: true });
      await expectConflict(reg(w, (await makePerson(h.db)).id), REGISTER_ERRORS.closed);
    }
  });

  it("a gated replay refuses after the end; an open replay registers with registered_mode replay", async () => {
    const ended = { status: "ended" as const, startsAt: new Date(Date.now() - 3 * 3600_000), liveStartedAt: new Date(Date.now() - 3 * 3600_000), liveEndedAt: new Date(Date.now() - 2 * 3600_000), recordingVideoId: FAKE_VIDEO_ID, durationSec: 3600 };
    const gated = await published({ ...ended, isReplayGated: true });
    await expectConflict(reg(gated, (await makePerson(h.db)).id), REGISTER_ERRORS.closed);
    const open = await published({ ...ended, isReplayGated: false });
    const p = await makePerson(h.db);
    await reg(open, p.id);
    expect((await regOf(open.id, p.id))!.registeredMode).toBe("replay");
  });

  it("an on-demand webinar registers in on_demand without a session", async () => {
    const w = await published({ mode: "on_demand", startsAt: null });
    const p = await makePerson(h.db);
    const { registrationId } = await reg(w, p.id);
    const [e] = await eventsOf(registrationId);
    expect(e).toMatchObject({ mode: "on_demand", data: { starts_at: null, ends_at: null, session: null, webinar_mode: "on_demand" } });
  });
});

describe("staff paths and access links (rules 14, 19, section 7)", () => {
  it("registerPersonByStaff needs persons.read and registers with source admin", async () => {
    const w = await published();
    const p = await makePerson(h.db, { locale: "fr-BE" });
    const noRead = ctxOf(staffActor({ userId: ownerId, permissions: ["webinars.host"] }));
    await expect(registerPersonByStaff(noRead, { webinarId: w.id, personId: p.id, sendAccessEmail: true })).rejects.toThrow();
    const ctx = ctxOf(staffActor({ userId: ownerId, permissions: ["webinars.host", "persons.read"] }));
    const { registrationId } = await registerPersonByStaff(ctx, { webinarId: w.id, personId: p.id, sendAccessEmail: false });
    expect((await regOf(w.id, p.id))!).toMatchObject({ id: registrationId, source: "admin", locale: "fr-BE", accessEmailsSent: 0 });
    expect(await accessEmails(registrationId)).toHaveLength(0);
  });

  it("resendAccessLink works for a customer_service user and keeps the throttle", async () => {
    const w = await published();
    const r = await makeRegistration(h.db, { webinarId: w.id });
    const ctx = ctxOf(staffActor({ userId: ownerId, roleKey: "customer_service", permissions: ["persons.read"] }));
    for (let i = 0; i < 4; i++) await resendAccessLink(ctx, r.id);
    expect(await accessEmails(r.id)).toHaveLength(3);
    const cancelled = await makeRegistration(h.db, { webinarId: w.id, status: "cancelled" });
    await expectConflict(resendAccessLink(ctx, cancelled.id), "registration_cancelled");
  });

  it("revokeAccessLink bumps token_version: the old link is no longer current", async () => {
    const w = await published();
    const p = await makePerson(h.db);
    const { registrationId } = await reg(w, p.id);
    const oldToken = webinarAccessToken(registrationId, 1);
    expect(isCurrentToken(verifyAccessToken(webinarAccessKey(), oldToken)!, (await regOf(w.id, p.id))!, oldToken)).toBe(true);
    await revokeAccessLink(ctxOf(staffActor({ userId: ownerId, permissions: ["webinars.host", "persons.read"] })), registrationId);
    const row = (await regOf(w.id, p.id))!;
    expect(row.tokenVersion).toBe(2);
    expect(isCurrentToken(verifyAccessToken(webinarAccessKey(), oldToken)!, row, oldToken)).toBe(false);
    const fresh = webinarAccessToken(registrationId, 2);
    expect(isCurrentToken(verifyAccessToken(webinarAccessKey(), fresh)!, row, fresh)).toBe(true);
  });
});

describe("POST /api/public/webinars/[slug]/register (section 4.4)", () => {
  const post = (slug: string, body: unknown, headers: Record<string, string> = {}) =>
    POST(
      new Request(`http://localhost/api/public/webinars/${slug}/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug }) },
    );
  const body = (email: string) => ({ email, firstName: "Ann", locale: "nl-BE", consents: {}, wordingVersion: "v1", utm: {} });

  it("always answers 202: new person, repeated, blocked; a filled honeypot writes nothing", async () => {
    makeCtx(h.db); // the route's database
    const w = await published();
    const email = `route-${Date.now()}@example.com`;
    expect((await post(w.slug, body(email))).status).toBe(202);
    expect((await post(w.slug, body(email))).status).toBe(202);
    const [p] = await h.db.select().from(persons).where(eq(persons.email, email));
    expect(await h.db.select().from(webinarRegistrations).where(eq(webinarRegistrations.personId, p!.id))).toHaveLength(1);

    const blocked = await makeRegistration(h.db, { webinarId: w.id, status: "blocked" });
    const [bp] = await h.db.select().from(persons).where(eq(persons.id, blocked.personId));
    const res = await post(w.slug, body(bp!.email!));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });

    const bot = `bot-${Date.now()}@example.com`;
    expect((await post(w.slug, { ...body(bot), website: "https://spam.example.com" })).status).toBe(202);
    expect(await h.db.select().from(persons).where(eq(persons.email, bot))).toHaveLength(0);
    expect((await post("no-such-webinar", body(`x-${Date.now()}@example.com`))).status).toBe(404);
  });

  it("passes acquisition.referral_code from site.readReferralCode for a new person, and none without the cookie", async () => {
    makeCtx(h.db);
    const w = await published();
    vi.mocked(readReferralCode).mockReturnValue("ABCD2345");
    const withCode = `ref-${Date.now()}@example.com`;
    expect((await post(w.slug, body(withCode), { cookie: "beam_ref=ABCD2345" })).status).toBe(202);
    const [a] = await h.db.select().from(persons).where(eq(persons.email, withCode));
    expect(a!.acquisition).toMatchObject({ source: "webinar", referral_code: "ABCD2345" });
    expect(vi.mocked(readReferralCode).mock.calls.at(-1)![0].get("beam_ref")).toEqual({ value: "ABCD2345" });

    vi.mocked(readReferralCode).mockReturnValue(null);
    const without = `noref-${Date.now()}@example.com`;
    expect((await post(w.slug, body(without))).status).toBe(202);
    const [b] = await h.db.select().from(persons).where(eq(persons.email, without));
    expect((b!.acquisition as Record<string, unknown>).referral_code).toBeUndefined();
  });

  it("a closed webinar answers 409 and creates no person", async () => {
    makeCtx(h.db);
    const w = await makeWebinar(h.db, { ownerUserId: ownerId, status: "ended", liveEndedAt: new Date(Date.now() - 3600_000), isReplayEnabled: false }, { published: true });
    const email = `closed-${Date.now()}@example.com`;
    const res = await post(w.slug, body(email));
    expect(res.status).toBe(409);
    expect(await h.db.select().from(persons).where(eq(persons.email, email))).toHaveLength(0);
  });
});
