/**
 * The staff week calendar (booking spec 5.1 `/admin/sessions`): Monday to Sunday columns, each
 * session a block with time, title, booked of capacity, holds, waiting count, a lead badge and
 * a status colour that is never the only signal (the status is also written out). The page
 * resolves every text; this component only lays it out. Server component.
 */
import Link from "next/link";
import type { Route } from "next";
import { Badge, cn } from "@beam/ui";

export type CalendarBlock = {
  id: string;
  time: string;
  title: string;
  kindLabel: string;
  status: "open" | "closed" | "cancelled";
  statusLabel: string | null;
  booked: string;
  held: string | null;
  waiting: string | null;
  lead: string | null;
  draft: string | null;
  full: boolean;
};

export type CalendarDay = { onDate: string; label: string; isToday: boolean; closedLabel: string | null; blocks: CalendarBlock[] };

const tone: Record<CalendarBlock["status"], string> = {
  open: "border-l-primary",
  closed: "border-l-amber-500 bg-amber-50 dark:bg-amber-950/30",
  cancelled: "border-l-destructive bg-muted text-muted-foreground line-through",
};

export function CalendarWeek({ days, empty }: { days: CalendarDay[]; empty: string | null }) {
  return (
    <div className="grid gap-3">
      {empty ? <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{empty}</p> : null}
      <ol className="grid gap-3 md:grid-cols-7">
        {days.map((d) => (
          <li key={d.onDate} className={cn("grid content-start gap-2 rounded-md border p-2", d.isToday && "ring-2 ring-primary")}>
            <Link href={`/admin/sessions/day/${d.onDate}` as Route} className="text-sm font-medium hover:underline" aria-current={d.isToday ? "date" : undefined}>
              {d.label}
            </Link>
            {d.closedLabel ? <p className="rounded bg-muted px-2 py-1 text-xs">{d.closedLabel}</p> : null}
            <ul className="grid gap-2">
              {d.blocks.map((b) => (
                <li key={b.id}>
                  <Link
                    href={`/admin/sessions/day/${d.onDate}` as Route}
                    className={cn("block rounded border border-l-4 p-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tone[b.status])}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span className="font-semibold">{b.time}</span>
                      <span className={cn("tabular-nums", b.full && "font-semibold text-destructive")}>{b.booked}</span>
                    </span>
                    <span className="block truncate">{b.title}</span>
                    <span className="block text-muted-foreground">{b.kindLabel}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {b.statusLabel ? <Badge variant="outline">{b.statusLabel}</Badge> : null}
                      {b.draft ? <Badge variant="outline">{b.draft}</Badge> : null}
                      {b.lead ? <Badge>{b.lead}</Badge> : null}
                      {b.held ? <Badge variant="secondary">{b.held}</Badge> : null}
                      {b.waiting ? <Badge variant="secondary">{b.waiting}</Badge> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
