import { notFound, redirect } from "next/navigation";
import { formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { payOrder } from "@/modules/commerce/actions";
import { getOrderForPayment, readViewer } from "@/modules/commerce/queries";
import { billingDetailsFrom, errorQuery } from "@/modules/commerce/ui/basket";
import { PayOrderScreen } from "@/modules/commerce/ui/pay-order";
import { BookSteps, SummaryAside } from "@/modules/site/ui/public/book-flow";

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
 * one, rule 26a) and the company invoice box (`PayOrderScreen`). An expired order says so with a
 * link back to the bookings; a paid order goes to the return page.
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

  if (order.isExpired || order.status !== "pending_payment") {
    return (
      <section aria-labelledby="pay-title" className="grid max-w-2xl gap-4">
        <h1 id="pay-title">{tr("commerce.pay_order.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("commerce.pay_order.reference", { reference: order.reference })}</p>
        <p role="status" className="rounded-md border p-3">
          {tr(order.isExpired ? "commerce.pay_order.expired" : "commerce.pay_order.not_payable")}
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

  const first = order.lines[0]?.description ?? "";
  const night = /nacht|nuit|night/i.test(first);
  return (
    <PayOrderScreen
      locale={locale}
      order={order}
      pay={pay}
      search={sp}
      steps={<BookSteps current={4} tr={tr} />}
      aside={
        <SummaryAside
          kind={night ? "night" : "day"}
          heading={tr("site.bookFlow.pay.summary")}
          title={first}
          when={[tr("commerce.pay_order.reference", { reference: order.reference })]}
          lines={order.lines.map((l) => ({ label: l.quantity > 1 ? `${l.quantity} × ${l.description}` : l.description, amount: formatMoney(l.lineTotalCents, locale) }))}
          total={{ label: tr("site.bookFlow.summary.total"), amount: formatMoney(order.dueCents, locale) }}
          trust={[tr("site.bookFlow.trust.secure"), tr("site.bookFlow.trust.email"), tr("site.bookFlow.trust.help")]}
        />
      }
    />
  );
}
