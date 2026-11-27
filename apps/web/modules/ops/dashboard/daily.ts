/**
 * The day view at the top of `/admin/dashboard` (owner requirements, section 6): for one Brussels
 * day, the capacity per session, the clients who come with their membership and package status
 * and the opportunities they open, the sessions of the next 7 days with free places, and the
 * revenue of the day against the same weekday a week earlier. Read-only SQL over booking's
 * `v_session_availability`, credits' `v_credit_grant_balances` and ops' `v_revenue_daily`.
 *
 * Who sees what (`dailyAccess`): every dashboard viewer sees capacity and the sessions to fill;
 * client details need `persons.read`; "fill this session" needs `email.write` (it makes a
 * segment and a campaign draft); revenue needs `reports.finance` (Front Desk does not see it).
 */
import type { DbOrTx } from "@beam/db";
import type { Locale } from "@beam/core/i18n";
import { comparePeriods } from "@beam/core/ops";
import { sql, type Actor } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { holdsAny } from "../reports/registry";
import { brusselsDate } from "../reports/revenue";
import { DASHBOARD_PERMISSIONS } from "./cards";

const DAY_MS = 86_400_000;
/** "Expiring soon" for memberships and package credits. */
export const EXPIRY_HORIZON_DAYS = 30;
/** A package with this many credits or fewer left is "almost used up". */
export const PACKAGE_LOW_UNITS = 1;
/** The look-ahead of the "sessions to fill" block. */
export const FILL_AHEAD_DAYS = 7;

export type DailyAccess = { capacity: boolean; clients: boolean; fill: boolean; revenue: boolean };

export function dailyAccess(actor: Actor): DailyAccess {
  const dashboard = holdsAny(actor, ...DASHBOARD_PERMISSIONS);
  return {
    capacity: dashboard,
    clients: dashboard && holdsAny(actor, "persons.read"),
    fill: dashboard && holdsAny(actor, "email.write"),
    revenue: dashboard && holdsAny(actor, "reports.finance"),
  };
}

// ---------------------------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` shifted by `n` calendar days (date arithmetic, no clock, DST-safe). */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** `?day=YYYY-MM-DD` when it is a real date, else today in Brussels. */
export function parseDay(value: string | undefined, now: Date): string {
  if (value && DAY_RE.test(value) && shiftDay(value, 0) === value) return value;
  return brusselsDate(now);
}

const onDay = (column: string, day: string) => sql`(${sql.raw(column)} at time zone 'Europe/Brussels')::date = ${day}::date`;
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const title = (locale: Locale) => sql`coalesce(s.title->>${locale}, s.title->>'nl-BE', '')`;

// ---------------------------------------------------------------------------------------------
// 1. Capacity
// ---------------------------------------------------------------------------------------------

export type SessionKind = "day" | "night" | "event";
export type CapacitySlot = {
  sessionId: string;
  kind: SessionKind;
  title: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  booked: number;
  /** Places held for staff, partners or hosts. */
  held: number;
  available: number;
  waiting: number;
};
export type DailyCapacity = { slots: CapacitySlot[]; total: { capacity: number; booked: number; held: number; available: number } };

type SlotRow = { id: string; kind: SessionKind; title: string; starts_at: string | Date; ends_at: string | Date; capacity: number | null; booked: number; held: number; available: number; waiting: number };

const toSlot = (r: SlotRow): CapacitySlot => ({
  sessionId: r.id,
  kind: r.kind,
  title: r.title,
  startsAt: new Date(r.starts_at),
  endsAt: new Date(r.ends_at),
  capacity: Number(r.capacity ?? 0),
  booked: Number(r.booked),
  held: Number(r.held),
  available: Number(r.available),
  waiting: Number(r.waiting),
});

const slotColumns = (locale: Locale) =>
  sql`s.id, s.kind, ${title(locale)} as title, s.starts_at, s.ends_at, coalesce(a.capacity, 0) as capacity, a.booked, a.held, a.available_total as available, a.waiting`;

