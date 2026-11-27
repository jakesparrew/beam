"use client";
/**
 * The check-in desk's result card (booking spec 5.1 `/admin/bookings/checkin`, R35-R37, R62b),
 * in the back-office kit style (owner review, November 2026): one hairline surface with the
 * attendee (initials, name, session, status pill) and the "Check in" button (`checkIn`) on the
 * right, then one line of small cues (night, member, package, child, guest), the attention items
 * (terms not yet accepted, health declaration, never blocking) with the form link, crm's
 * reception data as one muted line, the notes, "To pay" with a "Take payment" link to commerce's
 * POS for `reserved` rows, undo, no-show and the late check-in correction, and the owner's guests
 * as compact rows with "Check in all" (one action per row). `credits` is the credits module's
 * desk line, rendered in the card. Every text comes from the page, already formatted.
 */
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button, NavIcon, buttonVariants, cn } from "@beam/ui";
import { checkIn, markNoShow, revertNoShow, undoCheckIn } from "../actions/attendance";
import { Initials, StatusPill, type Tone } from "./kit";

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
  /** Visual cues shown as small icon chips: `icon` is a `NavIcon` name ("moon", "badge-check", ...). */
  cues: Array<{ icon: string; label: string }>;
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

const STATUS_TONE: Record<string, Tone> = { attended: "ok", confirmed: "info", reserved: "warn", no_show: "bad", cancelled: "muted", late_cancelled: "muted" };
const chip = "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[0.75rem] font-medium";

