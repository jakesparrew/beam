"use client";
/**
 * The attendee list of `/admin/sessions/[id]` (booking spec 5.1), in the back-office kit (owner
 * review, November 2026): one hairline table with the person (initials, name, "guest of" under
 * it), payment (with "to pay" on an unpaid pay-at-desk row), status as a pill and notes per
 * booking, with check in, undo, no-show, the late check-in correction, staff notes
 * (`updateBookingNotes`) and the cancel dialog. Buttons follow the flags the page computed from
 * `settings.booking_rules.check_in`; the actions check the same rules again. Every text comes
 * from the page.
 */
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Textarea, cn } from "@beam/ui";
import { checkIn, markNoShow, revertNoShow, undoCheckIn, updateBookingNotes } from "../actions/attendance";
import { CancelDialog, type CancelDialogLabels } from "./cancel-dialog";
import { Initials, StatusPill, td, th, type Tone } from "./kit";

export type AttendeeRowView = {
  bookingId: string;
  version: number;
  personId: string;
  name: string;
  guestOf: string | null;
  paidWith: string;
  status: string;
  statusLabel: string;
  /** "To pay: €25.00" on an unpaid pay-at-desk row. */
  toPay: string | null;
  notes: string | null;
  hasGuests: boolean;
  canCheckIn: boolean;
  canUndo: boolean;
  canMarkNoShow: boolean;
  canRevertNoShow: boolean;
  canCancel: boolean;
  /** The cancel dialog's policy preview. */
  policy: string;
};

export type AttendeeListLabels = {
  columns: { name: string; guestOf: string; paidWith: string; status: string; notes: string; actions: string };
  checkIn: string;
  undo: string;
  markNoShow: string;
  revertNoShow: string;
  editNotes: string;
  save: string;
  cancel: string;
  open: string;
  noHealthNotes: string;
  empty: string;
  cancelDialog: CancelDialogLabels;
  errors: Record<string, string>;
};

const STATUS_TONE: Record<string, Tone> = { attended: "ok", confirmed: "info", reserved: "warn", no_show: "bad", cancelled: "muted", late_cancelled: "muted" };

