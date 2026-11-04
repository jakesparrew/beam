import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDate, formatDateTime } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getBillitIntegrationStatus, listBillitBacklog, listReconcileRuns } from "@/modules/finance/queries";
import { FinanceActionButton } from "@/modules/finance/ui/action-button";
import { FinanceBadge } from "@/modules/finance/ui/badges";
import { financeLabels } from "@/modules/finance/ui/labels";
import { fillLabel } from "@/modules/finance/ui/text";

/** `/admin/finance/sync` (`invoices.read`; retries and reconcile need `invoices.issue`), finance spec section 5. */
export default async function FinanceSyncPage() {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const canIssue = hasPermission(actor, "invoices.issue");
  const locale = await adminLocale();
  const labels = financeLabels(locale);
  const l = (key: string, p?: Record<string, string | number>) => fillLabel(labels[key] ?? key, p);
  const db = await getAppDb();
  const [backlog, runs, status] = await Promise.all([listBillitBacklog(db), listReconcileRuns(db, { limit: 30 }), getBillitIntegrationStatus(db)]);
  const minutes = (m: number | null) => (m === null ? l("common.none") : l("common.minutes", { count: m }));

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{l("sync.title")}</h1>
        {canIssue ? (
          <div className="flex flex-wrap gap-2">
            {backlog.some((r) => r.billitStatus === "failed") ? <FinanceActionButton kind="retry_all" label={l("overview.retry_all")} labels={labels} /> : null}
            <FinanceActionButton kind="reconcile" label={l("sync.run_now")} labels={labels} />
          </div>
        ) : null}
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{l("sync.integration")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          <p>
            {l("sync.last_success")}: {status.lastSuccessAt ? formatDateTime(status.lastSuccessAt, locale) : l("sync.never")}
          </p>
          <p>
            {l("sync.last_failure")}: {status.lastFailureAt ? formatDateTime(status.lastFailureAt, locale) : l("sync.never")}
          </p>
        </CardContent>
      </Card>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">{l("sync.backlog")}</h2>
        {backlog.length === 0 ? (
          <EmptyState title={l("sync.in_sync")} />
        ) : (
          <Table>
            <TableCaption>{l("sync.backlog_caption")}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{l("sync.col_number")}</TableHead>
                <TableHead>{l("sync.col_kind")}</TableHead>
                <TableHead>{l("sync.col_status")}</TableHead>
                <TableHead className="text-right">{l("sync.col_attempts")}</TableHead>
                <TableHead>{l("sync.col_error")}</TableHead>
                <TableHead className="text-right">{l("sync.col_age")}</TableHead>
                <TableHead className="text-right">{l("sync.col_failing")}</TableHead>
                {canIssue ? <TableHead>{l("detail.actions")}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {backlog.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/admin/finance/invoices/${r.id}`} className="font-mono underline-offset-4 hover:underline">
                      {r.number}
                    </Link>
                  </TableCell>
                  <TableCell>{l(`kind.${r.kind}`)}</TableCell>
                  <TableCell>
                    <FinanceBadge group="billit_status" value={r.billitStatus} labels={labels} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.billitAttempts}</TableCell>
                  <TableCell className="max-w-sm truncate">{r.billitLastError ?? ""}</TableCell>
                  <TableCell className="text-right tabular-nums">{minutes(r.ageMinutes)}</TableCell>
                  <TableCell className={(r.failingMinutes ?? 0) >= 60 ? "text-right font-medium text-destructive tabular-nums" : "text-right tabular-nums"}>{minutes(r.failingMinutes)}</TableCell>
                  {canIssue ? (
                    <TableCell>
                      <FinanceActionButton kind="retry" invoiceId={r.id} label={l("retry.open")} labels={labels} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">{l("sync.runs")}</h2>
        {runs.length === 0 ? (
          <EmptyState title={l("sync.runs_empty")} />
        ) : (
          <Table>
            <TableCaption>{l("sync.runs_caption")}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{l("sync.col_run_on")}</TableHead>
                <TableHead>{l("sync.col_status")}</TableHead>
                <TableHead className="text-right">{l("sync.col_checked")}</TableHead>
                <TableHead>{l("sync.col_issues")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>{formatDate(run.runOn, locale)}</TableCell>
                  <TableCell>
                    <FinanceBadge group="reconcile_status" value={run.status} labels={labels} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{run.checkedCount}</TableCell>
                  <TableCell>
                    {run.issues.length === 0 ? (
                      String(run.issuesCount)
                    ) : (
                      <details>
                        <summary className="cursor-pointer">
                          {l("sync.show_issues")} ({run.issuesCount})
                        </summary>
                        <ul className="mt-2 grid gap-1 text-sm">
                          {run.issues.map((issue, i) => (
                            <li key={`${issue.type}-${i}`}>
                              <strong>{l(`issue_type.${issue.type}`)}</strong>
                              {issue.number ? <span className="font-mono"> {issue.number}</span> : null}: {issue.detail}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
