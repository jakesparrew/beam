import { notFound } from "next/navigation";
import { EmptyState } from "@beam/ui";
import { formatDate, formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { listMyInvoices } from "@/modules/finance/queries";
import { statusLabel } from "@/modules/finance/ui/portal/labels";
import { PortalPdfLink } from "@/modules/finance/ui/portal/pdf-link";
import { PortalStatusBadge } from "@/modules/finance/ui/portal/status-badge";

/**
 * `/[locale]/account/invoices` (finance rule 40, spec section 5): the customer's invoices and
 * credit notes, newest first, with number, date, total, status and PDF download.
 */
export default async function AccountInvoicesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const rows = await listMyInvoices(await getAppDb(), { personId: actor.personId });

  return (
    <section aria-labelledby="invoices-title" className="grid max-w-4xl gap-4">
      <div className="grid gap-1">
        <h1 id="invoices-title" className="text-2xl font-semibold">
          {tr("finance.portal.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{tr("finance.portal.intro")}</p>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={tr("finance.portal.list.empty")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{tr("finance.portal.list.caption")}</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-2 pr-3 font-medium">{tr("finance.portal.list.number")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{tr("finance.portal.list.kind")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{tr("finance.portal.list.date")}</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">{tr("finance.portal.list.total")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{tr("finance.portal.list.status")}</th>
                <th scope="col" className="py-2 font-medium">{tr("finance.portal.list.pdf")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0" data-testid="portal-invoice-row">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <a href={`/${seg}/account/invoices/${r.id}`} className="font-medium underline" aria-label={tr("finance.portal.list.open_document", { number: r.number })}>
                      {r.number}
                    </a>
                  </th>
                  <td className="py-2 pr-3">{tr(`finance.portal.kind.${r.kind}`)}</td>
                  <td className="py-2 pr-3">{formatDate(r.issuedOn, locale)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(r.totalCents, locale)}</td>
                  <td className="py-2 pr-3">
                    <PortalStatusBadge kind={r.kind} status={r.status} label={statusLabel(tr, r)} />
                  </td>
                  <td className="py-2">
                    <PortalPdfLink
                      href={`/${seg}/account/invoices/${r.id}/pdf`}
                      ready={r.pdfReady}
                      pending={r.pdfStatus !== "rendered"}
                      label={tr("finance.portal.pdf.download")}
                      preparingLabel={tr("finance.portal.pdf.preparing")}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
