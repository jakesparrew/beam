import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { formatMoney, formatTime, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { payOrder } from "@/modules/commerce/actions";
import { getOrderForPayment, readViewer } from "@/modules/commerce/queries";
import { basketErrorFrom, billingDetailsFrom, CompanyInvoiceBox, ErrorSummary, errorQuery, TermsCheckbox, termsUrlFor } from "@/modules/commerce/ui/basket";
import { OrderLinesTable } from "@/modules/commerce/ui/quote-lines";

type Search = { error?: string; field?: string };

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

const PAID = new Set(["paid", "partially_refunded", "refunded"]);

/**
 * `/[locale]/account/checkout/[orderId]` (section 5.2): pays an existing `pending_payment` order
 * created by booking, a waitlist claim or a renewal link: lines, the reservation countdown, the
 * euro credit toggle, the terms checkbox (only when the order's terms version is not the current
 * one, rule 26a) and the company invoice box. An expired order says so with a link back to the
 * bookings; a paid order goes to the return page.
 */
export default async function AccountPayOrderPage({ params, searchParams }: { params: Promise<{ locale: string; orderId: string }>; searchParams: Promise<Search> }) {
  const { locale: segment, orderId } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const sp = await searchParams;
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const order = await getOrderForPayment(await getAppDb(), orderId, await readViewer(actor), locale);
  if (!order) notFound();
  if (PAID.has(order.status)) redirect(`/${seg}/account/checkout/return/${order.orderId}` as never);

  const expired = order.isExpired;
  const heading = (
    <>
      <h1 id="pay-title" className="text-2xl font-semibold">
        {tr("commerce.pay_order.title")}
      </h1>
      <p className="text-sm text-muted-foreground">{tr("commerce.pay_order.reference", { reference: order.reference })}</p>
    </>
  );
  if (expired || order.status !== "pending_payment") {
    return (
      <section aria-labelledby="pay-title" className="grid max-w-2xl gap-4">
        {heading}
        <p role="status" className="rounded-md border p-3">
          {tr(expired ? "commerce.pay_order.expired" : "commerce.pay_order.not_payable")}
        </p>
        <a href={`/${seg}/account/book`} className="underline">
          {tr("commerce.pay_order.back_to_booking")}
        </a>
      </section>
    );
  }
  const id = order.orderId;

  async function pay(fd: FormData) {
    "use server";
    const billingDetails = billingDetailsFrom(fd);
    const result = await payOrder({
      orderId: id,
      clientKey: str(fd, "clientKey"),
      useEuroCredit: fd.get("useEuroCredit") === "1",
      ...(fd.get("acceptTerms") === "1" ? { acceptTerms: true } : {}),
      ...(billingDetails ? { billingDetails } : {}),
    });
    if (!result.ok) redirect(`/${seg}/account/checkout/${id}?${errorQuery(result.error)}` as never);
    redirect(result.data.redirectUrl as never);
  }

  return (
    <section aria-labelledby="pay-title" className="grid max-w-2xl gap-6">
      <div className="grid gap-1">{heading}</div>
      {order.expiresAt ? <p className="rounded-md border p-3">{tr("commerce.pay_order.held_until", { time: formatTime(order.expiresAt, locale) })}</p> : null}
      <OrderLinesTable locale={locale} lines={order.lines} totalCents={order.totalCents} />
      {order.dueCents !== order.totalCents ? (
        <p className="text-sm">
          {tr("commerce.pay_order.due")}: <span className="font-semibold tabular-nums">{formatMoney(order.dueCents, locale)}</span>
        </p>
      ) : null}
      <form action={pay} className="grid gap-4">
        <input type="hidden" name="clientKey" value={randomUUID()} />
        <ErrorSummary locale={locale} error={basketErrorFrom(sp)} />
        {order.euroBalanceCents > 0 ? (
          <div className="flex items-center gap-3">
            <input id="use-euro-credit" name="useEuroCredit" type="checkbox" value="1" defaultChecked className="size-5" />
            <label htmlFor="use-euro-credit" className="text-sm">
              {tr("commerce.checkout.euro_credit", { amount: formatMoney(order.euroBalanceCents, locale) })}
            </label>
          </div>
        ) : null}
        <CompanyInvoiceBox locale={locale} error={basketErrorFrom(sp)} />
        {order.needsTerms ? <TermsCheckbox locale={locale} termsUrl={await termsUrlFor(locale)} error={sp.field === "acceptTerms"} /> : null}
        <button type="submit" className="min-h-12 rounded-md bg-primary px-6 text-base font-semibold text-primary-foreground">
          {tr("commerce.checkout.pay", { amount: formatMoney(order.dueCents, locale) })}
        </button>
      </form>
    </section>
  );
}
