/**
 * booking api, area `schedule` (booking spec 3.0b, 4.9 file layout): `getOpeningHours` and
 * `nextOpeningAt` (booking-P2). The pure parts are `openingHoursFor` and `nextOpening` in
 * `@beam/core/booking`; this file loads `settings.business_hours`, the session exceptions and
 * platform's Belgian public holidays.
 */
import type { DbOrTx } from "@beam/db";
import { sessionExceptions } from "@beam/db/schema";
import {
  NEXT_OPENING_HORIZON_DAYS,
  addDays,
  brusselsDate,
  eachDate,
  nextOpening,
  openingHoursFor,
  type ExceptionLike,
} from "@beam/core/booking";
import type { LocalizedText } from "@beam/core/i18n";
import { belgianPublicHolidays } from "@beam/core/platform";
import { and, asc, gte, lte } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";

export type ExceptionRow = typeof sessionExceptions.$inferSelect;

/** The exceptions with `on_date` in `[fromOn, toOn]`, ordered by date. */
export function loadExceptionRows(db: DbOrTx, fromOn: string, toOn: string): Promise<ExceptionRow[]> {
  return db
    .select()
    .from(sessionExceptions)
    .where(and(gte(sessionExceptions.onDate, fromOn), lte(sessionExceptions.onDate, toOn)))
    .orderBy(asc(sessionExceptions.onDate), asc(sessionExceptions.createdAt));
}

/** A stored exception in the shape of the pure core. */
export function toExceptionLike(e: ExceptionRow): ExceptionLike {
  return { id: e.id, onDate: e.onDate, kind: e.kind, templateIds: e.templateIds, opensAt: e.opensAt, closesAt: e.closesAt };
}

/** Platform's Belgian public holidays of every year that `[fromOn, toOn]` touches. */
export function holidaysBetween(fromOn: string, toOn: string): Array<{ on: string; key: string }> {
  const out: Array<{ on: string; key: string }> = [];
  for (let y = Number(fromOn.slice(0, 4)); y <= Number(toOn.slice(0, 4)); y++) {
    for (const h of belgianPublicHolidays(y)) if (h.on >= fromOn && h.on <= toOn) out.push(h);
  }
  return out;
}

const appliesToAll = (e: ExceptionRow) => !e.templateIds || e.templateIds.length === 0;

/** Site footer and contact page: opening hours per date in `[from, to]` (3.0b). */
export async function getOpeningHours(
  db: DbOrTx,
  input: { from: string; to: string },
): Promise<Array<{ onDate: string; opensAt: string | null; closesAt: string | null; exceptionName: LocalizedText | null }>> {
  if (input.to < input.from) return [];
  const hours = await getSetting(db, "business_hours");
  const rows = await loadExceptionRows(db, input.from, input.to);
  const exceptions = rows.map(toExceptionLike);
  return eachDate(input.from, input.to).map((onDate) => {
    const open = openingHoursFor(onDate, hours, exceptions);
    const exception = rows.find((e) => e.onDate === onDate && appliesToAll(e));
    return {
      onDate,
      opensAt: open?.opensAt ?? null,
      closesAt: open?.closesAt ?? null,
      exceptionName: exception ? (exception.name as LocalizedText) : null,
    };
  });
}

/**
 * Automation task due dates: the first open instant `>= from`, or null within 30 days (3.0b).
 * Belgian public holidays are skipped unless `includePublicHolidays` (office staff are off).
 */
export async function nextOpeningAt(db: DbOrTx, from: Date, opts?: { includePublicHolidays?: boolean }): Promise<Date | null> {
  const hours = await getSetting(db, "business_hours");
  const fromOn = brusselsDate(from);
  const toOn = addDays(fromOn, NEXT_OPENING_HORIZON_DAYS);
  const exceptions = (await loadExceptionRows(db, fromOn, toOn)).map(toExceptionLike);
  const holidays = opts?.includePublicHolidays ? [] : holidaysBetween(fromOn, toOn);
  return nextOpening(from, hours, exceptions, holidays);
}
