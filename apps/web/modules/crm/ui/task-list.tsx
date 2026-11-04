"use client";
/**
 * The task table of `/admin/tasks` and of the company page (crm spec 5.1, rule 3.43): overdue
 * tasks first and in red, due today marked; complete, cancel, reopen, reassign (edit) and open
 * the related person or company. An invalid transition shows the catalogue's message.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Badge, Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { cancelTask, completeTask, reopenTask } from "../actions";
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
}: {
  tasks: TaskView[];
  currentUserId: string;
  canAssignOthers: boolean;
  owners: Option[];
  personId?: string;
  companyId?: string;
  labels: TaskListLabels;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<TaskFormValues | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const kinds = Object.entries(labels.kinds).map(([value, label]) => ({ value, label }));
  const priorities = Object.entries(labels.priorities).map(([value, label]) => ({ value, label }));
  const blank: TaskFormValues = { title: "", kind: "follow_up", dueLocal: "", priority: "normal", ownerUserId: currentUserId, notes: "" };

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

  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <Button type="button" onClick={() => setEditing(blank)} disabled={!!editing}>
          {labels.create}
        </Button>
      </div>
      {editing ? (
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
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {tasks.length === 0 ? (
        <EmptyState title={labels.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labels.columns.title}</TableHead>
              <TableHead>{labels.columns.kind}</TableHead>
              <TableHead>{labels.columns.priority}</TableHead>
              <TableHead>{labels.columns.due}</TableHead>
              <TableHead>{labels.columns.owner}</TableHead>
              <TableHead>{labels.columns.related}</TableHead>
              <TableHead>{labels.columns.source}</TableHead>
              <TableHead>{labels.columns.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((t) => {
              const href = relatedHref(t);
              const canTouch = canAssignOthers || t.ownerId === currentUserId;
              return (
                <TableRow key={t.id} data-overdue={t.isOverdue || undefined} className={t.isOverdue ? "text-destructive" : undefined}>
                  <TableCell className="font-medium">
                    <span className={t.status !== "open" ? "line-through opacity-70" : undefined}>{t.title}</span>
                    {t.status !== "open" ? (
                      <Badge variant="outline" className="ml-2">
                        {labels.statuses[t.status] ?? t.status}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>{labels.kinds[t.kind] ?? t.kind}</TableCell>
                  <TableCell>{labels.priorities[t.priority] ?? t.priority}</TableCell>
                  <TableCell>
                    {t.dueLabel ?? <span className="text-muted-foreground">{labels.noDue}</span>}
                    {t.isOverdue ? (
                      <Badge variant="destructive" className="ml-2">
                        {labels.overdue}
                      </Badge>
                    ) : t.isDueToday ? (
                      <Badge variant="warning" className="ml-2">
                        {labels.dueToday}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>{t.ownerLabel}</TableCell>
                  <TableCell>
                    {href && t.relatedLabel ? (
                      <Link href={href as never} className="underline-offset-4 hover:underline">
                        {t.relatedLabel}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{labels.sources[t.source] ?? t.source}</TableCell>
                  <TableCell>
                    {canTouch ? (
                      <div className="flex flex-wrap gap-1">
                        {t.status === "open" ? (
                          <>
                            <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => void move(t.id, completeTask)}>
                              {labels.complete}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => void move(t.id, cancelTask)}>
                              {labels.cancel}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setEditing({ id: t.id, title: t.title, kind: t.kind, dueLocal: t.dueLocal, priority: t.priority, ownerUserId: t.ownerId, notes: t.notes ?? "", personId: t.personId, companyId: t.companyId })
                              }
                            >
                              {labels.reassign}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => void move(t.id, reopenTask)}>
                            {labels.reopen}
                          </Button>
                        )}
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
