import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Button, cn, DialogFooter, Input } from "@beam/ui";
import type { PricingTrace } from "@beam/core/commerce";
import { formatDate, formatDateTime, formatMoney, formatPercent, pick, t, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { choosePaymentPath, cancelOrder, confirmManualRefund, emailReceipt, issueOnAccountInvoice, refundOrder, resendVoucher, retryRefund, sendPaymentLink, voidVoucher } from "@/modules/commerce/actions";
import { EXTERNAL_CARD_METHOD, getOrder, getRefundPreview, quickRefundLines } from "@/modules/commerce/queries";
import { vatSummary } from "@/modules/commerce/ui/receipt-pdf";
import { BackLink, Initials, Notice } from "@/modules/platform/ui/admin-list-kit";
import { PrimaryAction, StatusPill, Surface, type Tone } from "@/modules/platform/ui/admin-kit";
import { OrderMenu, type OrderMenuItem } from "./order-menu";

type Result = { ok: true } | { ok: false; error: { message: string } };

/** Back to this page with `?done=1` or `?error=<code>` (the inline actions below). */
function back(id: string, r: Result): never {
  redirect(`/admin/orders/${id}?${r.ok ? "done=1" : `error=${encodeURIComponent(r.error.message)}`}` as never);
}

function text(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const ORDER_TONE: Record<string, Tone> = { draft: "muted", pending_payment: "warn", paid: "ok", partially_refunded: "info", refunded: "muted", cancelled: "bad", expired: "muted" };
const PAYMENT_TONE: Record<string, Tone> = { open: "warn", pending: "warn", authorized: "info", paid: "ok", failed: "bad", expired: "muted", cancelled: "muted", refunded: "muted", partially_refunded: "info" };
const REFUND_TONE: Record<string, Tone> = { pending: "warn", sent: "warn", refunded: "ok", failed: "bad" };
/** Payment methods as staff say them (the provider's method code → a catalogue key). */
const METHOD_KEY: Record<string, string> = {
  [EXTERNAL_CARD_METHOD]: "commerce.pos.method_card_terminal",
  pointofsale: "commerce.pos.method_card_terminal",
  cash: "commerce.pos.method_cash",
  banktransfer: "commerce.pos.method_bank_transfer",
  credit_balance: "commerce.provider.credit_balance",
  card: "commerce.admin_orders.method_card_online",
  creditcard: "commerce.admin_orders.method_card_online",
  directdebit: "commerce.admin_orders.method_direct_debit",
  sepa_debit: "commerce.admin_orders.method_direct_debit",
};
/** Brand names, the same in every language. */
const METHOD_BRAND: Record<string, string> = { bancontact: "Bancontact", ideal: "iDEAL", applepay: "Apple Pay", apple_pay: "Apple Pay", googlepay: "Google Pay", google_pay: "Google Pay", paypal: "PayPal", kbc: "KBC/CBC", belfius: "Belfius", payconiq: "Payconiq" };

/** A small heading inside the summary card. */
function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-3 border-t border-border px-5 py-4 first:border-t-0", className)}>
      <h2 className="text-[0.75rem] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
      {children}
    </div>
  );
}

