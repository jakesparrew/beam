/**
 * `availability_preview` block (rule 30): the bands of `booking.getAvailabilityPreview`, never a
 * number, with Book links into the portal (rule 31). Rendered as a week schedule from today: seven
 * columns per week (Europe/Brussels, closed days marked), a coloured dot per band (with the band
 * in text for screen readers) and a pager over the loaded weeks, in day style (light) or night
 * style (navy). Each time links straight to that session's booking page.
 */
import type { Locale } from "@beam/core/i18n";
import type { AvailabilityBand } from "@beam/core/site";
import { bookSessionPath, portalUrl } from "../../../server/urls";
import { ArrowBadge, goldButtonClass, type BlockContext, type BlockOf } from "../block-renderer";
import { AvailabilityWeeks, type Week, type WeekDay } from "./availability-week";
import { bandLabel } from "./events-list";

const TZ = "Europe/Brussels";
const DAY_MS = 86_400_000;
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
const fmt = (d: Date, locale: Locale, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts }).format(d);

const DOT: Record<string, string> = { available: "bg-[#3f8f5a]", few: "bg-[#d1a64a]", full: "bg-[#9aa0b0]" };

type Slot = { sessionId: string; startsAt: string; band: string };

/** Whole weeks (seven days each, closed days included) from today up to the last slot. */
export function buildWeeks(slots: Slot[], locale: Locale, tr: BlockContext["tr"], hrefOf: (sessionId: string) => string): Week[] {
  const byDay = new Map<string, Slot[]>();
  for (const s of slots) byDay.set(dayKey(new Date(s.startsAt)), [...(byDay.get(dayKey(new Date(s.startsAt))) ?? []), s]);
  // Whole weeks from today up to the last loaded session (noon steps keep DST from skipping a day).
  const noon = new Date(`${dayKey(new Date())}T12:00:00Z`);
  const last = slots.length ? new Date(slots.at(-1)!.startsAt) : noon;
  const weekCount = Math.max(1, Math.ceil((last.getTime() - noon.getTime() + DAY_MS) / (7 * DAY_MS)));
  return Array.from({ length: weekCount }, (_, w): Week => {
    const days: WeekDay[] = Array.from({ length: 7 }, (_, d) => {
      const date = new Date(noon.getTime() + (w * 7 + d) * DAY_MS);
      return {
        key: dayKey(date),
        weekday: fmt(date, locale, { weekday: "short" }),
        day: fmt(date, locale, { day: "numeric" }),
        month: fmt(date, locale, { month: "short" }),
        slots: (byDay.get(dayKey(date)) ?? []).map((s) => ({
          sessionId: s.sessionId,
          startsAt: s.startsAt,
          time: fmt(new Date(s.startsAt), locale, { hour: "2-digit", minute: "2-digit" }),
          band: s.band,
          bandLabel: bandLabel(s.band as AvailabilityBand, tr),
          href: hrefOf(s.sessionId),
        })),
      };
    });
    const first = new Date(noon.getTime() + w * 7 * DAY_MS);
    const end = new Date(first.getTime() + 6 * DAY_MS);
    return { label: new Intl.DateTimeFormat(locale, { timeZone: TZ, day: "numeric", month: "long" }).formatRange(first, end), days };
  });
}

export function AvailabilityPreviewBlockView({ block, ctx }: { block: BlockOf<"availability_preview">; ctx: BlockContext }) {
  const { tr, locale } = ctx;
  const slots = ctx.data.availability[block.id] ?? [];
  const night = block.kind === "night";
  const bookHref = portalUrl(locale, night ? "book_night" : "book_day");
  const weeks = buildWeeks(slots, locale, tr, (id) => bookSessionPath(locale, id));

  return (
    <div className={`relative overflow-hidden rounded-[2rem] p-6 sm:p-10 ${night ? "site-on-dark bg-[#212842]" : "border border-border bg-card"}`}>
      {night ? (
        <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(1px_1px_at_8%_15%,#fffaef,transparent),radial-gradient(1.5px_1.5px_at_28%_8%,#d1a64a,transparent),radial-gradient(1px_1px_at_62%_14%,#fffaef,transparent),radial-gradient(1px_1px_at_88%_10%,#fffaef,transparent)] opacity-80" />
      ) : null}
      <div className="relative flex flex-col justify-between gap-6 md:flex-row md:items-end">
        <div className="space-y-2">
          <p className={`text-xs font-semibold tracking-[0.3em] uppercase ${night ? "text-[#d1a64a]" : "text-[#d1a64a]"}`}>{night ? "☾" : "☀"} {tr(night ? "site.blocks.availability.kindNight" : "site.blocks.availability.kindDay")}</p>
          <h2 className="font-display text-3xl sm:text-4xl">{tr(night ? "site.blocks.availability.titleNight" : "site.blocks.availability.titleDay")}</h2>
          <ul className="flex flex-wrap gap-4 pt-1 text-xs text-muted-foreground">
            {(["available", "few", "full"] as const).map((b) => (
              <li key={b} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={`size-2 rounded-full ${DOT[b]}`} />
                {bandLabel(b, tr)}
              </li>
            ))}
          </ul>
        </div>
        <a href={bookHref} className={`${goldButtonClass} self-start py-2 pr-2 pl-6 md:self-auto`}>
          {tr("site.blocks.availability.book")}
          <ArrowBadge dark />
        </a>
      </div>
      {slots.length === 0 ? (
        <p className="relative mt-8 text-muted-foreground">{tr("site.blocks.availability.none")}</p>
      ) : (
        <AvailabilityWeeks
          weeks={weeks}
          night={night}
          labels={{ prev: tr("site.blocks.availability.prevWeek"), next: tr("site.blocks.availability.nextWeek"), closed: tr("site.blocks.availability.closed") }}
        />
      )}
    </div>
  );
}
