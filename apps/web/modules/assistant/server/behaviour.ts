/**
 * How a person behaves, from facts BEAM already has: visits and their rhythm, the kind, weekday and
 * time of day they prefer, how far ahead they book, no-shows and late cancellations, credits and
 * their expiry, membership, spend, newsletter consent. No wellbeing or other sensitive data.
 * `computeBehaviour` is pure (tested); `loadBehaviour` gathers the inputs through the other
 * modules' facades. The signals are rules, so staff can see why a person is called "lapsing".
 */
import type { PersonBookingRow } from "@beam/core/booking";
import type { DbOrTx } from "@/lib/ctx";

const DAY = 86_400_000;

export const BEHAVIOUR_SIGNALS = ["never_visited", "new_visitor", "regular", "loyal", "lapsing", "lost", "night_fan", "no_show_risk", "credits_expiring", "credits_unused", "no_newsletter", "has_upcoming"] as const;
export type BehaviourSignal = (typeof BEHAVIOUR_SIGNALS)[number];

export type BehaviourInput = {
  now: Date;
  status: "lead" | "customer" | "member";
  bookings: Pick<PersonBookingRow, "kind" | "startsAt" | "status" | "createdAt" | "isGuest">[];
  credits: { kind: string; remainingUnits: number; nextExpiresAt: Date | null }[];
  isMember: boolean;
  paidCents: number;
  paidOrders: number;
  newsletter: boolean;
  activeFlows: string[];
};

export type BehaviourFacts = {
  status: "lead" | "customer" | "member";
  visits: number;
  visits90: number;
  lastVisitOn: string | null;
  daysSinceLastVisit: number | null;
  /** Median days between visits (null under two visits). */
  rhythmDays: number | null;
  favouriteKind: "day" | "night" | "event" | null;
  favouriteWeekday: number | null;
  favouriteDaypart: "morning" | "afternoon" | "evening" | null;
  leadTimeDays: number | null;
  noShows: number;
  lateCancellations: number;
  upcoming: number;
  nextBookingOn: string | null;
  credits: { kind: string; remaining: number; expiresOn: string | null }[];
  isMember: boolean;
  spendEuro: number;
  paidOrders: number;
  newsletter: boolean;
  activeFlows: string[];
  signals: BehaviourSignal[];
};

const brusselsDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(d);
const brusselsHour = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", hour12: false }).format(d));
/** 1 = Monday … 7 = Sunday, in Brussels. */
const brusselsWeekday = (d: Date) => {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", weekday: "short" }).format(d);
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name) + 1;
};
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
function mode<T extends string | number>(xs: T[]): T | null {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

export function computeBehaviour(input: BehaviourInput): BehaviourFacts {
  const { now } = input;
  const attended = input.bookings.filter((b) => b.status === "attended" && !b.isGuest).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const upcoming = input.bookings.filter((b) => (b.status === "confirmed" || b.status === "reserved") && b.startsAt > now).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const last = attended.at(-1)?.startsAt ?? null;
  const gaps = attended.slice(1).map((b, i) => (b.startsAt.getTime() - attended[i]!.startsAt.getTime()) / DAY).filter((g) => g >= 0.5);
  const rhythm = median(gaps);
  const lead = median(input.bookings.filter((b) => b.status !== "cancelled").map((b) => (b.startsAt.getTime() - b.createdAt.getTime()) / DAY).filter((d) => d >= 0));
  const daysSince = last ? Math.floor((now.getTime() - last.getTime()) / DAY) : null;
  const visits90 = attended.filter((b) => b.startsAt.getTime() > now.getTime() - 90 * DAY).length;
  const noShows = input.bookings.filter((b) => b.status === "no_show").length;
  const late = input.bookings.filter((b) => b.status === "late_cancelled").length;
  const hour = mode(attended.map((b) => brusselsHour(b.startsAt)).map((h) => (h < 12 ? "morning" : h < 17 ? "afternoon" : "evening")));
  const credits = input.credits.filter((c) => c.remainingUnits > 0).map((c) => ({ kind: c.kind, remaining: c.remainingUnits, expiresOn: c.nextExpiresAt ? brusselsDay(c.nextExpiresAt) : null }));
  const expiringSoon = input.credits.some((c) => c.remainingUnits > 0 && c.nextExpiresAt && c.nextExpiresAt.getTime() < now.getTime() + 45 * DAY);
  const nights = attended.filter((b) => b.kind === "night").length;

  const signals: BehaviourSignal[] = [];
  if (!attended.length) signals.push("never_visited");
  else if (attended.length === 1) signals.push("new_visitor");
  if (visits90 >= 5) signals.push("loyal");
  else if (visits90 >= 2) signals.push("regular");
  if (daysSince != null && attended.length >= 2) {
    const overdue = rhythm ? daysSince > Math.max(30, rhythm * 2) : daysSince > 60;
    if (daysSince > 180) signals.push("lost");
    else if (overdue && !upcoming.length) signals.push("lapsing");
  }
  if (attended.length >= 3 && nights / attended.length >= 0.5) signals.push("night_fan");
  if (noShows + late >= 2 && (noShows + late) / Math.max(1, attended.length + noShows + late) >= 0.25) signals.push("no_show_risk");
  if (expiringSoon) signals.push("credits_expiring");
  if (credits.length && !upcoming.length && (daysSince == null || daysSince > 30)) signals.push("credits_unused");
  if (!input.newsletter) signals.push("no_newsletter");
  if (upcoming.length) signals.push("has_upcoming");

  return {
    status: input.status,
    visits: attended.length,
    visits90,
    lastVisitOn: last ? brusselsDay(last) : null,
    daysSinceLastVisit: daysSince,
    rhythmDays: rhythm == null ? null : Math.round(rhythm),
    favouriteKind: mode(attended.map((b) => b.kind)),
    favouriteWeekday: mode(attended.map((b) => brusselsWeekday(b.startsAt))),
    favouriteDaypart: hour,
    leadTimeDays: lead == null ? null : Math.round(lead),
    noShows,
    lateCancellations: late,
    upcoming: upcoming.length,
    nextBookingOn: upcoming[0] ? brusselsDay(upcoming[0].startsAt) : null,
    credits,
    isMember: input.isMember,
    spendEuro: Math.round(input.paidCents / 100),
    paidOrders: input.paidOrders,
    newsletter: input.newsletter,
    activeFlows: input.activeFlows,
    signals,
  };
}

export async function loadBehaviour(db: DbOrTx, personId: string, now: Date = new Date()): Promise<BehaviourFacts | null> {
  // Loaded on use: the person page imports this through `assistant/api`, and the commerce, credits
  // and automation facades import each other at module load (a cycle when pulled in from here).
  const [{ listPersonEnrolments }, { listPersonBookings }, { getPersonCommerceSummary }, { getCurrentConsents, getPerson }, { getPersonCreditSummary }] = await Promise.all([
    import("@/modules/automation/api"),
    import("@/modules/booking/api"),
    import("@/modules/commerce/api"),
    import("@/modules/crm/api"),
    import("@/modules/credits/api"),
  ]);
  const person = await getPerson(db, personId);
  if (!person || person.erasedAt) return null;
  const [bookings, credits, commerce, consents, enrolments] = await Promise.all([
    listPersonBookings(db, personId, { limit: 200 }),
    getPersonCreditSummary(db, personId),
    getPersonCommerceSummary(db, personId),
    getCurrentConsents(db, personId),
    listPersonEnrolments(db, personId),
  ]);
  return computeBehaviour({
    now,
    status: person.status,
    bookings,
    credits: credits.byKind,
    isMember: !!credits.membership,
    paidCents: commerce.paidCents,
    paidOrders: commerce.paidOrders,
    newsletter: consents.newsletter?.status === "granted",
    activeFlows: enrolments.filter((e) => e.status === "active").map((e) => e.automationSlug),
  });
}
