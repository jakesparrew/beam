import { notFound, redirect } from "next/navigation";
import { localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { placeOrder, updateCheckout } from "@/modules/commerce/actions";
import { getCheckout, readViewer } from "@/modules/commerce/queries";
import { Basket, basketErrorFrom, billingDetailsFrom, errorQuery, itemsAfterUpdate, termsUrlFor } from "@/modules/commerce/ui/basket";

type Search = { checkout?: string; error?: string; field?: string };

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

/**
 * `/[locale]/account/checkout` (section 5.2): the basket of the signed-in customer with quote
 * lines and discount reasons, the promo code and its warning, the euro credit toggle, the
 * company invoice box, the terms checkbox and Pay. Every step re-quotes (rule 16); a changed
 * price shows "The price changed" with the new total before the customer can pay.
 */
export default async function AccountCheckoutPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const sp = await searchParams;
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const viewer = await readViewer(actor);
  const checkoutId = sp.checkout ?? viewer.checkoutIds?.[0] ?? null;
  const view = checkoutId ? await getCheckout(await getAppDb(), checkoutId, viewer, locale) : null;
  const open = view && (view.status === "started" || view.status === "abandoned") && view.channel === "portal" ? view : null;
  const here = (q?: string) => `/${seg}/account/checkout?checkout=${open?.checkoutId ?? ""}${q ? `&${q}` : ""}`;

  if (!open || !open.lines.length) {
    return (
      <section aria-labelledby="checkout-title" className="grid gap-4">
        <h1 id="checkout-title" className="text-2xl font-semibold">
          {tr("commerce.checkout.title")}
        </h1>
        <p>{tr("commerce.checkout.empty")}</p>
        <p>
          <a href={`/${seg}/account/shop`} className="underline">
            {tr("commerce.shop.back")}
          </a>
        </p>
      </section>
    );
  }
  const current = open;

  async function update(fd: FormData) {
    "use server";
    const items = itemsAfterUpdate(current.lines.map((l) => l.item), fd);
    if (!items.length) redirect(`/${seg}/account/shop` as never);
    const result = await updateCheckout({ checkoutId: current.checkoutId, items, promoCode: str(fd, "promoCode") || null });
    redirect(here(result.ok ? undefined : errorQuery(result.error)) as never);
  }

  async function place(fd: FormData) {
    "use server";
    const billingDetails = billingDetailsFrom(fd);
    const expected = Number(str(fd, "expectedTotalCents"));
    const result = await placeOrder({
      checkoutId: current.checkoutId,
      clientKey: str(fd, "clientKey"),
      useEuroCredit: fd.get("useEuroCredit") === "1",
      acceptTerms: fd.get("acceptTerms") === "1" ? true : undefined,
      ...(Number.isInteger(expected) ? { expectedTotalCents: expected } : {}),
      ...(billingDetails ? { billingDetails } : {}),
    });
    if (!result.ok) redirect(here(errorQuery(result.error)) as never);
    redirect(result.data.redirectUrl as never);
  }

  return (
    <section aria-labelledby="checkout-title" className="grid max-w-3xl gap-6">
      <h1 id="checkout-title" className="text-2xl font-semibold">
        {tr("commerce.checkout.title")}
      </h1>
      <Basket locale={locale} view={current} error={basketErrorFrom(sp)} updateAction={update} placeAction={place} termsUrl={await termsUrlFor(locale)} />
    </section>
  );
}
