import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { actorFromSession, appUrl, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { placeOrder, startCheckout, updateCheckout } from "@/modules/commerce/actions";
import { getCheckout, getShopProduct, readViewer } from "@/modules/commerce/queries";
import { landingPathFrom } from "@/modules/commerce/server/checkouts";
import { Basket, basketErrorFrom, billingDetailsFrom, ErrorSummary, errorQuery, itemsAfterUpdate, LoginForMemberPrices, termsUrlFor } from "@/modules/commerce/ui/basket";

type Search = { sku?: string; from?: string; checkout?: string; error?: string; field?: string };

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

/**
 * `/[locale]/checkout` (section 5.3): the guest checkout of site buy links `?sku=...&from=<page>`
 * (packages, memberships, vouchers and items; session and event links go to booking). The email
 * step comes first and creates the checkout row (with `landing_path` from `from`, else the
 * same-origin Referer); then the same basket as the portal, with terms, the company invoice box
 * and "Log in for member prices" (a guest quotes as public, edge case 23).
 */
export default async function SiteCheckoutPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const sp = await searchParams;
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const actor = actorFromSession(await getSession());
  const signedIn = actor?.kind === "customer" ? actor : null;
  const viewer = await readViewer(actor);
  const db = await getAppDb();
  const error = basketErrorFrom(sp);
  const shell = (children: React.ReactNode) => (
    <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-10">
      <h1 id="checkout-title" className="text-2xl font-semibold">
        {tr("commerce.checkout.title")}
      </h1>
      {children}
    </div>
  );

  const view = sp.checkout ? await getCheckout(db, sp.checkout, viewer, locale) : null;
  if (view && (view.status === "started" || view.status === "abandoned") && view.lines.length) {
    const current = view;
    // Inline server actions may capture only serialisable values (strings, plain data): a captured
    // helper function made the whole checkout page fail to render (final e2e gate).
    const herePath = `/${seg}/checkout?checkout=${current.checkoutId}`;
    async function update(fd: FormData) {
      "use server";
      const items = itemsAfterUpdate(current.lines.map((l) => l.item), fd);
      if (!items.length) redirect(`/${seg}` as never);
      const result = await updateCheckout({ checkoutId: current.checkoutId, items, promoCode: str(fd, "promoCode") || null });
      redirect((result.ok ? herePath : `${herePath}&${errorQuery(result.error)}`) as never);
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
      if (!result.ok) redirect(`${herePath}&${errorQuery(result.error)}` as never);
      redirect(result.data.redirectUrl as never);
    }
    const loginHref = `/${seg}/account/login?returnTo=${encodeURIComponent(`/${seg}/checkout?checkout=${current.checkoutId}`)}`;
    return shell(
      <>
        {current.isGuest ? (
          <p className="text-sm">
            {current.email} · <LoginForMemberPrices locale={locale} href={loginHref} />
          </p>
        ) : null}
        <Basket locale={locale} view={current} error={error} updateAction={update} placeAction={place} termsUrl={await termsUrlFor(locale)} />
      </>,
    );
  }

  const product = sp.sku ? await getShopProduct(db, { sku: sp.sku, personId: signedIn?.personId ?? null, locale, channel: "site", requireShopVisible: false }) : null;
  if (!product || product.isCustomAmount) {
    return shell(
      <>
        <ErrorSummary locale={locale} error={error} />
        <p role="status">{tr(sp.sku || sp.checkout ? "commerce.shop.not_available" : "commerce.checkout.empty")}</p>
        <a href={`/${seg}${product?.isCustomAmount ? "/gift" : ""}`} className="underline">
          {tr("commerce.return.go_home")}
        </a>
      </>,
    );
  }

  const productId = product.productId;
  const referer = (await headers()).get("referer");
  const landingPath = landingPathFrom(sp.from, referer, appUrl("/"));
  async function begin(fd: FormData) {
    "use server";
    const email = str(fd, "email");
    const result = await startCheckout({
      channel: "site",
      items: [{ productId, quantity: 1 }],
      locale,
      ...(landingPath ? { landingPath } : {}),
      ...(email ? { email } : {}),
    });
    if (!result.ok) redirect(`/${seg}/checkout?sku=${encodeURIComponent(sp.sku ?? "")}&${errorQuery(result.error)}` as never);
    redirect(`/${seg}/checkout?checkout=${result.data.checkoutId}` as never);
  }
  const emailError = error?.field === "email";
  return shell(
    <>
      <div className="rounded-md border p-4">
        <p className="font-medium">{product.name}</p>
        {product.unitCents !== null ? <p className="tabular-nums">{formatMoney(product.unitCents, locale)}</p> : null}
      </div>
      <ErrorSummary locale={locale} error={error && !emailError ? error : null} />
      <form action={begin} className="grid gap-4" aria-labelledby="email-step-title">
        <h2 id="email-step-title" className="text-lg font-semibold">
          {tr("commerce.checkout.email_title")}
        </h2>
        {signedIn ? null : (
          <div className="grid gap-1">
            <label htmlFor="email" className="text-sm font-medium">
              {tr("commerce.checkout.email_label")}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              maxLength={254}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? "email-hint email-error" : "email-hint"}
              className="h-11 rounded-md border px-3"
            />
            <p id="email-hint" className="text-sm text-muted-foreground">
              {tr("commerce.checkout.email_hint")}
            </p>
            {emailError ? (
              <p id="email-error" className="text-sm text-red-700 dark:text-red-300">
                {tr("commerce.errors.email_required")}
              </p>
            ) : null}
          </div>
        )}
        <button type="submit" className="min-h-12 w-fit rounded-md bg-primary px-6 font-semibold text-primary-foreground">
          {tr("commerce.checkout.continue")}
        </button>
      </form>
      {signedIn ? null : <LoginForMemberPrices locale={locale} href={`/${seg}/account/login?returnTo=${encodeURIComponent(`/${seg}/checkout?sku=${sp.sku ?? ""}`)}`} />}
    </>,
  );
}
