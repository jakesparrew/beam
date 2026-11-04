import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, buttonVariants, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { PricingTrace } from "@beam/core/commerce";
import { formatDateTime, formatMoney, pick, t, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { choosePaymentPath, cancelOrder, confirmManualRefund, emailReceipt, resendVoucher, retryRefund, sendPaymentLink, voidVoucher } from "@/modules/commerce/actions";
import { getOrder } from "@/modules/commerce/queries";

type Result = { ok: true } | { ok: false; error: { message: string } };

/** Back to this page with `?done=1` or `?error=<code>` (the inline actions below). */
function back(id: string, r: Result): never {
  redirect(`/admin/orders/${id}?${r.ok ? "done=1" : `error=${encodeURIComponent(r.error.message)}`}` as never);
}

function text(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * `/admin/orders/[id]` (commerce spec 5.1): lines with the price used (`pricing_trace`), payments
 * with their status history, refunds, vouchers, the invoice link (finance) and the order's
 * timeline events. Actions (server actions, no client script): choose the payment path (drafts),
 * send a payment link, cancel (draft or pending), refund (`commerce.refund`), retry a failed
 * refund, confirm a manual refund, email the receipt, resend or void a voucher.
 */
export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const actor = await requireStaff();
  if (!["commerce.sell", "commerce.refund", "invoices.read"].some((p) => hasPermission(actor, p as "commerce.sell"))) notFound();
  const { id } = await params;
  const sp = await searchParams;
  const detail = await getOrder(await getAppDb(), id);
  if (!detail) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_orders.${k}`, p);
  const money = (v: number) => formatMoney(v, locale);
  const errorText = (code: string) => (t.has(locale, `commerce.errors.${code}`) ? tr(`commerce.errors.${code}`) : tr("commerce.common.error"));
  const { order } = detail;
  const canSell = hasPermission(actor, "commerce.sell");
  const canRefund = hasPermission(actor, "commerce.refund");
  const isOpen = order.status === "draft" || order.status === "pending_payment";
  const isPaid = order.status === "paid" || order.status === "partially_refunded";
  const line = (d: unknown, fallback: string) => pick(d as LocalizedText, locale, "order_lines.description") || fallback;

  async function onPath(form: FormData) {
    "use server";
    back(id, await choosePaymentPath({ orderId: id, path: text(form, "path") }));
  }
  async function onLink(form: FormData) {
    "use server";
    back(id, await sendPaymentLink({ orderId: id, email: text(form, "email") }));
  }
  async function onCancel(form: FormData) {
    "use server";
    back(id, await cancelOrder({ orderId: id, reason: text(form, "reason") ?? "" }));
  }
  async function onReceipt(form: FormData) {
    "use server";
    back(id, await emailReceipt({ orderId: id, email: text(form, "email") }));
  }
  async function onRetry(form: FormData) {
    "use server";
    back(id, await retryRefund({ refundId: text(form, "refundId") }));
  }
  async function onConfirm(form: FormData) {
    "use server";
    back(id, await confirmManualRefund({ refundId: text(form, "refundId") }));
  }
  async function onResend(form: FormData) {
    "use server";
    back(id, await resendVoucher({ voucherId: text(form, "voucherId"), email: text(form, "email") }));
  }
  async function onVoid(form: FormData) {
    "use server";
    back(id, await voidVoucher({ voucherId: text(form, "voucherId"), reason: text(form, "reason") ?? "" }));
  }

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <Link href="/admin/orders" className="text-sm underline">
          {c("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{c("detail_title", { reference: order.reference })}</h1>
          <Badge>{tr(`commerce.order_status.${order.status}`)}</Badge>
          <Badge variant="outline">{tr(`commerce.channel.${order.channel}`)}</Badge>
        </div>
        <p className="text-sm">
          {detail.companyName ?? detail.person?.name ?? c("walk_in")}
          {detail.person?.email ? ` · ${detail.person.email}` : ""}
        </p>
      </header>
      <div role="status" aria-live="polite">
        {sp.done ? <p className="rounded-md border border-success p-3 text-sm">{c("done")}</p> : null}
        {sp.error ? <p className="rounded-md border border-destructive p-3 text-sm">{c("failed", { message: errorText(sp.error) })}</p> : null}
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">{c("created")}</dt>
          <dd>{formatDateTime(order.createdAt, locale, "short")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{c("col_total")}</dt>
          <dd className="tabular-nums">{money(order.totalCents)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{c("col_paid")}</dt>
          <dd className="tabular-nums">{money(detail.paidCents)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{order.paidAt ? c("paid_at") : c("due")}</dt>
          <dd className="tabular-nums">{order.paidAt ? formatDateTime(order.paidAt, locale, "short") : money(detail.dueCents)}</dd>
        </div>
        {order.expiresAt && isOpen ? (
          <div>
            <dt className="text-muted-foreground">{c("expires_at")}</dt>
            <dd>{formatDateTime(order.expiresAt, locale, "short")}</dd>
          </div>
        ) : null}
        {order.note ? (
          <div className="col-span-2">
            <dt className="text-muted-foreground">{c("note")}</dt>
            <dd>{order.note}</dd>
          </div>
        ) : null}
      </dl>

      <section aria-labelledby="lines-title" className="grid gap-2">
        <h2 id="lines-title" className="text-lg font-semibold">{c("lines")}</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{c("col_description")}</TableHead>
              <TableHead className="text-right">{c("col_quantity")}</TableHead>
              <TableHead className="text-right">{c("col_unit")}</TableHead>
              <TableHead className="text-right">{c("col_discount")}</TableHead>
              <TableHead className="text-right">{c("col_line_total")}</TableHead>
              <TableHead>{c("col_price")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.lines.map((l) => {
              const winner = (l.pricingTrace as Partial<PricingTrace> | null)?.winner;
              return (
                <TableRow key={l.id}>
                  <TableCell>{line(l.description, l.sku)}</TableCell>
                  <TableCell className="text-right">{l.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.unitAmountCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.discountCents ? money(l.discountCents) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.lineTotalCents)}</TableCell>
                  <TableCell>{winner ? c(`winner_${winner}`) : "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section aria-labelledby="payments-title" className="grid gap-2">
        <h2 id="payments-title" className="text-lg font-semibold">{c("payments")}</h2>
        {detail.payments.length === 0 ? (
          <p className="text-sm">{c("no_payments")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c("col_provider")}</TableHead>
                <TableHead>{c("col_method")}</TableHead>
                <TableHead>{c("col_status")}</TableHead>
                <TableHead className="text-right">{c("col_amount")}</TableHead>
                <TableHead>{c("col_history")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{tr(`commerce.provider.${p.provider}`)}</TableCell>
                  <TableCell>{p.method ?? "—"}</TableCell>
                  <TableCell>{tr(`commerce.payment_status.${p.status}`)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(p.amountCents)}</TableCell>
                  <TableCell className="text-xs">
                    {(p.statusHistory ?? []).map((h) => `${tr(`commerce.payment_status.${h.status}`)} ${formatDateTime(new Date(h.at), locale, "short")}`).join(" → ") || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section aria-labelledby="refunds-title" className="grid gap-2">
        <h2 id="refunds-title" className="text-lg font-semibold">{c("refunds")}</h2>
        {detail.refunds.length === 0 ? (
          <p className="text-sm">{c("no_refunds")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c("col_date")}</TableHead>
                <TableHead>{c("col_reason")}</TableHead>
                <TableHead>{c("col_status")}</TableHead>
                <TableHead className="text-right">{c("col_amount")}</TableHead>
                <TableHead>{c("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.refunds.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatDateTime(r.createdAt, locale, "short")}</TableCell>
                  <TableCell>{r.reason}</TableCell>
                  <TableCell>{tr(`commerce.refund_status.${r.status}`)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.amountCents)}</TableCell>
                  <TableCell className="flex flex-wrap gap-2">
                    {r.creditNoteId ? (
                      <Link href={`/admin/finance/invoices/${r.creditNoteId}`} className="underline">
                        {c("invoices")}
                      </Link>
                    ) : null}
                    {canRefund && r.status === "failed" ? (
                      <form action={onRetry}>
                        <input type="hidden" name="refundId" value={r.id} />
                        <Button type="submit" size="sm" variant="outline">
                          {c("retry")}
                        </Button>
                      </form>
                    ) : null}
                    {canRefund && r.status === "sent" ? (
                      <form action={onConfirm}>
                        <input type="hidden" name="refundId" value={r.id} />
                        <Button type="submit" size="sm" variant="outline">
                          {c("confirm_refund")}
                        </Button>
                      </form>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {detail.vouchers.length ? (
        <section aria-labelledby="vouchers-title" className="grid gap-2">
          <h2 id="vouchers-title" className="text-lg font-semibold">{c("vouchers")}</h2>
          <ul className="grid gap-2">
            {detail.vouchers.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
                <span>{v.codeLast4 ? c("code_last4", { last4: v.codeLast4 }) : "—"}</span>
                <span className="tabular-nums">{money(v.amountCents)}</span>
                <span>{tr(`commerce.voucher_status.${v.status}`)}</span>
                <span>{v.recipientName ?? ""}</span>
                {canSell && v.status === "active" ? (
                  <form action={onResend} className="flex items-center gap-2">
                    <input type="hidden" name="voucherId" value={v.id} />
                    <Input name="email" type="email" aria-label={c("email_optional")} placeholder={c("email_optional")} className="h-8 w-56" />
                    <Button type="submit" size="sm" variant="outline">
                      {c("resend_voucher")}
                    </Button>
                  </form>
                ) : null}
                {canRefund && v.status === "active" ? (
                  <form action={onVoid} className="flex items-center gap-2">
                    <input type="hidden" name="voucherId" value={v.id} />
                    <Input name="reason" required minLength={3} aria-label={c("reason")} placeholder={c("reason")} className="h-8 w-40" />
                    <Button type="submit" size="sm" variant="destructive">
                      {c("void_voucher")}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="invoice-title" className="grid gap-2">
        <h2 id="invoice-title" className="text-lg font-semibold">{c("invoices")}</h2>
        {detail.invoice ? (
          <Link href={`/admin/finance/invoices/${detail.invoice.id}`} className="underline">
            {c("open_invoice", { number: detail.invoice.number })}
          </Link>
        ) : (
          <p className="text-sm">{c("no_invoice")}</p>
        )}
      </section>

      <section aria-labelledby="actions-title" className="grid gap-4">
        <h2 id="actions-title" className="text-lg font-semibold">{c("actions")}</h2>
        {canSell && order.status === "draft" ? (
          <form action={onPath} className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{c("choose_path")}</span>
            {(["pos", "link", "bank_transfer"] as const).map((path) => (
              <Button key={path} type="submit" name="path" value={path} variant="outline">
                {c(`path_${path}`)}
              </Button>
            ))}
          </form>
        ) : null}
        {canSell && order.status === "pending_payment" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/admin/pos?order=${order.id}` as never} className={buttonVariants({ variant: "outline" })}>
              {c("open_pos")}
            </Link>
            <form action={onLink} className="flex items-center gap-2">
              <Input name="email" type="email" aria-label={c("email_optional")} placeholder={c("email_optional")} className="w-64" />
              <Button type="submit">{c("send_link")}</Button>
            </form>
          </div>
        ) : null}
        {canSell && isOpen ? (
          <form action={onCancel} className="flex items-center gap-2">
            <Input name="reason" required minLength={3} aria-label={c("reason")} placeholder={c("reason")} className="w-64" />
            <Button type="submit" variant="destructive">
              {c("cancel")}
            </Button>
          </form>
        ) : null}
        {canRefund && isPaid ? (
          <Link href={`/admin/orders/${order.id}/refund`} className={buttonVariants({ variant: "outline" })}>
            {c("refund")}
          </Link>
        ) : null}
        {canSell && (isPaid || order.status === "refunded") ? (
          <form action={onReceipt} className="flex items-center gap-2">
            <Input name="email" type="email" aria-label={c("email_optional")} placeholder={c("email_optional")} className="w-64" />
            <Button type="submit" variant="outline">
              {c("email_receipt")}
            </Button>
          </form>
        ) : null}
      </section>

      {detail.events.length ? (
        <section aria-labelledby="events-title" className="grid gap-1 text-sm">
          <h2 id="events-title" className="text-lg font-semibold">{c("col_history")}</h2>
          <ul>
            {detail.events.map((e) => (
              <li key={e.id}>
                {formatDateTime(e.occurredAt, locale, "short")} · {e.kind}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
