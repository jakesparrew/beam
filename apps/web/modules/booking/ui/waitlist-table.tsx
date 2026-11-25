"use client";
/**
 * The staff waitlist table (booking spec 5.1 `/admin/waitlist` and the session tab, R48, R49):
 * entries grouped by date, product type and session (in queue order), with the duplicate signals of flagged entries and the
 * staff actions `offerSeatManually`, `moveWaitlistEntry` (queue or position), `releaseWaitlistEntry`
 * and `reviewWaitlistFlag`. A `confirmed` entry shows no action (protected seat, R41). Entries
 * without an email are marked "phone this person" when offered. Texts come from the page.
 */
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Badge, Button, Input, NavIcon } from "@beam/ui";
import { moveWaitlistEntry, offerSeatManually, releaseWaitlistEntry, reviewWaitlistFlag } from "../actions/waitlist";

type Queue = "lead" | "customer" | "public";
type State = "waiting" | "offered" | "confirmed" | "released" | "expired" | "withdrawn";
type ProductType = "day" | "night" | "event" | "webinar";

export type WaitlistTableRow = {
  entryId: string;
  sessionId: string;
  sessionLabel: string;
  sessionTitle: string;
  /** Brussels date `YYYY-MM-DD` of the session start, the group key. */
  sessionDate: string;
  dateLabel: string;
  timeLabel: string;
  productType: ProductType;
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
  productTypes: Record<ProductType, string>;
  /** "Waiting: {count}", filled in per session. */
  waitingCount: string;
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

const TYPE_ORDER = ["day", "night", "event", "webinar"] as const;
const TYPE_ICON: Record<ProductType, string> = { day: "sun", night: "moon", event: "calendar-days", webinar: "video" };

function EntriesTable({ rows, labels, onDone }: { rows: WaitlistTableRow[]; labels: WaitlistTableLabels; onDone: (error: string | null) => void }) {
  return (
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
          {rows.map((r) => (
            <Row key={r.entryId} row={r} labels={labels} onDone={onDone} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * With `showSession` (the `/admin/waitlist` page, owner review section 10) the entries are grouped
 * by date, then by product type (day, night, event, webinar), then by session with its start time
 * and how many people wait; the session tab shows its own entries only.
 */
export function WaitlistTable({ rows, labels, showSession = true }: { rows: WaitlistTableRow[]; labels: WaitlistTableLabels; showSession?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{labels.empty}</p>;
  const done = (e: string | null) => {
    setError(e);
    if (!e) router.refresh();
  };
  const alert = error ? (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;
  if (!showSession) {
    return (
      <div className="space-y-6">
        {alert}
        <EntriesTable rows={rows} labels={labels} onDone={done} />
      </div>
    );
  }
  // Rows arrive ordered by session start, so dates and sessions keep that order.
  const dates = [...new Set(rows.map((r) => r.sessionDate))];
  return (
    <div className="space-y-8">
      {alert}
      {dates.map((date) => {
        const dayRows = rows.filter((r) => r.sessionDate === date);
        return (
          <section key={date} aria-labelledby={`waitlist-${date}`} className="space-y-4">
            <h2 id={`waitlist-${date}`} className="border-b pb-1 text-lg font-semibold first-letter:uppercase">
              {dayRows[0]!.dateLabel}
            </h2>
            {TYPE_ORDER.filter((type) => dayRows.some((r) => r.productType === type)).map((type) => {
              const typeRows = dayRows.filter((r) => r.productType === type);
              const sessions = [...new Map(typeRows.map((r) => [r.sessionId, r])).values()];
              return (
                <div key={type} className="space-y-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                    <NavIcon icon={TYPE_ICON[type]} />
                    {labels.productTypes[type]}
                  </h3>
                  {sessions.map((s) => {
                    const entries = typeRows.filter((r) => r.sessionId === s.sessionId);
                    const waiting = entries.filter((r) => r.state === "waiting").length;
                    return (
                      <div key={s.sessionId} className="rounded-md border" aria-label={s.sessionLabel} role="group">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-2">
                          <span className="font-semibold tabular-nums">{s.timeLabel}</span>
                          <Link href={`/admin/sessions/${s.sessionId}` as Route} className="font-medium hover:underline">
                            {s.sessionTitle}
                          </Link>
                          <Badge variant="secondary">{labels.waitingCount.replace("{count}", String(waiting))}</Badge>
                        </div>
                        <EntriesTable rows={entries} labels={labels} onDone={done} />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
