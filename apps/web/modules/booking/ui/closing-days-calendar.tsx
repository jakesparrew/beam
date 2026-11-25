"use client";
/**
 * Owner review section 10 "Closing days": a month grid of the schedule exceptions. Closed days
 * and holidays are red, special hours amber, weekdays that business hours keep closed are greyed.
 * Clicking a day opens a small panel below the grid: "Close this day" with an optional reason
 * (`upsertException`, kind `closed`, all sessions) or, on a day with exceptions, a button per
 * exception to remove it (`deleteException`). Texts and the grid come from the page.
 */
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Button, Input, Label, cn } from "@beam/ui";
import { deleteException, upsertException } from "../actions/templates";

type Locale = "nl-BE" | "fr-BE" | "en";

export type CalendarException = { id: string; kind: "closed" | "holiday" | "special_hours"; label: string; partial: boolean };
export type CalendarDay = { date: string; day: number; dateLabel: string; inMonth: boolean; past: boolean; today: boolean; weeklyClosed: boolean; exceptions: CalendarException[] };

export type ClosingDaysCalendarLabels = {
  weekdays: string[];
  hint: string;
  reason: string;
  close: string;
  remove: string;
  closedWeekly: string;
  partial: string;
  conflicts: string;
  openDay: string;
  error: string;
  kinds: Record<CalendarException["kind"], string>;
  /** Name in the three locales when no reason is given. */
  defaultName: Record<Locale, string>;
};

const isFullClosure = (e: CalendarException) => e.kind !== "special_hours" && !e.partial;

export function ClosingDaysCalendar({ days, labels }: { days: CalendarDay[]; labels: ClosingDaysCalendarLabels }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const day = days.find((d) => d.date === selected) ?? null;

  async function run(call: () => Promise<{ ok: true; data: { conflicts: unknown[] } } | { ok: false; error: unknown }>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await call();
      if (!res.ok) return setMessage({ error: true, text: labels.error });
      if (res.data.conflicts.length) setMessage({ error: false, text: labels.conflicts });
      setReason("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const close = (date: string) => {
    const text = reason.trim();
    const name = text ? { "nl-BE": text, "fr-BE": text, en: text } : labels.defaultName;
    return run(() => upsertException({ onDate: date, kind: "closed", name, templateIds: null }));
  };

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{labels.hint}</p>
      <div className="grid grid-cols-7 gap-1 text-sm">
        {labels.weekdays.map((w) => (
          <div key={w} aria-hidden className="px-1 py-1 text-center text-xs font-medium text-muted-foreground">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const closed = d.exceptions.some(isFullClosure);
          const special = !closed && d.exceptions.length > 0;
          return (
            <button
              key={d.date}
              type="button"
              aria-pressed={selected === d.date}
              aria-label={[d.dateLabel, ...d.exceptions.map((e) => `${labels.kinds[e.kind]}: ${e.label}`), d.weeklyClosed && !closed ? labels.closedWeekly : ""].filter(Boolean).join(" · ")}
              disabled={d.past}
              onClick={() => {
                setSelected(d.date === selected ? null : d.date);
                setMessage(null);
              }}
              className={cn(
                "flex min-h-20 flex-col items-start gap-1 rounded-md border p-1.5 text-left transition-colors hover:border-primary disabled:cursor-default disabled:hover:border-border",
                !d.inMonth && "opacity-40",
                d.past && "opacity-60",
                closed && "border-destructive/50 bg-destructive/10",
                special && "border-amber-400 bg-amber-50 dark:bg-amber-950/30",
                !closed && !special && d.weeklyClosed && "bg-muted",
                selected === d.date && "ring-2 ring-primary",
              )}
            >
              <span className={cn("text-xs tabular-nums", d.today && "rounded-full bg-primary px-1.5 font-semibold text-primary-foreground")}>{d.day}</span>
              {d.exceptions.slice(0, 2).map((e) => (
                <span key={e.id} className={cn("line-clamp-2 text-xs", isFullClosure(e) ? "font-medium text-destructive" : "text-amber-800 dark:text-amber-300")}>
                  {e.label}
                </span>
              ))}
              {!d.exceptions.length && d.weeklyClosed ? <span className="text-xs text-muted-foreground">{labels.closedWeekly}</span> : null}
            </button>
          );
        })}
      </div>

      {message ? (
        <Alert variant={message.error ? "destructive" : "default"} role={message.error ? "alert" : "status"}>
          <AlertDescription>
            {message.text}
            {!message.error && day ? (
              <>
                {" "}
                <Link href={`/admin/sessions/day/${day.date}` as Route} className="underline">
                  {labels.openDay}
                </Link>
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {day ? (
        <section aria-live="polite" className="grid gap-3 rounded-md border p-4">
          <h3 className="font-medium">
            <Link href={`/admin/sessions/day/${day.date}` as Route} className="hover:underline">
              {day.dateLabel}
            </Link>
          </h3>
          {day.exceptions.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                <span className="font-medium">{labels.kinds[e.kind]}</span> · {e.label}
                {e.partial ? <span className="text-muted-foreground"> ({labels.partial})</span> : null}
              </span>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(() => deleteException({ id: e.id }))}>
                {labels.remove}
              </Button>
            </div>
          ))}
          {day.exceptions.some(isFullClosure) ? null : (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(ev) => {
                ev.preventDefault();
                void close(day.date);
              }}
            >
              <div className="grid gap-1">
                <Label htmlFor="closing-reason">{labels.reason}</Label>
                <Input id="closing-reason" value={reason} maxLength={200} onChange={(ev) => setReason(ev.target.value)} className="w-72 max-w-full" />
              </div>
              <Button type="submit" disabled={busy}>
                {labels.close}
              </Button>
            </form>
          )}
        </section>
      ) : null}
    </div>
  );
}
