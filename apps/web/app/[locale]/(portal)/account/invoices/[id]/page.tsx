import { notFound } from "next/navigation";
import { formatDate, formatDateTime, formatMoney, formatPercent, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getMyInvoice, type DocumentRef } from "@/modules/finance/queries";
import { CancelRequestButton } from "@/modules/finance/ui/portal/cancel-request-button";
import { CompanyRequestForm } from "@/modules/finance/ui/portal/company-request-form";
import { methodLabel, requestLabels, statusLabel } from "@/modules/finance/ui/portal/labels";
import { PortalPdfLink } from "@/modules/finance/ui/portal/pdf-link";
import { PortalStatusBadge } from "@/modules/finance/ui/portal/status-badge";

/**
 * `/[locale]/account/invoices/[id]` (finance rules 20 and 40, spec section 5): the document with
 * lines and VAT, payment status, bank details for an open invoice, linked credit notes, the PDF
 * download and, inside the window, the "Need an invoice in your company's name?" form. Another
 * person's document is the 404 page.
 */
export default async function AccountInvoiceDetailPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale: segment, id } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const doc = await getMyInvoice(await getAppDb(), { personId: actor.personId, id });
  if (!doc) notFound();
  const money = (cents: number) => formatMoney(cents, locale);
  const docHref = (ref: DocumentRef) => `/${seg}/account/invoices/${ref.id}`;
  const title = tr(doc.kind === "invoice" ? "finance.portal.detail.invoice_title" : "finance.portal.detail.credit_note_title", { number: doc.number });

  return (
    <article aria-labelledby="invoice-title" className="grid max-w-3xl gap-6">
      <a href={`/${seg}/account/invoices`} className="text-sm underline">
        {tr("finance.portal.detail.back")}
      </a>
      <header className="grid gap-2">
        <h1 id="invoice-title" className="text-2xl font-semibold">
          {title}
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <PortalStatusBadge kind={doc.kind} status={doc.status} label={statusLabel(tr, doc)} />
          <span>{tr("finance.portal.detail.issued_on", { date: formatDate(doc.issuedOn, locale, "long") })}</span>
          {doc.status === "open" && doc.dueOn ? <span>{tr("finance.portal.detail.due_on", { date: formatDate(doc.dueOn, locale, "long") })}</span> : null}
          {doc.paidAt && doc.kind === "invoice" ? <span>{tr("finance.portal.detail.paid_on", { date: formatDate(doc.paidAt, locale, "long") })}</span> : null}
        </div>
        <PortalPdfLink
          href={`/${seg}/account/invoices/${doc.id}/pdf`}
          ready={doc.pdfReady}
          pending={doc.pdfStatus !== "rendered"}
          label={tr("finance.portal.pdf.download_number", { number: doc.number })}
          preparingLabel={tr("finance.portal.pdf.preparing")}
          className="inline-flex min-h-11 w-fit items-center rounded-md border px-4 font-medium underline-offset-4 hover:underline"
        />
      </header>

      {doc.customer ? (
        <section aria-labelledby="billed-to" className="grid gap-1 text-sm">
          <h2 id="billed-to" className="text-lg font-semibold">
            {tr("finance.portal.detail.billed_to")}
          </h2>
          <p>{doc.customer.name}</p>
          {doc.customer.vatNumber ? <p>{tr("finance.portal.detail.vat_number", { vat: doc.customer.vatNumber })}</p> : null}
        </section>
      ) : null}

      <section aria-labelledby="invoice-lines" className="grid gap-2">
        <h2 id="invoice-lines" className="text-lg font-semibold">
          {tr("finance.portal.detail.lines")}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{tr("finance.portal.detail.lines_caption")}</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-2 pr-3 font-medium">{tr("finance.portal.detail.description")}</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">{tr("finance.portal.detail.quantity")}</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">{tr("finance.portal.detail.unit_price")}</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">{tr("finance.portal.detail.vat_rate")}</th>
                <th scope="col" className="py-2 text-right font-medium">{tr("finance.portal.detail.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-2 pr-3">{l.description}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{l.quantity}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(l.unitAmountCents)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatPercent(l.vatRatePct, locale, 0)}</td>
                  <td className="py-2 text-right tabular-nums">{money(l.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="invoice-vat" className="grid gap-2">
        <h2 id="invoice-vat" className="text-lg font-semibold">
          {tr("finance.portal.detail.breakdown")}
        </h2>
        <table className="w-full max-w-md text-sm">
          <caption className="sr-only">{tr("finance.portal.detail.breakdown_caption")}</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-2 pr-3 font-medium">{tr("finance.portal.detail.rate")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{tr("finance.portal.detail.net")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{tr("finance.portal.detail.vat")}</th>
              <th scope="col" className="py-2 text-right font-medium">{tr("finance.portal.detail.gross")}</th>
            </tr>
          </thead>
          <tbody>
            {doc.vatBreakdown.map((b) => (
              <tr key={String(b.vat_rate_pct)} className="border-b last:border-0">
                <th scope="row" className="py-2 pr-3 text-left font-normal tabular-nums">{formatPercent(Number(b.vat_rate_pct), locale, 0)}</th>
                <td className="py-2 pr-3 text-right tabular-nums">{money(b.net_cents)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(b.vat_cents)}</td>
                <td className="py-2 text-right tabular-nums">{money(b.gross_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="grid max-w-md grid-cols-2 gap-1 text-sm">
          <dt>{tr("finance.portal.detail.subtotal")}</dt>
          <dd className="text-right tabular-nums">{money(doc.subtotalCents)}</dd>
          <dt>{tr("finance.portal.detail.vat_total")}</dt>
          <dd className="text-right tabular-nums">{money(doc.vatCents)}</dd>
          <dt className="font-semibold">{tr("finance.portal.detail.total")}</dt>
          <dd className="text-right font-semibold tabular-nums" data-testid="invoice-total">
            {money(doc.totalCents)}
          </dd>
        </dl>
      </section>

      <section aria-labelledby="invoice-payment" className="grid gap-2 text-sm">
        <h2 id="invoice-payment" className="text-lg font-semibold">
          {tr("finance.portal.detail.payment")}
        </h2>
        {doc.kind === "credit_note" ? (
          <p>{tr(doc.status === "paid" ? "finance.portal.detail.credit_note_paid" : "finance.portal.detail.credit_note_issued")}</p>
        ) : doc.status === "cancelled" ? (
          <p>{tr("finance.portal.detail.cancelled")}</p>
        ) : doc.paymentMethod && doc.status === "paid" ? (
          <p>{tr("finance.portal.detail.paid_with", { method: methodLabel(tr, doc.paymentMethod) })}</p>
        ) : null}
        {doc.reason ? <p>{tr("finance.portal.detail.reason", { reason: doc.reason })}</p> : null}
        {doc.bank ? (
          <div className="grid gap-2 rounded-md border p-3" data-testid="bank-details">
            <h3 className="font-semibold">{tr("finance.portal.detail.bank_title")}</h3>
            <p>{tr("finance.portal.detail.bank_intro")}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt>{tr("finance.portal.detail.amount_due")}</dt>
              <dd className="tabular-nums">{money(doc.totalCents)}</dd>
              <dt>{tr("finance.portal.detail.iban")}</dt>
              <dd className="font-mono">{doc.bank.iban}</dd>
              {doc.bank.bic ? (
                <>
                  <dt>{tr("finance.portal.detail.bic")}</dt>
                  <dd className="font-mono">{doc.bank.bic}</dd>
                </>
              ) : null}
              {doc.bank.paymentReference ? (
                <>
                  <dt>{tr("finance.portal.detail.structured_communication")}</dt>
                  <dd className="font-mono">{doc.bank.paymentReference}</dd>
                </>
              ) : null}
            </dl>
          </div>
        ) : null}
      </section>

      {doc.reverses || doc.creditNotes.length || doc.replacedBy ? (
        <section aria-labelledby="invoice-related" className="grid gap-2 text-sm">
          <h2 id="invoice-related" className="text-lg font-semibold">
            {doc.creditNotes.length ? tr("finance.portal.detail.credit_notes") : tr("finance.portal.detail.related")}
          </h2>
          <ul className="grid gap-1">
            {doc.reverses ? (
              <li>
                <a href={docHref(doc.reverses)} className="underline">
                  {tr("finance.portal.detail.reverses", { number: doc.reverses.number })}
                </a>
              </li>
            ) : null}
            {doc.creditNotes.map((c) => (
              <li key={c.id}>
                <a href={docHref(c)} className="underline">
                  {c.number}
                </a>{" "}
                · {formatDate(c.issuedOn, locale)} · <span className="tabular-nums">{money(c.totalCents)}</span>
              </li>
            ))}
            {doc.replacedBy ? (
              <li>
                <a href={docHref(doc.replacedBy)} className="underline">
                  {tr("finance.portal.detail.replaced_by", { number: doc.replacedBy.number })}
                </a>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {doc.requestWindowUntil ? (
        <section aria-labelledby="company-request" className="grid gap-3 rounded-md border p-4">
          <h2 id="company-request" className="text-lg font-semibold">
            {tr("finance.portal.request.title")}
          </h2>
          {doc.pendingRequest ? (
            <div className="grid gap-2 text-sm">
              <p>{tr("finance.portal.request.pending", { name: doc.pendingRequest.legalName })}</p>
              <CancelRequestButton requestId={doc.pendingRequest.id} labels={requestLabels(tr)} />
            </div>
          ) : doc.canRequestCompanyInvoice ? (
            <>
              <p className="text-sm">{tr("finance.portal.request.intro", { date: formatDate(doc.requestWindowUntil, locale, "long") })}</p>
              <CompanyRequestForm invoiceId={doc.id} labels={requestLabels(tr)} />
            </>
          ) : doc.status !== "cancelled" ? (
            <p className="text-sm">{tr("finance.portal.request.closed")}</p>
          ) : null}
          {doc.requests.filter((r) => r.status !== "requested").length ? (
            <div className="grid gap-1 text-sm">
              <h3 className="font-semibold">{tr("finance.portal.request.history")}</h3>
              <ul className="grid gap-1">
                {doc.requests
                  .filter((r) => r.status !== "requested")
                  .map((r) => (
                    <li key={r.id}>
                      {r.legalName} · {tr("finance.portal.request.requested_on", { date: formatDateTime(r.createdAt, locale) })} · {tr(`finance.portal.request.state.${r.status}`)}
                      {r.status === "rejected" && r.decisionNote ? <span> · {tr("finance.portal.request.note", { note: r.decisionNote })}</span> : null}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </article>
  );
}