/** Every session of `day` (cancelled ones and webinars left out) with its places, in start order. */
export async function getDailyCapacity(db: DbOrTx, input: { day: string; locale: Locale }): Promise<DailyCapacity> {
  const slots = rowsOf<SlotRow>(
    await db.execute(sql`select ${slotColumns(input.locale)}
      from sessions s join v_session_availability a on a.session_id = s.id
      where ${onDay("s.starts_at", input.day)} and s.status <> 'cancelled' and s.webinar_id is null
      order by s.starts_at, s.id`),
  ).map(toSlot);
  const sum = (k: "capacity" | "booked" | "held" | "available") => slots.reduce((n, s) => n + s[k], 0);
  return { slots, total: { capacity: sum("capacity"), booked: sum("booked"), held: sum("held"), available: sum("available") } };
}

/** Monday of the ISO week that holds `day` (`YYYY-MM-DD`). */
export function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return shiftDay(day, -((dow + 6) % 7));
}

export type WeekOccupancy = { from: string; days: string[]; slots: (CapacitySlot & { day: string; time: string })[] };

/**
 * Every session of the Monday-to-Sunday week that holds `day` (cancelled ones and webinars left
 * out), with its Brussels day and start time: the cells of the dashboard's week heatmap.
 */
export async function getWeekOccupancy(db: DbOrTx, input: { day: string; locale: Locale }): Promise<WeekOccupancy> {
  const from = weekStart(input.day);
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(from, i));
  const rows = rowsOf<SlotRow & { day: string; time: string }>(
    await db.execute(sql`select ${slotColumns(input.locale)},
        to_char(s.starts_at at time zone 'Europe/Brussels', 'YYYY-MM-DD') as day,
        to_char(s.starts_at at time zone 'Europe/Brussels', 'HH24:MI') as time
      from sessions s join v_session_availability a on a.session_id = s.id
      where (s.starts_at at time zone 'Europe/Brussels')::date between ${from}::date and ${days[6]}::date
        and s.status <> 'cancelled' and s.webinar_id is null
      order by s.starts_at, s.id`),
  );
  return { from, days, slots: rows.map((r) => ({ ...toSlot(r), day: r.day, time: r.time })) };
}

/** Open sessions starting within the next 7 days that still have free places (the "fill this session" list). */
export async function listSessionsToFill(db: DbOrTx, input: { now: Date; locale: Locale }): Promise<CapacitySlot[]> {
  return rowsOf<SlotRow>(
    await db.execute(sql`select ${slotColumns(input.locale)}
      from sessions s join v_session_availability a on a.session_id = s.id
      where s.starts_at > ${ts(input.now)} and s.starts_at < ${ts(input.now)} + ${FILL_AHEAD_DAYS}::int * interval '1 day'
        and s.status = 'open' and s.webinar_id is null and a.available_total > 0
      order by s.starts_at, s.id`),
  ).map(toSlot);
}

// ---------------------------------------------------------------------------------------------
// 2. Clients of the day
// ---------------------------------------------------------------------------------------------

export type CreditKind = "day" | "night";
export type DayClient = {
  personId: string;
  name: string | null;
  sessions: { sessionId: string; kind: SessionKind; startsAt: Date }[];
  /** No earlier confirmed or attended booking. */
  isFirstVisit: boolean;
  membership: {
    status: "active" | "past_due";
    /** When the membership stops unless renewed (period end, or the cancel date); the renewal date when `renews`. */
    endsAt: Date;
    /** A valid mandate pays the next period and no cancellation is planned. */
    renews: boolean;
    /** Free member credits still to use, per kind. */
    freeLeft: { kind: CreditKind; units: number }[];
  } | null;
  /** Bought (non-member) credits per kind: what is left of what was granted, and the nearest expiry of what is left. */
  packages: { kind: CreditKind; remaining: number; total: number; nextExpiresAt: Date | null }[];
};

