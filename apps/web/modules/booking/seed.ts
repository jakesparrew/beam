/**
 * booking's demo seed (runbook 6.3, booking-P2), run by `apps/web/scripts/seed-demo.ts` in
 * `after` order. Facade read by `pnpm gen:indexes`. Writes the demo schedule and the demo
 * lecture (`seedBookingDemo` in `@beam/db/seed/booking`) and materialises the next 90 days, so
 * a seeded `beam_dev` shows sessions in `/admin/sessions`. Idempotent.
 *
 * Demo activity (`seedDemoVisits`): the demo templates are moved back `DEMO_HISTORY_DAYS` and
 * that history is materialised, then the credit holders of commerce's and credits' demo seeds
 * visit through the real engine (`bookSeats` by a staff user at the booking moment, paid with
 * credits): past visits attended (the `booking.attended` change of the check-in action),
 * no-show (`markNoShowRow`) or cancelled (`cancelBookingRow`), upcoming ones confirmed, nights
 * (Wednesday to Sunday), a handful of busy day sessions this week (two of them full, with a
 * waiting list) and registrations for the demo lecture. A person is booked on a session only
 * once (any status), so a rerun the same day adds nothing; a refused booking (no credits left,
 * full) is skipped. Today's visits that already ended on the wall clock are checked in.
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "@beam/db";
import { bookings, sessionTemplates, sessions, users, waitlistEntries, wellbeingCheckins } from "@beam/db/schema";
import { BookingConflictError, MATERIALISE_DAYS, addDays, bookingTransition, brusselsDate, zonedTimeToUtc, type BookingRules } from "@beam/core/booking";
import { DEMO_DAY_SLOTS, seedBookingDefaults, seedBookingDemo } from "@beam/db/seed/booking";
import { ConflictError, and, asc, createCtx, eq, gt, gte, inArray, isNull, lt, lte, sql, type Actor, type Ctx, type Permission } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import type { SeedCtx } from "@/scripts/seed-demo";
import { markNoShowRow } from "./jobs/attendance";
import { materialiseRange } from "./jobs/schedule";
import { LIVE_STATUSES, bookSeats, type BookingRow, type SessionRow } from "./server/book";
import { cancelBookingRow } from "./server/cancel";
import { joinWaitlistRow } from "./server/claim";
import { recordBookingFact } from "./server/facts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Days of schedule materialised behind today, so past visits have sessions. */
export const DEMO_HISTORY_DAYS = 63;
const SLOTS = DEMO_DAY_SLOTS;

type Outcome = "attended" | "no_show" | "cancelled" | "late_cancelled";
/** One planned visit: `person` is the `DemoIds` key, `day` the offset from today (the first matching session on or after it). */
export type DemoVisit = { person: string; kind: "day" | "night"; day: number; at: string | null; outcome: Outcome | null };

/** Day-credit holders: `DemoIds` key, first visit window (days ago, after the purchase) and number of visits. */
const DAY_GUESTS: readonly (readonly [string, number, number])[] = [
  ["platform.person.customer1", 60, 5],
  ["platform.person.customer2", 60, 3], // on Lotte's shared package (credits' demo seed)
  ["platform.person.customer3", 56, 4], // 4 of 5: nearly finished
  ["platform.person.customer4", 36, 3],
  ["platform.person.customer5", 60, 6],
  ...[6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => [`platform.person.customer${n}`, 18 + (n - 6) * 4, 2] as const),
  ...[17, 18, 19].map((n) => [`platform.person.customer${n}`, 10 + (n - 17) * 6, 1] as const),
  ["crm.customer.an-verbruggen", 58, 5],
  ["crm.customer.koen-de-wilde", 60, 4],
  ["crm.customer.julie-moreau", 31, 2],
  ["crm.customer.sarah-lenaerts", 8, 1], // her bonus day
  ["crm.customer.lies-vermeulen", 60, 4], // 4 of 5: nearly finished
  ["crm.customer.tom-claes", 60, 10],
  ["crm.customer.nora-dumont", 19, 2],
  ["crm.customer.geert-lemmens", 60, 4],
  ["crm.customer.sophie-laurent", 48, 3],
  ["crm.customer.james-cooper", 32, 2],
];

