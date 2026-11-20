"use client";

/**
 * The week pager of the `availability_preview` block: the server prepares whole weeks (seven
 * days each, closed days included), this only switches which week is shown.
 */
import { useState } from "react";

export type WeekSlot = { sessionId: string; startsAt: string; time: string; band: string; bandLabel: string; href: string };
export type WeekDay = { key: string; weekday: string; day: string; month: string; slots: WeekSlot[] };
export type Week = { label: string; days: WeekDay[] };

const DOT: Record<string, string> = { available: "bg-[#3f8f5a]", few: "bg-[#d1a64a]", full: "bg-[#9aa0b0]" };

export function AvailabilityWeeks({ weeks, night, labels }: { weeks: Week[]; night: boolean; labels: { prev: string; next: string; closed: string } }) {
  const [i, setI] = useState(0);
  const week = weeks[i]!;
  const navBtn = `grid size-10 place-items-center rounded-full border transition disabled:opacity-30 ${night ? "border-[#fffaef]/20 hover:bg-[#fffaef]/10" : "border-border hover:bg-[#f4ead3]"}`;
  const accent = night ? "text-[#d1a64a]" : "text-[#d1a64a]";
  return (
    <div className="relative mt-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="font-display text-xl" aria-live="polite">
          {week.label}
        </p>
        <div className="flex gap-2">
          <button type="button" className={navBtn} onClick={() => setI(i - 1)} disabled={i === 0} aria-label={labels.prev}>
            ←
          </button>
          <button type="button" className={navBtn} onClick={() => setI(i + 1)} disabled={i === weeks.length - 1} aria-label={labels.next}>
            →
          </button>
        </div>
      </div>
      <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-2 md:grid md:grid-cols-7 md:overflow-visible">
        {week.days.map((d) => {
          const closed = d.slots.length === 0;
          return (
            <li
              key={d.key}
              className={`min-w-[8.5rem] snap-start rounded-2xl border p-3 md:min-w-0 ${closed ? (night ? "border-dashed border-[#fffaef]/10" : "border-dashed border-border") : night ? "border-[#fffaef]/15 bg-[#fffaef]/5" : "border-border bg-[#fffaef]"}`}
            >
              <div className={`flex items-baseline justify-between gap-2 ${closed ? "opacity-50" : ""}`}>
                <span className={`text-[0.7rem] font-semibold tracking-[0.2em] uppercase ${accent}`}>{d.weekday}</span>
                <span className="text-xs text-muted-foreground">{d.month}</span>
              </div>
              <p className={`font-display text-3xl leading-tight ${closed ? "opacity-50" : ""}`}>{d.day}</p>
              {closed ? (
                <p className="mt-3 text-xs text-muted-foreground">{labels.closed}</p>
              ) : (
                <ul className="mt-3 space-y-1.5">
                  {d.slots.map((s) => (
                    <li key={s.sessionId}>
                      <a
                        href={s.href}
                        aria-disabled={s.band === "full" || undefined}
                        className={`flex items-center justify-between gap-2 rounded-full px-3 py-1.5 text-sm font-medium tabular-nums transition ${s.band === "full" ? "pointer-events-none line-through opacity-50" : night ? "bg-[#fffaef]/10 hover:bg-[#fffaef]/20" : "bg-card shadow-sm hover:bg-[#f4ead3]"}`}
                      >
                        <time dateTime={s.startsAt}>{s.time}</time>
                        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[s.band] ?? DOT.available}`} />
                        <span data-band={s.band} className="sr-only">
                          {s.bandLabel}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