type ClientRow = {
  person_id: string;
  name: string | null;
  sessions: unknown;
  is_first_visit: boolean;
  membership_status: "active" | "past_due" | null;
  period_end_at: string | Date | null;
  cancel_at: string | Date | null;
  has_mandate: boolean | null;
  free_left: unknown;
  packages: unknown;
};

const json = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

/** The real persons with a live booking on a session of `day`, first arrivals first. */
export async function listDayClients(db: DbOrTx, input: { day: string; now: Date }): Promise<DayClient[]> {
  const now = ts(input.now);
  const rows = rowsOf<ClientRow>(
    await db.execute(sql`
      with day_bookings as (
        select b.person_id, s.id as session_id, s.kind, s.starts_at
        from bookings b join sessions s on s.id = b.session_id join persons pe on pe.id = b.person_id
        where ${onDay("s.starts_at", input.day)} and s.status <> 'cancelled' and s.webinar_id is null
          and (b.status in ('confirmed', 'attended', 'no_show') or (b.status = 'reserved' and b.reserved_until > ${now}))
          and pe.is_tester = false and pe.erased_at is null and pe.merged_into_person_id is null
      ), people as (
        select person_id, min(starts_at) as first_start,
          jsonb_agg(jsonb_build_object('sessionId', session_id, 'kind', kind, 'startsAt', starts_at) order by starts_at) as sessions
        from day_bookings group by person_id
      )
      select pp.person_id, nullif(trim(concat_ws(' ', pe.first_name, pe.last_name)), '') as name, pp.sessions,
        not exists (select 1 from bookings b2 join sessions s2 on s2.id = b2.session_id
                    where b2.person_id = pp.person_id and b2.status in ('confirmed', 'attended') and s2.starts_at < pp.first_start) as is_first_visit,
        m.status as membership_status, m.current_period_end_at as period_end_at, m.cancel_at, m.has_mandate,
        (select coalesce(jsonb_agg(jsonb_build_object('kind', f.credit_kind, 'units', f.units) order by f.credit_kind), '[]'::jsonb)
           from (select credit_kind, sum(remaining_units)::int as units from v_credit_grant_balances
                 where membership_id = m.id and is_usable and credit_kind in ('day', 'night') group by 1) f) as free_left,
        (select coalesce(jsonb_agg(jsonb_build_object('kind', k.credit_kind, 'remaining', k.remaining, 'total', k.total, 'nextExpiresAt', k.next_expires_at) order by k.credit_kind), '[]'::jsonb)
           from (select credit_kind, sum(remaining_units)::int as remaining, sum(base_units)::int as total,
                        min(expires_at) filter (where remaining_units > 0) as next_expires_at
                 from v_credit_grant_balances
                 where person_id = pp.person_id and membership_id is null and credit_kind in ('day', 'night')
                   and status in ('active', 'exhausted') and (expires_at is null or expires_at > ${now})
                 group by 1) k) as packages
      from people pp join persons pe on pe.id = pp.person_id
      left join lateral (
        select m.id, m.status, m.current_period_end_at, m.cancel_at,
          exists (select 1 from mandates md where md.id = m.mandate_id and md.status = 'valid') as has_mandate
        from memberships m where m.person_id = pp.person_id and m.status in ('active', 'past_due') and m.started_at <= ${now}
        order by m.started_at desc limit 1) m on true
      order by pp.first_start, name, pp.person_id`),
  );
  return rows.map((r) => {
    const cancelAt = r.cancel_at ? new Date(r.cancel_at) : null;
    return {
      personId: r.person_id,
      name: r.name,
      sessions: json<{ sessionId: string; kind: SessionKind; startsAt: string }[]>(r.sessions).map((s) => ({ ...s, startsAt: new Date(s.startsAt) })),
      isFirstVisit: r.is_first_visit,
      membership: r.membership_status
        ? {
            status: r.membership_status,
            endsAt: cancelAt ?? new Date(r.period_end_at!),
            renews: r.membership_status === "active" && !cancelAt && r.has_mandate === true,
            freeLeft: json<{ kind: CreditKind; units: number }[]>(r.free_left).filter((f) => f.units > 0),
          }
        : null,
      packages: json<{ kind: CreditKind; remaining: number; total: number; nextExpiresAt: string | null }[]>(r.packages).map((p) => ({
        ...p,
        nextExpiresAt: p.nextExpiresAt ? new Date(p.nextExpiresAt) : null,
      })),
    };
  });
}

