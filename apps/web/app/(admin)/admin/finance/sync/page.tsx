import Link from "next/link";
import { notFound } from "next/navigation";
import { cn } from "@beam/ui";
import { formatDate, formatDateTime } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getBillitIntegrationStatus, listBillitBacklog, listReconcileRuns } from "@/modules/finance/queries";
import { FinanceActionButton } from "@/modules/finance/ui/action-button";
import { financeLabels } from "@/modules/finance/ui/labels";
import { fillLabel } from "@/modules/finance/ui/text";
import { PageHeader, StatusPill, Surface, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { BackLink, KpiStrip, Notice } from "@/modules/platform/ui/admin-list-kit";

const TONE: Record<string, Tone> = { pending: "muted", failed: "bad", synced: "muted", ok: "ok", issues: "warn" };

/**
 * `/admin/finance/sync` (`invoices.read`; retries and reconcile need `invoices.issue`), finance
 * spec section 5. Out of the menu (owner review November 2026): Facturen links here from its
 * Billit notice and its "More" menu.
 */
export default async function FinanceSyncPage() {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const canIssue = hasPermission(actor, "invoices.issue");
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = financeLabels(locale);
  const l = (key: string, p?: Record<string, string | number>) => fillLabel(labels[key] ?? key, p);
  const db = await getAppDb();
  const [backlog, runs, status] = await Promise.all([listBillitBacklog(db), listReconcileRuns(db, { limit: 30 }), getBillitIntegrationStatus(db)]);
  const minutes = (m: number | null) => (m === null ? l("common.none") : l("common.minutes", { count: m }));
  const failed = backlog.filter((r) => r.billitStatus === "failed").length;

  return (
    <div className="grid gap-4">
      <BackLink href="/admin/finance/invoices">{tr("finance.nav.invoices")}</BackLink>
      <PageHeader
        title={l("sync.title")}
        description={l("sync.subtitle")}
        actions={
          canIssue ? (
            <>
              {failed ? <FinanceActionButton kind="retry_all" label={l("overview.retry_all")} labels={labels} /> : null}
              <FinanceActionButton kind="reconcile" label={l("sync.run_now")} labels={labels} />
            </>
          ) : null
        }
      />

      <KpiStrip
        aria-label={l("sync.integration")}
        items={[
          { key: "backlog", label: l("sync.backlog"), value: String(backlog.length), sub: l("overview.billit_value", { pending: backlog.length - failed, failed }), ...(failed ? { tone: "bad" as const } : {}) },
          { key: "success", label: l("sync.last_success"), value: status.lastSuccessAt ? formatDateTime(status.lastSuccessAt, locale, "short") : l("sync.never") },
          { key: "failure", label: l("sync.last_failure"), value: status.lastFailureAt ? formatDateTime(status.lastFailureAt, locale, "short") : l("sync.never") },
        ]}
      />

      <section className="grid gap-2">
        <h2 className="text-[0.9375rem] font-semibold">{l("sync.backlog")}</h2>
        {backlog.length === 0 ? (
          <Notice tone="ok">{l("sync.in_sync")}</Notice>
        ) : (
          <Surface flush>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-[0.8125rem]">
                <caption className="sr-only">{l("sync.backlog_caption")}</caption>
                <thead className="bg-[#faf9f6]">
                  <tr className="border-b border-border">
                    <th scope="col" className={cn(th, "w-40")}>{l("sync.col_number")}</th>
                    <th scope="col" className={cn(th, "w-28")}>{l("sync.col_status")}</th>
                    <th scope="col" className={cn(th, "w-20 text-right")}>{l("sync.col_attempts")}</th>
                    <th scope="col" className={th}>{l("sync.col_error")}</th>
                    <th scope="col" className={cn(th, "w-24 text-right")}>{l("sync.col_age")}</th>
                    <th scope="col" className={cn(th, "w-28 text-right")}>{l("sync.col_failing")}</th>
                    {canIssue ? (
                      <th scope="col" className={cn(th, "w-40")}>
                        <span className="sr-only">{l("detail.actions")}</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {backlog.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-b-0">
                      <td className={td}>
                        <Link href={`/admin/finance/invoices/${r.id}`} className="font-semibold hover:underline">
                          {r.number}
                        </Link>
                        <span className="block text-[0.75rem] text-muted-foreground">{l(`kind.${r.kind}`)}</span>
                      </td>
                      <td className={td}>
                        <StatusPill tone={TONE[r.billitStatus] ?? "muted"}>{l(`billit_status.${r.billitStatus}`)}</StatusPill>
                      </td>
                      <td className={cn(td, "text-right tabular-nums")}>{r.billitAttempts}</td>
                      <td className={cn(td, "max-w-sm truncate text-muted-foreground")} title={r.billitLastError ?? undefined}>
                        {r.billitLastError ?? ""}
                      </td>
                      <td className={cn(td, "text-right tabular-nums")}>{minutes(r.ageMinutes)}</td>
                      <td className={cn(td, "text-right tabular-nums", (r.failingMinutes ?? 0) >= 60 && "font-semibold text-[var(--status-bad)]")}>{minutes(r.failingMinutes)}</td>
                      {canIssue ? (
                        <td className={td}>
                          <FinanceActionButton kind="retry" invoiceId={r.id} label={l("retry.open")} labels={labels} />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Surface>
        )}
      </section>

      <section className="grid gap-2">
        <h2 className="text-[0.9375rem] font-semibold">{l("sync.runs")}</h2>
        {runs.length === 0 ? (
          <Notice tone="muted">{l("sync.runs_empty")}</Notice>
        ) : (
          <Surface flush>
            <table className="w-full text-[0.8125rem]">
              <caption className="sr-only">{l("sync.runs_caption")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={cn(th, "w-40")}>{l("sync.col_run_on")}</th>
                  <th scope="col" className={cn(th, "w-28")}>{l("sync.col_status")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{l("sync.col_checked")}</th>
                  <th scope="col" className={th}>{l("sync.col_issues")}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-border align-top last:border-b-0">
                    <td className={cn(td, "font-medium whitespace-nowrap")}>{formatDate(run.runOn, locale)}</td>
                    <td className={td}>
                      <StatusPill tone={TONE[run.status] ?? "bad"}>{l(`reconcile_status.${run.status}`)}</StatusPill>
                    </td>
                    <td className={cn(td, "text-right tabular-nums")}>{run.checkedCount}</td>
                    <td className={td}>
                      {run.issues.length === 0 ? (
                        <span className="tabular-nums">{run.issuesCount}</span>
                      ) : (
                        <details>
                          <summary className="cursor-pointer font-medium">
                            {l("sync.show_issues")} ({run.issuesCount})
                          </summary>
                          <ul className="mt-2 grid gap-1 text-[0.75rem]">
                            {run.issues.map((issue, i) => (
                              <li key={`${issue.type}-${i}`}>
                                <strong>{l(`issue_type.${issue.type}`)}</strong>
                                {issue.number ? <span> {issue.number}</span> : null}: {issue.detail}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Surface>
        )}
      </section>
    </div>
  );
}
