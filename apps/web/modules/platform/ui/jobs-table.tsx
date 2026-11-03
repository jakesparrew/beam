"use client";
/**
 * `/admin/system/jobs`: the jobs table with Retry and Discard (reason) for dead jobs.
 * Default filter `dead`; empty state "No dead jobs. Everything ran." (platform spec 5).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FormField,
  Textarea,
  type DataTableColumn,
  type DataTableFilter,
} from "@beam/ui";
import { discardJob, retryJob } from "../actions";
import { formValue } from "./login-form";

export type JobRowView = {
  id: string;
  kind: string;
  status: string;
  lane: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  key: string;
};

export type JobsTableLabels = {
  columns: Record<"kind" | "status" | "lane" | "attempts" | "runAt" | "lastError" | "key" | "actions", string>;
  statuses: Record<string, string>;
  lanes: Record<string, string>;
  filterStatus: string;
  filterKind: string;
  filterLane: string;
  any: string;
  retry: string;
  retried: string;
  discard: string;
  discardTitle: string;
  discardReason: string;
  discardConfirm: string;
  discarded: string;
  cancel: string;
  emptyDead: string;
  emptyFiltered: string;
  notDead: string;
  generic: string;
  pagination: string;
  previous: string;
  next: string;
  applyFilters: string;
  filters: string;
  none: string;
};

export function JobActions({ job, labels, canManage, onDone }: { job: Pick<JobRowView, "id" | "status" | "kind">; labels: JobsTableLabels; canManage: boolean; onDone?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!canManage || job.status !== "dead") return message ? <span role="status">{message}</span> : null;

  const finish = (text: string) => {
    setMessage(text);
    onDone?.();
    router.refresh();
  };
  async function retry() {
    setPending(true);
    const result = await retryJob({ jobId: job.id });
    setPending(false);
    if (result.ok) finish(labels.retried);
    else setMessage(result.error.code === "conflict" ? labels.notDead : labels.generic);
  }
  async function discard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const result = await discardJob({ jobId: job.id, reason: formValue(new FormData(event.currentTarget), "reason") });
    setPending(false);
    if (result.ok) {
      setOpen(false);
      finish(labels.discarded);
    } else setMessage(result.error.code === "conflict" ? labels.notDead : labels.generic);
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" onClick={() => void retry()} disabled={pending}>
        {labels.retry}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} disabled={pending}>
        {labels.discard}
      </Button>
      {message ? <span role="status">{message}</span> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{labels.discardTitle}</DialogTitle>
            <DialogDescription>{job.kind}</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void discard(e)} className="grid gap-4">
            <FormField label={labels.discardReason}>
              <Textarea name="reason" required minLength={3} maxLength={500} />
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {labels.cancel}
              </Button>
              <Button type="submit" variant="destructive" disabled={pending}>
                {labels.discardConfirm}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function JobsTable({
  rows,
  labels,
  kinds,
  nextCursor,
  searchParams,
  canManage,
  locale,
}: {
  rows: JobRowView[];
  labels: JobsTableLabels;
  kinds: string[];
  nextCursor: string | null;
  searchParams: Record<string, string | undefined>;
  canManage: boolean;
  locale: string;
}) {
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Brussels" });
  const columns: DataTableColumn<JobRowView>[] = [
    { key: "kind", header: labels.columns.kind, cell: (r) => <Link href={`/admin/system/jobs/${r.id}` as never}>{r.kind}</Link> },
    { key: "status", header: labels.columns.status, cell: (r) => <Badge variant={r.status === "dead" ? "destructive" : "secondary"}>{labels.statuses[r.status] ?? r.status}</Badge> },
    { key: "lane", header: labels.columns.lane, cell: (r) => labels.lanes[r.lane] ?? r.lane },
    { key: "attempts", header: labels.columns.attempts, align: "right", cell: (r) => `${r.attempts} / ${r.maxAttempts}` },
    { key: "run_at", header: labels.columns.runAt, cell: (r) => time.format(new Date(r.runAt)) },
    { key: "last_error", header: labels.columns.lastError, className: "max-w-xs truncate", cell: (r) => r.lastError?.split("\n")[0] ?? labels.none },
    { key: "key", header: labels.columns.key, className: "max-w-xs truncate font-mono text-xs", cell: (r) => r.key },
    { key: "actions", header: labels.columns.actions, cell: (r) => <JobActions job={r} labels={labels} canManage={canManage} /> },
  ];
  const filters: DataTableFilter[] = [
    {
      kind: "select",
      key: "status",
      label: labels.filterStatus,
      allLabel: labels.statuses.dead ?? "dead",
      options: [...["pending", "running", "succeeded"].map((s) => ({ value: s, label: labels.statuses[s] ?? s })), { value: "all", label: labels.any }],
    },
    { kind: "select", key: "kind", label: labels.filterKind, allLabel: labels.any, options: kinds.map((k) => ({ value: k, label: k })) },
    { kind: "select", key: "lane", label: labels.filterLane, allLabel: labels.any, options: ["fast", "bulk"].map((l) => ({ value: l, label: labels.lanes[l] ?? l })) },
    { kind: "search", key: "q", label: labels.columns.key },
  ];
  const filtered = Object.entries(searchParams).some(([k, v]) => k !== "cursor" && !!v);
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      nextCursor={nextCursor}
      filters={filters}
      searchParams={searchParams}
      emptyState={<EmptyState title={filtered ? labels.emptyFiltered : labels.emptyDead} />}
      labels={{ pagination: labels.pagination, previous: labels.previous, next: labels.next, applyFilters: labels.applyFilters, filters: labels.filters }}
    />
  );
}
