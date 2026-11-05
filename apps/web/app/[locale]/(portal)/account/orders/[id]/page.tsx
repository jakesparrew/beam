import { notFound, redirect } from "next/navigation";
import { formatDate, formatDateTime, formatMoney, localeFromSegment, t, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { withdrawOrder } from "@/modules/commerce/actions";
import { getMyOrder, getWithdrawalPreviewFor, readViewer } from "@/modules/commerce/queries";
import { OrderLinesTable } from "@/modules/commerce/ui/quote-lines";
import { getInvoiceForOrder } from "@/modules/finance/api";

/**
 * `/[locale]/account/orders/[id]` (section 5.2): lines, payments, refunds and the withdrawal
 * deadline when it applies (rule 54, `#withdrawal`); a pending order links to its payment page.
 * commerce-P6: the withdrawal form (the lines the plan can refund or hand to customer service,
 * dated services shown as exempt, a confirmation checkbox) submits `withdrawOrder`. A paid order
 * links to its invoice in the portal (finance's `getInvoiceForOrder`, `/account/invoices/[id]`).
 */
export default async function AccountOrderDetailPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<{ withdrawn?: string; error?: string }> }) {
  const { locale: segment, id } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const order = await getMyOrder(await getAppDb(), id, { personId: (await readViewer(actor)).personId }, locale);
  if (!order) notFound();
  const withdrawalOpen = order.withdrawalOpen;
  const sp = await searchParams;
  const db = await getAppDb();
  const plan = withdrawalOpen ? await getWithdrawalPreviewFor(db, order.orderId) : null;
  const wasPaid = order.status === "paid" || order.status === "partially_refunded" || order.status === "refunded";
  const invoice = wasPaid ? await getInvoiceForOrder(db, order.orderId) : null;
  const choosable = plan ? plan.lines.filter((l) => l.outcome !== "refused").map((l) => l.orderLineId) : [];
  const here = `/${seg}/account/orders/${order.orderId}`;
  const errorText = (code: string) => (t.has(locale, `commerce.errors.${code}`) ? tr(`commerce.errors.${code}`) : tr("commerce.common.error"));
  const lineName = (lineId: string) => order.lines.find((l) => l.id === lineId)?.description ?? "";

  async function onWithdraw(form: FormData) {
    "use server";
    const lineIds = choosable.filter((lineId) => form.get(`line_${lineId}`) === "on");
    const r = await withdrawOrder({ orderId: id, lineIds });
    redirect(`${here}?${r.ok ? "withdrawn=1" : `error=${encodeURIComponent(r.error.message)}`}#withdrawal` as never);
  }

  return (
    <article aria-labelledby="order-title" className="grid max-w-3xl gap-6">
      <a href={`/${seg}/account/orders`} className="text-sm underline">
        {tr("commerce.my_orders.back")}
      </a>
      <div className="grid gap-1">
        <h1 id="order-title" className="text-2xl font-semibold">
          {tr("commerce.my_orders.detail_title", { reference: order.reference })}
        </h1>
        <p className="text-sm">
          {formatDateTime(order.createdAt, locale)} · {tr(`commerce.order_status.${order.status}`)}
        </p>
      </div>
      {order.status === "pending_payment" ? (
        <a href={`/${seg}/account/checkout/${order.orderId}`} className="inline-flex min-h-11 w-fit items-center rounded-md bg-primary px-5 font-medium text-primary-foreground">
          {tr("commerce.my_orders.pay_now")}
        </a>
      ) : null}
      <section aria-labelledby="order-lines" className="grid gap-2">
        <h2 id="order-lines" className="text-lg font-semibold">
          {tr("commerce.my_orders.lines")}
        </h2>
        <OrderLinesTable locale={locale} lines={order.lines} totalCents={order.totalCents} />
      </section>
      {withdrawalOpen ? (
        <section id="withdrawal" aria-labelledby="withdrawal-title" className="grid gap-3 rounded-md border p-4">
          <h2 id="withdrawal-title" className="text-lg font-semibold">
            {tr("commerce.withdrawal.title")}
          </h2>
          <p>{tr("commerce.my_orders.withdrawal_until", { date: formatDate(order.withdrawalUntilAt!, locale, "long") })}</p>
          <p className="text-sm">{tr("commerce.withdrawal.intro")}</p>
          <div role="status" aria-live="polite">
            {sp.withdrawn ? <p className="rounded-md border p-3 text-sm">{tr("commerce.withdrawal.done")}</p> : null}
            {sp.error ? (
              <p id="withdrawal-error" className="rounded-md border border-destructive p-3 text-sm">
                {tr("commerce.withdrawal.failed", { message: errorText(sp.error) })}
              </p>
            ) : null}
          </div>
          {plan && choosable.length ? (
            <form action={onWithdraw} className="grid gap-3" aria-describedby={sp.error ? "withdrawal-error" : undefined}>
              <fieldset className="grid gap-2">
                <legend className="sr-only">{tr("commerce.withdrawal.title")}</legend>
                {plan.lines.map((l) => (
                  <label key={l.orderLineId} className="flex min-h-11 items-center gap-2">
                    {l.outcome === "refused" ? (
                      <span aria-hidden="true" className="size-5" />
                    ) : (
                      <input type="checkbox" name={`line_${l.orderLineId}`} defaultChecked className="size-5" />
                    )}
                    <span>
                      {lineName(l.orderLineId)}
                      {" · "}
                      {l.outcome === "refund"
                        ? tr("commerce.withdrawal.line_refund", { amount: formatMoney(l.amountCents, locale) })
                        : l.outcome === "task"
                          ? tr("commerce.withdrawal.line_task")
                          : l.reason === "dated_service"
                            ? tr("commerce.withdrawal.line_dated")
                            : tr("commerce.withdrawal.line_used")}
                    </span>
                  </label>
                ))}
              </fieldset>
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" name="confirm" required className="size-5" />
                <span>{tr("commerce.withdrawal.confirm")}</span>
              </label>
              <button type="submit" className="min-h-11 w-fit rounded-md border px-5 font-medium">
                {tr("commerce.withdrawal.submit")}
              </button>
            </form>
          ) : null}
        </section>
      ) : null}
      <section aria-labelledby="order-payments" className="grid gap-2">
        <h2 id="order-payments" className="text-lg font-semibold">
          {tr("commerce.my_orders.payments")}
        </h2>
        {order.payments.length === 0 ? (
          <p>{tr("commerce.my_orders.no_payments")}</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {order.payments.map((p) => (
              <li key={p.id}>
                {formatDateTime(p.createdAt, locale)} · <span className="tabular-nums">{formatMoney(p.amountCents, locale)}</span> · {tr(`commerce.payment_status.${p.status}`)}
              </li>
            ))}
          </ul>
        )}
      </section>
      {wasPaid && order.totalCents > 0 ? (
        <section aria-labelledby="order-invoice" className="grid gap-2">
          <h2 id="order-invoice" className="text-lg font-semibold">
            {tr("commerce.my_orders.invoice_title")}
          </h2>
          {invoice ? (
            <a href={`/${seg}/account/invoices/${invoice.id}`} className="w-fit underline">
              {tr("commerce.my_orders.invoice_link", { number: invoice.number })}
            </a>
          ) : (
            <p className="text-sm">{tr("commerce.my_orders.invoice_pending")}</p>
          )}
        </section>
      ) : null}
      {order.refunds.length ? (
        <section aria-labelledby="order-refunds" className="grid gap-2">
          <h2 id="order-refunds" className="text-lg font-semibold">
            {tr("commerce.my_orders.refunds")}
          </h2>
          <ul className="grid gap-1 text-sm">
            {order.refunds.map((r) => (
              <li key={r.id}>
                {formatDateTime(r.createdAt, locale)} · <span className="tabular-nums">{formatMoney(r.amountCents, locale)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
