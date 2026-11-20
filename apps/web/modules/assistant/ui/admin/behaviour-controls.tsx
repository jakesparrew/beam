"use client";

/** The two buttons of the behaviour panel: ask the lead agent for advice, and carry out one step. */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { advisePerson, applyAdvice } from "../../actions";

export function AskAgent({ personId, label, queuedLabel }: { personId: string; label: string; queuedLabel: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [queued, setQueued] = useState(false);
  return (
    <span className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending || queued}
        onClick={() =>
          start(async () => {
            const r = await advisePerson({ personId });
            if (!r.ok) return;
            setQueued(true);
            // The job runs right after the action; a few refreshes pick the advice up.
            for (const ms of [4000, 9000, 16000]) setTimeout(() => router.refresh(), ms);
            setTimeout(() => setQueued(false), 17000);
          })
        }
        className="rounded-full bg-[#212842] px-4 py-2 text-sm font-semibold text-[#fffaef] disabled:opacity-50"
      >
        {label}
      </button>
      {queued ? <span className="text-xs text-muted-foreground">{queuedLabel}</span> : null}
    </span>
  );
}

export function ApplyStep({ actionId, index, label }: { actionId: string; index: number; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await applyAdvice({ actionId, index });
            if (!r.ok) setError(r.error.message);
            router.refresh();
          })
        }
        className="site-gold rounded-full px-4 py-1.5 text-xs font-semibold text-[#212842] disabled:opacity-50"
      >
        {label}
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