function NotesCell({ row, labels, canWrite, onError }: { row: AttendeeRowView; labels: AttendeeListLabels; canWrite: boolean; onError: (e: string | null) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(row.notes ?? "");
  const [pending, setPending] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const res = await updateBookingNotes({ bookingId: row.bookingId, notes });
      if (!res.ok) onError(labels.errors[res.error.message] ?? labels.errors[res.error.code] ?? res.error.code);
      else {
        onError(null);
        setEditing(false);
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  if (!editing) {
    return (
      <div className="grid justify-items-start gap-0.5">
        {row.notes ? <span className="text-[0.8125rem] whitespace-pre-line">{row.notes}</span> : null}
        {canWrite ? (
          <button type="button" className="text-[0.75rem] font-medium text-muted-foreground hover:text-foreground hover:underline" onClick={() => setEditing(true)}>
            {labels.editNotes}
          </button>
        ) : row.notes ? null : (
          <span className="text-muted-foreground">–</span>
        )}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void save(e)} className="grid gap-1">
      <Textarea aria-label={labels.columns.notes} aria-describedby={`notes-hint-${row.bookingId}`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} />
      <span id={`notes-hint-${row.bookingId}`} className="text-[0.75rem] text-muted-foreground">
        {labels.noHealthNotes}
      </span>
      <span className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {labels.save}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
          {labels.cancel}
        </Button>
      </span>
    </form>
  );
}

export function AttendeeList({ rows, labels, canWrite, canOverride }: { rows: AttendeeRowView[]; labels: AttendeeListLabels; canWrite: boolean; canOverride: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>) {
    setBusy(id);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(labels.errors[res.error!.message] ?? labels.errors[res.error!.code] ?? res.error!.code);
      else router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) return <p className="rounded-xl border border-border bg-card px-5 py-6 text-center text-[0.8125rem] text-muted-foreground">{labels.empty}</p>;

  return (
    <div className="grid gap-3">
      {error ? (
        <p role="alert" className="rounded-lg bg-[var(--status-bad-soft)] px-3 py-2 text-[0.8125rem] text-[var(--status-bad)]">
          {error}
        </p>
      ) : null}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-[0.8125rem]">
            <thead className="bg-[#faf9f6]">
              <tr className="border-b border-border">
                <th scope="col" className={th}>{labels.columns.name}</th>
                <th scope="col" className={cn(th, "w-40")}>{labels.columns.paidWith}</th>
                <th scope="col" className={cn(th, "w-36")}>{labels.columns.status}</th>
                <th scope="col" className={cn(th, "w-56")}>{labels.columns.notes}</th>
                <th scope="col" className={cn(th, "text-right")}>{labels.columns.actions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const gone = r.status === "cancelled" || r.status === "late_cancelled";
                return (
                  <tr key={r.bookingId} data-booking-id={r.bookingId} data-status={r.status} className={cn("border-b border-border align-top last:border-b-0 hover:bg-[#faf9f6]", gone && "text-muted-foreground")}>
                    <td className={td}>
                      <Link href={`/admin/bookings/${r.bookingId}` as Route} className="flex items-center gap-2.5">
                        <Initials id={r.personId} name={r.name} className={cn(gone && "opacity-60")} />
                        <span className="grid leading-tight">
                          <span className={cn("font-semibold hover:underline", !gone && "text-foreground")}>{r.name}</span>
                          {r.guestOf ? (
                            <span className="text-[0.75rem] text-muted-foreground">
                              {labels.columns.guestOf} {r.guestOf}
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    </td>
                    <td className={td}>
                      <span className="grid leading-tight">
                        <span>{r.paidWith}</span>
                        {r.toPay ? <span className="text-[0.75rem] font-semibold text-[var(--status-warn)]">{r.toPay}</span> : null}
                      </span>
                    </td>
                    <td className={td}>
                      <StatusPill tone={STATUS_TONE[r.status] ?? "muted"}>{r.statusLabel}</StatusPill>
                    </td>
                    <td className={td}>
                      <NotesCell row={r} labels={labels} canWrite={canWrite} onError={setError} />
                    </td>
                    <td className={cn(td, "text-right")}>
                      {canWrite ? (
                        <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                          {r.canMarkNoShow ? (
                            <Button type="button" variant="ghost" size="sm" className="h-8" disabled={busy === r.bookingId} onClick={() => void run(r.bookingId, () => markNoShow({ bookingId: r.bookingId }))}>
                              {labels.markNoShow}
                            </Button>
                          ) : null}
                          {r.canCancel ? (
                            <CancelDialog bookingId={r.bookingId} expectedVersion={r.version} hasGuests={r.hasGuests} policy={r.policy} canOverride={canOverride} labels={labels.cancelDialog} />
                          ) : null}
                          {r.canRevertNoShow ? (
                            <Button type="button" variant="outline" size="sm" className="h-8" disabled={busy === r.bookingId} onClick={() => void run(r.bookingId, () => revertNoShow({ bookingId: r.bookingId }))}>
                              {labels.revertNoShow}
                            </Button>
                          ) : null}
                          {r.canUndo ? (
                            <Button type="button" variant="outline" size="sm" className="h-8" disabled={busy === r.bookingId} onClick={() => void run(r.bookingId, () => undoCheckIn({ bookingId: r.bookingId }))}>
                              {labels.undo}
                            </Button>
                          ) : null}
                          {r.canCheckIn ? (
                            <Button type="button" size="sm" className="h-8" disabled={busy === r.bookingId} onClick={() => void run(r.bookingId, () => checkIn({ bookingId: r.bookingId }))}>
                              {labels.checkIn}
                            </Button>
                          ) : null}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
