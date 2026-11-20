/**
 * The guest's wellbeing journey for the portal home: check-ins before and after visits (and
 * daily), the average change a visit brings, visits and hours so far, milestones, and which
 * check-in to ask for now (before an upcoming visit within a day, after a visit of the last three
 * days, or the daily one). Read-only; `booking.save_checkin` writes.
 */
import { addDays, brusselsDate } from "@beam/core/booking";
import { bookings, sessions, wellbeingCheckins } from "@beam/db/schema";
import { and, asc, desc, eq, gte, inArray, sql, type DbOrTx } from "@/lib/ctx";

export type WellbeingScores = { energy: number; sleep: number | null; calm: number; mood: number };
export type WellbeingCheckin = WellbeingScores & { id: string; moment: "before" | "after" | "daily"; bookingId: string | null; onDate: string; note: string | null };
export type CheckinPrompt = { moment: "before" | "after"; bookingId: string; sessionTitle: unknown; startsAt: Date } | { moment: "daily" };

export type WellbeingJourney = {
  /** Last 60 days, oldest first. */
  checkins: WellbeingCheckin[];
  /** Average after-minus-before per score over visits with both check-ins. */
  visitEffect: { visits: number; energy: number; calm: number; mood: number } | null;
  visits: number;
  /** Past visits of the last 60 days (attended or no-show), oldest first, for the staff chart. */
  visitDays: { bookingId: string; onDate: string; noShow: boolean }[];
  hours: number;
  nights: number;
  firstVisitOn: string | null;
  prompt: CheckinPrompt | null;
};

const LIVE = ["reserved", "confirmed", "attended"] as const;

export async function getWellbeingJourney(db: DbOrTx, personId: string, now: Date = new Date()): Promise<WellbeingJourney> {
  const today = brusselsDate(now);
  const rows = await db
    .select()
    .from(wellbeingCheckins)
    .where(and(eq(wellbeingCheckins.personId, personId), gte(wellbeingCheckins.onDate, addDays(today, -60))))
    .orderBy(asc(wellbeingCheckins.onDate), asc(wellbeingCheckins.createdAt));
  const checkins: WellbeingCheckin[] = rows.map((r) => ({
    id: r.id,
    moment: r.moment,
    bookingId: r.bookingId,
    onDate: r.onDate,
    energy: r.energy,
    sleep: r.sleep,
    calm: r.calm,
    mood: r.mood,
    note: r.note,
  }));

  // Visit effect: pairs of before/after on the same booking (all time, not only 60 days).
  const pairs = await db
    .select({ bookingId: wellbeingCheckins.bookingId, moment: wellbeingCheckins.moment, energy: wellbeingCheckins.energy, calm: wellbeingCheckins.calm, mood: wellbeingCheckins.mood })
    .from(wellbeingCheckins)
    .where(and(eq(wellbeingCheckins.personId, personId), inArray(wellbeingCheckins.moment, ["before", "after"])));
  const byBooking = new Map<string, { before?: (typeof pairs)[number]; after?: (typeof pairs)[number] }>();
  for (const p of pairs) {
    const e = byBooking.get(p.bookingId!) ?? {};
    e[p.moment as "before" | "after"] = p;
    byBooking.set(p.bookingId!, e);
  }
  const full = [...byBooking.values()].filter((e) => e.before && e.after);
  const avg = (k: "energy" | "calm" | "mood") => Math.round((full.reduce((n, e) => n + (e.after![k] - e.before![k]), 0) / full.length) * 10) / 10;
  const visitEffect = full.length ? { visits: full.length, energy: avg("energy"), calm: avg("calm"), mood: avg("mood") } : null;

  // Visits so far: attended bookings (or past live ones) of the person.
  const [stats] = await db
    .select({
      visits: sql<number>`count(*)::int`,
      minutes: sql<number>`coalesce(sum(extract(epoch from (${sessions.endsAt} - ${sessions.startsAt})) / 60), 0)::int`,
      nights: sql<number>`count(*) filter (where ${sessions.kind} = 'night')::int`,
      first: sql<string | null>`min((${sessions.startsAt} at time zone 'Europe/Brussels')::date)::text`,
    })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(and(eq(bookings.personId, personId), inArray(bookings.status, [...LIVE]), sql`${sessions.endsAt} < ${now}`, sql`${sessions.kind} in ('day', 'night')`));

  const recentVisits = await db
    .select({ bookingId: bookings.id, onDate: sql<string>`(${sessions.startsAt} at time zone 'Europe/Brussels')::date::text`, status: bookings.status })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(
      and(
        eq(bookings.personId, personId),
        inArray(bookings.status, [...LIVE, "no_show"]),
        sql`${sessions.kind} in ('day', 'night')`,
        sql`${sessions.endsAt} < ${now}`,
        sql`${sessions.startsAt} >= ${new Date(now.getTime() - 60 * 86_400_000)}`,
      ),
    )
    .orderBy(asc(sessions.startsAt));

  // What to ask now: before the next visit (within a day), after a recent one, else the daily one.
  const done = new Set(rows.filter((r) => r.bookingId).map((r) => `${r.bookingId}:${r.moment}`));
  const doneAll = await db
    .select({ bookingId: wellbeingCheckins.bookingId, moment: wellbeingCheckins.moment })
    .from(wellbeingCheckins)
    .where(and(eq(wellbeingCheckins.personId, personId), gte(wellbeingCheckins.onDate, addDays(today, -4))));
  for (const d of doneAll) if (d.bookingId) done.add(`${d.bookingId}:${d.moment}`);
  const near = await db
    .select({ id: bookings.id, title: sessions.title, startsAt: sessions.startsAt, endsAt: sessions.endsAt })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(
      and(
        eq(bookings.personId, personId),
        inArray(bookings.status, [...LIVE]),
        sql`${sessions.kind} in ('day', 'night')`,
        sql`${sessions.startsAt} between ${new Date(now.getTime() - 3 * 86_400_000)} and ${new Date(now.getTime() + 86_400_000)}`,
      ),
    )
    .orderBy(desc(sessions.startsAt));
  let prompt: CheckinPrompt | null = null;
  const upcoming = near.find((b) => b.startsAt > now && !done.has(`${b.id}:before`));
  const recent = near.find((b) => b.endsAt <= now && !done.has(`${b.id}:after`));
  if (upcoming) prompt = { moment: "before", bookingId: upcoming.id, sessionTitle: upcoming.title, startsAt: upcoming.startsAt };
  else if (recent) prompt = { moment: "after", bookingId: recent.id, sessionTitle: recent.title, startsAt: recent.startsAt };
  else if (!rows.some((r) => r.moment === "daily" && r.onDate === today)) prompt = { moment: "daily" };

  return {
    checkins,
    visitEffect,
    visits: stats?.visits ?? 0,
    visitDays: recentVisits.map((v) => ({ bookingId: v.bookingId, onDate: v.onDate, noShow: v.status === "no_show" })),
    hours: Math.round((stats?.minutes ?? 0) / 60),
    nights: stats?.nights ?? 0,
    firstVisitOn: stats?.first ?? null,
    prompt,
  };
}
