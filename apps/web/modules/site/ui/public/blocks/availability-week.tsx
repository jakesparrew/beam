"use client";

/**
 * The week pager of the `availability_preview` block: the server prepares whole weeks (seven
 * days each, closed days included), this only switches which week is shown. Each time links to
 * its booking page; with `pick` (the moment step of `/book`) times are chosen instead, one or
 * more, and a bar under the week continues to the first one with the others as `?more=<id>,<id>`
 * (owner: more sessions are added here, not later in the form).
 */
import { useState } from "react";

export type WeekSlot = { sessionId: string; startsAt: string; time: string; band: string; bandLabel: string; href: string };
export type WeekDay = { key: string; weekday: string; day: string; month: string; slots: WeekSlot[] };
export type Week = { label: string; days: WeekDay[] };

/** `continue[n - 1]` is the button text for n chosen times. */
export type PickLabels = { continue: string[]; clear: string };

const DOT: Record<string, string> = { available: "bg-[#3f8f5a]", few: "bg-[#d1a64a]", full: "bg-[#9aa0b0]" };

type Picked = { sessionId: string; startsAt: string; href: string; label: string };

/** The first chosen time's page, with the others in `more`. */
function continueHref(picked: Picked[]): string {
  const [first, ...rest] = picked;
  const url = new URL(first!.href, "http://local");
  if (rest.length) url.searchParams.set("more", rest.map((p) => p.sessionId).join(","));
  return url.pathname + url.search;
}

export function AvailabilityWeeks({ weeks, night, labels, pick }: { weeks: Week[]; night: boolean; labels: { prev: string; next: string; closed: string }; pick?: PickLabels }) {
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<Picked[]>([]);
  const week = weeks[i]!;
  const navBtn = `grid size-10 place-items-center rounded-full border transition disabled:opacity-30 ${night ? "border-[#fffaef]/20 hover:bg-[#fffaef]/10" : "border-border hover:bg-[#f4ead3]"}`;
  const accent = night ? "text-[#d1a64a]" : "text-[#d1a64a]";
  const toggle = (d: WeekDay, s: WeekSlot) =>
    setPicked((list) =>
      list.some((p) => p.sessionId === s.sessionId)
        ? list.filter((p) => p.sessionId !== s.sessionId)
        : [...list, { sessionId: s.sessionId, startsAt: s.startsAt, href: s.href, label: `${d.weekday} ${d.day} · ${s.time}` }].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    );
  const slotClass = (s: WeekSlot, on: boolean) =>
    `flex w-full items-center justify-center gap-2 rounded-xl px-2 py-2 text-[0.9375rem] font-semibold tabular-nums transition ${
      s.band === "full"
        ? "pointer-events-none line-through opacity-50"
        : on
          ? night
            ? "bg-[#d1a64a] text-[#212842]"
            : "bg-[#212842] text-[#fffaef]"
          : night
            ? "bg-[#fffaef]/10 hover:bg-[#fffaef]/20"
            : "bg-card shadow-sm hover:bg-[#f4ead3]"
    }`;
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
                  {d.slots.map((s) => {
                    const on = picked.some((p) => p.sessionId === s.sessionId);
                    const inner = (
                      <>
                        {on ? (
                          <span aria-hidden="true" className="w-2 text-xs leading-none">
                            ✓
                          </span>
                        ) : (
                          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[s.band] ?? DOT.available}`} />
                        )}
                        <time dateTime={s.startsAt}>{s.time}</time>
                        <span data-band={s.band} className="sr-only">
                          {s.bandLabel}
                        </span>
                      </>
                    );
                    return (
                      <li key={s.sessionId}>
                        {pick ? (
                          <button type="button" aria-pressed={on} disabled={s.band === "full"} onClick={() => toggle(d, s)} className={slotClass(s, on)} data-testid={`pick-${s.sessionId}`}>
                            {inner}
                          </button>
                        ) : (
                          <a href={s.href} aria-disabled={s.band === "full" || undefined} className={slotClass(s, false)}>
                            {inner}
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {pick && picked.length ? (
        <div
          className="site-on-dark sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-[#212842] p-3 pl-4 text-[#fffaef] shadow-[0_16px_40px_-16px_rgb(33_40_66/0.6)]"
          data-testid="pick-bar"
        >
          <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {picked.map((p) => (
              <li key={p.sessionId} className="rounded-full bg-[#fffaef]/10 px-3 py-1 text-xs font-medium tabular-nums first-letter:uppercase">
                {p.label}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setPicked([])} className="text-sm text-[#fffaef]/70 underline-offset-4 hover:text-[#fffaef] hover:underline">
            {pick.clear}
          </button>
          <a href={continueHref(picked)} className="site-gold inline-flex items-center gap-2 rounded-full py-1.5 pr-1.5 pl-5 text-sm font-semibold text-[#212842]" data-testid="pick-continue">
            {pick.continue[Math.min(picked.length, pick.continue.length) - 1]}
            <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-[#212842] text-[#fffaef]">
              →
            </span>
          </a>
        </div>
      ) : null}
    </div>
  );
}
