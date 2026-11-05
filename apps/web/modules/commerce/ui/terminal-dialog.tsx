"use client";
/**
 * The POS terminal dialog (commerce spec 5.1, edge case 16, rule 56): after "Take payment" by
 * terminal the screen polls the payment every 2 s (database only; the Mollie webhook moves it) for
 * up to 120 s. Paid opens the paid panel; failed, expired or cancelled says so and lets staff
 * choose another method on the same order. The cancel button cancels the payment (source staff).
 * Status changes are announced in an `aria-live="polite"` region. Also holds the receipt page's
 * print button (the only other client control of the POS screens).
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@beam/ui";
import { pollPosPayment, posCancelTerminal } from "../actions";

export type TerminalDialogText = {
  title: string;
  waiting: string;
  paid: string;
  failed: (status: string) => string;
  timeout: string;
  cancel: string;
  cancelled: string;
  chooseOther: string;
  error: string;
};

type Phase = "waiting" | "paid" | "ended" | "timeout" | "cancelled";

const POLL_MS = 2000;
const MAX_MS = 120_000;
const ENDED = new Set(["failed", "expired", "cancelled"]);

export function TerminalDialog({ paymentId, orderId, text, paidHref, otherHref }: { paymentId: string; orderId: string; text: TerminalDialogText; paidHref: string; otherHref: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("waiting");
  const [endedStatus, setEndedStatus] = useState("");
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const started = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== "waiting") return;
    started.current ??= Date.now();
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (Date.now() - (started.current ?? Date.now()) > MAX_MS) {
        setPhase("timeout");
        return;
      }
      const r = await pollPosPayment({ paymentId });
      if (stopped || !r.ok) return;
      if (r.data.orderStatus === "paid" || r.data.paymentStatus === "paid") {
        setPhase("paid");
        router.push(paidHref as never);
      } else if (ENDED.has(r.data.paymentStatus)) {
        setEndedStatus(r.data.paymentStatus);
        setPhase("ended");
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [phase, paymentId, paidHref, router]);

  const cancel = () =>
    startTransition(async () => {
      const r = await posCancelTerminal({ paymentId });
      if (r.ok) setPhase("cancelled");
      else setError(true);
    });

  const message =
    phase === "waiting" ? text.waiting : phase === "paid" ? text.paid : phase === "ended" ? text.failed(endedStatus) : phase === "timeout" ? text.timeout : text.cancelled;

  return (
    <section role="dialog" aria-modal="false" aria-labelledby={`terminal-${orderId}`} className="grid gap-3 rounded-md border p-4">
      <h2 id={`terminal-${orderId}`} className="text-lg font-semibold">
        {text.title}
      </h2>
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm" data-terminal-phase={phase}>
        {phase === "waiting" ? <span aria-hidden="true" className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
        <span>{message}</span>
      </div>
      {error ? <p className="text-sm text-destructive">{text.error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {phase === "waiting" || phase === "timeout" ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={cancel} disabled={pending}>
            {text.cancel}
          </Button>
        ) : null}
        {phase === "ended" || phase === "cancelled" ? (
          <Button type="button" className="min-h-11" onClick={() => router.push(otherHref as never)}>
            {text.chooseOther}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** "Print" on the receipt page. */
export function PrintButton({ label }: { label: string }) {
  return (
    <Button type="button" className="min-h-11 print:hidden" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
