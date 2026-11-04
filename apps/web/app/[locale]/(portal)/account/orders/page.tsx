import { notFound, redirect } from "next/navigation";
import { formatDate, formatMoney, localeFromSegment, t, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { redeemVoucher } from "@/modules/commerce/actions";
import { listMyOrders } from "@/modules/commerce/queries";

/**
 * `/[locale]/account/orders` (section 5.2): the customer's own orders (reference, date, total,
 * status as text) and the gift vouchers they bought (amount, recipient, status, expiry, and
 * "Scheduled for <date>" for a dated delivery, rule 45a). commerce-P6: the "Redeem a gift voucher"
 * field (`#redeem`, rule 45), whose euro credit lands on the customer's balance.
 */
export default async function AccountOrdersPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ redeemed?: string; until?: string; error?: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const { orders, vouchers } = await listMyOrders(await getAppDb(), actor.personId);
  const th = "py-2 pr-3 text-left font-medium";
  const sp = await searchParams;
  const errorText = (code: string) => (t.has(locale, `commerce.errors.${code}`) ? tr(`commerce.errors.${code}`) : tr("commerce.common.error"));
  const redeemedCents = sp.redeemed && /^\d+$/.test(sp.redeemed) ? Number(sp.redeemed) : null;
  const redeemedUntil = sp.until && /^\d{4}-\d{2}-\d{2}$/.test(sp.until) ? sp.until : null;

  async function onRedeem(form: FormData) {
    "use server";
    const code = form.get("code");
    const r = await redeemVoucher({ code: typeof code === "string" ? code : "" });
    const base = `/${seg}/account/orders`;
    if (r.ok) redirect(`${base}?redeemed=${r.data.amountCents}&until=${r.data.expiresAt.toISOString().slice(0, 10)}#redeem` as never);
    redirect(`${base}?error=${encodeURIComponent(r.error.message)}#redeem` as never);
  }

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
      <section id="redeem" aria-labelledby="redeem-title" className="grid gap-2 rounded-md border p-4">
        <h2 id="redeem-title" className="text-xl font-semibold">
          {tr("commerce.voucher.redeem_title")}
        </h2>
        <div role="status" aria-live="polite">
          {redeemedCents !== null && redeemedUntil ? (
            <p className="rounded-md border p-3 text-sm">{tr("commerce.voucher.redeemed", { amount: formatMoney(redeemedCents, locale), date: formatDate(redeemedUntil, locale, "long") })}</p>
          ) : null}
          {sp.error ? (
            <p id="redeem-error" className="rounded-md border border-destructive p-3 text-sm">
              {errorText(sp.error)}
            </p>
          ) : null}
        </div>
        <form action={onRedeem} className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">
            <span>{tr("commerce.voucher.redeem_label")}</span>
            <input
              name="code"
              required
              minLength={4}
              maxLength={40}
              autoComplete="off"
              aria-describedby={sp.error ? "redeem-hint redeem-error" : "redeem-hint"}
              className="h-11 w-72 rounded-md border px-3 uppercase"
            />
          </label>
          <button type="submit" className="min-h-11 rounded-md bg-primary px-5 font-medium text-primary-foreground">
            {tr("commerce.voucher.redeem_submit")}
          </button>
        </form>
        <p id="redeem-hint" className="text-sm text-muted-foreground">
          {tr("commerce.voucher.redeem_hint")}
        </p>
      </section>
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
