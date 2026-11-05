"use client";
/**
 * One action dashboard card (ops spec 5, rules 22a-32): title, count, the first rows (name,
 * figure, link to the person) and "Create task" per row when allowed. The server formats every
 * text; this component only calls `createTaskFromCard` and shows its outcome next to the row.
 * Keyboard reachable: every row action is a link or a button with a visible focus ring.
 */
import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, CardAction, CardContent, CardHeader, CardTitle } from "@beam/ui";
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
}: {
  cardKey: ActionCardKey;
  count: number;
  rows: ActionCardRowView[];
  canCreateTask: boolean;
  listHref: Route | { pathname: Route; query: Record<string, string> } | null;
  /** The screen of another module where the card's list is worked on (rule 31), shown with `labels.link`. */
  linkHref?: Route | null;
  labels: ActionCardLabels;
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
    <Card data-testid={`action-card-${cardKey}`} data-count={count}>
      <CardHeader>
        <CardTitle className="text-base">{labels.title}</CardTitle>
        <CardAction>
          <Badge variant={count > 0 ? "warning" : "secondary"}>{labels.count}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-2">
        {labels.secondary ? (
          <p className="text-sm text-muted-foreground" data-testid="action-card-secondary">
            {labels.secondary}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        ) : (
          <ul className="grid gap-2">
            {rows.map((row) => {
              const key = `${row.personId}:${row.refId}`;
              const s = state[key];
              return (
                <li key={key} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-b-0 last:pb-0" data-ref-id={row.refId}>
                  <div className="grid min-w-0 gap-0.5">
                    {row.href ? (
                      <Link href={row.href} className="truncate font-medium underline-offset-4 hover:underline focus-visible:underline" aria-label={`${labels.openPerson}: ${row.name}`}>
                        {row.name}
                      </Link>
                    ) : (
                      <span className="truncate font-medium">{row.name}</span>
                    )}
                    <span className="text-sm text-muted-foreground">
                      {row.text}
                      {row.flag ? (
                        <Badge variant="destructive" className="ml-2">
                          {row.flag}
                        </Badge>
                      ) : null}
                    </span>
                  </div>
                  {canCreateTask && row.personId ? (
                    s?.kind === "done" ? (
                      <span className="text-sm" role="status" data-testid="task-result">
                        {s.created ? labels.taskCreated : labels.taskExists}
                      </span>
                    ) : (
                      <div className="flex items-center gap-2">
                        {s?.kind === "error" ? (
                          <span className="text-sm text-destructive" role="status">
                            {s.message}
                          </span>
                        ) : null}
                        <Button size="sm" variant="outline" disabled={s?.kind === "busy"} onClick={() => void create(row)} data-testid="create-task">
                          {labels.createTask}
                        </Button>
                      </div>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {listHref && count > rows.length ? (
          <Link href={listHref} className="text-sm font-medium underline-offset-4 hover:underline focus-visible:underline">
            {labels.openList}
          </Link>
        ) : null}
        {linkHref && labels.link ? (
          <Link href={linkHref} className="text-sm font-medium underline-offset-4 hover:underline focus-visible:underline" data-testid="action-card-link">
            {labels.link}
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
