"use client";
/**
 * The table of `/admin/persons` (crm spec 5.1, owner review November 2026): one row per client
 * with the initials avatar, name and email, phone, status pill (member, customer, lead; a pin
 * when set by hand), usable day and night credits, last visit, next booking and tags; the whole
 * row opens the 360. With `persons.write`, rows can be selected for a bulk tag or untag (at
 * most 5000); the bar appears once something is selected. Search, filters and paging live in
 * the page (URL state). Every string is a prop.
 */
import Link from "next/link";
import { useState } from "react";
import { cn } from "@beam/ui";
import type { PersonStatus } from "@beam/core/crm";
import { aboveRow, Initials, rowClass, rowLink, StatusPill, Surface, td, th, theadClass, type Tone } from "./kit";
import { TagPicker, type TagOption, type TagPickerLabels } from "./tag-picker";

export type PersonRowView = {
  id: string;
  customerNumber: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: PersonStatus;
  isOverridden: boolean;
  isCorporate: boolean;
  tags: string[];
  dayCredits: number;
  nightCredits: number;
  /** ISO instants. */
  lastVisitAt: string | null;
  nextBookingAt: string | null;
};

export type PersonsTableLabels = {
  caption: string;
  /** The "Zakelijk" pill under the name of a corporate client. */
  corporate: string;
  columns: Record<"select" | "client" | "phone" | "status" | "credits" | "lastVisit" | "nextBooking" | "tags", string>;
  statuses: Record<PersonStatus, string>;
  overridePin: string;
  /** "{count} dag", "{count} nacht". */
  creditsDay: string;
  creditsNight: string;
  /** `crm.persons.list.selected` rendered for 1 and for 7 (the client swaps in the real count). */
  selectedOne: string;
  selectedOther: string;
  selectAll: string;
  picker: TagPickerLabels;
};

const STATUS_TONE: Record<PersonStatus, Tone> = { member: "ok", customer: "muted", lead: "info" };

export function PersonsTable({ rows, tags, canWrite, locale, labels }: { rows: PersonRowView[]; tags: TagOption[]; canWrite: boolean; locale: string; labels: PersonsTableLabels }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Brussels" });
  const dayTime = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" });
  const tagOf = new Map(tags.map((t) => [t.key, t]));
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const fill = (s: string, n: number) => s.replace("{count}", String(n));

  return (
    <div className="grid gap-2">
      {canWrite && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-2">
          <span className="text-[0.8125rem] font-semibold" role="status">
            {selected.size === 1 ? labels.selectedOne : labels.selectedOther.replace(/\b7\b/, String(selected.size))}
          </span>
          <TagPicker tags={tags} selected={[...selected]} labels={labels.picker} onDone={() => setSelected(new Set())} />
        </div>
      ) : null}
      <Surface flush data-testid="persons-list">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[60rem] text-[0.8125rem]">
            <caption className="sr-only">{labels.caption}</caption>
            <thead className={theadClass}>
              <tr className="border-b border-border">
                {canWrite ? (
                  <th scope="col" className={cn(th, "w-10")}>
                    <input
                      type="checkbox"
                      aria-label={labels.selectAll}
                      checked={allOnPage}
                      onChange={(e) => setSelected((s) => new Set(e.target.checked ? [...s, ...rows.map((r) => r.id)] : [...s].filter((id) => !rows.some((r) => r.id === id))))}
                      className="size-4 accent-[var(--primary)]"
                    />
                  </th>
                ) : null}
                <th scope="col" className={th}>{labels.columns.client}</th>
                <th scope="col" className={cn(th, "w-36")}>{labels.columns.phone}</th>
                <th scope="col" className={cn(th, "w-24")}>{labels.columns.status}</th>
                <th scope="col" className={cn(th, "w-32 text-right")}>{labels.columns.credits}</th>
                <th scope="col" className={cn(th, "w-28")}>{labels.columns.lastVisit}</th>
                <th scope="col" className={cn(th, "w-36")}>{labels.columns.nextBooking}</th>
                <th scope="col" className={cn(th, "w-44")}>{labels.columns.tags}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={rowClass} data-testid="persons-row" data-person-id={r.id}>
                  {canWrite ? (
                    <td className={td}>
                      <input type="checkbox" aria-label={`${labels.columns.select} ${r.name}`} checked={selected.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} className={cn(aboveRow, "size-4 accent-[var(--primary)]")} />
                    </td>
                  ) : null}
                  <td className={td}>
                    <span className="flex items-center gap-2.5">
                      <Initials name={r.name} />
                      <span className="grid min-w-0 leading-tight">
                        <span className="flex items-center gap-1.5">
                          <Link href={`/admin/persons/${r.id}` as never} className={cn(rowLink, "truncate font-medium hover:underline")}>
                            {r.name}
                          </Link>
                          {r.isCorporate ? <StatusPill tone="gold">{labels.corporate}</StatusPill> : null}
                        </span>
                        <span className="truncate text-[0.75rem] text-muted-foreground">{[r.email, r.customerNumber].filter(Boolean).join(" · ")}</span>
                      </span>
                    </span>
                  </td>
                  <td className={cn(td, "whitespace-nowrap tabular-nums")}>{r.phone ?? <span className="text-muted-foreground">–</span>}</td>
                  <td className={td}>
                    <StatusPill tone={STATUS_TONE[r.status]} data-testid="person-status" title={r.isOverridden ? labels.overridePin : undefined} className={r.isOverridden ? "ring-1 ring-current ring-inset" : undefined}>
                      {labels.statuses[r.status]}
                      {r.isOverridden ? <span className="sr-only"> ({labels.overridePin})</span> : null}
                    </StatusPill>
                  </td>
                  <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>
                    {r.dayCredits || r.nightCredits ? (
                      <span className="grid leading-tight">
                        {r.dayCredits ? <span className="font-semibold">{fill(labels.creditsDay, r.dayCredits)}</span> : null}
                        {r.nightCredits ? <span className={r.dayCredits ? "text-[0.75rem] text-muted-foreground" : "font-semibold"}>{fill(labels.creditsNight, r.nightCredits)}</span> : null}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">–</span>
                    )}
                  </td>
                  <td className={cn(td, "whitespace-nowrap")}>{r.lastVisitAt ? day.format(new Date(r.lastVisitAt)) : <span className="text-muted-foreground">–</span>}</td>
                  <td className={cn(td, "whitespace-nowrap")}>{r.nextBookingAt ? <span className="first-letter:uppercase">{dayTime.format(new Date(r.nextBookingAt))}</span> : <span className="text-muted-foreground">–</span>}</td>
                  <td className={td}>
                    <span className="flex flex-wrap gap-1">
                      {r.tags.slice(0, 3).map((k) => (
                        <span key={k} className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-[0.6875rem] font-medium">
                          <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: tagOf.get(k)?.color ?? "currentColor" }} />
                          {tagOf.get(k)?.label ?? k}
                        </span>
                      ))}
                      {r.tags.length > 3 ? <span className="text-[0.6875rem] text-muted-foreground">+{r.tags.length - 3}</span> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Surface>
    </div>
  );
}
