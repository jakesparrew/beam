/**
 * The day view of the dashboard (owner requirements 6): capacity per session and the revenue of
 * a day on PGlite fixtures, the clients of a day with their membership and package status, the
 * opportunity rules, and who sees which block. Days are Brussels dates relative to today, with
 * sessions and payments at midday, so the tests pass at any hour and across DST.
 */
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, capacityHolds } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant, makeEntry, makeMembership } from "@beam/db/testing/credits-factories";
import { resetRuntime, staffActor } from "@/lib/testing";
import { translator } from "@/lib/i18n";
import { brusselsDate } from "../reports/revenue";
import { makeCustomer } from "./ops-p3.fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const { clientOpportunities, dailyAccess, getClientSnapshot, getDailyCapacity, getDailyRevenue, listDayClients, parseDay, shiftDay } = await import("./daily");
const { DailyDashboard } = await import("../ui/DailyDashboard");
type DayClient = Awaited<ReturnType<typeof listDayClients>>[number];

let h: DbHandle;
const NOW = new Date();
const TODAY = brusselsDate(NOW);
const DAY = 86_400_000;
/** 11:00 or 12:00 Brussels on `day` (`hourUtc` 10), always that Brussels day. */
const at = (day: string, hourUtc = 10) => new Date(`${day}T${String(hourUtc).padStart(2, "0")}:00:00Z`);

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function book(sessionId: string, personId: string, status: "confirmed" | "cancelled" | "attended" = "confirmed") {
  await h.db.insert(bookings).values({
    sessionId,
    personId,
    status,
    paidWith: "free",
    source: "admin",
    ...(status === "cancelled" ? { cancelledAt: NOW, cancelReasonCode: "customer" as const } : {}),
    ...(status === "attended" ? { attendedAt: NOW } : {}),
  });
}

