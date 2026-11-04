import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants, EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { listCompanyInvoiceRequests } from "@/modules/finance/queries";
import { FinanceBadge } from "@/modules/finance/ui/badges";
import { financeLabels } from "@/modules/finance/ui/labels";
import { RequestDecision } from "@/modules/finance/ui/request-decision";
import { fillLabel } from "@/modules/finance/ui/text";

/** `/admin/finance/requests` (`invoices.read`; decisions need `invoices.issue`): company invoice requests (rule 20). */
export default async function FinanceRequestsPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const canIssue = hasPermission(actor, "invoices.issue");
  const showAll = (await searchParams).all === "1";
  const locale = await adminLocale();
  const labels = financeLabels(locale);
  const l = (key: string, p?: Record<string, string | number>) => fillLabel(labels[key] ?? key, p);
  const rows = await listCompanyInvoiceRequests(await getAppDb(), showAll ? {} : { status: "requested" });

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{l("requests.title")}</h1>
        <Link href={showAll ? "/admin/finance/requests" : "/admin/finance/requests?all=1"} className={buttonVariants({ variant: "outline" })}>
          {showAll ? l("requests.show_open") : l("requests.show_all")}
        </Link>
      </header>
      {rows.length === 0 ? (
        <EmptyState title={l("requests.empty")} />
      ) : (
        <Table>
          <TableCaption>{l("requests.caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{l("requests.col_customer")}</TableHead>
              <TableHead>{l("requests.col_invoice")}</TableHead>
              <TableHead>{l("requests.col_company")}</TableHead>
              <TableHead>{l("requests.col_vat")}</TableHead>
              <TableHead className="text-right">{l("requests.col_age")}</TableHead>
              <TableHead>{l("requests.col_status")}</TableHead>
              {canIssue ? <TableHead>{l("detail.actions")}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.customerName ?? l("common.none")}</TableCell>
                <TableCell>
                  <Link href={`/admin/finance/invoices/${r.invoiceId}`} className="font-mono underline-offset-4 hover:underline">
                    {r.invoiceNumber}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="block font-medium">{r.billing.legalName}</span>
                  <span className="block text-sm text-muted-foreground">
                    {[r.billing.vatNumber, r.billing.address.line1, `${r.billing.address.postal_code} ${r.billing.address.city}`, r.billing.address.country].filter(Boolean).join(", ")}
                  </span>
                </TableCell>
                <TableCell className={r.vatCheck === "ok" ? undefined : "font-medium text-destructive"}>{l(`requests.vat_${r.vatCheck}`)}</TableCell>
                <TableCell className="text-right tabular-nums">{l("requests.age_days", { count: r.ageDays })}</TableCell>
                <TableCell>
                  <FinanceBadge group="request_status" value={r.status} labels={labels} />
                  {r.decisionNote ? <span className="block text-sm text-muted-foreground">{r.decisionNote}</span> : null}
                </TableCell>
                {canIssue ? <TableCell>{r.status === "requested" ? <RequestDecision requestId={r.id} labels={labels} /> : null}</TableCell> : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
