"use client";
/**
 * The staff day view (booking spec 5.1 `/admin/sessions/day/[date]`): sessions in time order with
 * an availability bar, attendee and check-in counts, unpaid pay-at-desk rows and a close/reopen
 * button (`setSessionOpen`, `bookings.write`). The banner shows the opening hours or the
 * exception that closes the day. Every text comes from the page.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Badge, Button, cn } from "@beam/ui";
import { setSessionOpen } from "../actions/sessions";

export type DayViewItem = {
  id: string;
  time: string;
  title: string;
  kindLabel: string;
  status: "open" | "closed" | "cancelled";
  statusLabel: string;
  capacity: number;
  used: number;
  bookedLabel: string;
  attendeesLabel: string;
  checkedInLabel: string;
  unpaidLabel: string | null;
  location: string | null;
};

export type DayViewLabels = { close: string; reopen: string; error: string; forbidden: string; availability: string };

export function DayView({ items, banner, empty, canWrite, labels }: { items: DayViewItem[]; banner: string | null; empty: string; canWrite: boolean; labels: DayViewLabels }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(item: DayViewItem) {
    setBusy(item.id);
    setError(null);
    try {
      const res = await setSessionOpen({ id: item.id, open: item.status !== "open" });
      if (!res.ok) setError(res.error.code === "forbidden" ? labels.forbidden : labels.error);
      else router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4">
      {banner ? <p className="rounded-md border bg-muted px-3 py-2 text-sm">{banner}</p> : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {items.length === 0 ? <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{empty}</p> : null}
      <ul className="grid gap-3">
        {items.map((s) => {
          const pct = s.capacity > 0 ? Math.min(100, Math.round((s.used / s.capacity) * 100)) : 100;
          return (
            <li key={s.id} className={cn("grid gap-2 rounded-md border p-3 sm:grid-cols-[6rem_1fr_auto] sm:items-center", s.status === "cancelled" && "opacity-60")}>
              <span className="text-lg font-semibold tabular-nums">{s.time}</span>
              <div className="grid gap-1">
                <span className="font-medium">
                  {s.title} <span className="text-sm font-normal text-muted-foreground">· {s.kindLabel}{s.location ? ` · ${s.location}` : ""}</span>
                </span>
                <div
                  className="h-2 w-full overflow-hidden rounded bg-muted"
                  role="meter"
                  aria-label={labels.availability}
                  aria-valuemin={0}
                  aria-valuemax={s.capacity}
                  aria-valuenow={s.used}
                  aria-valuetext={s.bookedLabel}
                >
                  <div className={cn("h-full", pct >= 100 ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
                </div>
                <span className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                  <span>{s.bookedLabel}</span>
                  <span>{s.attendeesLabel}</span>
                  <span>{s.checkedInLabel}</span>
                  {s.unpaidLabel ? <Badge variant="destructive">{s.unpaidLabel}</Badge> : null}
                  <Badge variant="outline">{s.statusLabel}</Badge>
                </span>
              </div>
              {canWrite && s.status !== "cancelled" ? (
                <Button type="button" variant="outline" size="sm" disabled={busy === s.id} onClick={() => void toggle(s)}>
                  {s.status === "open" ? labels.close : labels.reopen}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
