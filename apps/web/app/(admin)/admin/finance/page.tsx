import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn, EmptyState } from "@beam/ui";
import { formatDate, formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getFinanceOverview, getInvoicingIdentity } from "@/modules/finance/queries";
import { brusselsDay } from "@/modules/finance/service/billit-sync";
import { FinanceActionButton } from "@/modules/finance/ui/action-button";
import { financeLabels } from "@/modules/finance/ui/labels";
import { fillLabel } from "@/modules/finance/ui/text";
import { PageHeader, StatusPill, Surface, td, th } from "@/modules/platform/ui/admin-kit";
import { BackLink, KpiStrip, Notice } from "@/modules/platform/ui/admin-list-kit";

/**
 * `/admin/finance` (`invoices.read`): the V1 overview of finance spec section 5, reached from
 * Facturen ("More"): today's and this month's invoicing, open and overdue amounts, then the
 * follow-up checks (Billit backlog, failed PDFs, company requests, last reconcile) with links.
 */
export default async function FinanceOverviewPage() {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const canIssue = hasPermission(actor, "invoices.issue");
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const labels = financeLabels(locale);
  const l = (key: string, params?: Record<string, string | number>) => fillLabel(labels[key] ?? key, params);
  const money = (cents: number) => formatMoney(cents, locale);
  const [o, identity] = await Promise.all([getFinanceOverview(db), getInvoicingIdentity(db, { locale })]);
  const year = brusselsDay(new Date()).slice(0, 4);
  const fieldLabel = (path: string) => labels[`settings.field.${path.split(".").pop()}`] ?? path;
  const back = <BackLink href="/admin/finance/invoices">{tr("finance.nav.invoices")}</BackLink>;

  if (o.documentCount === 0) {
    return (
      <div className="grid gap-4">
        {back}
        <PageHeader title={l("overview.title")} />
        <EmptyState title={l("overview.empty", { year })} />
      </div>
    );
  }

  const checks: { key: string; title: string; value: string; detail?: string; href: Route; alert: boolean }[] = [
    {
      key: "billit",
      title: l("overview.billit"),
      value: l("overview.billit_value", { pending: o.billit.pending, failed: o.billit.failed }),
      ...(o.billit.failing > 0 ? { detail: l("overview.billit_failing", { count: o.billit.failing }) } : {}),
      href: "/admin/finance/sync",
      alert: o.billit.failed > 0,
    },
    { key: "pdf", title: l("overview.pdf_failed"), value: String(o.pdfFailed), href: "/admin/finance/invoices", alert: o.pdfFailed > 0 },
    { key: "requests", title: l("overview.requests"), value: String(o.pendingRequests), href: "/admin/finance/requests", alert: o.pendingRequests > 0 },
    {
      key: "reconcile",
      title: l("overview.reconcile"),
      value: o.lastReconcile
        ? l("overview.reconcile_value", { date: formatDate(o.lastReconcile.runOn, locale), status: l(`reconcile_status.${o.lastReconcile.status}`), issues: o.lastReconcile.issuesCount })
        : l("overview.reconcile_never"),
      href: "/admin/finance/sync",
      alert: o.lastReconcile?.status === "failed" || o.lastReconcile?.status === "issues",
    },
  ];

  return (
    <div className="grid gap-4">
      {back}
      <PageHeader
        title={l("overview.title")}
        description={l("overview.subtitle")}
        actions={
          canIssue && (o.billit.failed > 0 || o.pdfFailed > 0) ? (
            <>
              {o.billit.failed > 0 ? <FinanceActionButton kind="retry_all" label={l("overview.retry_all")} labels={labels} /> : null}
              {o.pdfFailed > 0 ? <FinanceActionButton kind="rerender_blocked" label={l("overview.rerender_blocked")} labels={labels} /> : null}
            </>
          ) : null
        }
      />
      {identity.missing.length > 0 ? (
        <Notice tone="bad" action={{ href: "/admin/finance/settings", label: l("settings.title") }}>
          {o.pdfBlocked ? `${l("overview.pdf_blocked")} ` : ""}
          {l("overview.identity_missing", { fields: identity.missing.map(fieldLabel).join(", ") })}
        </Notice>
      ) : null}
      <KpiStrip
        data-testid="finance-overview-kpis"
        items={[
          { key: "today", label: l("overview.today"), value: money(o.today.netCents), sub: l("invoices.kpi_month_sub", { count: o.today.count }) },
          { key: "month", label: l("overview.month"), value: money(o.month.netCents), sub: l("invoices.kpi_month_sub", { count: o.month.count }) },
          { key: "open", label: l("overview.open"), value: money(o.open.amountCents), sub: l("invoices.kpi_count", { count: o.open.count }) },
          { key: "overdue", label: l("overview.overdue"), value: money(o.overdue.amountCents), sub: l("invoices.kpi_count", { count: o.overdue.count }), ...(o.overdue.count ? { tone: "bad" as const } : {}) },
        ]}
      />
      <Surface flush>
        <table className="w-full text-[0.8125rem]">
          <caption className="sr-only">{l("overview.checks")}</caption>
          <thead className="bg-[#faf9f6]">
            <tr className="border-b border-border">
              <th scope="col" className={th}>{l("overview.checks")}</th>
              <th scope="col" className={th}>{l("overview.col_state")}</th>
              <th scope="col" className={cn(th, "w-28")}>
                <span className="sr-only">{l("overview.view_all")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.key} className="border-b border-border last:border-b-0" data-check={c.key}>
                <th scope="row" className={cn(td, "text-left font-medium")}>
                  {c.title}
                </th>
                <td className={td}>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={c.alert ? "bad" : "ok"}>{c.value}</StatusPill>
                    {c.detail ? <span className="text-[0.75rem] font-semibold text-[var(--status-bad)]">{c.detail}</span> : null}
                  </span>
                </td>
                <td className={cn(td, "text-right")}>
                  <Link href={c.href} className="font-semibold text-[#8a5a14] hover:underline">
                    {l("overview.view_all")} →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Surface>
    </div>
  );
}