/** A label and a right-aligned figure of the receipt totals. */
function TotalRow({ label, value, strong, muted }: { label: ReactNode; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4", strong && "text-[0.9375rem] font-semibold", muted && "text-muted-foreground")}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

const chip = "inline-flex w-fit items-center rounded-md border border-border bg-[#faf9f6] px-2 py-0.5 font-mono text-[0.75rem] font-medium text-[#8a5a14] hover:border-[#c9973a]";

/**
 * `/admin/orders/[id]` (commerce spec 5.1): a payment-detail page. The header holds the reference,
 * the status and channel, the customer, the one action the order's state asks for and a "⋯" menu
 * with the rest. Left, the receipt: lines with the price used (`pricing_trace`), totals with VAT
 * per rate. Right, a summary: the order's steps with dates, payments, the invoice (finance),
 * refunds and vouchers when there are any, and the timeline events. Actions (server actions):
 * choose the payment path (drafts), send a payment link, cancel (draft or pending), refund
 * (`commerce.refund`: a dialog with one euro amount spread over the lines, `quickRefundLines`, and
 * a link to the per-line refund screen), retry a failed refund, confirm a manual refund, email the
 * receipt, resend or void a voucher. An on-account order ("Op rekening") is settled here by a
 * payment link, an open invoice (`invoices.issue`) or at the till.
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
  const r = (k: string, p?: Record<string, string | number>) => tr(`commerce.admin_refund.${k}`, p);
  const money = (v: number) => formatMoney(v, locale);
  const when = (d: Date | string) => formatDateTime(d, locale, "short");
  const errorText = (code: string) => (t.has(locale, `commerce.errors.${code}`) ? tr(`commerce.errors.${code}`) : tr("commerce.common.error"));
  const { order } = detail;
  const canSell = hasPermission(actor, "commerce.sell");
  const canRefund = hasPermission(actor, "commerce.refund");
  const canInvoice = hasPermission(actor, "invoices.issue");
  const isOpen = order.status === "draft" || order.status === "pending_payment";
  const isPaid = order.status === "paid" || order.status === "partially_refunded";
  const onAccount = order.status === "pending_payment" && !!order.onAccountAt;
  const hasOpenTransfer = detail.payments.some((p) => p.provider === "bank_transfer" && p.status === "open");
  const line = (d: unknown, fallback: string) => pick(d as LocalizedText, locale, "order_lines.description") || fallback;
  const methodText = (p: (typeof detail.payments)[number]) => {
    const key = p.method ? METHOD_KEY[p.method] : undefined;
    if (key) return tr(key);
    return (p.method && METHOD_BRAND[p.method]) ?? tr(`commerce.provider.${p.provider}`);
  };
  const paymentRef = (p: (typeof detail.payments)[number]) => (p.raw as { terminal_reference?: string | null } | null)?.terminal_reference ?? p.providerPaymentId ?? null;
  const refundableCents = canRefund && isPaid ? ((await getRefundPreview(await getAppDb(), id))?.refundableCents ?? 0) : 0;

  async function onPath(form: FormData) {
    "use server";
    back(id, await choosePaymentPath({ orderId: id, path: text(form, "path") }));
  }
  async function onLink(form: FormData) {
    "use server";
    back(id, await sendPaymentLink({ orderId: id, email: text(form, "email") }));
  }
  async function onInvoice() {
    "use server";
    back(id, await issueOnAccountInvoice({ orderId: id }));
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
  async function onQuickRefund(form: FormData) {
    "use server";
    const raw = (text(form, "amount") ?? "").replace(",", ".");
    const euros = Number(raw);
    const preview = await getRefundPreview(await getAppDb(), id);
    const lines = preview && raw && Number.isFinite(euros) ? quickRefundLines(preview, Math.round(euros * 100)) : null;
    if (!lines) back(id, { ok: false, error: { message: "refund_too_high" } });
    back(id, await refundOrder({ orderId: id, lines, reason: text(form, "reason") ?? "", kind: "refund" }));
  }
  async function onVoid(form: FormData) {
    "use server";
    back(id, await voidVoucher({ voucherId: text(form, "voucherId"), reason: text(form, "reason") ?? "" }));
  }

  // --- The "⋯" menu: everything but the one primary action. ---
  const emailField = <Input name="email" type="email" aria-label={c("email_optional")} placeholder={c("email_optional")} />;
  const menu: OrderMenuItem[] = [];
  if (canSell && order.status === "pending_payment") {
    menu.push({
      key: "link",
      label: c("send_link"),
      dialog: {
        title: c("send_link"),
        description: c("link_intro"),
        body: (
          <form action={onLink} className="grid gap-4">
            {emailField}
            <DialogFooter>
              <Button type="submit">{c("send_link")}</Button>
            </DialogFooter>
          </form>
        ),
      },
    });
    if (onAccount && canInvoice && !hasOpenTransfer) {
      menu.push({
        key: "invoice",
        label: tr("commerce.pos.settle_invoice"),
        dialog: {
          title: tr("commerce.pos.settle_invoice"),
          description: c("invoice_intro"),
          body: (
            <form action={onInvoice}>
              <DialogFooter>
                <Button type="submit">{tr("commerce.pos.settle_invoice")}</Button>
              </DialogFooter>
            </form>
          ),
        },
      });
    }
  }
  if (canRefund && isPaid && refundableCents > 0) {
    menu.push({
      key: "refund",
      label: c("refund"),
      dialog: {
        title: r("title", { reference: order.reference }),
        description: r("refundable", { amount: money(refundableCents) }),
        body: (
          <form action={onQuickRefund} className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span>{r("quick_amount")}</span>
              <Input name="amount" type="number" inputMode="decimal" step="0.01" min="0.01" max={(refundableCents / 100).toFixed(2)} defaultValue={(refundableCents / 100).toFixed(2)} required />
            </label>
            <p className="text-sm text-muted-foreground">{r("quick_intro")}</p>
            <label className="grid gap-1 text-sm">
              <span>{r("reason")}</span>
              <Input name="reason" required minLength={5} maxLength={500} defaultValue={r("quick_default_reason")} />
            </label>
            <p className="text-sm text-muted-foreground">{r("where")}</p>
            <DialogFooter className="items-center gap-2">
              <Link href={`/admin/orders/${order.id}/refund`} className="text-sm underline">
                {r("per_line")}
              </Link>
              <Button type="submit">{r("confirm")}</Button>
            </DialogFooter>
          </form>
        ),
      },
    });
  }
  if (canSell && (isPaid || order.status === "refunded")) {
    menu.push({
      key: "receipt",
      label: c("email_receipt"),
      dialog: {
        title: c("email_receipt"),
        description: c("receipt_intro"),
        body: (
          <form action={onReceipt} className="grid gap-4">
            {emailField}
            <DialogFooter>
              <Button type="submit">{c("email_receipt")}</Button>
            </DialogFooter>
          </form>
        ),
      },
    });
    menu.push({ key: "print", label: tr("commerce.pos.print_receipt"), href: `/admin/pos/receipt/${order.id}` });
  }
  if (detail.invoice) menu.push({ key: "open_invoice", label: c("open_invoice", { number: detail.invoice.number }), href: `/admin/finance/invoices/${detail.invoice.id}` });
  if (canSell && isOpen) {
    menu.push({
      key: "cancel",
      label: c("cancel"),
      destructive: true,
      dialog: {
        title: c("cancel"),
        description: c("cancel_intro"),
        body: (
          <form action={onCancel} className="grid gap-4">
            <Input name="reason" required minLength={3} aria-label={c("reason")} placeholder={c("reason")} />
            <DialogFooter>
              <Button type="submit" variant="destructive">
                {c("cancel")}
              </Button>
            </DialogFooter>
          </form>
        ),
      },
    });
  }

  // --- The receipt figures. ---
  const grossCents = detail.lines.reduce((s, l) => s + l.unitAmountCents * l.quantity, 0);
  const discountCents = detail.lines.reduce((s, l) => s + l.discountCents, 0);
  const vatRows = vatSummary(detail.lines.map((l) => ({ vatRatePct: Number(l.vatRatePct), lineTotalCents: l.lineTotalCents, vatCents: l.vatCents }))).filter((v) => v.vatCents > 0);

  // --- The steps of the order, with dates. ---
  type Step = { key: string; label: string; at?: string; state: "done" | "current" | "todo" | "bad" };
  const steps: Step[] = [{ key: "created", label: c("created"), at: when(order.createdAt), state: "done" }];
  if (order.paidAt) steps.push({ key: "paid", label: c("col_paid"), at: when(order.paidAt), state: "done" });
  else if (order.status === "cancelled") steps.push({ key: "cancelled", label: tr("commerce.order_status.cancelled"), ...(order.cancelledAt ? { at: when(order.cancelledAt) } : {}), state: "bad" });
  else if (order.status === "expired") steps.push({ key: "expired", label: tr("commerce.order_status.expired"), ...(order.expiresAt ? { at: when(order.expiresAt) } : {}), state: "bad" });
  else if (onAccount) steps.push({ key: "on_account", label: tr("commerce.pos.on_account_since", { date: when(order.onAccountAt!) }), state: "current" });
  else if (isOpen) steps.push({ key: "awaiting", label: tr(`commerce.order_status.${order.status}`), ...(order.expiresAt ? { at: `${c("expires_at")} ${when(order.expiresAt)}` } : {}), state: "current" });
  else steps.push({ key: "paid", label: c("col_paid"), state: "done" });
  if (detail.invoice) steps.push({ key: "invoiced", label: c("invoiced"), at: formatDate(detail.invoice.issuedOn, locale, "short"), state: "done" });
  else if (order.status !== "cancelled" && order.status !== "expired") steps.push({ key: "invoiced", label: c("invoiced"), state: "todo" });
  const lastRefund = detail.refunds.at(-1);
  if (lastRefund) {
    const settled = detail.refunds.every((x) => x.status === "refunded");
    const label = order.status === "refunded" || order.status === "partially_refunded" ? tr(`commerce.order_status.${order.status}`) : c("refunds");
    steps.push({ key: "refunded", label, at: when(lastRefund.createdAt), state: settled ? "done" : "current" });
  }

  const customerName = detail.companyName ?? detail.person?.name ?? c("walk_in");
  const statusLabel = onAccount ? tr("commerce.pos.on_account") : tr(`commerce.order_status.${order.status}`);

  return (
    <div className="grid gap-5">
      <BackLink href="/admin/orders">{c("title")}</BackLink>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="grid min-w-0 gap-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1>{c("detail_title", { reference: order.reference })}</h1>
            <StatusPill tone={onAccount ? "gold" : (ORDER_TONE[order.status] ?? "muted")}>{statusLabel}</StatusPill>
            <StatusPill tone="muted">{tr(`commerce.channel.${order.channel}`)}</StatusPill>
          </div>
          {detail.person ? (
            <Link href={`/admin/persons/${detail.person.id}` as never} className="group flex w-fit items-center gap-2.5 text-[0.8125rem]">
              <Initials name={detail.person.name} />
              <span className="grid leading-tight">
                <span className="font-semibold group-hover:underline">{customerName}</span>
                {detail.person.email ? <span className="text-muted-foreground">{detail.person.email}</span> : null}
              </span>
            </Link>
          ) : (
            <p className="flex items-center gap-2.5 text-[0.8125rem]">
              <Initials name={customerName} />
              <span className="font-semibold">{customerName}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canSell && order.status === "pending_payment" ? <PrimaryAction href={`/admin/pos?order=${order.id}` as never}>{c("open_pos")}</PrimaryAction> : null}
          {menu.length ? <OrderMenu label={c("more_actions")} closeLabel={r("close")} items={menu} /> : null}
        </div>
      </header>

      <div role="status" aria-live="polite" className="empty:hidden">
        {sp.done ? <Notice tone="ok">{c("done")}</Notice> : null}
        {sp.error ? <Notice tone="bad">{c("failed", { message: errorText(sp.error) })}</Notice> : null}
      </div>

      {canSell && order.status === "draft" ? (
        <Surface aria-labelledby="path-title" className="flex flex-wrap items-center justify-between gap-3 py-4">
          <h2 id="path-title" className="text-[0.875rem] font-semibold">
            {c("choose_path")}
          </h2>
          <form action={onPath} className="flex flex-wrap gap-2">
            {(["pos", "link", "bank_transfer"] as const).map((path) => (
              <Button key={path} type="submit" name="path" value={path} variant={path === "pos" ? "default" : "outline"} size="sm">
                {c(`path_${path}`)}
              </Button>
            ))}
          </form>
        </Surface>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="grid gap-5">
          <Surface flush aria-labelledby="lines-title">
            <h2 id="lines-title" className="sr-only">
              {c("lines")}
            </h2>
            <ul className="divide-y divide-border">
              {detail.lines.map((l) => {
                const winner = (l.pricingTrace as Partial<PricingTrace> | null)?.winner;
                return (
                  <li key={l.id} className="flex items-start justify-between gap-4 px-5 py-3.5">
                    <div className="grid min-w-0 gap-0.5">
                      <span className="text-[0.875rem] font-medium">{line(l.description, l.sku)}</span>
                      <span className="flex flex-wrap items-center gap-2 text-[0.75rem] text-muted-foreground tabular-nums">
                        {l.quantity} × {money(l.unitAmountCents)}
                        {winner && winner !== "base" && l.discountCents > 0 ? <StatusPill tone="gold">{c(`winner_${winner}`)}</StatusPill> : null}
                      </span>
                    </div>
                    <div className="grid shrink-0 text-right tabular-nums">
                      <span className="text-[0.875rem] font-medium">{money(l.lineTotalCents)}</span>
                      {l.discountCents > 0 ? <s className="text-[0.75rem] text-muted-foreground">{money(l.unitAmountCents * l.quantity)}</s> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            <dl className="grid gap-1.5 border-t border-border bg-[#faf9f6] px-5 py-4 text-[0.8125rem]">
              {discountCents > 0 ? (
                <>
                  <TotalRow label={c("subtotal")} value={money(grossCents)} />
                  <TotalRow label={c("col_discount")} value={money(-discountCents)} />
                </>
              ) : null}
              {vatRows.map((v) => (
                <TotalRow key={v.ratePct} muted label={c("vat_included", { rate: formatPercent(v.ratePct, locale, 2) })} value={money(v.vatCents)} />
              ))}
              <div className="mt-1.5 border-t border-border pt-2.5">
                <TotalRow strong label={c("col_total")} value={money(order.totalCents)} />
              </div>
              {detail.paidCents > 0 ? <TotalRow muted label={c("col_paid")} value={money(detail.paidCents)} /> : null}
              {detail.refundedCents > 0 ? <TotalRow muted label={tr("commerce.order_status.refunded")} value={money(-detail.refundedCents)} /> : null}
              {isOpen && detail.dueCents > 0 ? <TotalRow strong label={c("due")} value={money(detail.dueCents)} /> : null}
            </dl>
          </Surface>

          {detail.vouchers.length ? (
            <Surface flush aria-labelledby="vouchers-title">
              <h2 id="vouchers-title" className="border-b border-border px-5 py-3 text-[0.875rem] font-semibold">
                {c("vouchers")}
              </h2>
              <ul className="divide-y divide-border">
                {detail.vouchers.map((v) => (
                  <li key={v.id} className="grid gap-3 px-5 py-3.5 text-[0.8125rem]">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono">{v.codeLast4 ? c("code_last4", { last4: v.codeLast4 }) : "—"}</span>
                      <span className="tabular-nums">{money(v.amountCents)}</span>
                      <StatusPill tone={v.status === "active" ? "ok" : "muted"}>{tr(`commerce.voucher_status.${v.status}`)}</StatusPill>
                      {v.recipientName ? <span className="text-muted-foreground">{v.recipientName}</span> : null}
                    </div>
                    {v.status === "active" && (canSell || canRefund) ? (
                      <div className="flex flex-wrap gap-2">
                        {canSell ? (
                          <form action={onResend} className="flex items-center gap-2">
                            <input type="hidden" name="voucherId" value={v.id} />
                            <Input name="email" type="email" aria-label={c("email_optional")} placeholder={c("email_optional")} className="h-8 w-56" />
                            <Button type="submit" size="sm" variant="outline">
                              {c("resend_voucher")}
                            </Button>
                          </form>
                        ) : null}
                        {canRefund ? (
                          <form action={onVoid} className="flex items-center gap-2">
                            <input type="hidden" name="voucherId" value={v.id} />
                            <Input name="reason" required minLength={3} aria-label={c("reason")} placeholder={c("reason")} className="h-8 w-40" />
                            <Button type="submit" size="sm" variant="destructive">
                              {c("void_voucher")}
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Surface>
          ) : null}
        </div>

        <Surface flush className="text-[0.8125rem]">
          <Section title={c("col_history")}>
            <ol className="grid">
              {steps.map((s, i) => (
                <li key={s.key} className="relative flex gap-3 pb-3.5 last:pb-0">
                  {i < steps.length - 1 ? <span aria-hidden="true" className="absolute top-4 bottom-0 left-[4.5px] w-px bg-border" /> : null}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-[5px] size-2.5 shrink-0 rounded-full border-2",
                      s.state === "done" && "border-[#c9973a] bg-[#c9973a]",
                      s.state === "current" && "border-[#c9973a] bg-card",
                      s.state === "todo" && "border-border bg-card",
                      s.state === "bad" && "border-[var(--status-bad)] bg-[var(--status-bad)]",
                    )}
                  />
                  <span className="grid leading-snug">
                    <span className={cn("font-medium", s.state === "todo" && "text-muted-foreground")}>{s.label}</span>
                    {s.at ? <span className="text-[0.75rem] text-muted-foreground tabular-nums">{s.at}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </Section>

          {detail.payments.length ? (
            <Section title={c("payments")}>
              <ul className="grid gap-3">
                {detail.payments.map((p) => {
                  const ref = paymentRef(p);
                  return (
                    <li key={p.id} className="grid gap-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{methodText(p)}</span>
                        <span className="font-medium tabular-nums">{money(p.amountCents)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 text-[0.75rem] text-muted-foreground">
                        <span className="min-w-0 truncate tabular-nums">
                          {ref ? (
                            <span className="font-mono" title={ref}>
                              {ref}
                            </span>
                          ) : (
                            tr(`commerce.provider.${p.provider}`)
                          )}
                          {" · "}
                          {when(p.paidAt ?? p.createdAt)}
                        </span>
                        <span title={(p.statusHistory ?? []).map((h) => `${tr(`commerce.payment_status.${h.status}`)} ${when(new Date(h.at))}`).join(" → ") || undefined}>
                          <StatusPill tone={PAYMENT_TONE[p.status] ?? "muted"}>{tr(`commerce.payment_status.${p.status}`)}</StatusPill>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Section>
          ) : null}

          {detail.invoice ? (
            <Section title={c("invoices")}>
              <div className="flex items-center justify-between gap-3">
                <Link href={`/admin/finance/invoices/${detail.invoice.id}`} className={chip}>
                  {detail.invoice.number}
                </Link>
                <span className="text-[0.75rem] text-muted-foreground tabular-nums">{formatDate(detail.invoice.issuedOn, locale, "short")}</span>
              </div>
            </Section>
          ) : null}

          {detail.refunds.length ? (
            <Section title={c("refunds")}>
              <ul className="grid gap-3">
                {detail.refunds.map((x) => (
                  <li key={x.id} className="grid gap-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="tabular-nums text-muted-foreground">{when(x.createdAt)}</span>
                      <span className="font-medium tabular-nums">{money(-x.amountCents)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-[0.75rem]">
                      <span className="min-w-0 truncate text-muted-foreground" title={x.reason}>
                        {x.reason}
                      </span>
                      <StatusPill tone={REFUND_TONE[x.status] ?? "muted"}>{tr(`commerce.refund_status.${x.status}`)}</StatusPill>
                    </div>
                    {x.creditNoteId || (canRefund && (x.status === "failed" || x.status === "sent")) ? (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {x.creditNoteId ? (
                          <Link href={`/admin/finance/invoices/${x.creditNoteId}`} className={chip}>
                            {c("credit_note")}
                          </Link>
                        ) : null}
                        {canRefund && x.status === "failed" ? (
                          <form action={onRetry}>
                            <input type="hidden" name="refundId" value={x.id} />
                            <Button type="submit" size="sm" variant="outline">
                              {c("retry")}
                            </Button>
                          </form>
                        ) : null}
                        {canRefund && x.status === "sent" ? (
                          <form action={onConfirm}>
                            <input type="hidden" name="refundId" value={x.id} />
                            <Button type="submit" size="sm" variant="outline">
                              {c("confirm_refund")}
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {order.note ? (
            <Section title={c("note")}>
              <p className="whitespace-pre-line">{order.note}</p>
            </Section>
          ) : null}

          {detail.events.length ? (
            <details className="group border-t border-border px-5 py-3">
              <summary className="cursor-pointer text-[0.75rem] font-semibold tracking-wide text-muted-foreground uppercase">
                {c("activity")} <span className="font-normal">{detail.events.length}</span>
              </summary>
              <ul className="mt-2 grid gap-1 text-[0.75rem]">
                {detail.events.map((e) => (
                  <li key={e.id} className="flex justify-between gap-3">
                    <span className="font-mono">{e.kind}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">{when(e.occurredAt)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Surface>
      </div>
    </div>
  );
}
