import Link from "next/link";
import { notFound } from "next/navigation";
import { cn, EmptyState } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listCompanyInvoiceRequests } from "@/modules/finance/queries";
import { financeLabels } from "@/modules/finance/ui/labels";
import { RequestDecision } from "@/modules/finance/ui/request-decision";
import { fillLabel } from "@/modules/finance/ui/text";
import { PageHeader, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { BackLink, Initials } from "@/modules/platform/ui/admin-list-kit";

const TONE: Record<string, Tone> = { requested: "warn", approved: "ok", rejected: "muted", cancelled: "muted" };

/**
 * `/admin/finance/requests` (`invoices.read`; decisions need `invoices.issue`): company invoice
 * requests (rule 20). Out of the menu (owner review November 2026): Facturen shows a notice with
 * the number of open requests that links here.
 */
export default async function FinanceRequestsPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const canIssue = hasPermission(actor, "invoices.issue");
  const showAll = (await searchParams).all === "1";
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = financeLabels(locale);
  const l = (key: string, p?: Record<string, string | number>) => fillLabel(labels[key] ?? key, p);
  const rows = await listCompanyInvoiceRequests(await getAppDb(), showAll ? {} : { status: "requested" });

  return (
    <div className="grid gap-4">
      <BackLink href="/admin/finance/invoices">{tr("finance.nav.invoices")}</BackLink>
      <PageHeader title={l("requests.title")} description={l("requests.subtitle")} />
      <Toolbar>
        <Segmented
          label={l("requests.caption")}
          items={[
            { key: "open", label: l("requests.show_open"), href: "/admin/finance/requests", active: !showAll },
            { key: "all", label: l("requests.show_all"), href: "/admin/finance/requests?all=1", active: showAll },
          ]}
        />
      </Toolbar>
      {rows.length === 0 ? (
        <EmptyState title={l("requests.empty")} />
      ) : (
        <Surface flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-[0.8125rem]">
              <caption className="sr-only">{l("requests.caption")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{l("requests.col_customer")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{l("requests.col_invoice")}</th>
                  <th scope="col" className={th}>{l("requests.col_company")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{l("requests.col_vat")}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{l("requests.col_age")}</th>
                  <th scope="col" className={cn(th, "w-28")}>{l("requests.col_status")}</th>
                  {canIssue ? (
                    <th scope="col" className={cn(th, "w-48")}>
                      <span className="sr-only">{l("detail.actions")}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border align-top last:border-b-0">
                    <td className={td}>
                      <span className="flex items-center gap-2.5">
                        <Initials name={r.customerName} />
                        <span className="font-medium">{r.customerName ?? l("common.none")}</span>
                      </span>
                    </td>
                    <td className={td}>
                      <Link href={`/admin/finance/invoices/${r.invoiceId}`} className="font-semibold hover:underline">
                        {r.invoiceNumber}
                      </Link>
                    </td>
                    <td className={td}>
                      <span className="block font-medium">{r.billing.legalName}</span>
                      <span className="block text-[0.75rem] text-muted-foreground">
                        {[r.billing.vatNumber, r.billing.address.line1, `${r.billing.address.postal_code} ${r.billing.address.city}`, r.billing.address.country].filter(Boolean).join(", ")}
                      </span>
                    </td>
                    <td className={td}>
                      <StatusPill tone={r.vatCheck === "ok" ? "ok" : "bad"}>{l(`requests.vat_${r.vatCheck}`)}</StatusPill>
                    </td>
                    <td className={cn(td, "text-right tabular-nums")}>{l("requests.age_days", { count: r.ageDays })}</td>
                    <td className={td}>
                      <StatusPill tone={TONE[r.status] ?? "muted"}>{l(`request_status.${r.status}`)}</StatusPill>
                      {r.decisionNote ? <span className="block pt-1 text-[0.75rem] text-muted-foreground">{r.decisionNote}</span> : null}
                    </td>
                    {canIssue ? <td className={td}>{r.status === "requested" ? <RequestDecision requestId={r.id} labels={labels} /> : null}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
