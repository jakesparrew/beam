/**
 * The activity charts of the staff person page: visits per period (day, night, event, and the
 * visits that did not happen), interactions per period (bookings made, emails, purchases, chat and
 * messages, webinars and forms) and when the person visits (weekday × part of the day).
 * Weekly buckets when the history is short (under 120 days), monthly otherwise (at most 12).
 * `buildActivity` is pure (tested); `loadActivity` gathers bookings, the CRM timeline and the
 * person's chat messages through the facades.
 */
import { assistantConversations, assistantMessages } from "@beam/db/schema";
import { and, eq, gte, inArray, type DbOrTx } from "@/lib/ctx";

const DAY = 86_400_000;

export const INTERACTION_KINDS = ["bookings", "emails", "purchases", "chat", "events"] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

/** Timeline event kind -> interaction series (unlisted kinds are bookkeeping, not interactions). */
export function interactionOf(kind: string): InteractionKind | null {
  if (kind === "booking.confirmed" || kind === "booking.reserved") return "bookings";
  if (kind.startsWith("email.") && kind !== "email.bounced") return "emails";
  if (kind === "order.paid" || kind === "membership.started") return "purchases";
  if (kind === "inbox.message_received" || kind === "assistant.lead_captured") return "chat";
  if (kind.startsWith("webinar.") || kind.startsWith("form.") || kind === "waitlist.joined") return "events";
  return null;
}

export type Visit = { startsAt: Date; kind: "day" | "night" | "event"; status: string; isGuest: boolean };

export type ActivityData = {
  unit: "week" | "month";
  /** First day of each bucket (Brussels), YYYY-MM-DD. */
  buckets: string[];
  visits: { day: number[]; night: number[]; event: number[]; missed: number[] };
  interactions: Record<InteractionKind, number[]>;
  /** heat[weekday 0=Mon..6=Sun][daypart 0=morning,1=afternoon,2=evening] = attended visits. */
  heat: number[][];
  totals: { visits: number; missed: number; interactions: number };
};

const iso = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(d);
const parse = (day: string) => new Date(`${day}T00:00:00Z`);
const hourOf = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", hour12: false }).format(d));
const weekdayOf = (d: Date) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", weekday: "short" }).format(d));

/** The bucket starts from the first activity (or a sensible minimum) up to the current period. */
export function bucketStarts(now: Date, first: Date | null): { unit: "week" | "month"; starts: string[] } {
  const today = parse(iso(now));
  const since = first ? parse(iso(first)) : today;
  if (today.getTime() - since.getTime() < 120 * DAY) {
    const monday = (d: Date) => new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
    const end = monday(today);
    const start = new Date(Math.min(monday(since).getTime(), end.getTime() - 7 * 7 * DAY));
    const starts: string[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 7 * DAY) starts.push(new Date(t).toISOString().slice(0, 10));
    return { unit: "week", starts };
  }
  const endMonth = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
  const startMonth = Math.max(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1), Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
  const starts: string[] = [];
  for (let d = new Date(startMonth); d.getTime() <= endMonth; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) starts.push(d.toISOString().slice(0, 10));
  return { unit: "month", starts };
}

/** Index of the bucket a moment falls in, or -1 outside the range. */
export function bucketIndex(starts: readonly string[], at: Date, unit: "week" | "month"): number {
  const day = iso(at);
  if (day < starts[0]!) return -1;
  for (let i = starts.length - 1; i >= 0; i--) if (day >= starts[i]!) {
    if (i === starts.length - 1) {
      const end = unit === "week" ? new Date(parse(starts[i]!).getTime() + 7 * DAY) : new Date(Date.UTC(parse(starts[i]!).getUTCFullYear(), parse(starts[i]!).getUTCMonth() + 1, 1));
      return day < iso(end) ? i : -1;
    }
    return i;
  }
  return -1;
}

export function buildActivity(input: { now: Date; visits: Visit[]; interactions: { at: Date; kind: InteractionKind }[] }): ActivityData {
  const past = input.visits.filter((v) => !v.isGuest && v.startsAt <= input.now);
  const firstMoments = [...past.map((v) => v.startsAt), ...input.interactions.map((i) => i.at)].sort((a, b) => a.getTime() - b.getTime());
  const { unit, starts } = bucketStarts(input.now, firstMoments[0] ?? null);
  const zero = () => starts.map(() => 0);
  const visits = { day: zero(), night: zero(), event: zero(), missed: zero() };
  const interactions = Object.fromEntries(INTERACTION_KINDS.map((k) => [k, zero()])) as Record<InteractionKind, number[]>;
  const heat = Array.from({ length: 7 }, () => [0, 0, 0]);
  let missed = 0;
  let attended = 0;
  for (const v of past) {
    const i = bucketIndex(starts, v.startsAt, unit);
    if (v.status === "attended") {
      attended++;
      const h = hourOf(v.startsAt);
      heat[weekdayOf(v.startsAt)]![h < 12 ? 0 : h < 17 ? 1 : 2]! += 1;
      if (i >= 0) visits[v.kind][i]! += 1;
    } else if (v.status === "no_show" || v.status === "late_cancelled") {
      missed++;
      if (i >= 0) visits.missed[i]! += 1;
    }
  }
  let total = 0;
  for (const x of input.interactions) {
    const i = bucketIndex(starts, x.at, unit);
    if (i < 0) continue;
    interactions[x.kind][i]! += 1;
    total++;
  }
  return { unit, buckets: starts, visits, interactions, heat, totals: { visits: attended, missed, interactions: total } };
}

export async function loadActivity(db: DbOrTx, personId: string, now: Date = new Date()): Promise<ActivityData> {
  // Loaded on use, like `behaviour.ts` (the facades import each other at module load).
  const [{ listPersonBookings }, { listTimeline, resolvePersonIds }] = await Promise.all([import("@/modules/booking/api"), import("@/modules/crm/api")]);
  const since = new Date(now.getTime() - 400 * DAY);
  const [bookings, ids] = await Promise.all([listPersonBookings(db, personId, { limit: 500 }), resolvePersonIds(db as Parameters<typeof resolvePersonIds>[0], personId)]);
  const interactions: { at: Date; kind: InteractionKind }[] = [];
  let before: { occurredAt: Date; id: string } | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await listTimeline(db, { personId, limit: 200, ...(before ? { before } : {}) });
    for (const item of res.items) {
      const kind = interactionOf(item.kind);
      if (kind && item.occurredAt >= since) interactions.push({ at: item.occurredAt, kind });
    }
    const last = res.items.at(-1);
    if (!res.nextBefore || (last && last.occurredAt < since)) break;
    before = res.nextBefore;
  }
  const chats = await db
    .select({ at: assistantMessages.createdAt })
    .from(assistantMessages)
    .innerJoin(assistantConversations, eq(assistantConversations.id, assistantMessages.conversationId))
    .where(and(inArray(assistantConversations.personId, ids), eq(assistantMessages.author, "visitor"), gte(assistantMessages.createdAt, since)));
  for (const c of chats) interactions.push({ at: c.at, kind: "chat" });
  return buildActivity({
    now,
    visits: bookings.map((b) => ({ startsAt: b.startsAt, kind: b.kind, status: b.status, isGuest: b.isGuest })),
    interactions,
  });
}
