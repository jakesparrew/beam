"use client";
/**
 * The staff waitlist table (booking spec 5.1 `/admin/waitlist` and the session tab, R48, R49):
 * entries grouped by session and queue, with the duplicate signals of flagged entries and the
 * staff actions `offerSeatManually`, `moveWaitlistEntry` (queue or position), `releaseWaitlistEntry`
 * and `reviewWaitlistFlag`. A `confirmed` entry shows no action (protected seat, R41). Entries
 * without an email are marked "phone this person" when offered. Texts come from the page.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Badge, Button, Input } from "@beam/ui";
import { moveWaitlistEntry, offerSeatManually, releaseWaitlistEntry, reviewWaitlistFlag } from "../actions/waitlist";

type Queue = "lead" | "customer" | "public";
type State = "waiting" | "offered" | "confirmed" | "released" | "expired" | "withdrawn";

export type WaitlistTableRow = {
  entryId: string;
  sessionId: string;
  sessionLabel: string;
  personName: string;
  hasEmail: boolean;
  queue: Queue;
  state: State;
  joinedAt: string;
  offerExpiresAt: string | null;
  isFlagged: boolean;
  flagReason: string | null;
  bookingId: string | null;
};

export type WaitlistTableLabels = {
  person: string;
  queue: string;
  joinedAt: string;
  offerExpires: string;
  signals: string;
  offerSeat: string;
  moveQueue: string;
  reorder: string;
  release: string;
  withdraw: string;
  clearFlag: string;
  reason: string;
  noEmailPhone: string;
  confirm: string;
  empty: string;
  queues: Record<Queue, string>;
  states: Record<State, string>;
  errors: Record<string, string>;
};

const fmt = (iso: string) => new Intl.DateTimeFormat(undefined, { timeZone: "Europe/Brussels", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

const selectClass = "h-9 rounded-md border border-input bg-transparent px-2 text-sm";

function Row({ row, labels, onDone }: { row: WaitlistTableRow; labels: WaitlistTableLabels; onDone: (error: string | null) => void }) {
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const [joinedAt, setJoinedAt] = useState("");
  const open = row.state === "waiting" || (row.state === "offered" && !row.bookingId);

  async function run(fn: () => Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>) {
    setPending(true);
    try {
      const res = await fn();
      if (res.ok) onDone(null);
      else onDone(labels.errors[res.error.code === "conflict" ? res.error.message : res.error.code] ?? labels.errors.validation ?? res.error.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <tr className="border-b align-top" data-testid={`waitlist-row-${row.entryId}`}>
      <td className="p-2">
        <div className="font-medium">{row.personName}</div>
        {row.state === "offered" && !row.hasEmail ? <div className="text-xs text-amber-700">{labels.noEmailPhone}</div> : null}
        {row.isFlagged ? (
          <div className="mt-1 text-xs">
            <Badge variant="destructive">{labels.signals}</Badge> <span className="break-all">{row.flagReason}</span>
          </div>
        ) : null}
      </td>
      <td className="p-2">
        <div>{labels.queues[row.queue]}</div>
        <div className="text-xs text-muted-foreground">
          {labels.states[row.state]}
          {row.offerExpiresAt && row.state === "offered" ? ` · ${labels.offerExpires} ${fmt(row.offerExpiresAt)}` : ""}
        </div>
      </td>
      <td className="p-2 text-sm">{fmt(row.joinedAt)}</td>
      <td className="p-2">
        {open ? (
          <div className="flex flex-wrap items-center gap-2">
            {row.state === "waiting" ? (
              <Button size="sm" disabled={pending} onClick={() => void run(() => offerSeatManually({ entryId: row.entryId }))}>
                {labels.offerSeat}
              </Button>
            ) : null}
            <label className="sr-only" htmlFor={`queue-${row.entryId}`}>
              {labels.moveQueue}
            </label>
            <select
              id={`queue-${row.entryId}`}
              className={selectClass}
              value={row.queue}
              disabled={pending}
              onChange={(e) => void run(() => moveWaitlistEntry({ entryId: row.entryId, queue: e.target.value as Queue }))}
            >
              {(Object.keys(labels.queues) as Queue[]).map((q) => (
                <option key={q} value={q}>
                  {labels.queues[q]}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={`joined-${row.entryId}`}>
              {labels.reorder}
            </label>
            <Input id={`joined-${row.entryId}`} type="datetime-local" className="h-9 w-48" value={joinedAt} onChange={(e) => setJoinedAt(e.target.value)} />
            <Button size="sm" variant="outline" disabled={pending || !joinedAt} onClick={() => void run(() => moveWaitlistEntry({ entryId: row.entryId, joinedAt: new Date(joinedAt).toISOString() }))}>
              {labels.reorder}
            </Button>
            <label className="sr-only" htmlFor={`reason-${row.entryId}`}>
              {labels.reason}
            </label>
            <Input id={`reason-${row.entryId}`} className="h-9 w-48" placeholder={labels.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button size="sm" variant="outline" disabled={pending || !reason.trim()} onClick={() => void run(() => releaseWaitlistEntry({ entryId: row.entryId, reason }))}>
              {labels.release}
            </Button>
            {row.isFlagged && row.state === "waiting" ? (
              <>
                <Button size="sm" variant="secondary" disabled={pending || !reason.trim()} onClick={() => void run(() => reviewWaitlistFlag({ entryId: row.entryId, decision: "clear", note: reason }))}>
                  {labels.clearFlag}
                </Button>
                <Button size="sm" variant="destructive" disabled={pending || !reason.trim()} onClick={() => void run(() => reviewWaitlistFlag({ entryId: row.entryId, decision: "withdraw", note: reason }))}>
                  {labels.withdraw}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export function WaitlistTable({ rows, labels, showSession = true }: { rows: WaitlistTableRow[]; labels: WaitlistTableLabels; showSession?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{labels.empty}</p>;
  const sessions = [...new Map(rows.map((r) => [r.sessionId, r.sessionLabel])).entries()];
  const done = (e: string | null) => {
    setError(e);
    if (!e) router.refresh();
  };
  return (
    <div className="space-y-6">
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {sessions.map(([sessionId, sessionLabel]) => (
        <section key={sessionId} aria-label={sessionLabel}>
          {showSession ? <h2 className="mb-2 text-lg font-semibold">{sessionLabel}</h2> : null}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="p-2">{labels.person}</th>
                  <th className="p-2">{labels.queue}</th>
                  <th className="p-2">{labels.joinedAt}</th>
                  <th className="p-2">
                    <span className="sr-only">{labels.confirm}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((r) => r.sessionId === sessionId)
                  .map((r) => (
                    <Row key={r.entryId} row={r} labels={labels} onDone={done} />
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