/** Night visits (the first night from the day offset): person, day offset, outcome of a past night. */
const NIGHT_VISITS: readonly (readonly [string, number, Outcome | null])[] = [
  ["platform.person.customer2", -44, "attended"],
  ["platform.person.customer2", 4, null],
  ["crm.customer.james-cooper", -27, "attended"],
  ["crm.customer.james-cooper", -13, "no_show"],
  ["crm.customer.james-cooper", 4, null],
  ["crm.customer.sarah-lenaerts", -41, "attended"],
  ["crm.customer.sarah-lenaerts", 4, null],
  ["crm.customer.hannah-clarke", -7, "attended"],
  ["crm.customer.hannah-clarke", 11, null],
  ["platform.person.customer4", 4, null], // the membership's free night
  ["crm.customer.geert-lemmens", 4, null], // before his imported membership ends
  ["crm.customer.nora-dumont", 11, null],
];

/** Busy day sessions this week, filled from `FILL_POOL` up to `seats` (14 = full). */
export const BUSY_SESSIONS: readonly { day: number; at: string; seats: number; waitlist?: readonly string[] }[] = [
  { day: 0, at: "13:00", seats: 8 },
  { day: 0, at: "16:00", seats: 10 },
  { day: 2, at: "13:00", seats: 14, waitlist: ["crm.customer.marc-gerard", "platform.person.customer16"] },
  { day: 3, at: "16:00", seats: 12 },
  { day: 4, at: "10:00", seats: 13 },
  { day: 6, at: "13:00", seats: 11 },
];

/** Day-credit holders who fill the busy sessions: not the five portal customers (they keep a balance), Lies or Sarah. */
const FILL_POOL = DAY_GUESTS.map(([p]) => p).filter((p) => !/^platform\.person\.customer[1-5]$/.test(p) && !["crm.customer.lies-vermeulen", "crm.customer.sarah-lenaerts"].includes(p));

/** Registrations for the demo lecture (free event). */
const LECTURE_GUESTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `platform.person.customer${n}`).concat(["crm.customer.an-verbruggen", "crm.customer.julie-moreau", "crm.customer.sophie-laurent"]);

const EMERGENCY_CONTACT = { name: "Noodcontact demo", phone: "+32 470 00 00 00", relation: "partner" };

/** The visits of `DAY_GUESTS` and `NIGHT_VISITS`, spread from the purchase to three weeks ahead. Pure. */
export function demoVisitPlan(): DemoVisit[] {
  const out: DemoVisit[] = [];
  DAY_GUESTS.forEach(([person, since, visits], i) => {
    for (let k = 0; k < visits; k++) {
      const day = -since + 1 + Math.floor(((k + 0.5) * (since + 20)) / visits);
      let outcome: Outcome | null = null;
      if (day < 0) {
        if (visits >= 5 && k === 1) outcome = "cancelled";
        else if ((i + k) % 13 === 7) outcome = "late_cancelled";
        else if ((i * 3 + k) % 10 === 4) outcome = "no_show";
        else outcome = "attended";
      }
      out.push({ person, kind: "day", day, at: SLOTS[(i + k * 3) % SLOTS.length]!, outcome });
    }
  });
  for (const [person, day, outcome] of NIGHT_VISITS) out.push({ person, kind: "night", day, at: null, outcome });
  return out;
}

/** The first open template session of `kind` (at the Brussels time `at`) in the week from `today + day`. */
async function findSession(tx: Tx, today: string, kind: "day" | "night", day: number, at: string | null): Promise<SessionRow | null> {
  const [row] = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.kind, kind),
        eq(sessions.status, "open"),
        isNull(sessions.webinarId),
        gte(sessions.startsAt, zonedTimeToUtc(addDays(today, day), "00:00")),
        lt(sessions.startsAt, zonedTimeToUtc(addDays(today, day + 7), "00:00")),
        at ? sql`to_char(${sessions.startsAt} at time zone 'Europe/Brussels', 'HH24:MI') = ${at}` : undefined,
      ),
    )
    .orderBy(asc(sessions.startsAt))
    .limit(1);
  return row ?? null;
}

type VisitInput = { personId: string; session: SessionRow; bookedAt: Date; outcome: Outcome | null; payWith: "credit" | "free" };

