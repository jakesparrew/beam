import { notFound } from "next/navigation";
import { formatDate, formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { listMyOrders } from "@/modules/commerce/queries";

/**
 * `/[locale]/account/orders` (section 5.2): the customer's own orders (reference, date, total,
 * status as text) and the gift vouchers they bought (amount, recipient, status, expiry, and
 * "Scheduled for <date>" for a dated delivery, rule 45a).
 */
export default async function AccountOrdersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const { orders, vouchers } = await listMyOrders(await getAppDb(), actor.personId);
  const th = "py-2 pr-3 text-left font-medium";

  return (
    <section aria-labelledby="orders-title" className="grid gap-6">
      <h1 id="orders-title" className="text-2xl font-semibold">
        {tr("commerce.my_orders.title")}
      </h1>
      {orders.length === 0 ? (
        <div className="grid gap-2">
          <p>{tr("commerce.my_orders.empty")}</p>
          <a href={`/${seg}/account/shop`} className="underline">
            {tr("commerce.my_orders.go_shop")}
          </a>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{tr("commerce.my_orders.title")}</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className={th}>
                  {tr("commerce.my_orders.reference")}
                </th>
                <th scope="col" className={th}>
                  {tr("commerce.my_orders.date")}
                </th>
                <th scope="col" className={`${th} text-right`}>
                  {tr("commerce.my_orders.total")}
                </th>
                <th scope="col" className={th}>
                  {tr("commerce.my_orders.status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.orderId} className="border-b">
                  <td className="py-2 pr-3">
                    <a href={`/${seg}/account/orders/${o.orderId}`} className="underline" aria-label={tr("commerce.my_orders.open", { reference: o.reference })}>
                      {o.reference}
                    </a>
                  </td>
                  <td className="py-2 pr-3">{formatDate(o.createdAt, locale)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(o.totalCents, locale)}</td>
                  <td className="py-2 pr-3">{tr(`commerce.order_status.${o.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {vouchers.length ? (
        <section aria-labelledby="vouchers-title" className="grid gap-2">
          <h2 id="vouchers-title" className="text-xl font-semibold">
            {tr("commerce.my_orders.vouchers_title")}
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th scope="col" className={th}>
                  {tr("commerce.my_orders.voucher_amount")}
                </th>
                <th scope="col" className={th}>
                  {tr("commerce.my_orders.voucher_recipient")}
                </th>
                <th scope="col" className={th}>
                  {tr("commerce.my_orders.status")}
                </th>
                <th scope="col" className={th}>
                  {tr("commerce.my_orders.voucher_expiry")}
                </th>
              </tr>
            </thead>
            <tbody>
              {vouchers.map((v) => (
                <tr key={v.voucherId} className="border-b">
                  <td className="py-2 pr-3 tabular-nums">{formatMoney(v.amountCents, locale)}</td>
                  <td className="py-2 pr-3">{v.recipientName ?? "—"}</td>
                  <td className="py-2 pr-3">
                    {tr(`commerce.voucher_status.${v.status}`)}
                    {v.deliverOn && v.deliverOn > new Date().toISOString().slice(0, 10) ? (
                      <span className="block text-xs">{tr("commerce.my_orders.voucher_scheduled", { date: formatDate(v.deliverOn, locale) })}</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">{v.expiresAt ? formatDate(v.expiresAt, locale) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </section>
  );
}
