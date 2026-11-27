import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn } from "@beam/ui";
import { isAnonymisedSnapshot, isReducedSnapshot } from "@beam/core/finance";
import { formatDate, formatDateTime, formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getInvoice, type DocumentRef } from "@/modules/finance/queries";
import { brusselsDay, isBelgianVatBuyer } from "@/modules/finance/service/billit-sync";
import { FinanceActionButton } from "@/modules/finance/ui/action-button";
import { InvoiceActions } from "@/modules/finance/ui/invoice-actions";
import { financeLabels } from "@/modules/finance/ui/labels";
import { fillLabel } from "@/modules/finance/ui/text";
import { PageHeader, StatusPill, Surface, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { BackLink, KpiStrip } from "@/modules/platform/ui/admin-list-kit";

/** A titled block of label/value rows. */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Surface className="grid content-start gap-3 p-4">
      <h2 className="text-[0.8125rem] font-semibold">{title}</h2>
      <dl className="grid gap-1.5 text-[0.8125rem]">{children}</dl>
    </Surface>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const STATE_TONE: Record<string, Tone> = { paid: "ok", open: "warn", cancelled: "muted", issued: "muted", synced: "muted", sent: "muted", rendered: "muted", pending: "muted", not_applicable: "muted", failed: "bad", requested: "warn", approved: "ok", rejected: "muted" };

/** `/admin/finance/invoices/[id]` (`invoices.read`; actions need `invoices.issue`), finance spec section 5. */
export default async function FinanceInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const { id } = await params;
  const detail = await getInvoice(await getAppDb(), id);
  if (!detail) notFound();
  const canIssue = hasPermission(actor, "invoices.issue");
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = financeLabels(locale);
  const l = (key: string, p?: Record<string, string | number>) => fillLabel(labels[key] ?? key, p);
  const money = (c: number) => formatMoney(c, locale);
  const pill = (group: string, value: string) => <StatusPill tone={STATE_TONE[value] ?? "muted"}>{labels[`${group}.${value}`] ?? value}</StatusPill>;
  const { invoice: doc } = detail;
  const isInvoice = doc.kind === "invoice";
  const isOpen = isInvoice && doc.status === "open";
  const today = brusselsDay(new Date());
  const overdue = isOpen && !!doc.dueOn && doc.dueOn < today;
  const buyer = doc.customerSnapshot;
  const seller = doc.sellerSnapshot;
  const pdfReady = doc.pdfStatus === "rendered" && !!doc.pdfFileId;
  const docLink = (ref: DocumentRef) => (
    <Link href={`/admin/finance/invoices/${ref.id}`} className="font-medium underline-offset-4 hover:underline">
      {ref.number}
    </Link>
  );
  const status: { tone: Tone; label: string } = !isInvoice
    ? { tone: "info", label: l("kind.credit_note") }
    : overdue
      ? { tone: "bad", label: l("overview.overdue") }
      : { tone: STATE_TONE[doc.status] ?? "muted", label: l(`status.${doc.status}`) };
  const customer = isAnonymisedSnapshot(buyer) ? l("detail.anonymised") : buyer.name;

  return (
    <div className="grid gap-4">
      <BackLink href="/admin/finance/invoices">{tr("finance.nav.invoices")}</BackLink>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            {doc.number}
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
            {doc.isCompany ? <StatusPill tone="muted">{l("common.b2b")}</StatusPill> : null}
            {doc.billitStatus === "failed" ? <StatusPill tone="bad">{`${l("detail.billit")}: ${l("billit_status.failed")}`}</StatusPill> : null}
          </span>
        }
        description={`${l(`kind.${doc.kind}`)} · ${customer} · ${formatDate(doc.issuedOn, locale)}${doc.dueOn && isInvoice ? ` · ${l("invoices.due", { date: formatDate(doc.dueOn, locale) })}` : ""}`}
        actions={
          pdfReady ? (
            <a href={`/admin/finance/invoices/${doc.id}/pdf`} target="_blank" rel="noopener" className="inline-flex h-9 items-center rounded-lg border border-border bg-card px-3 text-[0.8125rem] font-semibold hover:bg-muted">
              {l("detail.open_pdf")}
            </a>
          ) : null
        }
      />

      {canIssue ? (
        <section aria-label={l("detail.actions")} className="flex flex-wrap items-start gap-2">
          <InvoiceActions
            invoiceId={doc.id}
            number={doc.number}
            isOpen={isOpen}
            isInvoice={isInvoice}
            isLive={isInvoice && doc.status !== "cancelled" && detail.creditNotes.length === 0}
            today={today}
            issuedOn={doc.issuedOn}
            lines={doc.lines.filter((x) => x.quantity > 0).map((x) => ({ orderLineId: x.order_line_id, description: x.description, quantity: x.quantity }))}
            labels={labels}
          />
          {overdue ? <FinanceActionButton kind="reminder" invoiceId={doc.id} label={l("reminder.open")} confirmText={l("reminder.confirm", { number: doc.number })} labels={labels} /> : null}
          {doc.billitStatus !== "synced" || doc.billitPaymentStatus === "failed" ? <FinanceActionButton kind="retry" invoiceId={doc.id} label={l("retry.open")} labels={labels} /> : null}
          {doc.pdfStatus === "failed" ? <FinanceActionButton kind="rerender" invoiceId={doc.id} label={l("rerender.open")} labels={labels} /> : null}
        </section>
      ) : null}

      <KpiStrip
        items={[
          { key: "total", label: l("detail.total"), value: money(doc.totalCents) },
          { key: "net", label: l("detail.subtotal"), value: money(doc.subtotalCents) },
          { key: "vat", label: l("detail.vat_total"), value: money(doc.vatCents) },
          ...(detail.balance
            ? [
                { key: "credited", label: l("detail.credited"), value: money(detail.balance.creditedCents) },
                { key: "remaining", label: l("detail.remaining"), value: money(detail.balance.remainingCents), ...(detail.balance.remainingCents > 0 && isOpen ? { tone: overdue ? ("bad" as const) : ("warn" as const) } : {}) },
              ]
            : []),
        ]}
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid gap-4">
          <Surface flush>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-[0.8125rem]">
                <caption className="sr-only">{l("detail.lines_caption")}</caption>
                <thead className="bg-[#faf9f6]">
                  <tr className="border-b border-border">
                    <th scope="col" className={th}>{l("detail.col_description")}</th>
                    <th scope="col" className={cn(th, "w-16 text-right")}>{l("detail.col_quantity")}</th>
                    <th scope="col" className={cn(th, "w-28 text-right")}>{l("detail.col_unit")}</th>
                    <th scope="col" className={cn(th, "w-16 text-right")}>{l("detail.col_vat_rate")}</th>
                    <th scope="col" className={cn(th, "w-28 text-right")}>{l("detail.col_net")}</th>
                    <th scope="col" className={cn(th, "w-28 text-right")}>{l("detail.col_vat")}</th>
                    <th scope="col" className={cn(th, "w-28 text-right")}>{l("detail.col_total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.lines.map((line, i) => (
                    <tr key={`${line.order_line_id}-${i}`} className="border-b border-border">
                      <td className={td}>
                        <span className="font-medium">{line.description}</span>
                        {line.vat_note ? <span className="block text-[0.75rem] text-muted-foreground">{line.vat_note}</span> : null}
                      </td>
                      <td className={cn(td, "text-right tabular-nums")}>{line.quantity}</td>
                      <td className={cn(td, "text-right tabular-nums")}>{money(line.unit_amount_cents)}</td>
                      <td className={cn(td, "text-right tabular-nums")}>{line.vat_rate_pct} %</td>
                      <td className={cn(td, "text-right tabular-nums")}>{money(line.net_cents)}</td>
                      <td className={cn(td, "text-right tabular-nums")}>{money(line.vat_cents)}</td>
                      <td className={cn(td, "text-right font-semibold tabular-nums")}>{money(line.line_total_cents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tbody className="bg-[#fcfbf9]">
                  {doc.vatBreakdown.map((b) => (
                    <tr key={b.vat_rate_pct} className="border-b border-border text-muted-foreground last:border-b-0">
                      <th scope="row" colSpan={3} className={cn(td, "text-left font-normal")}>
                        {l("detail.breakdown")}
                      </th>
                      <td className={cn(td, "text-right tabular-nums")}>{b.vat_rate_pct} %</td>
                      <td className={cn(td, "text-right tabular-nums")}>{money(b.net_cents)}</td>
                      <td className={cn(td, "text-right tabular-nums")}>{money(b.vat_cents)}</td>
                      <td className={cn(td, "text-right tabular-nums")}>{money(b.gross_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Surface>

          <div className="grid gap-4 md:grid-cols-2">
            <Block title={l("detail.payments")}>
              {detail.payments.length === 0 ? <p className="text-muted-foreground">{l("common.none")}</p> : null}
              {detail.payments.map((p) => (
                <Row key={p.id} label={`${p.provider}${p.method ? ` · ${p.method}` : ""}`}>
                  <span className="font-semibold tabular-nums">{money(p.amountCents)}</span> · {p.status}
                  {p.providerPaymentId ? <span className="block text-[0.75rem] text-muted-foreground">{p.providerPaymentId}</span> : null}
                </Row>
              ))}
              {detail.refunds.map((r) => (
                <Row key={r.id} label={l("detail.refunds")}>
                  <span className="tabular-nums">{money(r.amountCents)}</span> · {r.status} · {formatDate(r.createdAt, locale)}
                </Row>
              ))}
              <p className="text-[0.75rem] text-muted-foreground">{l("detail.refund_link")}</p>
            </Block>
            <Block title={l("detail.credit_notes")}>
              {detail.creditNotes.length === 0 ? <p className="text-muted-foreground">{l("common.none")}</p> : null}
              {detail.creditNotes.map((n) => (
                <Row key={n.id} label={formatDate(n.issuedOn, locale)}>
                  {docLink(n)} · <span className="tabular-nums">{money(n.totalCents)}</span> {pill("status", n.status)}
                </Row>
              ))}
              {detail.requests.length ? <h3 className="mt-1 text-[0.75rem] font-semibold">{l("detail.requests")}</h3> : null}
              {detail.requests.map((r) => (
                <Row key={r.id} label={formatDate(r.createdAt, locale)}>
                  {r.legalName} {pill("request_status", r.status)}
                  {r.decisionNote ? <span className="block text-[0.75rem] text-muted-foreground">{r.decisionNote}</span> : null}
                </Row>
              ))}
            </Block>
          </div>

          <Surface className="p-4">
            <details>
              <summary className="cursor-pointer text-[0.8125rem] font-semibold">{l("detail.pdf")}</summary>
              <div className="mt-3">
                {pdfReady ? (
                  <iframe src={`/admin/finance/invoices/${doc.id}/pdf`} title={l("detail.pdf_preview", { number: doc.number })} className="h-[36rem] w-full rounded-lg border border-border" />
                ) : (
                  <p className="text-[0.8125rem]">{doc.pdfStatus === "failed" ? l("detail.pdf_failed") : l("detail.pdf_pending")}</p>
                )}
              </div>
            </details>
          </Surface>

          <Surface className="p-4">
            <details>
              <summary className="cursor-pointer text-[0.8125rem] font-semibold">
                {l("detail.jobs")} <span className="font-normal text-muted-foreground">{detail.jobs.length}</span>
              </summary>
              <table className="mt-3 w-full text-[0.8125rem]">
                <caption className="sr-only">{l("detail.jobs_caption")}</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className={cn(th, "pl-0 first:pl-0")}>{l("detail.col_job")}</th>
                    <th scope="col" className={th}>{l("detail.col_status")}</th>
                    <th scope="col" className={cn(th, "text-right")}>{l("detail.col_attempts")}</th>
                    <th scope="col" className={th}>{l("detail.col_created")}</th>
                    <th scope="col" className={cn(th, "pr-0 last:pr-0")}>{l("detail.last_error")}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.jobs.map((j) => (
                    <tr key={j.id} className="border-b border-border last:border-b-0">
                      <td className={cn(td, "pl-0 first:pl-0")}>{j.kind}</td>
                      <td className={td}>{j.status}</td>
                      <td className={cn(td, "text-right tabular-nums")}>{j.attempts}</td>
                      <td className={cn(td, "whitespace-nowrap")}>{formatDateTime(j.createdAt, locale)}</td>
                      <td className={cn(td, "max-w-md truncate pr-0 last:pr-0")}>{j.lastError ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </Surface>
        </div>

        <div className="grid gap-4">
          <Block title={l("detail.info")}>
            <Row label={l("detail.issued_on")}>{formatDate(doc.issuedOn, locale)}</Row>
            {doc.dueOn ? <Row label={l("detail.due_on")}>{formatDate(doc.dueOn, locale)}</Row> : null}
            {doc.paidAt ? <Row label={l("detail.paid_at")}>{formatDateTime(doc.paidAt, locale)}</Row> : null}
            {doc.paymentReference ? <Row label={l("detail.structured_communication")}>{doc.paymentReference}</Row> : null}
            {doc.reason ? <Row label={l("detail.reason")}>{doc.reason}</Row> : null}
            {detail.original ? <Row label={l("detail.credit_note_for")}>{docLink(detail.original)}</Row> : null}
            {detail.replaces ? <Row label={l("detail.replaces")}>{docLink(detail.replaces)}</Row> : null}
            {detail.replacedBy ? <Row label={l("detail.replaced_by")}>{docLink(detail.replacedBy)}</Row> : null}
            {detail.order ? (
              <Row label={l("detail.order")}>
                <Link href={`/admin/orders/${detail.order.id}`} className="font-medium underline-offset-4 hover:underline">
                  {l("detail.open_order")}
                </Link>{" "}
                <span className="text-muted-foreground">
                  ({detail.order.status}, {money(detail.order.totalCents)})
                </span>
              </Row>
            ) : null}
            {doc.emailedAt ? <Row label={l("detail.emailed_at")}>{formatDateTime(doc.emailedAt, locale)}</Row> : null}
            {detail.lastReminderAt ? <Row label={l("detail.last_reminder")}>{formatDateTime(detail.lastReminderAt, locale)}</Row> : null}
          </Block>
          <Block title={l("detail.buyer")}>
            {isAnonymisedSnapshot(buyer) ? (
              <p>{l("detail.anonymised")}</p>
            ) : (
              <>
                <Row label={l("detail.buyer")}>{buyer.name}</Row>
                {buyer.address ? (
                  <Row label={l("reissue.line1")}>{[buyer.address.line1, buyer.address.line2, `${buyer.address.postal_code} ${buyer.address.city}`, buyer.address.country].filter(Boolean).join(", ")}</Row>
                ) : null}
                {buyer.vat_number ? <Row label={l("detail.vat_number")}>{buyer.vat_number}</Row> : null}
                {buyer.purchase_order_ref ? <Row label={l("detail.po_reference")}>{buyer.purchase_order_ref}</Row> : null}
                {isReducedSnapshot(buyer) ? <p className="text-muted-foreground">{l("detail.reduced")}</p> : null}
              </>
            )}
          </Block>
          <Block title={l("detail.billit")}>
            <Row label={l("detail.billit")}>{pill("billit_status", doc.billitStatus)}</Row>
            {doc.billitId ? <Row label={l("detail.billit_id")}>{doc.billitId}</Row> : null}
            <Row label={l("detail.attempts")}>{doc.billitAttempts}</Row>
            {doc.billitLastError ? <Row label={l("detail.last_error")}>{doc.billitLastError}</Row> : null}
            <Row label={l("detail.payment_registration")}>{pill("payment_status", doc.billitPaymentStatus)}</Row>
            <Row label={l("detail.peppol")}>{pill("peppol_status", doc.peppolStatus)}</Row>
            {doc.peppolStatus === "failed" ? <p className="font-medium text-[var(--status-bad)]">{isBelgianVatBuyer(doc) ? l("detail.peppol_failed_be") : l("detail.peppol_failed_other")}</p> : null}
          </Block>
          <Block title={l("detail.seller")}>
            <Row label={l("settings.field.legal_name")}>{seller.legal_name || l("common.none")}</Row>
            <Row label={l("detail.vat_number")}>{seller.vat_number || l("common.none")}</Row>
            <Row label={l("reissue.line1")}>{[seller.address.line1, `${seller.address.postal_code} ${seller.address.city}`, seller.address.country].filter((s) => s.trim()).join(", ") || l("common.none")}</Row>
            <Row label={l("settings.field.iban")}>{seller.iban || l("common.none")}</Row>
          </Block>
        </div>
      </div>
    </div>
  );
}