/** The check-in of `actions/attendance.ts` (`confirmed -> attended`, `attended_at`, `booking.attended`) at `ctx.now`. */
async function attend(ctx: Ctx, booking: BookingRow, s: SessionRow): Promise<void> {
  bookingTransition(booking.status, "attended", "staff");
  const [row] = await ctx.tx
    .update(bookings)
    .set({ status: "attended", attendedAt: ctx.now, version: sql`${bookings.version} + 1`, updatedAt: ctx.now })
    .where(eq(bookings.id, booking.id))
    .returning();
  await recordBookingFact(ctx, "booking.attended", row!, { session: { kind: s.kind, eventCategory: s.eventCategory, startsAt: s.startsAt, partnerCompanyId: s.partnerCompanyId }, by: "staff" });
}

/**
 * Books one visit in a savepoint and plays its outcome; false when the person already has a
 * booking on the session or the engine refuses it (credits, capacity).
 */
async function bookVisit(tx: Tx, actor: Actor, rules: BookingRules, v: VisitInput): Promise<boolean> {
  const [seen] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.sessionId, v.session.id), eq(bookings.personId, v.personId)))
    .limit(1);
  if (seen) return false;
  const s = v.session;
  try {
    await tx.transaction(async (sp) => {
      const at = (now: Date) => createCtx({ tx: sp, actor, now, requestId: "seed:booking", durableMode: "immediate" });
      const r = await bookSeats(sp, at(v.bookedAt), {
        sessionId: s.id,
        personId: v.personId,
        payWith: v.payWith,
        clientKey: randomUUID(),
        source: "admin",
        by: "staff",
        sendEmail: false,
        ...(s.kind === "night" ? { emergencyContact: EMERGENCY_CONTACT } : {}),
      });
      const [b] = await sp.update(bookings).set({ createdAt: v.bookedAt }).where(eq(bookings.id, r.bookingIds[0]!)).returning();
      const booking = b!;
      if (v.outcome === "attended") {
        await attend(at(new Date(s.startsAt.getTime() + 5 * MIN)), booking, s);
      } else if (v.outcome === "no_show") {
        await markNoShowRow(at(new Date(s.endsAt.getTime() + 2 * HOUR)), booking, s, rules, "staff");
      } else if (v.outcome) {
        const when = v.outcome === "cancelled" ? new Date(v.bookedAt.getTime() + 6 * HOUR) : new Date(s.startsAt.getTime() - 5 * HOUR);
        await cancelBookingRow(sp, at(when), { bookingId: booking.id, includeGuests: true, by: "staff" });
      }
    });
    return true;
  } catch (error) {
    if (error instanceof BookingConflictError || error instanceof ConflictError) return false;
    throw error;
  }
}

