import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { isAnonymisedSnapshot, isReducedSnapshot } from "@beam/core/finance";
import { formatDate, formatDateTime, formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getInvoice, type DocumentRef } from "@/modules/finance/queries";
import { brusselsDay, isBelgianVatBuyer } from "@/modules/finance/service/billit-sync";
import { FinanceActionButton } from "@/modules/finance/ui/action-button";
import { FinanceBadge } from "@/modules/finance/ui/badges";
import { InvoiceActions } from "@/modules/finance/ui/invoice-actions";
import { financeLabels } from "@/modules/finance/ui/labels";
import { fillLabel } from "@/modules/finance/ui/text";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">{children}</CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** `/admin/finance/invoices/[id]` (`invoices.read`; actions need `invoices.issue`), finance spec section 5. */
export default async function FinanceInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "invoices.read")) notFound();
  const { id } = await params;
  const detail = await getInvoice(await getAppDb(), id);
  if (!detail) notFound();
  const canIssue = hasPermission(actor, "invoices.issue");
  const locale = await adminLocale();
  const labels = financeLabels(locale);
  const l = (key: string, p?: Record<string, string | number>) => fillLabel(labels[key] ?? key, p);
  const money = (c: number) => formatMoney(c, locale);
  const { invoice: doc } = detail;
  const isInvoice = doc.kind === "invoice";
  const isOpen = isInvoice && doc.status === "open";
  const today = brusselsDay(new Date());
  const buyer = doc.customerSnapshot;
  const seller = doc.sellerSnapshot;
  const pdfReady = doc.pdfStatus === "rendered" && !!doc.pdfFileId;
  const docLink = (ref: DocumentRef) => (
    <Link href={`/admin/finance/invoices/${ref.id}`} className="font-mono underline-offset-4 hover:underline">
      {ref.number}
    </Link>
  );

  return (
    <div className="grid gap-6">
      <Link href="/admin/finance/invoices" className="text-sm underline-offset-4 hover:underline">
        {l("detail.back")}
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl font-semibold">{doc.number}</h1>
        <Badge variant="outline">{l(`kind.${doc.kind}`)}</Badge>
        <FinanceBadge group="status" value={doc.status} labels={labels} />
        {doc.isCompany ? <Badge variant="secondary">{l("common.b2b")}</Badge> : null}
      </header>

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
          {isOpen && doc.dueOn && doc.dueOn < today ? (
            <FinanceActionButton kind="reminder" invoiceId={doc.id} label={l("reminder.open")} confirmText={l("reminder.confirm", { number: doc.number })} labels={labels} />
          ) : null}
          {doc.billitStatus !== "synced" || doc.billitPaymentStatus === "failed" ? <FinanceActionButton kind="retry" invoiceId={doc.id} label={l("retry.open")} labels={labels} /> : null}
          {doc.pdfStatus === "failed" ? <FinanceActionButton kind="rerender" invoiceId={doc.id} label={l("rerender.open")} labels={labels} /> : null}
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={l("detail.order")}>
          <dl className="grid gap-2">
            <Row label={l("detail.issued_on")}>{formatDate(doc.issuedOn, locale)}</Row>
            {doc.dueOn ? <Row label={l("detail.due_on")}>{formatDate(doc.dueOn, locale)}</Row> : null}
            {doc.paidAt ? <Row label={l("detail.paid_at")}>{formatDateTime(doc.paidAt, locale)}</Row> : null}
            {doc.paymentReference ? <Row label={l("detail.structured_communication")}>{<span className="font-mono">{doc.paymentReference}</span>}</Row> : null}
            {doc.reason ? <Row label={l("detail.reason")}>{doc.reason}</Row> : null}
            {detail.original ? <Row label={l("detail.credit_note_for")}>{docLink(detail.original)}</Row> : null}
            {detail.replaces ? <Row label={l("detail.replaces")}>{docLink(detail.replaces)}</Row> : null}
            {detail.replacedBy ? <Row label={l("detail.replaced_by")}>{docLink(detail.replacedBy)}</Row> : null}
            {detail.order ? (
              <Row label={l("detail.order")}>
                <span className="font-mono text-xs">{detail.order.id}</span> ({detail.order.status}, {money(detail.order.totalCents)})
              </Row>
            ) : null}
            {doc.emailedAt ? <Row label={l("detail.emailed_at")}>{formatDateTime(doc.emailedAt, locale)}</Row> : null}
            {detail.lastReminderAt ? <Row label={l("detail.last_reminder")}>{formatDateTime(detail.lastReminderAt, locale)}</Row> : null}
          </dl>
        </Section>
        <Section title={l("detail.buyer")}>
          {isAnonymisedSnapshot(buyer) ? (
            <p>{l("detail.anonymised")}</p>
          ) : (
            <dl className="grid gap-2">
              <Row label={l("detail.buyer")}>{buyer.name}</Row>
              {buyer.address ? (
                <Row label={l("reissue.line1")}>
                  {[buyer.address.line1, buyer.address.line2, `${buyer.address.postal_code} ${buyer.address.city}`, buyer.address.country].filter(Boolean).join(", ")}
                </Row>
              ) : null}
              {buyer.vat_number ? <Row label={l("detail.vat_number")}>{buyer.vat_number}</Row> : null}
              {buyer.purchase_order_ref ? <Row label={l("detail.po_reference")}>{buyer.purchase_order_ref}</Row> : null}
              {isReducedSnapshot(buyer) ? <p className="text-muted-foreground">{l("detail.reduced")}</p> : null}
            </dl>
          )}
        </Section>
        <Section title={l("detail.seller")}>
          <dl className="grid gap-2">
            <Row label={l("settings.field.legal_name")}>{seller.legal_name || l("common.none")}</Row>
            <Row label={l("detail.vat_number")}>{seller.vat_number || l("common.none")}</Row>
            <Row label={l("reissue.line1")}>{[seller.address.line1, `${seller.address.postal_code} ${seller.address.city}`, seller.address.country].filter((s) => s.trim()).join(", ") || l("common.none")}</Row>
            <Row label={l("settings.field.iban")}>{seller.iban || l("common.none")}</Row>
          </dl>
        </Section>
        <Section title={l("detail.billit")}>
          <dl className="grid gap-2">
            <Row label={l("detail.billit")}>
              <FinanceBadge group="billit_status" value={doc.billitStatus} labels={labels} />
            </Row>
            {doc.billitId ? <Row label={l("detail.billit_id")}>{<span className="font-mono">{doc.billitId}</span>}</Row> : null}
            <Row label={l("detail.attempts")}>{doc.billitAttempts}</Row>
            {doc.billitLastError ? <Row label={l("detail.last_error")}>{doc.billitLastError}</Row> : null}
            <Row label={l("detail.payment_registration")}>
              <FinanceBadge group="payment_status" value={doc.billitPaymentStatus} labels={labels} />
            </Row>
            <Row label={l("detail.peppol")}>
              <FinanceBadge group="peppol_status" value={doc.peppolStatus} labels={labels} />
            </Row>
            {doc.peppolStatus === "failed" ? <p className="font-medium text-destructive">{isBelgianVatBuyer(doc) ? l("detail.peppol_failed_be") : l("detail.peppol_failed_other")}</p> : null}
          </dl>
        </Section>
      </div>

      <Table>
        <TableCaption>{l("detail.lines_caption")}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{l("detail.col_description")}</TableHead>
            <TableHead className="text-right">{l("detail.col_quantity")}</TableHead>
            <TableHead className="text-right">{l("detail.col_unit")}</TableHead>
            <TableHead className="text-right">{l("detail.col_vat_rate")}</TableHead>
            <TableHead className="text-right">{l("detail.col_net")}</TableHead>
            <TableHead className="text-right">{l("detail.col_vat")}</TableHead>
            <TableHead className="text-right">{l("detail.col_total")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {doc.lines.map((line, i) => (
            <TableRow key={`${line.order_line_id}-${i}`}>
              <TableCell>
                {line.description}
                {line.vat_note ? <span className="block text-xs text-muted-foreground">{line.vat_note}</span> : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">{line.quantity}</TableCell>
              <TableCell className="text-right tabular-nums">{money(line.unit_amount_cents)}</TableCell>
              <TableCell className="text-right tabular-nums">{line.vat_rate_pct} %</TableCell>
              <TableCell className="text-right tabular-nums">{money(line.net_cents)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(line.vat_cents)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(line.line_total_cents)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="grid gap-4 lg:grid-cols-2">
        <Table>
          <TableCaption>{l("detail.breakdown_caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{l("detail.col_vat_rate")}</TableHead>
              <TableHead className="text-right">{l("detail.col_net")}</TableHead>
              <TableHead className="text-right">{l("detail.col_vat")}</TableHead>
              <TableHead className="text-right">{l("detail.col_total")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {doc.vatBreakdown.map((b) => (
              <TableRow key={b.vat_rate_pct}>
                <TableCell>{b.vat_rate_pct} %</TableCell>
                <TableCell className="text-right tabular-nums">{money(b.net_cents)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(b.vat_cents)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(b.gross_cents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Section title={l("detail.balance")}>
          <dl className="grid gap-2">
            <Row label={l("detail.subtotal")}>{money(doc.subtotalCents)}</Row>
            <Row label={l("detail.vat_total")}>{money(doc.vatCents)}</Row>
            <Row label={l("detail.total")}>{<strong>{money(doc.totalCents)}</strong>}</Row>
            {detail.balance ? <Row label={l("detail.credited")}>{money(detail.balance.creditedCents)}</Row> : null}
            {detail.balance ? <Row label={l("detail.remaining")}>{money(detail.balance.remainingCents)}</Row> : null}
          </dl>
        </Section>
      </div>

      <Section title={l("detail.pdf")}>
        {pdfReady ? (
          <>
            <a href={`/admin/finance/invoices/${doc.id}/pdf`} target="_blank" rel="noopener" className="underline-offset-4 hover:underline">
              {l("detail.open_pdf")}
            </a>
            <iframe src={`/admin/finance/invoices/${doc.id}/pdf`} title={l("detail.pdf_preview", { number: doc.number })} className="h-[36rem] w-full rounded-md border" />
          </>
        ) : (
          <p>{doc.pdfStatus === "failed" ? l("detail.pdf_failed") : l("detail.pdf_pending")}</p>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={l("detail.payments")}>
          {detail.payments.length === 0 ? (
            <p>{l("common.none")}</p>
          ) : (
            <ul className="grid gap-1">
              {detail.payments.map((p) => (
                <li key={p.id}>
                  {p.provider} {p.method ?? ""} · {money(p.amountCents)} · {p.status}
                  {p.providerPaymentId ? <span className="font-mono text-xs"> {p.providerPaymentId}</span> : null}
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground">{l("detail.refund_link")}</p>
          {detail.refunds.length ? (
            <ul className="grid gap-1">
              {detail.refunds.map((r) => (
                <li key={r.id}>
                  {l("detail.refunds")}: {money(r.amountCents)} · {r.status} · {formatDate(r.createdAt, locale)}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
        <Section title={l("detail.credit_notes")}>
          {detail.creditNotes.length === 0 ? (
            <p>{l("common.none")}</p>
          ) : (
            <ul className="grid gap-1">
              {detail.creditNotes.map((n) => (
                <li key={n.id}>
                  {docLink(n)} · {formatDate(n.issuedOn, locale)} · {money(n.totalCents)} · <FinanceBadge group="status" value={n.status} labels={labels} />
                </li>
              ))}
            </ul>
          )}
          {detail.requests.length ? (
            <>
              <h3 className="mt-2 font-medium">{l("detail.requests")}</h3>
              <ul className="grid gap-1">
                {detail.requests.map((r) => (
                  <li key={r.id}>
                    {r.legalName} · <FinanceBadge group="request_status" value={r.status} labels={labels} /> · {formatDate(r.createdAt, locale)}
                    {r.decisionNote ? <span className="block text-muted-foreground">{r.decisionNote}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Section>
      </div>

      <Table>
        <TableCaption>{l("detail.jobs_caption")}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{l("detail.col_job")}</TableHead>
            <TableHead>{l("detail.col_status")}</TableHead>
            <TableHead className="text-right">{l("detail.col_attempts")}</TableHead>
            <TableHead>{l("detail.col_created")}</TableHead>
            <TableHead>{l("detail.last_error")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.jobs.map((j) => (
            <TableRow key={j.id}>
              <TableCell className="font-mono text-xs">{j.kind}</TableCell>
              <TableCell>{j.status}</TableCell>
              <TableCell className="text-right tabular-nums">{j.attempts}</TableCell>
              <TableCell>{formatDateTime(j.createdAt, locale)}</TableCell>
              <TableCell className="max-w-md truncate">{j.lastError ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
