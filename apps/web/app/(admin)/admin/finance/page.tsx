import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@beam/ui";
import { formatDate, formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getFinanceOverview, getInvoicingIdentity } from "@/modules/finance/queries";
import { brusselsDay } from "@/modules/finance/service/billit-sync";
import { FinanceActionButton } from "@/modules/finance/ui/action-button";
import { financeLabels } from "@/modules/finance/ui/labels";
import { fillLabel } from "@/modules/finance/ui/text";

/** `/admin/finance` (`invoices.read`): the V1 overview tiles of finance spec section 5. */
export default async function FinanceOverviewPage() {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const canIssue = hasPermission(actor, "invoices.issue");
  const locale = await adminLocale();
  const db = await getAppDb();
  const labels = financeLabels(locale);
  const l = (key: string, params?: Record<string, string | number>) => fillLabel(labels[key] ?? key, params);
  const money = (cents: number) => formatMoney(cents, locale);
  const [o, identity] = await Promise.all([getFinanceOverview(db), getInvoicingIdentity(db, { locale })]);
  const year = brusselsDay(new Date()).slice(0, 4);
  const fieldLabel = (path: string) => labels[`settings.field.${path.split(".").pop()}`] ?? path;

  if (o.documentCount === 0) {
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold">{l("overview.title")}</h1>
        <EmptyState title={l("overview.empty", { year })} />
      </div>
    );
  }

  const tiles: { key: string; title: string; value: string; detail?: string; href: string; alert?: boolean }[] = [
    { key: "today", title: l("overview.today"), value: l("overview.count_net", { count: o.today.count, amount: money(o.today.netCents) }), href: "/admin/finance/invoices" },
    { key: "month", title: l("overview.month"), value: l("overview.count_net", { count: o.month.count, amount: money(o.month.netCents) }), href: "/admin/finance/invoices" },
    { key: "open", title: l("overview.open"), value: l("overview.count_amount", { count: o.open.count, amount: money(o.open.amountCents) }), href: "/admin/finance/invoices?status=open" },
    {
      key: "overdue",
      title: l("overview.overdue"),
      value: l("overview.count_amount", { count: o.overdue.count, amount: money(o.overdue.amountCents) }),
      href: "/admin/finance/invoices?status=open",
      alert: o.overdue.count > 0,
    },
    {
      key: "billit",
      title: l("overview.billit"),
      value: l("overview.billit_value", { pending: o.billit.pending, failed: o.billit.failed }),
      ...(o.billit.failing > 0 ? { detail: l("overview.billit_failing", { count: o.billit.failing }) } : {}),
      href: "/admin/finance/sync",
      alert: o.billit.failing > 0,
    },
    { key: "pdf", title: l("overview.pdf_failed"), value: String(o.pdfFailed), href: "/admin/finance/invoices", alert: o.pdfFailed > 0 },
    { key: "requests", title: l("overview.requests"), value: String(o.pendingRequests), href: "/admin/finance/requests" },
    {
      key: "reconcile",
      title: l("overview.reconcile"),
      value: o.lastReconcile
        ? l("overview.reconcile_value", { date: formatDate(o.lastReconcile.runOn, locale), status: l(`reconcile_status.${o.lastReconcile.status}`), issues: o.lastReconcile.issuesCount })
        : l("overview.reconcile_never"),
      href: "/admin/finance/sync",
      alert: o.lastReconcile?.status === "failed",
    },
  ];

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{l("overview.title")}</h1>
        {canIssue ? (
          <div className="flex flex-wrap gap-2">
            {o.billit.failed > 0 ? <FinanceActionButton kind="retry_all" label={l("overview.retry_all")} labels={labels} /> : null}
            {o.pdfFailed > 0 ? <FinanceActionButton kind="rerender_blocked" label={l("overview.rerender_blocked")} labels={labels} /> : null}
          </div>
        ) : null}
      </header>
      {identity.missing.length > 0 ? (
        <Alert variant="destructive">
          <AlertDescription>
            {o.pdfBlocked ? `${l("overview.pdf_blocked")} ` : ""}
            {l("overview.identity_missing", { fields: identity.missing.map(fieldLabel).join(", ") })}{" "}
            <Link href="/admin/finance/settings" className="underline underline-offset-4">
              {l("settings.title")}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Card key={tile.key} className={tile.alert ? "border-destructive" : undefined}>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">{tile.title}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1">
              <p className="text-lg font-semibold tabular-nums">{tile.value}</p>
              {tile.detail ? <p className="text-sm font-medium text-destructive">{tile.detail}</p> : null}
              <Link href={tile.href as "/admin/finance"} className="text-sm underline-offset-4 hover:underline">
                {l("overview.view_all")}
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
