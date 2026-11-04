"use client";
/**
 * Staff cancellation dialog (booking spec 5.1 session detail and `/admin/bookings/[id]`, R28-R32):
 * shows the policy preview ("Free cancellation until ..." or "Cancelling now keeps the session
 * used"), asks whether the guests go too (default yes, R30) and a mandatory reason, and with
 * `bookings.override` offers the forced release or refund. It submits `cancelBooking` with the
 * version the page read; a stale version shows "This booking changed meanwhile, reload".
 * The same file holds the other staff change dialogs of the booking screens: reschedule (R31),
 * add a guest (R54-R56) and cancel the whole session (R33). Every text comes from the page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, FormField, Input, Label, Textarea } from "@beam/ui";
import { addGuest, cancelBooking, cancelSession, rescheduleBooking } from "../actions/bookings";

export type CancelDialogLabels = {
  trigger: string;
  title: string;
  includeGuests: string;
  reason: string;
  noHealthNotes: string;
  forceTitle: string;
  forceNone: string;
  forceReleaseCredit: string;
  forceRefund: string;
  confirm: string;
  close: string;
  reload: string;
  errors: Record<string, string>;
};

type Force = "none" | "release_credit" | "refund";

export function CancelDialog({
  bookingId,
  expectedVersion,
  hasGuests,
  policy,
  canOverride,
  labels,
}: {
  bookingId: string;
  expectedVersion: number;
  hasGuests: boolean;
  /** The policy preview, formatted by the page. */
  policy: string;
  canOverride: boolean;
  labels: CancelDialogLabels;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [includeGuests, setIncludeGuests] = useState(true);
  const [reason, setReason] = useState("");
  const [force, setForce] = useState<Force>("none");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; stale: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await cancelBooking({ bookingId, expectedVersion, includeGuests, reason, ...(force !== "none" ? { force } : {}) });
      if (res.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      const key = res.error.code === "validation" ? "validation" : res.error.message;
      setError({ text: labels.errors[key] ?? labels.errors[res.error.code] ?? labels.errors.internal ?? res.error.code, stale: res.error.message === "stale_version" });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8">
          {labels.trigger}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={labels.close}>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{labels.title}</DialogTitle>
            <DialogDescription>{policy}</DialogDescription>
          </DialogHeader>
          {hasGuests ? (
            <div className="flex items-center gap-2">
              <Checkbox id={`cancel-guests-${bookingId}`} checked={includeGuests} onCheckedChange={(v) => setIncludeGuests(v === true)} />
              <Label htmlFor={`cancel-guests-${bookingId}`}>{labels.includeGuests}</Label>
            </div>
          ) : null}
          <FormField label={labels.reason} hint={labels.noHealthNotes} required requiredMark=" *">
            <Textarea name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} rows={3} />
          </FormField>
          {canOverride ? (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">{labels.forceTitle}</legend>
              {(["none", "release_credit", "refund"] as const).map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="force" value={f} checked={force === f} onChange={() => setForce(f)} className="size-4" />
                  {f === "none" ? labels.forceNone : f === "release_credit" ? labels.forceReleaseCredit : labels.forceRefund}
                </label>
              ))}
            </fieldset>
          ) : null}
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {error.text}
                {error.stale ? (
                  <Button type="button" variant="link" size="sm" onClick={() => router.refresh()}>
                    {labels.reload}
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={pending || reason.trim().length === 0}>
              {labels.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The other staff changes of a booking and a session (booking spec 5.1, R31, R33, R54-R56)
// ---------------------------------------------------------------------------

export type ChangeDialogLabels = { trigger: string; title: string; reason: string; confirm: string; close: string; reload: string; errors: Record<string, string> };

/** A dialog shell with a reason field and the error box; `onSubmit` runs the action. */
function ChangeDialog({
  labels,
  reasonRequired,
  destructive,
  children,
  onSubmit,
}: {
  labels: ChangeDialogLabels;
  reasonRequired: boolean;
  destructive?: boolean;
  children?: ReactNode;
  onSubmit: (reason: string) => Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; stale: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await onSubmit(reason.trim());
      if (res.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      setError({ text: labels.errors[res.error.message] ?? labels.errors[res.error.code] ?? labels.errors.internal ?? res.error.code, stale: res.error.message === "stale_version" });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={destructive ? "destructive" : "outline"} size="sm" className="min-h-11 sm:min-h-8">
          {labels.trigger}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={labels.close}>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{labels.title}</DialogTitle>
          </DialogHeader>
          {children}
          <FormField label={labels.reason} required={reasonRequired} requiredMark=" *">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} required={reasonRequired} maxLength={500} rows={2} />
          </FormField>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {error.text}
                {error.stale ? (
                  <Button type="button" variant="link" size="sm" onClick={() => router.refresh()}>
                    {labels.reload}
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending || (reasonRequired && reason.trim().length < (destructive ? 3 : 1))}>
              {labels.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const selectClass =
  "h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Staff reschedule (`rescheduleBooking`, R31): a target session of the same kind and a reason. */
export function RescheduleDialog({
  bookingId,
  expectedVersion,
  targets,
  labels,
}: {
  bookingId: string;
  expectedVersion: number;
  targets: Array<{ id: string; label: string }>;
  labels: ChangeDialogLabels & { target: string; choose: string };
}) {
  const [target, setTarget] = useState("");
  return (
    <ChangeDialog
      labels={labels}
      reasonRequired
      onSubmit={async (reason) => {
        const res = await rescheduleBooking({ bookingId, expectedVersion, targetSessionId: target, reason });
        return res.ok ? { ok: true } : res;
      }}
    >
      <FormField label={labels.target} required requiredMark=" *">
        <select className={selectClass} value={target} onChange={(e) => setTarget(e.target.value)} required>
          <option value="">{labels.choose}</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </FormField>
    </ChangeDialog>
  );
}

/** Staff adds a guest to an owner's booking (`addGuest`, R54-R56); a free guest needs `bookings.override`. */
export function AddGuestDialog({
  ownerBookingId,
  isNight,
  payOptions,
  labels,
}: {
  ownerBookingId: string;
  isNight: boolean;
  payOptions: Array<{ value: "guest" | "order" | "free"; label: string }>;
  labels: ChangeDialogLabels & { firstName: string; lastName: string; email: string; sharesBed: string; payment: string };
}) {
  const [guest, setGuest] = useState({ firstName: "", lastName: "", email: "", sharesBed: false, payWith: payOptions[0]?.value ?? "guest" });
  const [clientKey] = useState(() => crypto.randomUUID());
  return (
    <ChangeDialog
      labels={labels}
      reasonRequired={false}
      onSubmit={async (reason) => {
        const res = await addGuest({
          ownerBookingId,
          guest: {
            firstName: guest.firstName.trim(),
            lastName: guest.lastName.trim(),
            ...(guest.email.trim() ? { email: guest.email.trim() } : {}),
            ...(isNight ? { sharesBed: guest.sharesBed } : {}),
            payWith: guest.payWith,
          },
          ...(reason ? { reason } : {}),
          clientKey,
        });
        return res.ok ? { ok: true } : res;
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <FormField label={labels.firstName} required requiredMark=" *">
          <Input value={guest.firstName} onChange={(e) => setGuest((g) => ({ ...g, firstName: e.target.value }))} required maxLength={100} />
        </FormField>
        <FormField label={labels.lastName} required requiredMark=" *">
          <Input value={guest.lastName} onChange={(e) => setGuest((g) => ({ ...g, lastName: e.target.value }))} required maxLength={100} />
        </FormField>
        <FormField label={labels.email}>
          <Input type="email" value={guest.email} onChange={(e) => setGuest((g) => ({ ...g, email: e.target.value }))} maxLength={320} />
        </FormField>
        <FormField label={labels.payment}>
          <select className={selectClass} value={guest.payWith} onChange={(e) => setGuest((g) => ({ ...g, payWith: e.target.value as "guest" | "order" | "free" }))}>
            {payOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      {isNight ? (
        <div className="flex items-center gap-2">
          <Checkbox id={`guest-bed-${ownerBookingId}`} checked={guest.sharesBed} onCheckedChange={(v) => setGuest((g) => ({ ...g, sharesBed: v === true }))} />
          <Label htmlFor={`guest-bed-${ownerBookingId}`}>{labels.sharesBed}</Label>
        </div>
      ) : null}
    </ChangeDialog>
  );
}

/** BEAM cancels the whole session (`cancelSession`, `bookings.override`, R33): reason (min 3) and "email every attendee". */
export function CancelSessionDialog({ sessionId, labels }: { sessionId: string; labels: ChangeDialogLabels & { notify: string; warning: string } }) {
  const [notify, setNotify] = useState(true);
  return (
    <ChangeDialog
      labels={labels}
      reasonRequired
      destructive
      onSubmit={async (reason) => {
        const res = await cancelSession({ id: sessionId, reason, notify });
        return res.ok ? { ok: true } : res;
      }}
    >
      <p className="text-sm">{labels.warning}</p>
      <div className="flex items-center gap-2">
        <Checkbox id={`cancel-session-notify-${sessionId}`} checked={notify} onCheckedChange={(v) => setNotify(v === true)} />
        <Label htmlFor={`cancel-session-notify-${sessionId}`}>{labels.notify}</Label>
      </div>
    </ChangeDialog>
  );
}
