"use client";
/**
 * The attendee list of `/admin/sessions/[id]` (booking spec 5.1): name, guest of, paid with,
 * status and notes per booking, with check in, undo, no-show, the late check-in correction,
 * staff notes (`updateBookingNotes`) and the cancel dialog. Buttons follow the flags the page
 * computed from `settings.booking_rules.check_in`; the actions check the same rules again.
 * Every text comes from the page.
 */
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@beam/ui";
import { checkIn, markNoShow, revertNoShow, undoCheckIn, updateBookingNotes } from "../actions/attendance";
import { CancelDialog, type CancelDialogLabels } from "./cancel-dialog";

export type AttendeeRowView = {
  bookingId: string;
  version: number;
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
      <div className="grid gap-1">
        {row.notes ? <span className="whitespace-pre-line text-sm">{row.notes}</span> : null}
        {canWrite ? (
          <Button type="button" variant="link" size="sm" className="h-auto justify-start p-0" onClick={() => setEditing(true)}>
            {labels.editNotes}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void save(e)} className="grid gap-1">
      <Textarea aria-label={labels.columns.notes} aria-describedby={`notes-hint-${row.bookingId}`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} />
      <span id={`notes-hint-${row.bookingId}`} className="text-xs text-muted-foreground">
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

  if (rows.length === 0) return <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{labels.empty}</p>;

  return (
    <div className="grid gap-3">
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{labels.columns.name}</TableHead>
            <TableHead>{labels.columns.guestOf}</TableHead>
            <TableHead>{labels.columns.paidWith}</TableHead>
            <TableHead>{labels.columns.status}</TableHead>
            <TableHead>{labels.columns.notes}</TableHead>
            <TableHead>{labels.columns.actions}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.bookingId} data-booking-id={r.bookingId} data-status={r.status}>
              <TableCell className="font-medium">
                <Link href={`/admin/bookings/${r.bookingId}` as Route} className="underline-offset-4 hover:underline">
                  {r.name}
                </Link>
              </TableCell>
              <TableCell>{r.guestOf ?? ""}</TableCell>
              <TableCell>{r.paidWith}</TableCell>
              <TableCell>
                <span className="flex flex-wrap gap-1">
                  <Badge variant={r.status === "attended" ? "default" : "outline"}>{r.statusLabel}</Badge>
                  {r.toPay ? <Badge variant="warning">{r.toPay}</Badge> : null}
                </span>
              </TableCell>
              <TableCell>
                <NotesCell row={r} labels={labels} canWrite={canWrite} onError={setError} />
              </TableCell>
              <TableCell>
                {canWrite ? (
                  <span className="flex flex-wrap gap-2">
                    {r.canCheckIn ? (
                      <Button type="button" size="sm" disabled={busy === r.bookingId} onClick={() => void run(r.bookingId, () => checkIn({ bookingId: r.bookingId }))}>
                        {labels.checkIn}
                      </Button>
                    ) : null}
                    {r.canUndo ? (
                      <Button type="button" variant="outline" size="sm" disabled={busy === r.bookingId} onClick={() => void run(r.bookingId, () => undoCheckIn({ bookingId: r.bookingId }))}>
                        {labels.undo}
                      </Button>
                    ) : null}
                    {r.canRevertNoShow ? (
                      <Button type="button" variant="outline" size="sm" disabled={busy === r.bookingId} onClick={() => void run(r.bookingId, () => revertNoShow({ bookingId: r.bookingId }))}>
                        {labels.revertNoShow}
                      </Button>
                    ) : null}
                    {r.canMarkNoShow ? (
                      <Button type="button" variant="ghost" size="sm" disabled={busy === r.bookingId} onClick={() => void run(r.bookingId, () => markNoShow({ bookingId: r.bookingId }))}>
                        {labels.markNoShow}
                      </Button>
                    ) : null}
                    {r.canCancel ? (
                      <CancelDialog bookingId={r.bookingId} expectedVersion={r.version} hasGuests={r.hasGuests} policy={r.policy} canOverride={canOverride} labels={labels.cancelDialog} />
                    ) : null}
                  </span>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