/** The demo visits (see the file header). Needs a staff user to book as; returns the bookings created. */
export async function seedDemoVisits(s: SeedCtx, lectureSessionId: string): Promise<number> {
  const tx = s.db as Tx;
  const userId =
    s.ids.get("platform.user.reception") ??
    s.ids.get("platform.user.owner") ??
    (await tx.select({ id: users.id }).from(users).where(and(eq(users.audience, "staff"), eq(users.status, "active"))).orderBy(asc(users.createdAt)).limit(1))[0]?.id;
  if (!userId) return 0;
  const actor: Actor = { kind: "staff", userId, roleKey: "reception", permissions: new Set<Permission>(["bookings.write", "waitlist.manage"]), mfaAt: s.now };
  const rules: BookingRules = await getSetting(tx, "booking_rules");
  const today = brusselsDate(s.now);
  const latest = s.now.getTime() - 2 * HOUR;
  let created = 0;

  const since = new Map(DAY_GUESTS.map(([p, d]) => [p, s.now.getTime() - d * DAY + 12 * HOUR]));
  for (const [i, v] of demoVisitPlan().entries()) {
    const personId = s.ids.get(v.person);
    const session = personId ? await findSession(tx, today, v.kind, v.day, v.at) : null;
    if (!personId || !session) continue;
    const start = session.startsAt.getTime();
    const bookedAt =
      v.kind === "night"
        ? Math.min(start - DAY, latest)
        : Math.min(Math.max(since.get(v.person) ?? 0, start - 3 * DAY + (i % 5) * HOUR), latest - (i % 4) * 9 * HOUR);
    // A visit pushed past a closed day onto today or later stays confirmed.
    const outcome = session.endsAt.getTime() <= s.now.getTime() ? v.outcome : null;
    if (await bookVisit(tx, actor, rules, { personId, session, bookedAt: new Date(bookedAt), outcome, payWith: "credit" })) created++;
  }

  for (const [t, busy] of BUSY_SESSIONS.entries()) {
    const session = await findSession(tx, today, "day", busy.day, busy.at);
    if (!session) continue;
    const [live] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(bookings)
      .where(and(eq(bookings.sessionId, session.id), inArray(bookings.status, [...LIVE_STATUSES, "attended", "no_show"])));
    let need = busy.seats - Number(live?.n ?? 0);
    for (let j = 0; j < FILL_POOL.length && need > 0; j++) {
      const personId = s.ids.get(FILL_POOL[(t * 5 + j) % FILL_POOL.length]!);
      if (!personId) continue;
      const bookedAt = new Date(latest - ((j % 6) + 1) * 19 * HOUR);
      if (await bookVisit(tx, actor, rules, { personId, session, bookedAt, outcome: null, payWith: "credit" })) {
        created++;
        need--;
      }
    }
    for (const key of busy.waitlist ?? []) {
      const personId = s.ids.get(key);
      if (!personId) continue;
      const [entry] = await tx.select({ id: waitlistEntries.id }).from(waitlistEntries).where(and(eq(waitlistEntries.sessionId, session.id), eq(waitlistEntries.personId, personId)));
      if (entry) continue;
      try {
        await tx.transaction(async (sp) => {
          await joinWaitlistRow(sp, createCtx({ tx: sp, actor, now: new Date(latest), requestId: "seed:booking", durableMode: "immediate" }), { sessionId: session.id, personId, by: "staff" });
        });
      } catch (error) {
        if (!(error instanceof BookingConflictError)) throw error;
      }
    }
  }

  const [lecture] = await tx.select().from(sessions).where(eq(sessions.id, lectureSessionId));
  if (lecture && lecture.status === "open") {
    for (const [j, key] of LECTURE_GUESTS.entries()) {
      const personId = s.ids.get(key);
      if (!personId) continue;
      if (await bookVisit(tx, actor, rules, { personId, session: lecture, bookedAt: new Date(latest - j * 5 * HOUR), outcome: null, payWith: "free" })) created++;
    }
  }

  // Today's demo visits that already ended on the wall clock are checked in (the no-show job would
  // mark them otherwise); with a pinned clock in the past (tests) the wall clock is the seed's day start.
  const wall = new Date(Date.now() < s.now.getTime() + DAY ? Math.max(Date.now(), s.now.getTime()) : s.now.getTime());
  const ended = await tx
    .select({ booking: bookings, session: sessions })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(and(eq(bookings.status, "confirmed"), eq(bookings.bookedByUserId, userId), eq(bookings.source, "admin"), gte(sessions.startsAt, s.now), lte(sessions.endsAt, wall)));
  for (const r of ended) await attend(createCtx({ tx, actor, now: new Date(r.session.startsAt.getTime() + 5 * MIN), requestId: "seed:booking", durableMode: "immediate" }), r.booking, r.session);
  return created;
}

/**
 * A visitor without a package must be able to pay for one session: day templates sell BEAM's
 * single day session, night templates its single night (commerce's catalogue seed creates them).
 * Sessions already materialised without a product get it too. Idempotent; a missing SKU is skipped.
 */
export async function linkSingleSessionProducts(db: SeedCtx["db"]): Promise<void> {
  for (const [kind, sku] of [["day", "BEAM-DAY-ADULT"], ["night", "BEAM-NIGHT-ADULT"]] as const) {
    const product = sql`(select id from products where sku = ${sku})`;
    await db.update(sessionTemplates).set({ productId: product }).where(and(eq(sessionTemplates.kind, kind), isNull(sessionTemplates.productId)));
    await db.update(sessions).set({ productId: product }).where(and(eq(sessions.kind, kind), isNull(sessions.productId), isNull(sessions.webinarId)));
  }
}

