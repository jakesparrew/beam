"use client";
/**
 * One inbox thread (crm spec 5.1): the header with channel, sender, status, assignee and the
 * sensitive switch, then the messages oldest first. Internal notes are marked as such; a Meta
 * reply that was not delivered shows the reason (rule 3.50). The page formats every value on
 * the server; the controls call `assignThread`, `setThreadStatus` and `markThreadSensitive`.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert, AlertDescription, Badge, Button, Switch } from "@beam/ui";
import { assignThread, markThreadSensitive, setThreadStatus } from "../../inbox/actions";

export type MessageView = {
  id: string;
  direction: "in" | "out" | "note";
  directionLabel: string;
  body: string;
  occurredAt: string;
  meta: string[];
  problem: string | null;
};

export type ThreadHeaderView = {
  id: string;
  subject: string;
  sender: string;
  channelLabel: string;
  status: "open" | "pending" | "resolved";
  statusLabel: string;
  assigneeUserId: string | null;
  isSensitive: boolean;
  facts: { label: string; value: string }[];
  escalated: boolean;
};

export type ThreadViewLabels = {
  assignee: string;
  nobody: string;
  resolve: string;
  reopen: string;
  sensitive: string;
  sensitiveHint: string;
  escalated: string;
  error: string;
  conflict: string;
  saving: string;
};

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ThreadView({
  header,
  messages,
  assignees,
  labels,
  canWrite,
}: {
  header: ThreadHeaderView;
  messages: MessageView[];
  assignees: { value: string; label: string }[];
  labels: ThreadViewLabels;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(work: () => Promise<{ ok: true } | { ok: false; error: { code: string } }>) {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) setError(result.error.code === "conflict" ? labels.conflict : labels.error);
      else router.refresh();
    });
  }

  return (
    <section className="grid gap-4" aria-busy={pending}>
      <header className="grid gap-3 rounded-md border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h1 className="text-xl font-semibold">{header.subject}</h1>
            <p className="text-sm text-muted-foreground">
              {header.sender} · {header.channelLabel}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {header.escalated ? <Badge variant="destructive">{labels.escalated}</Badge> : null}
            <Badge variant={header.status === "open" ? "default" : header.status === "pending" ? "warning" : "secondary"}>{header.statusLabel}</Badge>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          {header.facts.map((f) => (
            <div key={f.label} className="grid">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span>{labels.assignee}</span>
              <select
                className={selectClass}
                value={header.assigneeUserId ?? ""}
                disabled={pending}
                onChange={(e) => run(() => assignThread({ threadId: header.id, assigneeUserId: e.target.value || null }))}
              >
                <option value="">{labels.nobody}</option>
                {assignees.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            {header.status === "resolved" ? (
              <Button variant="outline" disabled={pending} onClick={() => run(() => setThreadStatus({ threadId: header.id, status: "open" }))}>
                {labels.reopen}
              </Button>
            ) : (
              <Button variant="outline" disabled={pending} onClick={() => run(() => setThreadStatus({ threadId: header.id, status: "resolved" }))}>
                {labels.resolve}
              </Button>
            )}
            <label className="flex items-center gap-2 text-sm" title={labels.sensitiveHint}>
              <Switch checked={header.isSensitive} disabled={pending} onCheckedChange={(v: boolean) => run(() => markThreadSensitive({ threadId: header.id, isSensitive: v }))} aria-label={labels.sensitive} />
              <span>{labels.sensitive}</span>
            </label>
          </div>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </header>
      <ol className="grid gap-3">
        {messages.map((m) => (
          <li
            key={m.id}
            className={
              m.direction === "note"
                ? "rounded-md border border-dashed border-warning bg-warning/10 p-3"
                : m.direction === "out"
                  ? "ml-8 rounded-md border bg-secondary/40 p-3"
                  : "mr-8 rounded-md border p-3"
            }
          >
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-medium">{m.directionLabel}</span>
              <time>{m.occurredAt}</time>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
            {m.meta.length ? <p className="mt-1 text-xs text-muted-foreground">{m.meta.join(" · ")}</p> : null}
            {m.problem ? <p className="mt-1 text-xs font-medium text-destructive">{m.problem}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
