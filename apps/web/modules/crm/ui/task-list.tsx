"use client";
/**
 * The task table of `/admin/tasks`, the 360 and the company page (crm spec 5.1, rule 3.43; owner
 * review November 2026): a "Done" button first in each open row, the title with its kind, the
 * due date with an overdue (red) or today (amber) pill, the owner with initials and the related
 * person or company; edit (reassign) and cancel are quiet row actions, a closed task can be
 * reopened. An invalid transition shows the catalogue's message.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, cn, EmptyState } from "@beam/ui";
import { cancelTask, completeTask, reopenTask } from "../actions";
import { Initials, quietButton, StatusPill, Surface, td, th, theadClass } from "./kit";
import { TaskForm, type TaskFormLabels, type TaskFormValues } from "./task-form";

export type TaskView = {
  id: string;
  title: string;
  kind: string;
  priority: string;
  status: "open" | "done" | "cancelled";
  source: string;
  /** Formatted in Brussels time by the server. */
  dueLabel: string | null;
  /** `YYYY-MM-DDTHH:mm` in Brussels time for the edit form. */
  dueLocal: string;
  isOverdue: boolean;
  isDueToday: boolean;
  ownerId: string;
  ownerLabel: string;
  personId: string | null;
  companyId: string | null;
  relatedLabel: string | null;
  notes: string | null;
};

export type TaskListLabels = {
  create: string;
  empty: string;
  columns: { title: string; kind: string; priority: string; due: string; owner: string; related: string; source: string; actions: string };
  overdue: string;
  dueToday: string;
  noDue: string;
  complete: string;
  cancel: string;
  reopen: string;
  reassign: string;
  /** The short row action that opens the edit form (reassign, due date, notes). */
  edit: string;
  openRelated: string;
  invalidTransition: string;
  error: string;
  kinds: Record<string, string>;
  priorities: Record<string, string>;
  statuses: Record<string, string>;
  sources: Record<string, string>;
  form: TaskFormLabels;
};

type Option = { value: string; label: string };

