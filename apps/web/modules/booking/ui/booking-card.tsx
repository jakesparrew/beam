"use client";
/**
 * The check-in desk's result card (booking spec 5.1 `/admin/bookings/checkin`, R35-R37, R62b):
 * attendee, session and status, the big "Check in" button (`checkIn`), undo, no-show and the
 * late check-in correction, "To pay" with a "Take payment" link to commerce's POS for `reserved`
 * rows, the "Terms not yet accepted" and health declaration badges (never blocking), crm's
 * reception card data when crm provides it, and the owner's guests with "Check in all" (one
 * action per row). Every text comes from the page, already formatted.
 */
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Badge, Button, buttonVariants, cn } from "@beam/ui";
import { checkIn, markNoShow, revertNoShow, undoCheckIn } from "../actions/attendance";

export type BookingCardView = {
  bookingId: string;
  personId: string;
  name: string;
  sessionLine: string;
  status: string;
  statusLabel: string;
  /** "Checked in at 10:02" for an attended row. */
  checkedInLabel: string | null;
  /** "This booking is for Tue 5 Nov, not today." */
  wrongDayLabel: string | null;
  /** "To pay: €45.00" for a reserved row; with the POS order id. */
  toPayLabel: string | null;
  orderId: string | null;
  termsPending: boolean;
  health: "valid" | "expired" | "missing";
  canCheckIn: boolean;
  /** Outside the window or another day, with `bookings.override`: an override button shows. */
  canOverride: boolean;
  canUndo: boolean;
  canMarkNoShow: boolean;
  canRevertNoShow: boolean;
  notes: string | null;
  /** crm's reception card lines (customer number, status, member, tags, emergency contact, minor). */
  reception: string[];
  guests: Array<{ bookingId: string; name: string; statusLabel: string; canCheckIn: boolean }>;
};

export type BookingCardLabels = {
  checkIn: string;
  checkInAll: string;
  checkInOverride: string;
  undo: string;
  markNoShow: string;
  revertNoShow: string;
  takePayment: string;
  termsPending: string;
  healthMissing: string;
  healthExpired: string;
  fillInForm: string;
  guestsOf: string;
  notes: string;
  errors: Record<string, string>;
};

export function BookingCard({ card, labels, canWrite }: { card: BookingCardView; labels: BookingCardLabels; canWrite: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(labels.errors[res.error!.message] ?? labels.errors[res.error!.code] ?? labels.errors.internal ?? res.error!.code);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function checkInAll() {
    const ids = [card.canCheckIn ? card.bookingId : null, ...card.guests.filter((g) => g.canCheckIn).map((g) => g.bookingId)].filter((x): x is string => !!x);
    await run(async () => {
      for (const bookingId of ids) {
        const res = await checkIn({ bookingId });
        if (!res.ok) return res;
      }
      return { ok: true };
    });
  }

  const healthLabel = card.health === "missing" ? labels.healthMissing : card.health === "expired" ? labels.healthExpired : null;
  const guestsToCheck = card.guests.filter((g) => g.canCheckIn).length;

  return (
    <section aria-labelledby={`card-${card.bookingId}`} data-booking-id={card.bookingId} data-status={card.status} className="grid gap-4 rounded-lg border p-4 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id={`card-${card.bookingId}`} className="text-xl font-semibold">
            {card.name}
          </h2>
          <p className="text-sm text-muted-foreground">{card.sessionLine}</p>
        </div>
        <Badge variant={card.status === "attended" ? "default" : card.status === "reserved" || card.status === "no_show" ? "destructive" : "outline"}>{card.statusLabel}</Badge>
      </header>

      {card.wrongDayLabel ? (
        <Alert variant="destructive">
          <AlertDescription>{card.wrongDayLabel}</AlertDescription>
        </Alert>
      ) : null}
      {card.checkedInLabel ? <p className="text-sm font-medium">{card.checkedInLabel}</p> : null}

      <div className="flex flex-wrap gap-2">
        {card.termsPending ? <Badge variant="warning">{labels.termsPending}</Badge> : null}
        {healthLabel ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="warning">{healthLabel}</Badge>
            <Link href={`/admin/forms/enter?personId=${card.personId}` as Route} className="text-sm underline">
              {labels.fillInForm}
            </Link>
          </span>
        ) : null}
      </div>

      {card.reception.length ? (
        <ul className="grid gap-1 rounded-md bg-muted p-3 text-sm">
          {card.reception.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {card.notes ? (
        <p className="text-sm">
          <span className="font-medium">{labels.notes}: </span>
          {card.notes}
        </p>
      ) : null}

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {card.toPayLabel ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-lg font-semibold" data-testid="to-pay">
            {card.toPayLabel}
          </p>
          {card.orderId ? (
            <Link href={`/admin/pos?order=${card.orderId}` as Route} data-action="take-payment" className={buttonVariants({ size: "lg" })}>
              {labels.takePayment}
            </Link>
          ) : null}
        </div>
      ) : null}

      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          {card.canCheckIn ? (
            <Button type="button" data-action="check-in" size="lg" className="min-h-11 min-w-40 text-base" disabled={busy} onClick={() => void run(() => checkIn({ bookingId: card.bookingId }))}>
              {labels.checkIn}
            </Button>
          ) : null}
          {card.canOverride ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} data-action="check-in-override" onClick={() => void run(() => checkIn({ bookingId: card.bookingId, override: true }))}>
              {labels.checkInOverride}
            </Button>
          ) : null}
          {card.canUndo ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} data-action="undo" onClick={() => void run(() => undoCheckIn({ bookingId: card.bookingId }))}>
              {labels.undo}
            </Button>
          ) : null}
          {card.canRevertNoShow ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} data-action="revert-no-show" onClick={() => void run(() => revertNoShow({ bookingId: card.bookingId }))}>
              {labels.revertNoShow}
            </Button>
          ) : null}
          {card.canMarkNoShow ? (
            <Button type="button" variant="ghost" className="min-h-11" disabled={busy} data-action="no-show" onClick={() => void run(() => markNoShow({ bookingId: card.bookingId }))}>
              {labels.markNoShow}
            </Button>
          ) : null}
        </div>
      ) : null}

      {card.guests.length ? (
        <div className="grid gap-2 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">{labels.guestsOf}</h3>
            {canWrite && guestsToCheck > 0 ? (
              <Button type="button" variant="secondary" className="min-h-11" disabled={busy} data-action="check-in-all" onClick={() => void checkInAll()}>
                {labels.checkInAll}
              </Button>
            ) : null}
          </div>
          <ul className="grid gap-2">
            {card.guests.map((g) => (
              <li key={g.bookingId} data-booking-id={g.bookingId} className={cn("flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2")}>
                <span>
                  {g.name} <span className="text-sm text-muted-foreground">· {g.statusLabel}</span>
                </span>
                {canWrite && g.canCheckIn ? (
                  <Button type="button" size="sm" className="min-h-11" disabled={busy} onClick={() => void run(() => checkIn({ bookingId: g.bookingId }))}>
                    {labels.checkIn}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
