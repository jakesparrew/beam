"use client";
/**
 * The staff waitlist table (booking spec 5.1 `/admin/waitlist` and the session tab, R48, R49), in
 * the back-office kit (owner review, November 2026): one hairline table with the entries grouped
 * by date, then per session (time, title, product type, how many wait, in queue order), each
 * entry with its person, queue, sign-up time and state as a pill. "Offer seat"
 * (`offerSeatManually`) is the one visible action; the rarely used ones (`moveWaitlistEntry`
 * queue or position, `releaseWaitlistEntry`, `reviewWaitlistFlag` with the duplicate signals of
 * a flagged entry) sit in a "More" panel. A `confirmed` entry shows no action (protected seat,
 * R41). Entries without an email are marked "phone this person" when offered. Texts come from
 * the page.
 */
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input, NavIcon, Popover, PopoverContent, PopoverTrigger, cn } from "@beam/ui";
import { moveWaitlistEntry, offerSeatManually, releaseWaitlistEntry, reviewWaitlistFlag } from "../actions/waitlist";
import { Initials, StatusPill, td, th, type Tone } from "./kit";

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
  personId: string;
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
  status: string;
  joinedAt: string;
  offerExpires: string;
  signals: string;
  offerSeat: string;
  more: string;
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
const STATE_TONE: Record<State, Tone> = { waiting: "info", offered: "warn", confirmed: "ok", released: "muted", expired: "muted", withdrawn: "muted" };
const TYPE_ORDER = ["day", "night", "event", "webinar"] as const;
const TYPE_ICON: Record<ProductType, string> = { day: "sun", night: "moon", event: "calendar-days", webinar: "video" };
const control = "h-8 rounded-md border border-input bg-card px-2 text-[0.8125rem]";
const COLS = 5;

