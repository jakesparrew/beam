"use client";

import { useEffect, useRef, useState } from "react";

export type ReturnPollStatus = { status: string; paymentStatus: string | null; dueCents: number };
type PollResult = { ok: true; data: ReturnPollStatus } | { ok: false; error: { code: string; message: string } };

export type ReturnPollerLabels = {
  checking: string;
  paid: string;
  granted: string;
  failed: string;
  pending: string;
  expired: string;
  retry: string;
};

const FAILED = new Set(["failed", "expired", "cancelled"]);

/**
 * site-P9: the purchase conversion of the paid return page. `track` is site's
 * `trackMarketingConversion` (passed in by the page, a client reference: commerce may not import
 * site's ui); it reports only to the marketing tags loaded after marketing consent and does
 * nothing otherwise. Reported once per order and browser tab session (`key`).
 */
export type PurchaseConversion = {
  track: (kind: "purchase", input: { valueCents?: number }) => void;
  valueCents: number;
  key: string;
};

const CONVERSION_STORAGE_PREFIX = "beam_purchase_tracked:";

/** Calls `conversion.track` unless this tab already reported `conversion.key`; true when reported. */
export function reportPurchaseConversion(conversion: PurchaseConversion, storage: Pick<Storage, "getItem" | "setItem"> | null): boolean {
  const storageKey = CONVERSION_STORAGE_PREFIX + conversion.key;
  try {
    if (storage?.getItem(storageKey)) return false;
    storage?.setItem(storageKey, "1");
  } catch {
    // Storage blocked: report anyway (at worst once per page view).
  }
  conversion.track("purchase", { valueCents: conversion.valueCents });
  return true;
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function phaseOf(s: ReturnPollStatus | null, timedOut: boolean): "checking" | "paid" | "failed" | "expired" | "pending" {
  if (!s) return timedOut ? "pending" : "checking";
  if (s.status === "paid" || s.status === "partially_refunded" || s.status === "refunded") return "paid";
  if (s.status === "expired" || s.status === "cancelled") return "expired";
  if (s.paymentStatus && FAILED.has(s.paymentStatus)) return "failed";
  return timedOut ? "pending" : "checking";
}

/**
 * The return page poll (section 5.2): asks `poll` every 2 s for 30 s and announces each status
 * change in an `aria-live="polite"` region (rule 56). Paid shows the success text, a failed
 * payment the retry button (a form posting to `retryAction`), still open after 30 s "Payment
 * pending, we will email you".
 */
export function ReturnPoller({
  initial,
  poll,
  retryAction,
  labels,
  conversion,
  intervalMs = 2000,
  maxMs = 30_000,
}: {
  initial: ReturnPollStatus;
  poll: () => Promise<PollResult>;
  retryAction: ((fd: FormData) => Promise<void>) | null;
  labels: ReturnPollerLabels;
  conversion?: PurchaseConversion | null;
  intervalMs?: number;
  maxMs?: number;
}) {
  const [status, setStatus] = useState<ReturnPollStatus>(initial);
  const [timedOut, setTimedOut] = useState(false);
  const started = useRef<number | null>(null);
  const phase = phaseOf(status, timedOut);
  const reported = useRef(false);

  // Deferred to a task after this commit's effects: the layout's marketing tags (rendered after
  // the page) initialise in their own effect, which runs after this one.
  useEffect(() => {
    if (phase !== "paid" || !conversion || reported.current) return;
    const id = window.setTimeout(() => {
      reported.current = true;
      reportPurchaseConversion(conversion, sessionStore());
    }, 0);
    return () => window.clearTimeout(id);
  }, [phase, conversion]);

  useEffect(() => {
    if (phase === "paid" || phase === "expired" || phase === "failed" || timedOut) return;
    started.current ??= Date.now();
    const begun = started.current;
    const tick = async () => {
      try {
        const res = await poll();
        if (res.ok) setStatus(res.data);
      } catch {
        // A failed poll is retried on the next tick.
      }
      if (Date.now() - begun >= maxMs) setTimedOut(true);
    };
    const id = window.setTimeout(() => {
      void tick();
    }, intervalMs);
    return () => window.clearTimeout(id);
  }, [phase, poll, intervalMs, maxMs, timedOut, status]);

  const text = phase === "paid" ? labels.paid : phase === "failed" ? labels.failed : phase === "expired" ? labels.expired : phase === "pending" ? labels.pending : labels.checking;
  return (
    <div className="grid gap-4" data-return-phase={phase}>
      <div aria-live="polite" role="status" className="rounded-md border p-4 text-base">
        <p className="font-medium">{text}</p>
        {phase === "paid" ? <p className="mt-1 text-sm">{labels.granted}</p> : null}
      </div>
      {(phase === "failed" || phase === "pending") && retryAction ? (
        <form action={retryAction}>
          <button type="submit" className="min-h-11 rounded-md bg-primary px-5 font-medium text-primary-foreground">
            {labels.retry}
          </button>
        </form>
      ) : null}
    </div>
  );
}
