import { notFound, redirect } from "next/navigation";
import { formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getShopProduct } from "@/modules/commerce/queries";
import { addToPortalBasket, basketErrorFrom, ErrorSummary } from "@/modules/commerce/ui/basket";

type Search = { error?: string; field?: string; product?: string };

/**
 * `/[locale]/account/shop/[sku]` (section 5.2): one product with its description, the person's
 * price, validity, sharing and the withdrawal notice (rule 54); site product links land here.
 * An inactive, hidden or unknown product shows "This product is not available."
 */
export default async function AccountShopProductPage({ params, searchParams }: { params: Promise<{ locale: string; sku: string }>; searchParams: Promise<Search> }) {
  const { locale: segment, sku } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const sp = await searchParams;
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const product = await getShopProduct(await getAppDb(), { sku: decodeURIComponent(sku), personId: actor.personId, locale });

  if (!product) {
    return (
      <section aria-labelledby="product-title" className="grid gap-4">
        <h1 id="product-title" className="text-2xl font-semibold">
          {tr("commerce.shop.title")}
        </h1>
        <p role="status">{tr("commerce.shop.not_available")}</p>
        <a href={`/${seg}/account/shop`} className="underline">
          {tr("commerce.shop.back")}
        </a>
      </section>
    );
  }
  const productId = product.productId;

  async function buy(fd: FormData) {
    "use server";
    const out = await addToPortalBasket({ locale: locale!, personId: actor.personId, productId, buyNow: fd.get("mode") === "buy" });
    if ("error" in out) redirect(`/${seg}/account/shop/${encodeURIComponent(sku)}?${out.error}` as never);
    redirect(`/${seg}/account/checkout?checkout=${out.checkoutId}` as never);
  }

  return (
    <article aria-labelledby="product-title" className="grid max-w-2xl gap-4">
      <a href={`/${seg}/account/shop`} className="text-sm underline">
        {tr("commerce.shop.back")}
      </a>
      <h1 id="product-title" className="text-2xl font-semibold">
        {product.name}
      </h1>
      <ErrorSummary locale={locale} error={basketErrorFrom(sp)} />
      {product.description ? <p className="whitespace-pre-line">{product.description}</p> : null}
      {product.unitCents !== null ? (
        <p className="text-xl">
          <span className="sr-only">{tr("commerce.shop.your_price")}: </span>
          <span className="font-semibold tabular-nums">{formatMoney(product.unitCents, locale)}</span>
          {product.listCents !== null ? (
            <span className="ml-3 text-base text-muted-foreground">{tr("commerce.shop.list_price", { amount: formatMoney(product.listCents, locale) })}</span>
          ) : null}
        </p>
      ) : null}
      <ul className="grid gap-1 text-sm">
        {product.creditUnits && product.creditKind ? <li>{tr("commerce.shop.credits", { units: product.creditUnits, kind: tr(`commerce.credit_kind.${product.creditKind}`) })}</li> : null}
        {product.validityDays ? <li>{tr("commerce.shop.validity", { days: product.validityDays })}</li> : null}
        {product.isSharingAllowed ? <li>{tr("commerce.shop.sharing")}</li> : null}
        <li>{tr("commerce.shop.withdrawal_notice")}</li>
      </ul>
      {product.warning ? <p className="rounded-md border p-3 text-sm">{tr(`commerce.errors.${product.warning}`)}</p> : null}
      {product.isCustomAmount ? (
        <a href={`/${seg}/gift`} className="inline-flex min-h-11 items-center underline">
          {tr("commerce.shop.choose_amount")}
        </a>
      ) : (
        <form action={buy} className="flex flex-wrap gap-2">
          <button type="submit" name="mode" value="add" className="min-h-11 rounded-md border px-4 font-medium" disabled={!!product.warning}>
            {tr("commerce.shop.add_to_basket")}
          </button>
          <button type="submit" name="mode" value="buy" className="min-h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground" disabled={!!product.warning}>
            {tr("commerce.shop.buy_now")}
          </button>
        </form>
      )}
    </article>
  );
}
