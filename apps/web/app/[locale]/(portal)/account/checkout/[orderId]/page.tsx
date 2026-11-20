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
      <h1 id="pay-title">
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

  const first = order.lines[0]?.description ?? "";
  const night = /nacht|nuit|night/i.test(first);
  return (
    <section aria-labelledby="pay-title" className="mx-auto w-full max-w-6xl">
      <BookSteps current={4} tr={tr} />
      <div className="grid gap-8 lg:grid-cols-[1fr_24rem]">
        <div className="grid content-start gap-6">
          <header className="space-y-2">
            <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.25em] text-[#2f6d44] uppercase">
              <LockIcon /> {tr("site.bookFlow.pay.eyebrow")}
            </p>
            {heading}
          </header>
          {order.expiresAt ? (
            <p className="flex items-center gap-3 rounded-2xl bg-[#fdf3dc] p-4 text-sm">
              <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-[#d1a64a]/25 text-[#a0621e]">
                ◷
              </span>
              <span>
                <span className="block font-semibold">{tr("commerce.pay_order.held_until", { time: formatTime(order.expiresAt, locale) })}</span>
                <span className="block text-[#212842]/70">{tr("site.bookFlow.pay.heldBody")}</span>
              </span>
            </p>
          ) : null}
          <form action={pay} className="grid gap-6 rounded-[2rem] bg-card p-6 shadow-[0_1px_2px_rgb(33_40_66/0.04),0_24px_48px_-28px_rgb(33_40_66/0.3)] sm:p-10">
            <input type="hidden" name="clientKey" value={randomUUID()} />
            <ErrorSummary locale={locale} error={basketErrorFrom(sp)} />
            <OrderLinesTable locale={locale} lines={order.lines} totalCents={order.totalCents} />
            {order.dueCents !== order.totalCents ? (
              <p className="text-sm">
                {tr("commerce.pay_order.due")}: <span className="font-semibold tabular-nums">{formatMoney(order.dueCents, locale)}</span>
              </p>
            ) : null}
            {order.euroBalanceCents > 0 ? (
              <div className="flex items-center gap-3">
                <input id="use-euro-credit" name="useEuroCredit" type="checkbox" value="1" defaultChecked className="size-5 accent-[#212842]" />
                <label htmlFor="use-euro-credit" className="text-sm">
                  {tr("commerce.checkout.euro_credit", { amount: formatMoney(order.euroBalanceCents, locale) })}
                </label>
              </div>
            ) : null}
            <CompanyInvoiceBox locale={locale} error={basketErrorFrom(sp)} />
            {order.needsTerms ? <TermsCheckbox locale={locale} termsUrl={await termsUrlFor(locale)} error={sp.field === "acceptTerms"} /> : null}
            <div className="grid gap-3">
              <button
                type="submit"
                className="site-gold inline-flex h-14 w-full items-center justify-center gap-3 rounded-full px-8 text-base font-semibold text-[#212842] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <LockIcon />
                {tr("commerce.checkout.pay", { amount: formatMoney(order.dueCents, locale) })}
              </button>
              <p className="text-center text-xs leading-relaxed text-muted-foreground">{tr("site.bookFlow.pay.secureNote")}</p>
              <ul className="flex flex-wrap justify-center gap-2" aria-label={tr("site.bookFlow.pay.methods")}>
                {["Bancontact", "Visa", "Mastercard", "Apple Pay"].map((m) => (
                  <li key={m} className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-semibold text-[#212842]/70">
                    {m}
                  </li>
                ))}
              </ul>
            </div>
          </form>
        </div>
        <SummaryAside
          kind={night ? "night" : "day"}
          heading={tr("site.bookFlow.pay.summary")}
          title={first}
          when={[tr("commerce.pay_order.reference", { reference: order.reference })]}
          lines={order.lines.map((l) => ({ label: l.quantity > 1 ? `${l.quantity} × ${l.description}` : l.description, amount: formatMoney(l.lineTotalCents, locale) }))}
          total={{ label: tr("site.bookFlow.summary.total"), amount: formatMoney(order.dueCents, locale) }}
          trust={[tr("site.bookFlow.trust.secure"), tr("site.bookFlow.trust.email"), tr("site.bookFlow.trust.help")]}
        />
      </div>
    </section>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