function Row({ row, labels, onDone }: { row: WaitlistTableRow; labels: WaitlistTableLabels; onDone: (error: string | null) => void }) {
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const [joinedAt, setJoinedAt] = useState("");
  const open = row.state === "waiting" || (row.state === "offered" && !row.bookingId);
  const closed = row.state === "released" || row.state === "expired" || row.state === "withdrawn";

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
    <tr className={cn("border-b border-border last:border-b-0 hover:bg-[#faf9f6]", closed && "text-muted-foreground")} data-testid={`waitlist-row-${row.entryId}`}>
      <td className={td}>
        <span className="flex items-center gap-2.5">
          <Initials id={row.personId} name={row.personName} className={cn(closed && "opacity-60")} />
          <span className="grid leading-tight">
            <span className={cn("font-semibold", !closed && "text-foreground")}>{row.personName}</span>
            {row.state === "offered" && !row.hasEmail ? <span className="text-[0.75rem] text-[var(--status-warn)]">{labels.noEmailPhone}</span> : null}
            {row.isFlagged ? (
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[0.75rem]">
                <StatusPill tone="bad">{labels.signals}</StatusPill>
                <span className="break-all text-muted-foreground">{row.flagReason}</span>
              </span>
            ) : null}
          </span>
        </span>
      </td>
      <td className={td}>{labels.queues[row.queue]}</td>
      <td className={cn(td, "whitespace-nowrap tabular-nums")}>{fmt(row.joinedAt)}</td>
      <td className={td}>
        <span className="grid justify-items-start gap-0.5">
          <StatusPill tone={STATE_TONE[row.state]}>{labels.states[row.state]}</StatusPill>
          {row.offerExpiresAt && row.state === "offered" ? (
            <span className="text-[0.75rem] whitespace-nowrap text-muted-foreground">
              {labels.offerExpires} {fmt(row.offerExpiresAt)}
            </span>
          ) : null}
        </span>
      </td>
      <td className={cn(td, "text-right")}>
        {open ? (
          <span className="inline-flex items-center justify-end gap-1.5">
            {row.state === "waiting" ? (
              <Button size="sm" className="h-8" disabled={pending} onClick={() => void run(() => offerSeatManually({ entryId: row.entryId }))}>
                {labels.offerSeat}
              </Button>
            ) : null}
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost" className="h-8 px-2" disabled={pending} aria-label={`${labels.more}: ${row.personName}`}>
                  <span aria-hidden="true">•••</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="admin-theme grid w-80 gap-3 rounded-xl p-3 text-left text-[0.8125rem]">
                <div className="grid gap-1">
                  <label htmlFor={`queue-${row.entryId}`} className="text-[0.75rem] font-medium text-muted-foreground">
                    {labels.moveQueue}
                  </label>
                  <select
                    id={`queue-${row.entryId}`}
                    className={control}
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
                </div>
                <div className="grid gap-1">
                  <label htmlFor={`joined-${row.entryId}`} className="text-[0.75rem] font-medium text-muted-foreground">
                    {labels.reorder}
                  </label>
                  <span className="flex gap-1.5">
                    <Input id={`joined-${row.entryId}`} type="datetime-local" className="h-8 flex-1" value={joinedAt} onChange={(e) => setJoinedAt(e.target.value)} />
                    <Button size="sm" variant="outline" className="h-8" disabled={pending || !joinedAt} onClick={() => void run(() => moveWaitlistEntry({ entryId: row.entryId, joinedAt: new Date(joinedAt).toISOString() }))}>
                      {labels.confirm}
                    </Button>
                  </span>
                </div>
                <div className="grid gap-1.5 border-t border-border pt-3">
                  <label htmlFor={`reason-${row.entryId}`} className="text-[0.75rem] font-medium text-muted-foreground">
                    {labels.reason}
                  </label>
                  <Input id={`reason-${row.entryId}`} className="h-8" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <span className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" className="h-8" disabled={pending || !reason.trim()} onClick={() => void run(() => releaseWaitlistEntry({ entryId: row.entryId, reason }))}>
                      {labels.release}
                    </Button>
                    {row.isFlagged && row.state === "waiting" ? (
                      <>
                        <Button size="sm" variant="secondary" className="h-8" disabled={pending || !reason.trim()} onClick={() => void run(() => reviewWaitlistFlag({ entryId: row.entryId, decision: "clear", note: reason }))}>
                          {labels.clearFlag}
                        </Button>
                        <Button size="sm" variant="destructive" className="h-8" disabled={pending || !reason.trim()} onClick={() => void run(() => reviewWaitlistFlag({ entryId: row.entryId, decision: "withdraw", note: reason }))}>
                          {labels.withdraw}
                        </Button>
                      </>
                    ) : null}
                  </span>
                </div>
              </PopoverContent>
            </Popover>
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function Head({ labels }: { labels: WaitlistTableLabels }) {
  return (
    <thead className="bg-[#faf9f6]">
      <tr className="border-b border-border">
        <th scope="col" className={th}>{labels.person}</th>
        <th scope="col" className={cn(th, "w-40")}>{labels.queue}</th>
        <th scope="col" className={cn(th, "w-44")}>{labels.joinedAt}</th>
        <th scope="col" className={cn(th, "w-52")}>{labels.status}</th>
        <th scope="col" className={cn(th, "w-44")}>
          <span className="sr-only">{labels.offerSeat}</span>
        </th>
      </tr>
    </thead>
  );
}

/**
 * With `showSession` (the `/admin/waitlist` page, owner review section 10) the entries are grouped
 * by date, then per session ordered by product type (day, night, event, webinar) with its start
 * time and how many people wait; the session tab shows its own entries only.
 */
export function WaitlistTable({ rows, labels, showSession = true }: { rows: WaitlistTableRow[]; labels: WaitlistTableLabels; showSession?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  if (rows.length === 0) return <p className="rounded-xl border border-border bg-card px-5 py-6 text-center text-[0.8125rem] text-muted-foreground">{labels.empty}</p>;
  const done = (e: string | null) => {
    setError(e);
    if (!e) router.refresh();
  };
  // Rows arrive ordered by session start, so dates and sessions keep that order.
  const dates = showSession ? [...new Set(rows.map((r) => r.sessionDate))] : [];
  return (
    <div className="grid gap-3">
      {error ? (
        <p role="alert" className="rounded-lg bg-[var(--status-bad-soft)] px-3 py-2 text-[0.8125rem] text-[var(--status-bad)]">
          {error}
        </p>
      ) : null}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-[0.8125rem]">
            <Head labels={labels} />
            {showSession ? (
              dates.map((date) => {
                const dayRows = rows.filter((r) => r.sessionDate === date);
                const sessions = TYPE_ORDER.flatMap((type) => [...new Map(dayRows.filter((r) => r.productType === type).map((r) => [r.sessionId, r])).values()]);
                return sessions.map((s, i) => {
                  const entries = dayRows.filter((r) => r.sessionId === s.sessionId);
                  const waiting = entries.filter((r) => r.state === "waiting").length;
                  return (
                    <tbody key={s.sessionId} aria-label={s.sessionLabel}>
                      {i === 0 ? (
                        <tr className="border-b border-border bg-[#f5f3ee]">
                          <th scope="rowgroup" colSpan={COLS} id={`waitlist-${date}`} className="px-5 py-2 text-left text-[0.8125rem] font-semibold first-letter:uppercase">
                            {s.dateLabel}
                          </th>
                        </tr>
                      ) : null}
                      <tr className="border-b border-border bg-[#fcfbf9]">
                        <th scope="rowgroup" colSpan={COLS} className="px-5 py-1.5 text-left font-normal">
                          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            <span className="font-semibold tabular-nums">{s.timeLabel}</span>
                            <Link href={`/admin/sessions/${s.sessionId}` as Route} className="font-medium hover:underline">
                              {s.sessionTitle}
                            </Link>
                            <StatusPill tone="muted" className="gap-1">
                              <NavIcon icon={TYPE_ICON[s.productType]} className="size-3" />
                              {labels.productTypes[s.productType]}
                            </StatusPill>
                            <span className="text-[0.75rem] text-muted-foreground tabular-nums">{labels.waitingCount.replace("{count}", String(waiting))}</span>
                          </span>
                        </th>
                      </tr>
                      {entries.map((r) => (
                        <Row key={r.entryId} row={r} labels={labels} onDone={done} />
                      ))}
                    </tbody>
                  );
                });
              })
            ) : (
              <tbody>
                {rows.map((r) => (
                  <Row key={r.entryId} row={r} labels={labels} onDone={done} />
                ))}
              </tbody>
            )}
          </table>
        </div>
      </section>
    </div>
  );
}