export function TaskList({
  tasks,
  currentUserId,
  canAssignOthers,
  owners,
  personId,
  companyId,
  labels,
  compact = false,
  showCreate = true,
  dense,
  openCreate = false,
}: {
  tasks: TaskView[];
  currentUserId: string;
  canAssignOthers: boolean;
  owners: Option[];
  personId?: string;
  companyId?: string;
  labels: TaskListLabels;
  /** Inside a 360 or company page: no "about" column and no source. */
  compact?: boolean;
  showCreate?: boolean;
  /** The 360's side column: a titled list (heading `id`) with a small "+" instead of the table. */
  dense?: { title: string; headingId: string };
  /** Opens the create form at once (the 360's "⋯ → Nieuwe taak"). */
  openCreate?: boolean;
}) {
  const router = useRouter();
  const blank: TaskFormValues = { title: "", kind: "follow_up", dueLocal: "", priority: "normal", ownerUserId: currentUserId, notes: "" };
  const [editing, setEditing] = useState<TaskFormValues | null>(openCreate && showCreate ? blank : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const kinds = Object.entries(labels.kinds).map(([value, label]) => ({ value, label }));
  const priorities = Object.entries(labels.priorities).map(([value, label]) => ({ value, label }));

  async function move(id: string, fn: typeof completeTask) {
    setBusy(id);
    setError(null);
    try {
      const result = await fn({ id });
      if (result.ok) router.refresh();
      else setError(result.error.code === "conflict" ? labels.invalidTransition : labels.error);
    } finally {
      setBusy(null);
    }
  }

  const relatedHref = (t: TaskView) => (t.personId ? `/admin/persons/${t.personId}` : t.companyId ? `/admin/companies/${t.companyId}` : null);
  const form = editing ? (
    <TaskForm
      initial={editing}
      {...(personId ? { personId } : {})}
      {...(companyId ? { companyId } : {})}
      canAssignOthers={canAssignOthers}
      owners={owners}
      kinds={kinds}
      priorities={priorities}
      labels={labels.form}
      onDone={() => setEditing(null)}
    />
  ) : null;
  const alert = error ? (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;
  const rowAction = "rounded px-1 text-[0.75rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";

  if (dense)
    return (
      <div className="grid" data-testid="task-list-dense">
        <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-2.5">
          <h2 id={dense.headingId} className="text-[0.875rem] font-semibold">
            {dense.title}
            {tasks.length ? <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{tasks.length}</span> : null}
          </h2>
          {showCreate ? (
            <button
              type="button"
              onClick={() => setEditing(blank)}
              disabled={!!editing}
              aria-label={labels.create}
              title={labels.create}
              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-3.5">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          ) : null}
        </header>
        {form ? <div className="border-b border-border p-3">{form}</div> : null}
        {alert ? <div className="p-3">{alert}</div> : null}
        {tasks.length === 0 ? (
          <p className="px-5 py-3 text-[0.8125rem] text-muted-foreground">{labels.empty}</p>
        ) : (
          <ul className="divide-y divide-border text-[0.8125rem]" data-testid="task-list">
            {tasks.map((t) => {
              const canTouch = canAssignOthers || t.ownerId === currentUserId;
              const open = t.status === "open";
              return (
                <li key={t.id} data-task-id={t.id} data-overdue={t.isOverdue || undefined} className="group flex items-start gap-2.5 px-5 py-2">
                  {canTouch && open ? (
                    <button
                      type="button"
                      disabled={busy === t.id}
                      onClick={() => void move(t.id, completeTask)}
                      aria-label={`${labels.complete}: ${t.title}`}
                      title={labels.complete}
                      data-action="complete"
                      className="mt-0.5 size-3.5 shrink-0 rounded-full border-[1.5px] border-muted-foreground/60 hover:border-[var(--status-ok)] hover:bg-[var(--status-ok-soft)]"
                    />
                  ) : (
                    <span aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 rounded-full border-[1.5px] border-border" />
                  )}
                  <span className="grid min-w-0 flex-1 leading-tight">
                    <span className="font-medium">{t.title}</span>
                    <span className="flex flex-wrap items-center gap-x-1.5 text-[0.75rem] text-muted-foreground">
                      {t.dueLabel ? <span className={cn("tabular-nums", t.isOverdue && "font-semibold text-[var(--status-bad)]")}>{t.dueLabel}</span> : <span>{labels.noDue}</span>}
                      {t.isOverdue ? <StatusPill tone="bad">{labels.overdue}</StatusPill> : t.isDueToday ? <StatusPill tone="warn">{labels.dueToday}</StatusPill> : null}
                      <span>· {t.ownerLabel}</span>
                    </span>
                  </span>
                  {canTouch && open ? (
                    <span className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        title={labels.reassign}
                        className={rowAction}
                        onClick={() => setEditing({ id: t.id, title: t.title, kind: t.kind, dueLocal: t.dueLocal, priority: t.priority, ownerUserId: t.ownerId, notes: t.notes ?? "", personId: t.personId, companyId: t.companyId })}
                      >
                        {labels.edit}
                      </button>
                      <button type="button" disabled={busy === t.id} onClick={() => void move(t.id, cancelTask)} className={rowAction}>
                        {labels.cancel}
                      </button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );

  return (
    <div className="grid gap-2">
      {showCreate ? (
        <div className={cn("flex", compact ? "justify-start" : "justify-end")}>
          <button type="button" onClick={() => setEditing(blank)} disabled={!!editing} className={quietButton}>
            + {labels.create}
          </button>
        </div>
      ) : null}
      {form}
      {alert}
      {tasks.length === 0 ? (
        compact ? (
          <p className="rounded-xl border border-border bg-card px-5 py-4 text-[0.8125rem] text-muted-foreground">{labels.empty}</p>
        ) : (
          <EmptyState title={labels.empty} />
        )
      ) : (
        <Surface flush data-testid="task-list">
          <div className="overflow-x-auto">
            <table className={cn("w-full text-[0.8125rem]", !compact && "min-w-[52rem]")}>
              <thead className={theadClass}>
                <tr className="border-b border-border">
                  <th scope="col" className={cn(th, "w-24")}>
                    <span className="sr-only">{labels.complete}</span>
                  </th>
                  <th scope="col" className={th}>{labels.columns.title}</th>
                  <th scope="col" className={cn(th, "w-44")}>{labels.columns.due}</th>
                  <th scope="col" className={cn(th, "w-44")}>{labels.columns.owner}</th>
                  {compact ? null : <th scope="col" className={cn(th, "w-48")}>{labels.columns.related}</th>}
                  <th scope="col" className={cn(th, "w-28 text-right")}>
                    <span className="sr-only">{labels.columns.actions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const href = relatedHref(t);
                  const canTouch = canAssignOthers || t.ownerId === currentUserId;
                  const open = t.status === "open";
                  return (
                    <tr key={t.id} data-overdue={t.isOverdue || undefined} data-task-id={t.id} className="border-b border-border last:border-b-0 hover:bg-[#faf9f6]">
                      <td className={td}>
                        {canTouch && open ? (
                          <button type="button" disabled={busy === t.id} onClick={() => void move(t.id, completeTask)} className={cn(quietButton, "gap-1.5")} data-action="complete">
                            <span aria-hidden="true" className="size-3 rounded-full border-[1.5px] border-current" />
                            {labels.complete}
                          </button>
                        ) : !open ? (
                          <StatusPill tone="muted">{labels.statuses[t.status] ?? t.status}</StatusPill>
                        ) : null}
                      </td>
                      <td className={td}>
                        <span className="grid leading-tight">
                          <span className={cn("font-medium", !open && "text-muted-foreground line-through")}>{t.title}</span>
                          <span className="text-[0.75rem] text-muted-foreground">
                            {[labels.kinds[t.kind] ?? t.kind, t.priority === "high" ? labels.priorities.high : null, compact ? null : (labels.sources[t.source] ?? t.source)].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                      </td>
                      <td className={cn(td, "whitespace-nowrap")}>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {t.dueLabel ? <span className={cn("tabular-nums", t.isOverdue && open && "font-semibold text-[var(--status-bad)]")}>{t.dueLabel}</span> : <span className="text-muted-foreground">{labels.noDue}</span>}
                          {open && t.isOverdue ? <StatusPill tone="bad">{labels.overdue}</StatusPill> : open && t.isDueToday ? <StatusPill tone="warn">{labels.dueToday}</StatusPill> : null}
                        </span>
                      </td>
                      <td className={td}>
                        <span className="flex items-center gap-2">
                          <Initials name={t.ownerLabel} />
                          <span className="truncate">{t.ownerLabel}</span>
                        </span>
                      </td>
                      {compact ? null : (
                        <td className={td}>
                          {href && t.relatedLabel ? (
                            <Link href={href as never} className="font-medium hover:underline">
                              {t.relatedLabel}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">–</span>
                          )}
                        </td>
                      )}
                      <td className={cn(td, "text-right whitespace-nowrap")}>
                        {canTouch ? (
                          open ? (
                            <span className="inline-flex gap-1">
                              <button
                                type="button"
                                title={labels.reassign}
                                className="rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                                onClick={() =>
                                  setEditing({ id: t.id, title: t.title, kind: t.kind, dueLocal: t.dueLocal, priority: t.priority, ownerUserId: t.ownerId, notes: t.notes ?? "", personId: t.personId, companyId: t.companyId })
                                }
                              >
                                {labels.edit}
                              </button>
                              <button type="button" disabled={busy === t.id} onClick={() => void move(t.id, cancelTask)} className="rounded-md px-1.5 py-1 text-[0.75rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
                                {labels.cancel}
                              </button>
                            </span>
                          ) : (
                            <button type="button" disabled={busy === t.id} onClick={() => void move(t.id, reopenTask)} className={quietButton}>
                              {labels.reopen}
                            </button>
                          )
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
