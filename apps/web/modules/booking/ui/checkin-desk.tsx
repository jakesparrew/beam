"use client";
/**
 * The reception desk's scan bar (booking spec 5.1 `/admin/bookings/checkin`, 5.4; owner review
 * November 2026): one compact, focused input that accepts a scanned code (a USB or Bluetooth
 * scanner types the code or the QR URL and Enter), a typed code or a name, with the desk's two
 * actions (`actions`) beside it. Submitting navigates to `?q=<input>` (keeping the chosen
 * session `?s=`); the page then shows the result card or the name matches (`children`). The
 * input keeps focus after each scan and is emptied, so the next guest can be scanned at once.
 * Also the one-click buttons of the day table: `CheckInButton` per row and `CheckInAllButton`
 * per session (one `checkIn` per booking, in order). Every text comes from the page.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Input, Label, NavIcon } from "@beam/ui";
import { checkIn } from "../actions/attendance";

export type CheckinDeskLabels = { scan: string; submit: string; hint: string };

export function CheckinDesk({ labels, actions, children }: { labels: CheckinDeskLabels; actions?: ReactNode; children?: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  // After every navigation (a scan, a check-in refresh) the field takes focus again.
  useEffect(() => {
    input.current?.focus();
  }, [params]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = value.trim();
    if (!q) return;
    setValue("");
    const next = new URLSearchParams();
    const session = params.get("s");
    if (session) next.set("s", session);
    next.set("q", q);
    router.push(`${pathname}?${next.toString()}` as never);
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <form role="search" onSubmit={submit} className="flex min-w-[16rem] flex-1 items-center gap-2">
          <Label htmlFor="checkin-scan" className="sr-only">
            {labels.scan}
          </Label>
          <Input
            ref={input}
            id="checkin-scan"
            name="q"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={labels.scan}
            aria-describedby="checkin-scan-hint"
            className="h-10 flex-1 bg-card text-[0.9375rem]"
          />
          <span id="checkin-scan-hint" className="sr-only">
            {labels.hint}
          </span>
          <Button type="submit" variant="outline" className="h-10">
            {labels.submit}
          </Button>
        </form>
        {actions}
      </div>
      <div aria-live="polite" className="grid gap-3">
        {children}
      </div>
    </div>
  );
}

type Result = { ok: boolean; error?: { code: string; message: string } };

/** Runs `checkIn` for each booking in order, stops at the first refusal, refreshes on success. */
function useCheckIn(errors: Record<string, string>) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(bookingIds: string[]) {
    setBusy(true);
    setError(null);
    try {
      for (const bookingId of bookingIds) {
        const res: Result = await checkIn({ bookingId });
        if (!res.ok) {
          setError(errors[res.error!.message] ?? errors[res.error!.code] ?? errors.internal ?? res.error!.code);
          return;
        }
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function ErrorText({ text }: { text: string | null }) {
  return text ? (
    <span role="alert" className="text-[0.75rem] text-[var(--status-bad)]">
      {text}
    </span>
  ) : null;
}

export function CheckInButton({ bookingId, label, errors }: { bookingId: string; label: string; errors: Record<string, string> }) {
  const { busy, error, run } = useCheckIn(errors);
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <ErrorText text={error} />
      <Button type="button" size="sm" className="h-8 min-w-28" disabled={busy} data-action="row-check-in" onClick={() => void run([bookingId])}>
        <NavIcon icon="circle-check" />
        {label}
      </Button>
    </span>
  );
}

export function CheckInAllButton({ bookingIds, label, errors }: { bookingIds: string[]; label: string; errors: Record<string, string> }) {
  const { busy, error, run } = useCheckIn(errors);
  return (
    <span className="inline-flex items-center gap-2">
      <ErrorText text={error} />
      <Button type="button" variant="outline" size="sm" className="h-8" disabled={busy} data-action="session-check-in-all" onClick={() => void run(bookingIds)}>
        <NavIcon icon="users" />
        {label}
        <span className="tabular-nums opacity-60">{bookingIds.length}</span>
      </Button>
    </span>
  );
}
