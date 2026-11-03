/**
 * Belgian public holidays (PL-88): the ten legal days. Easter by the anonymous Gregorian
 * algorithm (Meeus/Jones/Butcher). Used for support hours and booking's closed-day hints.
 */
export type PublicHoliday = { on: string; key: string };

export const BELGIAN_HOLIDAY_KEYS = [
  "new_year",
  "easter_monday",
  "labour_day",
  "ascension",
  "whit_monday",
  "national_day",
  "assumption",
  "all_saints",
  "armistice",
  "christmas",
] as const;

export type BelgianHolidayKey = (typeof BELGIAN_HOLIDAY_KEYS)[number];

/** Easter Sunday as `[month, day]` (month 1-12). */
export function easterSunday(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

const iso = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);

const cache = new Map<number, PublicHoliday[]>();

/** The ten Belgian public holidays of `year`, sorted by date. */
export function belgianPublicHolidays(year: number): { on: string; key: string }[] {
  if (!Number.isInteger(year) || year < 1583) throw new RangeError(`unsupported year ${year}`);
  const cached = cache.get(year);
  if (cached) return cached.map((h) => ({ ...h }));
  const [em, ed] = easterSunday(year);
  const fromEaster = (days: number) => iso(year, em, ed + days);
  const list: PublicHoliday[] = [
    { on: iso(year, 1, 1), key: "new_year" },
    { on: fromEaster(1), key: "easter_monday" },
    { on: iso(year, 5, 1), key: "labour_day" },
    { on: fromEaster(39), key: "ascension" },
    { on: fromEaster(50), key: "whit_monday" },
    { on: iso(year, 7, 21), key: "national_day" },
    { on: iso(year, 8, 15), key: "assumption" },
    { on: iso(year, 11, 1), key: "all_saints" },
    { on: iso(year, 11, 11), key: "armistice" },
    { on: iso(year, 12, 25), key: "christmas" },
  ].sort((a, b) => a.on.localeCompare(b.on));
  cache.set(year, list);
  return list.map((h) => ({ ...h }));
}

/** Whether `YYYY-MM-DD` is a Belgian public holiday. */
export function isBelgianPublicHoliday(isoDate: string): boolean {
  const year = Number(isoDate.slice(0, 4));
  return belgianPublicHolidays(year).some((h) => h.on === isoDate);
}