export function BookingCard({ card, labels, canWrite, credits }: { card: BookingCardView; labels: BookingCardLabels; canWrite: boolean; credits?: ReactNode }) {
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
    <section aria-labelledby={`card-${card.bookingId}`} data-booking-id={card.bookingId} data-status={card.status} className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Initials id={card.personId} name={card.name} className="size-10 text-[0.8125rem]" />
          <div className="grid min-w-0 gap-0.5">
            <h2 id={`card-${card.bookingId}`} className="flex flex-wrap items-center gap-2 text-[1.0625rem] font-semibold">
              {card.name}
              <StatusPill tone={STATUS_TONE[card.status] ?? "muted"}>{card.statusLabel}</StatusPill>
            </h2>
            <p className="text-[0.8125rem] text-muted-foreground">{card.sessionLine}</p>
          </div>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            {card.canMarkNoShow ? (
              <Button type="button" variant="ghost" size="sm" disabled={busy} data-action="no-show" onClick={() => void run(() => markNoShow({ bookingId: card.bookingId }))}>
                <NavIcon icon="user-x" />
                {labels.markNoShow}
              </Button>
            ) : null}
            {card.canRevertNoShow ? (
              <Button type="button" variant="outline" size="sm" disabled={busy} data-action="revert-no-show" onClick={() => void run(() => revertNoShow({ bookingId: card.bookingId }))}>
                {labels.revertNoShow}
              </Button>
            ) : null}
            {card.canUndo ? (
              <Button type="button" variant="outline" size="sm" disabled={busy} data-action="undo" onClick={() => void run(() => undoCheckIn({ bookingId: card.bookingId }))}>
                {labels.undo}
              </Button>
            ) : null}
            {card.canOverride ? (
              <Button type="button" variant="outline" size="sm" disabled={busy} data-action="check-in-override" onClick={() => void run(() => checkIn({ bookingId: card.bookingId, override: true }))}>
                <NavIcon icon="circle-check" />
                {labels.checkInOverride}
              </Button>
            ) : null}
            {card.canCheckIn ? (
              <Button type="button" data-action="check-in" className="h-10 min-w-36 text-[0.9375rem]" disabled={busy} onClick={() => void run(() => checkIn({ bookingId: card.bookingId }))}>
                <NavIcon icon="circle-check" className="size-5" />
                {labels.checkIn}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      {card.wrongDayLabel ? (
        <p role="status" className="rounded-lg bg-[var(--status-bad-soft)] px-3 py-2 text-[0.8125rem] font-medium text-[var(--status-bad)]">
          {card.wrongDayLabel}
        </p>
      ) : null}

      {card.cues.length || card.termsPending || healthLabel || card.checkedInLabel ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {card.checkedInLabel ? (
            <span className={cn(chip, "bg-[var(--status-ok-soft)] text-[var(--status-ok)]")}>
              <NavIcon icon="circle-check" className="size-3.5" />
              {card.checkedInLabel}
            </span>
          ) : null}
          {card.cues.length ? (
            <ul className="contents" data-testid="checkin-cues">
              {card.cues.map((c) => (
                <li key={c.icon} className={cn(chip, "bg-muted text-foreground")}>
                  <NavIcon icon={c.icon} className="size-3.5 text-muted-foreground" />
                  {c.label}
                </li>
              ))}
            </ul>
          ) : null}
          {card.termsPending ? (
            <span className={cn(chip, "bg-[var(--status-warn-soft)] text-[var(--status-warn)]")}>
              <NavIcon icon="scroll-text" className="size-3.5" />
              {labels.termsPending}
            </span>
          ) : null}
          {healthLabel ? (
            <span className={cn(chip, "bg-[var(--status-warn-soft)] text-[var(--status-warn)]")}>
              <NavIcon icon="activity" className="size-3.5" />
              {healthLabel}
              <Link href={`/admin/forms/enter?personId=${card.personId}` as Route} className="font-semibold underline underline-offset-2">
                {labels.fillInForm}
              </Link>
            </span>
          ) : null}
        </div>
      ) : null}

      {card.reception.length ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[0.75rem] text-muted-foreground">
          {card.reception.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {card.notes ? (
        <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-[0.8125rem]">
          <NavIcon icon="sticky-note" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            <span className="font-semibold">{labels.notes}: </span>
            {card.notes}
          </span>
        </p>
      ) : null}
      {credits}

      {card.toPayLabel ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--status-warn-soft)] px-3 py-2">
          <p className="flex items-center gap-2 text-[0.9375rem] font-semibold text-[var(--status-warn)]" data-testid="to-pay">
            <NavIcon icon="euro" className="size-4" />
            {card.toPayLabel}
          </p>
          {card.orderId ? (
            <Link href={`/admin/pos?order=${card.orderId}` as Route} data-action="take-payment" className={buttonVariants({ size: "sm" })}>
              <NavIcon icon="credit-card" />
              {labels.takePayment}
            </Link>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-lg bg-[var(--status-bad-soft)] px-3 py-2 text-[0.8125rem] text-[var(--status-bad)]">
          {error}
        </p>
      ) : null}

      {card.guests.length ? (
        <div className="grid gap-1 border-t border-border pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[0.8125rem] font-semibold">
              <NavIcon icon="user-plus" className="size-4 text-muted-foreground" />
              {labels.guestsOf}
            </h3>
            {canWrite && guestsToCheck > 0 ? (
              <Button type="button" variant="outline" size="sm" disabled={busy} data-action="check-in-all" onClick={() => void checkInAll()}>
                <NavIcon icon="users" />
                {labels.checkInAll}
              </Button>
            ) : null}
          </div>
          <ul className="grid">
            {card.guests.map((g) => (
              <li key={g.bookingId} data-booking-id={g.bookingId} className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border py-1.5 last:border-b-0">
                <span className="flex items-center gap-2.5">
                  <Initials id={g.bookingId} name={g.name} className="size-7" />
                  <span className="font-medium">{g.name}</span>
                  <span className="text-[0.75rem] text-muted-foreground">{g.statusLabel}</span>
                </span>
                {canWrite && g.canCheckIn ? (
                  <Button type="button" size="sm" disabled={busy} onClick={() => void run(() => checkIn({ bookingId: g.bookingId }))}>
                    <NavIcon icon="circle-check" />
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
