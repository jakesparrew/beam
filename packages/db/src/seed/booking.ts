/**
 * booking seeds (booking-P2, booking spec 3.0, 3.0b, 9 and section 12).
 *
 * - `seed` (the `defaults` profile, also run in production): the settings rows `booking_rules`
 *   and `business_hours` with their defaults and the module's two `retention_policies` rows,
 *   all `on conflict (key) do nothing`. The retention rows are written only once ops has created
 *   `retention_policies`.
 * - `seedBookingDemo` (the `demo` profile helper): the demo schedule (four day blocks Tue-Sun
 *   09:00/11:30/14:00/16:30, 120 minutes, 12 seats; a night Fri-Sat 21:00, 720 minutes, 6 beds)
 *   and one published `lecture` event. booking's demo seed (`apps/web/modules/booking/seed.ts`)
 *   calls it and then materialises the next 90 days; it never runs in the `defaults` profile.
 */
import { and, eq, sql } from "drizzle-orm";
import { DEFAULT_BOOKING_RULES, DEFAULT_BUSINESS_HOURS, addDays, brusselsDate, zonedTimeToUtc } from "@beam/core/booking";
import type { DbOrTx } from "../client";
import { sessionTemplates, sessions } from "../schema/booking";
import { settings } from "../schema/platform";
import type { DefaultSeed } from "./run";

/** Section 9 (cross-module D37): anchored on the session's `starts_at`, run by booking's `sweep`. */
export const BOOKING_RETENTION_POLICIES = [
  {
    key: "booking.waitlist_entries",
    tableName: "waitlist_entries",
    days: 365,
    action: "delete",
    description: "Waiting list entries, 1 year after the session started",
  },
  {
    key: "booking.bookings_free_text",
    tableName: "bookings",
    days: 1095,
    action: "anonymise",
    description: "Booking notes and cancellation reasons, 3 years after the session started",
  },
] as const;

const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);

async function tableExists(db: DbOrTx, name: string): Promise<boolean> {
  const rows = rowsOf<{ t: string | null }>(await db.execute(sql`select to_regclass(${`public.${name}`})::text as t`));
  return rows[0]?.t != null;
}

/** Inserts the two settings and the retention policies; idempotent. */
export async function seedBookingDefaults(db: DbOrTx): Promise<void> {
  await db
    .insert(settings)
    .values([
      { key: "booking_rules", value: DEFAULT_BOOKING_RULES },
      { key: "business_hours", value: DEFAULT_BUSINESS_HOURS },
    ])
    .onConflictDoNothing({ target: settings.key });
  if (!(await tableExists(db, "retention_policies"))) return;
  for (const p of BOOKING_RETENTION_POLICIES) {
    await db.execute(sql`insert into retention_policies (key, table_name, days, action, description)
      values (${p.key}, ${p.tableName}, ${p.days}, ${p.action}, ${p.description})
      on conflict (key) do nothing`);
  }
}

export const seed: DefaultSeed = {
  after: ["platform", "ops"],
  run: (db) => seedBookingDefaults(db),
};

// ---------------------------------------------------------------------------
// Demo rows
// ---------------------------------------------------------------------------

const DAY_NAME = { "nl-BE": "Dagsessie", "fr-BE": "Séance de jour", en: "Day session" };
const DAY_DESCRIPTION = {
  "nl-BE": "Twee uur warmte, rust en ontspanning in het centrum.",
  "fr-BE": "Deux heures de chaleur, de calme et de détente au centre.",
  en: "Two hours of warmth, rest and relaxation at the centre.",
};
const NIGHT_NAME = { "nl-BE": "Nachtverblijf", "fr-BE": "Séjour de nuit", en: "Night stay" };
const LECTURE_TITLE = { "nl-BE": "Lezing: slapen en herstel", "fr-BE": "Conférence : sommeil et récupération", en: "Lecture: sleep and recovery" };
const LECTURE_DESCRIPTION = {
  "nl-BE": "Een avond over slaap, ademhaling en herstel, met tijd voor vragen.",
  "fr-BE": "Une soirée sur le sommeil, la respiration et la récupération, avec du temps pour les questions.",
  en: "An evening about sleep, breathing and recovery, with time for questions.",
};
/** Marks the demo lecture so a second seed run finds it. */
export const DEMO_LECTURE_NOTE = "demo:booking:lecture";

type DemoTemplate = Omit<typeof sessionTemplates.$inferInsert, "activeFromOn">;

const DEMO_TEMPLATES: DemoTemplate[] = [
  ...["09:00", "11:30", "14:00", "16:30"].map((startTime) => ({
    kind: "day" as const,
    name: DAY_NAME,
    description: DAY_DESCRIPTION,
    weekdays: [2, 3, 4, 5, 6, 7],
    startTime,
    durationMinutes: 120,
    capacitySeats: 12,
    creditKind: "day" as const,
    creditCost: 1,
    location: "Warmteruimte",
  })),
  {
    kind: "night",
    name: NIGHT_NAME,
    weekdays: [5, 6],
    startTime: "21:00",
    durationMinutes: 720,
    capacityBeds: 6,
    creditKind: "night",
    creditCost: 1,
    location: "Slaapzaal",
  },
];

/**
 * The demo schedule and the demo lecture (idempotent: a template is matched on kind and start
 * time, the lecture on its note). Returns the template ids and the lecture's session id.
 */
export async function seedBookingDemo(db: DbOrTx, input: { now: Date }): Promise<{ templateIds: string[]; lectureSessionId: string }> {
  const today = brusselsDate(input.now);
  const templateIds: string[] = [];
  for (const t of DEMO_TEMPLATES) {
    const [existing] = await db
      .select({ id: sessionTemplates.id })
      .from(sessionTemplates)
      .where(and(eq(sessionTemplates.kind, t.kind), eq(sessionTemplates.startTime, t.startTime)));
    if (existing) {
      templateIds.push(existing.id);
      continue;
    }
    const [row] = await db.insert(sessionTemplates).values({ ...t, activeFromOn: today }).returning({ id: sessionTemplates.id });
    templateIds.push(row!.id);
  }
  const [lecture] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.notes, DEMO_LECTURE_NOTE));
  if (lecture) return { templateIds, lectureSessionId: lecture.id };
  const startsAt = zonedTimeToUtc(addDays(today, 21), "19:30");
  const [row] = await db
    .insert(sessions)
    .values({
      kind: "event",
      eventCategory: "lecture",
      title: LECTURE_TITLE,
      description: LECTURE_DESCRIPTION,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 120 * 60_000),
      capacitySeats: 40,
      creditKind: null,
      creditCost: 0,
      location: "Grote zaal",
      notes: DEMO_LECTURE_NOTE,
      hasManualChanges: true,
      publishedAt: input.now,
    })
    .returning({ id: sessions.id });
  return { templateIds, lectureSessionId: row!.id };
}
