/**
 * The "review and pay" screen of an existing `pending_payment` order (booking step 2, owner's
 * review 8): lines, the hold countdown, euro credit (only for the signed-in owner), the company
 * invoice box, the terms when the order needs them, and the pay button that opens Stripe
 * Checkout. Shared by `/[locale]/account/checkout/[orderId]` (portal) and
 * `/[locale]/checkout/pay/[orderId]` (a guest who holds the order through the viewer cookie). The
 * page passes the step indicator and the summary column, which belong to the site's booking flow.
 */
import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";
import { formatMoney, formatTime, type Locale } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import type { CustomerOrderView } from "../server/checkouts";
import { basketErrorFrom, CompanyInvoiceBox, ErrorSummary, TermsCheckbox, termsUrlFor } from "./basket";
import { OrderLinesTable } from "./quote-lines";

export async function PayOrderScreen({
  locale,
  order,
  pay,
  search,
  steps,
  aside,
}: {
  locale: Locale;
  order: CustomerOrderView;
  pay: (fd: FormData) => Promise<void>;
  search: { error?: string; field?: string };
  steps: ReactNode;
  aside: ReactNode;
}) {
  const tr = translator(locale);
  const error = basketErrorFrom(search);
  return (
    <section aria-labelledby="pay-title" className="mx-auto w-full max-w-6xl">
      {steps}
      <div className="grid gap-8 lg:grid-cols-[1fr_24rem]">
        <div className="grid content-start gap-6">
          <header className="space-y-2">
            <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.25em] text-[#2f6d44] uppercase">
              <LockIcon /> {tr("site.bookFlow.pay.eyebrow")}
            </p>
            <h1 id="pay-title">{tr("commerce.pay_order.title")}</h1>
            <p className="text-sm text-muted-foreground">{tr("commerce.pay_order.reference", { reference: order.reference })}</p>
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
            <ErrorSummary locale={locale} error={error} />
            <OrderLinesTable locale={locale} lines={order.lines} totalCents={order.totalCents} showDiscount />
            {order.creditPaidCents > 0 ? (
              <p className="flex justify-between text-sm" data-testid="order-credit-paid">
                <span>{tr("commerce.pay_order.credit_paid")}</span>
                <span className="tabular-nums">−{formatMoney(order.creditPaidCents, locale)}</span>
              </p>
            ) : null}
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
            <CompanyInvoiceBox locale={locale} error={error} />
            {order.needsTerms ? <TermsCheckbox locale={locale} termsUrl={await termsUrlFor(locale)} error={search.field === "acceptTerms"} /> : null}
            <div className="grid gap-3">
              <button
                type="submit"
                className="site-gold site-fill inline-flex h-14 w-full items-center justify-center gap-3 rounded-full px-8 text-base font-semibold text-[#212842] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <LockIcon />
                {tr("commerce.checkout.pay", { amount: formatMoney(order.dueCents, locale) })}
              </button>
              <p className="text-center text-xs leading-relaxed text-muted-foreground">{tr("site.bookFlow.pay.secureNote")}</p>
              <p className="text-center text-xs leading-relaxed text-muted-foreground">{tr("site.bookFlow.pay.methodOnStripe")}</p>
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
        {aside}
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
