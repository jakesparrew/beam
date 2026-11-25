import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { payOrder } from "@/modules/commerce/actions";
import { getOrderForPayment, readViewer } from "@/modules/commerce/queries";
import { billingDetailsFrom, errorQuery } from "@/modules/commerce/ui/basket";
import { PayOrderScreen } from "@/modules/commerce/ui/pay-order";
import { BookSteps, SummaryAside } from "@/modules/site/ui/public/book-flow";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Search = { error?: string; field?: string };

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

const PAID = new Set(["paid", "partially_refunded", "refunded"]);

/**
 * `/[locale]/checkout/pay/[orderId]`: step 2 of booking without an account (owner's review 8).
 * The guest reviews the held booking (lines, total, the hold countdown) and pays through Stripe
 * Checkout. The order is found through the signed viewer cookie set when it was booked (or the
 * signed-in owner); anyone else gets a 404. A paid order goes to the guest return page.
 */
export default async function SitePayOrderPage({ params, searchParams }: { params: Promise<{ locale: string; orderId: string }>; searchParams: Promise<Search> }) {
  const { locale: segment, orderId } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const sp = await searchParams;
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const order = await getOrderForPayment(await getAppDb(), orderId, await readViewer(actorFromSession(await getSession())), locale);
  if (!order) notFound();
  if (PAID.has(order.status)) redirect(`/${seg}/checkout/return/${order.orderId}` as never);

  if (order.isExpired || order.status !== "pending_payment") {
    return (
      <section aria-labelledby="pay-title" className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-10">
        <h1 id="pay-title" className="font-display text-4xl">
          {tr("commerce.pay_order.title")}
        </h1>
        <p role="status" className="rounded-2xl border border-border bg-card p-5">
          {tr(order.isExpired ? "commerce.pay_order.expired" : "commerce.pay_order.not_payable")}
        </p>
        <a href={`/${seg}/book`} className="underline">
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
    if (!result.ok) redirect(`/${seg}/checkout/pay/${id}?${errorQuery(result.error)}` as never);
    redirect(result.data.redirectUrl as never);
  }

  const first = order.lines.find((l) => l.kind === "session" || l.kind === "night")?.description ?? order.lines[0]?.description ?? "";
  const night = order.lines.some((l) => l.kind === "night");
  return (
    <div className="px-4 py-10 sm:px-6 lg:px-8">
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
    </div>
  );
}
