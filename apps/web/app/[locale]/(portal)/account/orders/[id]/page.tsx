import { notFound } from "next/navigation";
import { formatDate, formatDateTime, formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getMyOrder, readViewer } from "@/modules/commerce/queries";
import { OrderLinesTable } from "@/modules/commerce/ui/quote-lines";

/**
 * `/[locale]/account/orders/[id]` (section 5.2): lines, payments, refunds and the withdrawal
 * deadline when it applies (rule 54, `#withdrawal`); a pending order links to its payment page.
 * The withdrawal action and the invoice links arrive with commerce-P6 and finance.
 */
export default async function AccountOrderDetailPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale: segment, id } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const order = await getMyOrder(await getAppDb(), id, { personId: (await readViewer(actor)).personId }, locale);
  if (!order) notFound();
  const withdrawalOpen = order.withdrawalOpen;

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
        <p id="withdrawal" className="rounded-md border p-3">
          {tr("commerce.my_orders.withdrawal_until", { date: formatDate(order.withdrawalUntilAt!, locale, "long") })}
        </p>
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
