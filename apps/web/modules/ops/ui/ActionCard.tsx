"use client";
/**
 * One action dashboard list (ops spec 5, rules 22a-32), shown as one folding row of the "To do"
 * surface: title and count; open, the first rows (name, figure, link to the person) and a small
 * "+" to create a task per row when allowed. The server formats every
 * text; this component only calls `createTaskFromCard` and shows its outcome next to the row.
 * Keyboard reachable: every row action is a link or a button with a visible focus ring.
 */
import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { cn } from "@beam/ui";
import type { ActionCardKey } from "@beam/core/ops";
import { createTaskFromCard } from "../dashboard/actions";

export type ActionCardRowView = {
  personId: string | null;
  refId: string;
  name: string;
  text: string;
  /** e.g. "due soon" for a date within 5 days (colour is never the only signal). */
  flag?: string;
  href: Route | null;
};

export type ActionCardLabels = {
  title: string;
  count: string;
  empty: string;
  createTask: string;
  taskCreated: string;
  taskExists: string;
  openList: string;
  openPerson: string;
  /** Rule 29: the second figure shown apart from `count` (`ops.dashboard.card.<key>.secondary`), when the card has one. */
  secondary?: string;
  /** Rule 31: the label of the link to the screen that owns the card's list (`ops.dashboard.card.<key>.review`). */
  link?: string;
  /** Fallback message, and the per-code messages of `platform.errors.*`. */
  error: string;
  errors: Partial<Record<string, string>>;
};

type RowState = { kind: "busy" } | { kind: "done"; created: boolean } | { kind: "error"; message: string };

export function ActionCard({
  cardKey,
  count,
  rows,
  canCreateTask,
  listHref,
  linkHref,
  labels,
  open = false,
}: {
  cardKey: ActionCardKey;
  count: number;
  rows: ActionCardRowView[];
  canCreateTask: boolean;
  listHref: Route | { pathname: Route; query: Record<string, string> } | null;
  /** The screen of another module where the card's list is worked on (rule 31), shown with `labels.link`. */
  linkHref?: Route | null;
  labels: ActionCardLabels;
  /** Folded open (the single-card view); the dashboard shows each list as one folded row. */
  open?: boolean;
}) {
  const [state, setState] = useState<Record<string, RowState>>({});

  async function create(row: ActionCardRowView) {
    if (!row.personId) return;
    const key = `${row.personId}:${row.refId}`;
    setState((s) => ({ ...s, [key]: { kind: "busy" } }));
    const result = await createTaskFromCard({ card: cardKey, personId: row.personId, refId: row.refId });
    setState((s) => ({
      ...s,
      [key]: result.ok ? { kind: "done", created: result.data.created } : { kind: "error", message: labels.errors[result.error.code] ?? labels.error },
    }));
  }

  return (
    <details className="group border-b border-border last:border-b-0" data-testid={`action-card-${cardKey}`} data-count={count} open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-2.5 hover:bg-[#faf9f6] [&::-webkit-details-marker]:hidden">
        <span className="text-[0.8125rem] font-semibold">{labels.title}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold", count > 0 ? "bg-[var(--status-warn-soft)] text-[var(--status-warn)]" : "bg-muted text-muted-foreground")}>{labels.count}</span>
        {labels.secondary ? (
          <span className="truncate text-[0.75rem] text-muted-foreground" data-testid="action-card-secondary">
            {labels.secondary}
          </span>
        ) : null}
        <span aria-hidden="true" className="ml-auto text-muted-foreground transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="px-5 pb-3">
        {rows.length === 0 ? (
          <p className="text-[0.8125rem] text-muted-foreground">{labels.empty}</p>
        ) : (
          <ul className="grid">
            {rows.map((row) => {
              const key = `${row.personId}:${row.refId}`;
              const st = state[key];
              return (
                <li key={key} className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3 border-t border-border py-1.5 text-[0.8125rem]" data-ref-id={row.refId}>
                  {row.href ? (
                    <Link href={row.href} className="truncate font-medium hover:underline" aria-label={`${labels.openPerson}: ${row.name}`}>
                      {row.name}
                    </Link>
                  ) : (
                    <span className="truncate font-medium">{row.name}</span>
                  )}
                  <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <span className="truncate">{row.text}</span>
                    {row.flag ? <span className="shrink-0 rounded-full bg-[var(--status-bad-soft)] px-2 py-0.5 text-[0.6875rem] font-semibold text-[var(--status-bad)]">{row.flag}</span> : null}
                  </span>
                  {canCreateTask && row.personId ? (
                    st?.kind === "done" ? (
                      <span className="text-[0.75rem] text-[var(--status-ok)]" role="status" data-testid="task-result">
                        {st.created ? labels.taskCreated : labels.taskExists}
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        {st?.kind === "error" ? (
                          <span className="text-[0.75rem] text-destructive" role="status">
                            {st.message}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          title={labels.createTask}
                          aria-label={`${labels.createTask}: ${row.name}`}
                          disabled={st?.kind === "busy"}
                          onClick={() => void create(row)}
                          data-testid="create-task"
                          className="grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:border-[#c9973a] hover:text-foreground disabled:opacity-50"
                        >
                          +
                        </button>
                      </span>
                    )
                  ) : (
                    <span />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap gap-4 pt-1.5 text-[0.75rem] font-medium">
          {listHref && count > rows.length ? (
            <Link href={listHref} className="text-muted-foreground hover:text-foreground">
              {labels.openList} →
            </Link>
          ) : null}
          {linkHref && labels.link ? (
            <Link href={linkHref} className="text-muted-foreground hover:text-foreground" data-testid="action-card-link">
              {labels.link} →
            </Link>
          ) : null}
        </div>
      </div>
    </details>
  );
}