describe("days", () => {
  it("shiftDay moves calendar days across month ends and DST changes", () => {
    expect(shiftDay("2026-10-24", 1)).toBe("2026-10-25");
    expect(shiftDay("2026-10-25", 1)).toBe("2026-10-26");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("parseDay keeps a real date and falls back to today in Brussels", () => {
    expect(parseDay("2026-11-30", NOW)).toBe("2026-11-30");
    expect(parseDay("2026-02-30", NOW)).toBe(TODAY);
    expect(parseDay("tomorrow", NOW)).toBe(TODAY);
    expect(parseDay(undefined, new Date("2026-11-24T23:30:00Z"))).toBe("2026-11-25");
  });
});

describe("getDailyCapacity", () => {
  it("lists the day's sessions with capacity, bookings, holds and free places, and totals them", async () => {
    const day = shiftDay(TODAY, 20);
    const dayS = await makeSession(h.db, { startsAt: at(day, 9), capacitySeats: 14 });
    const night = await makeSession(h.db, { kind: "night", startsAt: at(day, 19), endsAt: new Date(at(day, 19).getTime() + 12 * 3_600_000), capacityBeds: 8 });
    // Left out: a cancelled session, a webinar session, a session of the next day.
    await makeSession(h.db, { startsAt: at(day, 12), status: "cancelled", cancelledAt: NOW });
    await makeSession(h.db, { startsAt: at(day, 13), webinarId: randomUUID() });
    await makeSession(h.db, { startsAt: at(shiftDay(day, 1), 9) });
    for (let i = 0; i < 3; i++) await book(dayS.id, (await makeCustomer(h.db)).id);
    await book(dayS.id, (await makeCustomer(h.db)).id, "cancelled");
    await h.db.insert(capacityHolds).values({ sessionId: dayS.id, kind: "staff", quantity: 2 });
    for (let i = 0; i < 2; i++) await book(night.id, (await makeCustomer(h.db)).id);

    const r = await getDailyCapacity(h.db, { day, locale: "en" });
    expect(r.slots.map((s) => s.sessionId)).toEqual([dayS.id, night.id]);
    expect(r.slots[0]).toMatchObject({ kind: "day", capacity: 14, booked: 3, held: 2, available: 9 });
    expect(r.slots[1]).toMatchObject({ kind: "night", capacity: 8, booked: 2, held: 0, available: 6 });
    expect(r.total).toEqual({ capacity: 22, booked: 5, held: 2, available: 15 });
  });

  it("is empty on a day without sessions", async () => {
    expect(await getDailyCapacity(h.db, { day: shiftDay(TODAY, 400), locale: "en" })).toEqual({ slots: [], total: { capacity: 0, booked: 0, held: 0, available: 0 } });
  });
});

describe("getDailyRevenue", () => {
  it("groups the day's paid orders (till included, testers left out) and compares with the same weekday last week", async () => {
    const day = shiftDay(TODAY, -30);
    const before = shiftDay(day, -7);
    const p = await makeCustomer(h.db);
    await makePaidOrder(h.db, {
      personId: p.id,
      order: { paidAt: at(day) },
      lines: [
        { productKind: "session", unitAmountCents: 12_000 },
        { productKind: "night", unitAmountCents: 42_000 },
        { productKind: "package", unitAmountCents: 60_000 },
        { productKind: "membership", unitAmountCents: 39_600 },
        { productKind: "ticket", unitAmountCents: 2_500 },
        { productKind: "item", unitAmountCents: 1_500 },
      ],
    });
    await makePaidOrder(h.db, { personId: p.id, order: { paidAt: at(day, 15), channel: "pos" }, lines: [{ productKind: "item", unitAmountCents: 1_000 }] });
    await makePaidOrder(h.db, { personId: (await makePerson(h.db)).id, order: { paidAt: at(day) }, lines: [{ productKind: "package", unitAmountCents: 99_900 }] }); // tester
    await makePaidOrder(h.db, { personId: p.id, order: { paidAt: at(before) }, lines: [{ productKind: "session", unitAmountCents: 12_000 }] });

    const r = await getDailyRevenue(h.db, { day });
    expect(r.compareDay).toBe(before);
    const g = Object.fromEntries(r.groups.map((x) => [x.key, x.sales.current]));
    expect(g).toEqual({ sessions: 54_000, packages: 60_000, memberships: 39_600, events: 2_500, other: 2_500 });
    expect(r.net.current).toBe(158_600);
    expect(r.net.previous).toBe(12_000);
    expect(r.groups.find((x) => x.key === "sessions")!.sales.previous).toBe(12_000);
    expect(r.refunds.current).toBe(0);
  });
});

describe("listDayClients", () => {
  it("lists who comes with membership, free credits, packages and first visit; cancelled and testers left out", async () => {
    const day = shiftDay(TODAY, 3);
    const morning = await makeSession(h.db, { startsAt: at(day, 9), capacitySeats: 14 });
    const night = await makeSession(h.db, { kind: "night", startsAt: at(day, 19), capacityBeds: 8 });

    const first = await makeCustomer(h.db, { firstName: "Ann", lastName: "First" });
    await book(morning.id, first.id);

    const regular = await makeCustomer(h.db, { firstName: "Bert", lastName: "Regular" });
    const past = await makeSession(h.db, { startsAt: new Date(NOW.getTime() - 40 * DAY) });
    await book(past.id, regular.id, "attended");
    await book(morning.id, regular.id);
    await book(night.id, regular.id);
    const pack = await makeCreditGrant(h.db, { personId: regular.id, creditKind: "day", units: 10 });
    await makeEntry(h.db, { grantId: pack.id, kind: "consume", quantity: -9 });
    const cancelAt = new Date(NOW.getTime() + 10 * DAY);
    const m = await makeMembership(h.db, { personId: regular.id, cancelAt });
    await makeCreditGrant(h.db, { personId: regular.id, source: "membership", membershipId: m.id, creditKind: "night", units: 1 });

    const cancelled = await makeCustomer(h.db);
    await book(morning.id, cancelled.id, "cancelled");
    await book(morning.id, (await makePerson(h.db)).id); // tester

    const rows = await listDayClients(h.db, { day, now: NOW });
    expect(rows.map((r) => r.personId)).toEqual([first.id, regular.id]);
    const ann = rows.find((r) => r.personId === first.id)!;
    expect(ann).toMatchObject({ name: "Ann First", isFirstVisit: true, membership: null, packages: [] });
    const bert = rows.find((r) => r.personId === regular.id)!;
    expect(bert.sessions.map((s) => s.sessionId)).toEqual([morning.id, night.id]);
    expect(bert.isFirstVisit).toBe(false);
    expect(bert.membership).toMatchObject({ status: "active", renews: false, freeLeft: [{ kind: "night", units: 1 }] });
    expect(bert.membership!.endsAt.getTime()).toBe(cancelAt.getTime());
    expect(bert.packages).toEqual([{ kind: "day", remaining: 1, total: 10, nextExpiresAt: pack.expiresAt }]);
    expect(clientOpportunities(bert, NOW).map((o) => o.key).sort()).toEqual(["free_session_unused", "membership_renewal", "package_low"]);
    expect(clientOpportunities(ann, NOW).map((o) => o.key)).toEqual(["first_visit"]);

    // The 360's snapshot of one person reads the same membership, packages and first visit.
    expect(await getClientSnapshot(h.db, { personId: regular.id, now: NOW })).toEqual({ ...bert, sessions: [] });
    expect(await getClientSnapshot(h.db, { personId: first.id, now: NOW })).toEqual({ ...ann, sessions: [] });
    expect(await getClientSnapshot(h.db, { personId: randomUUID(), now: NOW })).toBeNull();
  });
});

describe("clientOpportunities", () => {
  const base: DayClient = { personId: randomUUID(), name: "X", sessions: [], isFirstVisit: false, membership: null, packages: [] };
  const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);

  it("nothing for a regular without package or membership", () => {
    expect(clientOpportunities(base, NOW)).toEqual([]);
  });

  it("package used up or almost: offer a new one; otherwise credits expiring within 30 days", () => {
    const opps = (packages: DayClient["packages"]) => clientOpportunities({ ...base, packages }, NOW);
    expect(opps([{ kind: "day", remaining: 0, total: 5, nextExpiresAt: null }])).toEqual([{ key: "package_low", kind: "day", units: 0 }]);
    expect(opps([{ kind: "night", remaining: 1, total: 3, nextExpiresAt: inDays(5) }])).toEqual([{ key: "package_low", kind: "night", units: 1 }]);
    expect(opps([{ kind: "day", remaining: 4, total: 10, nextExpiresAt: inDays(20) }])).toEqual([{ key: "package_expiring", kind: "day", units: 4, date: inDays(20) }]);
    expect(opps([{ kind: "day", remaining: 4, total: 10, nextExpiresAt: inDays(40) }])).toEqual([]);
  });

  it("membership: renewal talk when past due or ending within 30 days without renewing; free sessions left", () => {
    const member = (m: Partial<NonNullable<DayClient["membership"]>>) =>
      clientOpportunities({ ...base, membership: { status: "active", endsAt: inDays(200), renews: true, freeLeft: [], ...m } }, NOW).map((o) => o.key);
    expect(member({})).toEqual([]);
    expect(member({ renews: true, endsAt: inDays(5) })).toEqual([]);
    expect(member({ renews: false, endsAt: inDays(25) })).toEqual(["membership_renewal"]);
    expect(member({ renews: false, endsAt: inDays(45) })).toEqual([]);
    expect(member({ status: "past_due", endsAt: inDays(100) })).toEqual(["membership_renewal"]);
    expect(member({ freeLeft: [{ kind: "day", units: 4 }] })).toEqual(["free_session_unused"]);
  });

  it("first visit", () => {
    expect(clientOpportunities({ ...base, isFirstVisit: true }, NOW).map((o) => o.key)).toEqual(["first_visit"]);
  });
});

describe("who sees which block", () => {
  const access = (permissions: string[]) => dailyAccess(staffActor({ permissions }));

  it("Front Desk (reception) sees capacity and clients but no revenue and no campaign button", () => {
    expect(access(["persons.read", "persons.write", "bookings.read", "bookings.write", "waitlist.manage", "commerce.sell", "credits.read", "tasks.all"])).toEqual({
      capacity: true,
      clients: true,
      fill: false,
      revenue: false,
    });
  });

  it("finance sees revenue; marketing can fill a session; client details need persons.read", () => {
    expect(access(["persons.read", "reports.read", "reports.finance"])).toMatchObject({ revenue: true, fill: false });
    expect(access(["persons.read", "reports.read", "email.write"])).toMatchObject({ revenue: false, fill: true });
    expect(access(["reports.read"])).toEqual({ capacity: true, clients: false, fill: false, revenue: false });
    expect(access(["persons.read", "email.write", "reports.finance"])).toEqual({ capacity: false, clients: false, fill: false, revenue: false });
  });

  it("the rendered blocks follow the access", async () => {
    const day = shiftDay(TODAY, 3);
    const tr = translator("en");
    const render = async (permissions: string[]) => {
      const ctx = { tx: h.db, actor: staffActor({ permissions }), now: NOW, locale: "en" as const };
      return renderToStaticMarkup(await DailyDashboard({ ctx, tr, day, access: dailyAccess(ctx.actor), errors: {} }));
    };
    const desk = await render(["persons.read", "tasks.all"]);
    expect(desk).toContain('data-testid="daily-capacity"');
    expect(desk).toContain('data-testid="daily-clients"');
    expect(desk).toContain("Ann First");
    expect(desk).not.toContain('data-testid="daily-revenue"');
    expect(desk).not.toContain('data-testid="fill-session"');

    const owner = await render(["reports.read", "reports.finance", "persons.read", "email.write"]);
    expect(owner).toContain('data-testid="daily-revenue"');
    expect(owner).toContain('data-opportunity="first_visit"');

    const noClients = await render(["reports.read"]);
    expect(noClients).not.toContain('data-testid="daily-clients"');
    expect(noClients).not.toContain("Ann First");
  });
});
