import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime } from "@beam/core/i18n";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, jobsTableLabels, translator } from "@/lib/i18n";
import { getJob } from "@/modules/platform/queries";
import { JobActions } from "@/modules/platform/ui/jobs-table";

/** `/admin/system/jobs/[id]`: the full row (payload with secret keys redacted), result, error and provider calls. */
export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "system.jobs" });
  const { id } = await params;
  const locale = await adminLocale();
  const tr = translator(locale);
  const job = await getJob(await getAppDb(), id);
  if (!job) notFound();
  const labels = jobsTableLabels(tr);
  const when = (d: Date | null) => (d ? formatDateTime(d, locale, "short") : "–");
  const fields: [string, string][] = [
    [tr("platform.jobs.col_status"), labels.statuses[job.status] ?? job.status],
    [tr("platform.jobs.col_lane"), labels.lanes[job.lane] ?? job.lane],
    [tr("platform.jobs.col_attempts"), `${job.attempts} / ${job.maxAttempts}`],
    [tr("platform.jobs.col_key"), job.idempotencyKey],
    [tr("platform.jobs.col_run_at"), when(job.runAt)],
    [tr("platform.jobs.created_at"), when(job.createdAt)],
    [tr("platform.jobs.started_at"), when(job.startedAt)],
    [tr("platform.jobs.finished_at"), when(job.finishedAt)],
    [tr("platform.jobs.locked_by"), job.lockedBy ?? "–"],
    [tr("platform.jobs.request_id"), job.requestId ?? "–"],
  ];
  return (
    <div className="grid gap-6">
      <Link href="/admin/system/jobs" className="text-sm underline">
        {tr("platform.jobs.back")}
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{tr("platform.jobs.detail_title", { kind: job.kind })}</h1>
        <Badge variant={job.status === "dead" ? "destructive" : "secondary"}>{labels.statuses[job.status] ?? job.status}</Badge>
      </header>
      <JobActions job={{ id: job.id, status: job.status, kind: job.kind }} labels={labels} canManage />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        {fields.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-medium">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{tr("platform.jobs.payload")}</h2>
        <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{JSON.stringify(job.payload, null, 2)}</pre>
      </section>
      {job.result !== null && job.result !== undefined ? (
        <section className="grid gap-2">
          <h2 className="text-lg font-semibold">{tr("platform.jobs.result")}</h2>
          <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{JSON.stringify(job.result, null, 2)}</pre>
        </section>
      ) : null}
      {job.lastError ? (
        <section className="grid gap-2">
          <h2 className="text-lg font-semibold">{tr("platform.jobs.error")}</h2>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{job.lastError}</pre>
        </section>
      ) : null}
      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{tr("platform.jobs.timeline")}</h2>
        {job.calls.length === 0 ? (
          <p className="text-muted-foreground">{tr("platform.jobs.timeline_empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr("platform.jobs.created_at")}</TableHead>
                <TableHead>{tr("platform.jobs.col_provider")}</TableHead>
                <TableHead>{tr("platform.jobs.col_operation")}</TableHead>
                <TableHead>{tr("platform.jobs.col_http")}</TableHead>
                <TableHead>{tr("platform.jobs.col_duration")}</TableHead>
                <TableHead>{tr("platform.jobs.error")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {job.calls.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{when(c.createdAt)}</TableCell>
                  <TableCell>{c.provider}</TableCell>
                  <TableCell>{c.operation}</TableCell>
                  <TableCell>{c.statusCode ?? "–"}</TableCell>
                  <TableCell>{c.durationMs}</TableCell>
                  <TableCell className="max-w-xs truncate">{c.ok ? "–" : (c.error ?? "–")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