/** A stable 0..1 number for a seed key, so reruns write the same scores. */
function unit(key: string): number {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}
const clamp = (n: number) => Math.max(1, Math.min(5, Math.round(n)));

/**
 * Wellbeing check-ins for the portal demo customers (`customer1..5@example.com`): a before and an
 * after check-in on each visit they attended (after is about 1 to 2 points better), and a daily
 * check-in on some of the last 40 days with a slow upward trend. Idempotent (unique indexes).
 */
export async function seedDemoCheckins(s: SeedCtx): Promise<number> {
  const people = await s.db
    .select({ personId: users.personId, email: users.email })
    .from(users)
    .where(and(eq(users.audience, "customer"), inArray(users.email, [1, 2, 3, 4, 5].map((n) => `customer${n}@example.com`))));
  let written = 0;
  for (const p of people) {
    if (!p.personId) continue;
    const base = 2 + unit(p.email) * 0.8;
    const visits = await s.db
      .select({ id: bookings.id, startsAt: sessions.startsAt })
      .from(bookings)
      .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
      .where(and(eq(bookings.personId, p.personId), eq(bookings.status, "attended")));
    const rows: (typeof wellbeingCheckins.$inferInsert)[] = [];
    for (const v of visits) {
      const onDate = brusselsDate(v.startsAt);
      const r = (k: string) => unit(`${v.id}:${k}`);
      rows.push({ personId: p.personId, bookingId: v.id, moment: "before", onDate, energy: clamp(base + r("e") - 0.3), sleep: clamp(base + r("s")), calm: clamp(base + r("c") - 0.5), mood: clamp(base + r("m")) });
      rows.push({ personId: p.personId, bookingId: v.id, moment: "after", onDate, energy: clamp(base + 1.3 + r("e2")), calm: clamp(base + 1.8 + r("c2")), mood: clamp(base + 1.2 + r("m2")) });
    }
    const today = brusselsDate(s.now);
    for (let d = 40; d >= 1; d--) {
      if (unit(`${p.email}:day:${d}`) < 0.55) continue;
      const lift = ((40 - d) / 40) * 1.2;
      const r = (k: string) => unit(`${p.email}:${d}:${k}`) - 0.5;
      rows.push({ personId: p.personId, moment: "daily", onDate: addDays(today, -d), energy: clamp(base + lift + r("e")), sleep: clamp(base + lift + r("s")), calm: clamp(base + lift + r("c")), mood: clamp(base + lift + 0.3 + r("m")) });
    }
    if (rows.length) {
      const inserted = await s.db.insert(wellbeingCheckins).values(rows).onConflictDoNothing().returning({ id: wellbeingCheckins.id });
      written += inserted.length;
    }
  }
  return written;
}

export async function runBookingDemoSeed(s: SeedCtx): Promise<{ templates: number; inserted: number; visits: number }> {
  await seedBookingDefaults(s.db);
  const { templateIds, lectureSessionId } = await seedBookingDemo(s.db, { now: s.now });
  await linkSingleSessionProducts(s.db);
  const today = brusselsDate(s.now);
  const { inserted } = await materialiseRange(s.db, today, addDays(today, MATERIALISE_DAYS), { notBefore: s.now, now: s.now });
  // The demo history: the templates ran since `DEMO_HISTORY_DAYS` ago, their past sessions published then.
  const historyFrom = addDays(today, -DEMO_HISTORY_DAYS);
  await s.db
    .update(sessionTemplates)
    .set({ activeFromOn: historyFrom })
    .where(and(inArray(sessionTemplates.id, templateIds), gt(sessionTemplates.activeFromOn, historyFrom)));
  const past = await materialiseRange(s.db, historyFrom, addDays(today, -1), { now: new Date(s.now.getTime() - (DEMO_HISTORY_DAYS + 14) * DAY) });
  const visits = await seedDemoVisits(s, lectureSessionId);
  await seedDemoCheckins(s);
  return { templates: templateIds.length, inserted: inserted + past.inserted, visits };
}

export const seed = { after: ["credits"], run: (s: SeedCtx) => runBookingDemoSeed(s) };