export type OpportunityKey = "first_visit" | "package_low" | "package_expiring" | "membership_renewal" | "free_session_unused";
export type Opportunity = { key: OpportunityKey; kind?: CreditKind; units?: number; date?: Date };

/**
 * The short actions a client opens (owner requirements 6): welcome a first-time visitor; offer a
 * new package when one is (almost) used up; remind of credits that expire within 30 days; talk
 * about renewal when the membership is past due or stops within 30 days; remind of free member
 * sessions not used yet.
 */
export function clientOpportunities(client: DayClient, now: Date): Opportunity[] {
  const horizon = now.getTime() + EXPIRY_HORIZON_DAYS * DAY_MS;
  const out: Opportunity[] = [];
  if (client.isFirstVisit) out.push({ key: "first_visit" });
  const m = client.membership;
  if (m && (m.status === "past_due" || (!m.renews && m.endsAt.getTime() <= horizon))) out.push({ key: "membership_renewal", date: m.endsAt });
  for (const f of m?.freeLeft ?? []) out.push({ key: "free_session_unused", kind: f.kind, units: f.units });
  for (const p of client.packages) {
    if (p.total > 0 && p.remaining <= PACKAGE_LOW_UNITS) out.push({ key: "package_low", kind: p.kind, units: p.remaining });
    else if (p.nextExpiresAt && p.nextExpiresAt.getTime() <= horizon) out.push({ key: "package_expiring", kind: p.kind, units: p.remaining, date: p.nextExpiresAt });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 4. Revenue
// ---------------------------------------------------------------------------------------------

/** The owner's revenue groups over `v_revenue_daily`'s product kinds (tickets cover events and webinars). */
export const REVENUE_GROUPS = {
  sessions: ["session", "night"],
  packages: ["package"],
  memberships: ["membership"],
  events: ["ticket"],
  other: ["item", "voucher"],
} as const;
export type RevenueGroup = keyof typeof REVENUE_GROUPS;
export type Comparison = ReturnType<typeof comparePeriods>;

export type DailyRevenue = {
  day: string;
  /** The same weekday a week earlier. */
  compareDay: string;
  /** Sales minus refunds, VAT included. */
  net: Comparison;
  refunds: Comparison;
  groups: { key: RevenueGroup; sales: Comparison }[];
};

/** Paid orders of `day` by payment date (every channel, the till included), VAT included, against the same weekday last week. */
export async function getDailyRevenue(db: DbOrTx, input: { day: string }): Promise<DailyRevenue> {
  const compareDay = shiftDay(input.day, -7);
  const rows = rowsOf<{ cur: boolean; product_kind: string; gross: string | number; refunds: string | number }>(
    await db.execute(sql`select day_on = ${input.day}::date as cur, product_kind, sum(gross_cents)::bigint as gross, sum(refunds_cents)::bigint as refunds
      from v_revenue_daily where day_on in (${input.day}::date, ${compareDay}::date) group by 1, 2`),
  );
  const total = (cur: boolean, k: "gross" | "refunds", kinds?: readonly string[]) =>
    rows.filter((r) => r.cur === cur && (!kinds || kinds.includes(r.product_kind))).reduce((n, r) => n + Number(r[k]), 0);
  const both = (k: "gross" | "refunds", kinds?: readonly string[]) => comparePeriods(total(true, k, kinds), total(false, k, kinds));
  const gross = both("gross");
  const refunds = both("refunds");
  return {
    day: input.day,
    compareDay,
    net: comparePeriods(gross.current - refunds.current, gross.previous - refunds.previous),
    refunds,
    groups: (Object.keys(REVENUE_GROUPS) as RevenueGroup[]).map((key) => ({ key, sales: both("gross", REVENUE_GROUPS[key]) })),
  };
}

// ---------------------------------------------------------------------------------------------
// 4b. Revenue for the day, the week to date and the month to date (owner: always visible together)
// ---------------------------------------------------------------------------------------------

export type RevenuePeriodKey = "day" | "week" | "month";
export type RevenuePeriod = {
  key: RevenuePeriodKey;
  from: string;
  to: string;
  /** The same span one period earlier (the same weekday last week, last week to the same weekday, last month to the same day). */
  compareFrom: string;
  compareTo: string;
  net: Comparison;
  groups: { key: RevenueGroup; sales: Comparison }[];
};

/** The last day of the month before `day`'s month, capped to `day`'s day of month. */
export function previousMonthSpan(day: string): [string, string] {
  const [y, m, d] = day.split("-").map(Number);
  const firstPrev = new Date(Date.UTC(y!, m! - 2, 1));
  const lastPrev = new Date(Date.UTC(y!, m! - 1, 0)).getUTCDate();
  const to = new Date(Date.UTC(firstPrev.getUTCFullYear(), firstPrev.getUTCMonth(), Math.min(d!, lastPrev)));
  return [firstPrev.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
}

/** Revenue of the day, the ISO week to date and the month to date, each against the same span one period earlier. */
export async function getRevenuePeriods(db: DbOrTx, input: { day: string }): Promise<RevenuePeriod[]> {
  const day = input.day;
  const monthStart = `${day.slice(0, 8)}01`;
  const [prevMonthFrom, prevMonthTo] = previousMonthSpan(day);
  const spans: Record<RevenuePeriodKey, [string, string, string, string]> = {
    day: [day, day, shiftDay(day, -7), shiftDay(day, -7)],
    week: [weekStart(day), day, shiftDay(weekStart(day), -7), shiftDay(day, -7)],
    month: [monthStart, day, prevMonthFrom, prevMonthTo],
  };
  const from = [prevMonthFrom, shiftDay(weekStart(day), -7)].sort()[0]!;
  const rows = rowsOf<{ day_on: string | Date; product_kind: string; gross: string | number; refunds: string | number }>(
    await db.execute(sql`select day_on, product_kind, sum(gross_cents)::bigint as gross, sum(refunds_cents)::bigint as refunds
      from v_revenue_daily where day_on between ${from}::date and ${day}::date group by 1, 2`),
  );
  const iso = (v: string | Date) => (typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10));
  const sum = (a: string, b: string, k: "gross" | "refunds", kinds?: readonly string[]) =>
    rows.filter((r) => iso(r.day_on) >= a && iso(r.day_on) <= b && (!kinds || kinds.includes(r.product_kind))).reduce((n, r) => n + Number(r[k]), 0);
  return (Object.keys(spans) as RevenuePeriodKey[]).map((key) => {
    const [a, b, ca, cb] = spans[key];
    const gross = comparePeriods(sum(a, b, "gross"), sum(ca, cb, "gross"));
    const refunds = comparePeriods(sum(a, b, "refunds"), sum(ca, cb, "refunds"));
    return {
      key,
      from: a,
      to: b,
      compareFrom: ca,
      compareTo: cb,
      net: comparePeriods(gross.current - refunds.current, gross.previous - refunds.previous),
      groups: (Object.keys(REVENUE_GROUPS) as RevenueGroup[]).map((g) => ({ key: g, sales: comparePeriods(sum(a, b, "gross", REVENUE_GROUPS[g]), sum(ca, cb, "gross", REVENUE_GROUPS[g])) })),
    };
  });
}
