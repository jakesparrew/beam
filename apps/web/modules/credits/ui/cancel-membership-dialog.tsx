"use client";
/**
 * The customer's membership actions (credits spec section 5, `/[locale]/account/membership`):
 * `CancelMembershipDialog` (the confirm dialog states the end date, rule 53; focus is trapped and
 * returns to the trigger on close), `ResumeMembershipButton` and `PayRenewalButton` (redirects to
 * the payment page commerce returns). Every string arrives as a prop; errors show inline.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@beam/ui";
import { cancelMyMembership, payMyRenewal, resumeMyMembership } from "../actions";

export type MembershipActionLabels = Record<string, string>;
type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/** The words for an error of a customer membership action. */
export function membershipError(error: { code: string; message: string }, l: MembershipActionLabels): string {
  if (error.message === "stale_version") return l["errors.stale_version"] ?? "";
  if (error.message === "nothing_to_pay") return l["errors.nothing_to_pay"] ?? "";
  return l[`errors.${error.code}`] ?? l["errors.generic"] ?? "";
}

function useRun() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(call: () => Promise<Result>, l: MembershipActionLabels, onOk?: (data: unknown) => void): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const r = await call();
      if (!r.ok) {
        setError(membershipError(r.error, l));
        return false;
      }
      if (onOk) onOk(r.data);
      else router.refresh();
      return true;
    } catch {
      setError(l["errors.generic"] ?? "");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

export function CancelMembershipDialog({
  membershipId,
  version,
  description,
  labels: l,
}: {
  membershipId: string;
  version: number;
  /** The end date in words, formatted on the server ("Your membership stays active until 31 Dec 2026 …"). */
  description: string;
  labels: MembershipActionLabels;
}) {
  const [open, setOpen] = useState(false);
  const { busy, error, run, setError } = useRun();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-11">
          {l["membership.cancel"]}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={l["membership.close"]}>
        <DialogHeader>
          <DialogTitle>{l["membership.cancel_title"]}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" className="min-h-11" onClick={() => setOpen(false)}>
            {l["membership.cancel_keep"]}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            disabled={busy}
            onClick={() =>
              void run(() => cancelMyMembership({ membershipId, version }), l).then((ok) => {
                if (ok) setOpen(false);
              })
            }
          >
            {busy ? l["membership.busy"] : l["membership.cancel_confirm"]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResumeMembershipButton({ membershipId, version, labels: l }: { membershipId: string; version: number; labels: MembershipActionLabels }) {
  const { busy, error, run } = useRun();
  return (
    <div className="grid gap-2">
      <Button type="button" className="min-h-11 w-fit" disabled={busy} onClick={() => void run(() => resumeMyMembership({ membershipId, version }), l)}>
        {busy ? l["membership.busy"] : l["membership.resume"]}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function PayRenewalButton({ membershipId, labels: l }: { membershipId: string; labels: MembershipActionLabels }) {
  const { busy, error, run } = useRun();
  return (
    <div className="grid gap-2">
      <Button
        type="button"
        className="min-h-11 w-fit"
        disabled={busy}
        onClick={() =>
          void run(
            () => payMyRenewal({ membershipId }),
            l,
            (data) => {
              const url = (data as { redirectUrl?: string } | null)?.redirectUrl;
              if (url) window.location.assign(url);
            },
          )
        }
      >
        {busy ? l["membership.busy"] : l["membership.pay"]}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
