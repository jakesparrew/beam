import { notFound, redirect } from "next/navigation";
import { formatMoney, localeFromSegment, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getShopCatalogue, getShopProduct, type ShopProduct } from "@/modules/commerce/queries";
import { addToPortalBasket, basketErrorFrom, ErrorSummary } from "@/modules/commerce/ui/basket";

type Search = { product?: string; error?: string; field?: string };

const GROUPS = ["package", "membership", "voucher", "item"] as const;

/** The label of a winning price candidate (rule 8): member price, personal price or promotion. */
function sourceKey(source: string | null): string | null {
  if (source === "member_version" || source === "member_discount") return "commerce.shop.member_price";
  if (source === "person_price") return "commerce.checkout.reason_person_price";
  if (source === "promotion") return "commerce.checkout.reason_promotion";
  return null;
}

/** One product card: name, the person's own price (with the normal price when lower), facts and the two buttons. */
function ProductTile({ locale, product, buy }: { locale: Locale; product: ShopProduct; buy: (fd: FormData) => Promise<void> }) {
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const headingId = `product-${product.productId}`;
  return (
    <li className="grid gap-2 rounded-lg border p-4" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-lg font-semibold">
        <a href={`/${seg}/account/shop/${encodeURIComponent(product.sku)}`} className="hover:underline">
          {product.name}
        </a>
      </h3>
      {product.unitCents !== null ? (
        <p className="text-base">
          <span className="sr-only">{tr("commerce.shop.your_price")}: </span>
          <span className="font-semibold tabular-nums">{formatMoney(product.unitCents, locale)}</span>
          {sourceKey(product.priceSource) ? <span className="ml-2 rounded border px-1.5 py-0.5 text-xs">{tr(sourceKey(product.priceSource)!)}</span> : null}
          {product.listCents !== null ? (
            <span className="ml-2 text-sm text-muted-foreground">{tr("commerce.shop.list_price", { amount: formatMoney(product.listCents, locale) })}</span>
          ) : null}
        </p>
      ) : null}
      {product.creditUnits && product.creditKind ? (
        <p className="text-sm">{tr("commerce.shop.credits", { units: product.creditUnits, kind: tr(`commerce.credit_kind.${product.creditKind}`) })}</p>
      ) : null}
      {product.validityDays ? <p className="text-sm">{tr("commerce.shop.validity", { days: product.validityDays })}</p> : null}
      {product.warning ? <p className="text-sm">{tr(`commerce.errors.${product.warning}`)}</p> : null}
      {product.isCustomAmount ? (
        <a href={`/${seg}/gift`} className="inline-flex min-h-11 items-center underline">
          {tr("commerce.shop.choose_amount")}
        </a>
      ) : (
        <form action={buy} className="flex flex-wrap gap-2">
          <input type="hidden" name="productId" value={product.productId} />
          <button type="submit" name="mode" value="add" className="min-h-11 rounded-md border px-4 text-sm font-medium" disabled={!!product.warning}>
            {tr("commerce.shop.add_to_basket")}
          </button>
          <button type="submit" name="mode" value="buy" className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" disabled={!!product.warning}>
            {tr("commerce.shop.buy_now")}
          </button>
        </form>
      )}
    </li>
  );
}

/**
 * `/[locale]/account/shop` (section 5.2): shop-visible packages, memberships, vouchers and items
 * with the person's own price. `?product=<productId>` (forms' result-page CTAs) redirects to the
 * product page with the query kept; an unknown, inactive or hidden id shows the shop with the
 * notice "This product is not available".
 */
export default async function AccountShopPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const sp = await searchParams;
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const db = await getAppDb();

  let unavailable = false;
  if (sp.product) {
    const target = await getShopProduct(db, { productId: sp.product, personId: actor.personId, locale });
    if (target) redirect(`/${seg}/account/shop/${encodeURIComponent(target.sku)}?product=${encodeURIComponent(sp.product)}` as never);
    unavailable = true;
  }
  const catalogue = await getShopCatalogue(db, { personId: actor.personId, locale });

  async function buy(fd: FormData) {
    "use server";
    const raw = fd.get("productId");
    const productId = typeof raw === "string" ? raw : "";
    const out = await addToPortalBasket({ locale: locale!, personId: actor.personId, productId, buyNow: fd.get("mode") === "buy" });
    if ("error" in out) redirect(`/${seg}/account/shop?${out.error}` as never);
    redirect(`/${seg}/account/checkout?checkout=${out.checkoutId}` as never);
  }

  return (
    <section aria-labelledby="shop-title" className="grid gap-6">
      <div className="grid gap-1">
        <h1 id="shop-title" className="text-2xl font-semibold">
          {tr("commerce.shop.title")}
        </h1>
        <p className="text-muted-foreground">{tr("commerce.shop.intro")}</p>
      </div>
      {unavailable ? (
        <p role="status" className="rounded-md border p-3">
          {tr("commerce.shop.not_available")}
        </p>
      ) : null}
      <ErrorSummary locale={locale} error={basketErrorFrom(sp)} />
      {catalogue.length === 0 ? <p>{tr("commerce.shop.empty")}</p> : null}
      {GROUPS.map((kind) => {
        const items = catalogue.filter((p) => p.kind === kind);
        if (!items.length) return null;
        return (
          <section key={kind} aria-labelledby={`shop-group-${kind}`} className="grid gap-3">
            <h2 id={`shop-group-${kind}`} className="text-xl font-semibold">
              {tr(`commerce.shop.group_${kind}`)}
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((p) => (
                <ProductTile key={p.productId} locale={locale} product={p} buy={buy} />
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
