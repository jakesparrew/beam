"use client";
/**
 * Staff cancellation dialog (booking spec 5.1 session detail and `/admin/bookings/[id]`, R28-R32):
 * shows the policy preview ("Free cancellation until ..." or "Cancelling now keeps the session
 * used"), asks whether the guests go too (default yes, R30) and a mandatory reason, and with
 * `bookings.override` offers the forced release or refund. It submits `cancelBooking` with the
 * version the page read; a stale version shows "This booking changed meanwhile, reload".
 * Every text comes from the page.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, FormField, Label, Textarea } from "@beam/ui";
import { cancelBooking } from "../actions/bookings";

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
