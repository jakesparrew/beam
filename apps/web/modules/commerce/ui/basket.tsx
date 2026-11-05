import { randomUUID } from "node:crypto";
import Link from "next/link";
import { formatMoney, type Locale } from "@beam/core/i18n";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getCurrentLegalVersion } from "@/modules/site/api";
import type { CheckoutView } from "../server/checkouts";
import { PromoField } from "./promo-field";
import { ReturnPoller, type PurchaseConversion, type ReturnPollStatus } from "./return-poller";
import { QuoteLines } from "./quote-lines";

/** The live terms URL in the page locale (rule 26a); null when unreadable. */
export async function termsUrlFor(locale: Locale): Promise<string | null> {
  try {
    const terms = await getCurrentLegalVersion(await getAppDb(), "terms");
    return terms?.urlByLocale[locale] ?? null;
  } catch {
    return null;
  }
}

/**
 * "Add to basket" and "Buy now" of the portal shop (called from a page's server action): buy now
 * starts a new checkout with the one product; add appends it to the open portal checkout of this
 * browser, or starts one. Returns the checkout id or the failed action's error query.
 */
export async function addToPortalBasket(input: { locale: Locale; personId: string; productId: string; buyNow: boolean }): Promise<{ checkoutId: string } | { error: string }> {
  const { startCheckout, updateCheckout } = await import("../actions");
  const { getCheckout, readViewer } = await import("../server/checkouts");
  const item = { productId: input.productId, quantity: 1 };
  if (!input.buyNow) {
    const viewer = await readViewer({ kind: "customer", userId: "", personId: input.personId });
    const db = await getAppDb();
    for (const id of viewer.checkoutIds ?? []) {
      const view = await getCheckout(db, id, viewer, input.locale);
      if (!view || view.channel !== "portal" || (view.status !== "started" && view.status !== "abandoned")) continue;
      const items = view.lines.map((l) => l.item);
      const existing = items.find((i) => i.productId === input.productId && !i.amountCents && !i.voucher);
      const next = existing ? items.map((i) => (i === existing ? { ...i, quantity: Math.min(50, i.quantity + 1) } : i)) : [...items, item];
      const res = await updateCheckout({ checkoutId: view.checkoutId, items: next });
      return res.ok ? { checkoutId: view.checkoutId } : { error: errorQuery(res.error) };
    }
  }
  const res = await startCheckout({ channel: "portal", items: [item], locale: input.locale });
  return res.ok ? { checkoutId: res.data.checkoutId } : { error: errorQuery(res.error) };
}

export type BasketError = { code: string; field?: string | null } | null;

/** Form field names of the company invoice box (rule 26b), read back by `billingDetailsFrom`. */
export const BILLING_FIELDS = ["company_name", "vat_number", "address_line1", "postal_code", "city", "country", "billing_email"] as const;

/** `error=<code>&field=<field>` for a failed action result (conflict and not-found reasons kept). */
export function errorQuery(error: { code: string; message: string; fields?: Record<string, string> }): string {
  const code = error.code === "conflict" || error.code === "not_found" ? error.message : error.code;
  const field = error.fields ? Object.keys(error.fields)[0] : undefined;
  const q = new URLSearchParams({ error: code });
  if (field) q.set("field", field);
  return q.toString();
}

/** The basket error from the page's search params. */
export function basketErrorFrom(sp: { error?: string; field?: string }): BasketError {
  if (!sp.error || !/^[a-z_]{2,40}$/.test(sp.error)) return null;
  return { code: sp.error, field: sp.field && /^[A-Za-z0-9_.]{1,60}$/.test(sp.field) ? sp.field : null };
}

/** The basket items after an "Update" or "Remove" post (`qty_<i>`, `remove=<i>`). */
export function itemsAfterUpdate<T extends { quantity: number }>(items: T[], fd: FormData): T[] {
  const remove = fd.get("remove");
  return items
    .map((item, i) => {
      const raw = Number(fd.get(`qty_${i}`));
      const quantity = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, 50) : item.quantity;
      return { ...item, quantity };
    })
    .filter((_, i) => String(i) !== remove);
}

/** The finance `BillingDetailsInput` from the company box, or undefined when it is left empty. */
export function billingDetailsFrom(fd: FormData): Record<string, unknown> | undefined {
  const v = (k: string) => {
    const x = fd.get(k);
    return typeof x === "string" ? x.trim() : "";
  };
  if (!v("company_name")) return undefined;
  return {
    isCompany: true,
    legalName: v("company_name"),
    vatNumber: v("vat_number") || undefined,
    address: { line1: v("address_line1"), postal_code: v("postal_code"), city: v("city"), country: (v("country") || "BE").toUpperCase() },
    billingEmail: v("billing_email") || undefined,
  };
}

function Field({ id, label, error, errorText, ...rest }: { id: string; label: string; error?: boolean; errorText?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input id={id} name={id} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} className="h-11 rounded-md border px-3" {...rest} />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-red-700 dark:text-red-300">
          {errorText}
        </p>
      ) : null}
    </div>
  );
}

/** The company invoice box (rule 26b), a native disclosure so it works without JavaScript. */
export function CompanyInvoiceBox({ locale, error }: { locale: Locale; error: BasketError }) {
  const tr = translator(locale);
  const billingError = error?.field?.startsWith("billingDetails") ? tr("commerce.errors.billing_invalid") : undefined;
  return (
    <details className="rounded-md border p-3" open={!!billingError}>
      <summary className="min-h-11 cursor-pointer py-2 font-medium">{tr("commerce.checkout.company_toggle")}</summary>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <Field id="company_name" label={tr("commerce.checkout.company_name")} autoComplete="organization" maxLength={200} error={!!billingError} errorText={billingError} />
        <Field id="vat_number" label={tr("commerce.checkout.vat_number")} maxLength={30} />
        <Field id="address_line1" label={tr("commerce.checkout.address_line1")} autoComplete="address-line1" maxLength={200} />
        <Field id="postal_code" label={tr("commerce.checkout.postal_code")} autoComplete="postal-code" maxLength={20} />
        <Field id="city" label={tr("commerce.checkout.city")} autoComplete="address-level2" maxLength={100} />
        <Field id="country" label={tr("commerce.checkout.country")} autoComplete="country" defaultValue="BE" maxLength={2} />
        <Field id="billing_email" label={tr("commerce.checkout.billing_email")} type="email" autoComplete="email" maxLength={254} />
      </div>
    </details>
  );
}

/** The terms checkbox (rule 26a) with its link, required, and its error linked by `aria-describedby`. */
export function TermsCheckbox({ locale, termsUrl, error }: { locale: Locale; termsUrl: string | null; error: boolean }) {
  const tr = translator(locale);
  return (
    <div className="grid gap-1">
      <div className="flex items-start gap-3">
        <input
          id="accept-terms"
          name="acceptTerms"
          type="checkbox"
          value="1"
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "accept-terms-error" : undefined}
          className="mt-1 size-5"
        />
        <label htmlFor="accept-terms" className="text-sm">
          {tr("commerce.checkout.terms_label")}
        </label>
      </div>
      {termsUrl ? (
        <a href={termsUrl} target="_blank" rel="noreferrer" className="ml-8 text-sm underline">
          {tr("commerce.checkout.terms_link")}
        </a>
      ) : null}
      {error ? (
        <p id="accept-terms-error" className="ml-8 text-sm text-red-700 dark:text-red-300">
          {tr("commerce.errors.accept_terms")}
        </p>
      ) : null}
    </div>
  );
}

/** The error summary of a failed step, announced once (`role="alert"`). */
export function ErrorSummary({ locale, error }: { locale: Locale; error: BasketError }) {
  if (!error) return null;
  const tr = translator(locale);
  const known = new Set(["validation", "rate_limited", "payment_unavailable", "terms_unavailable", "already_member", "pending_exists", "product_unavailable", "checkout_closed", "checkout_not_found", "login_required", "order_expired", "invalid_transition", "not_found", "price_changed", "not_sold_online", "amount_out_of_range", "email_required"]);
  return (
    <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
      {tr(`commerce.errors.${known.has(error.code) ? error.code : "validation"}`)}
    </div>
  );
}

/**
 * The checkout basket of the portal and the site (section 5.2): quote lines with quantities and
 * remove buttons, the promo code, the euro credit toggle, the company invoice box, the terms
 * checkbox and the Pay button. One plain form; "Update" and "Apply code" post to `updateAction`,
 * "Pay" to `placeAction`. The hidden `clientKey` makes a double submit return the same order.
 */
export function Basket({
  locale,
  view,
  error,
  updateAction,
  placeAction,
  termsUrl,
}: {
  locale: Locale;
  view: CheckoutView;
  error: BasketError;
  updateAction: (fd: FormData) => Promise<void>;
  placeAction: (fd: FormData) => Promise<void>;
  termsUrl: string | null;
}) {
  const tr = translator(locale);
  const promoWarning = view.quote.warnings.find((w) => w.code.startsWith("promo_"))?.code ?? null;
  const lineWarnings = view.quote.warnings.filter((w) => !w.code.startsWith("promo_"));
  return (
    <form action={placeAction} className="grid gap-6" noValidate={false}>
      <input type="hidden" name="checkoutId" value={view.checkoutId} />
      <input type="hidden" name="clientKey" value={randomUUID()} />
      <input type="hidden" name="expectedTotalCents" value={String(view.quote.totalCents)} />
      <ErrorSummary locale={locale} error={error} />
      {view.priceChanged ? (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          {tr("commerce.checkout.price_changed", { amount: formatMoney(view.quote.totalCents, locale) })}
        </div>
      ) : null}
      {lineWarnings.map((w, i) => (
        <p key={`${w.code}-${i}`} className="rounded-md border p-3 text-sm">
          {tr(`commerce.errors.${w.code}`)}
        </p>
      ))}
      <QuoteLines locale={locale} lines={view.lines} quote={view.quote} editable updateAction={updateAction} />
      <div className="flex justify-end">
        <button type="submit" formAction={updateAction} formNoValidate className="min-h-11 rounded-md border px-4 text-sm font-medium">
          {tr("commerce.checkout.update")}
        </button>
      </div>
      <PromoField locale={locale} defaultValue={view.promoCode} warning={promoWarning} applyAction={updateAction} />
      {!view.isGuest && view.euroBalanceCents > 0 ? (
        <div className="flex items-center gap-3">
          <input id="use-euro-credit" name="useEuroCredit" type="checkbox" value="1" defaultChecked className="size-5" />
          <label htmlFor="use-euro-credit" className="text-sm">
            {tr("commerce.checkout.euro_credit", { amount: formatMoney(view.euroBalanceCents, locale) })}
          </label>
        </div>
      ) : null}
      <CompanyInvoiceBox locale={locale} error={error} />
      <TermsCheckbox locale={locale} termsUrl={termsUrl} error={error?.field === "acceptTerms"} />
      <button type="submit" disabled={!view.termsAvailable || !view.lines.length} className="min-h-12 rounded-md bg-primary px-6 text-base font-semibold text-primary-foreground disabled:opacity-60">
        {tr("commerce.checkout.pay", { amount: formatMoney(view.quote.totalCents, locale) })}
      </button>
    </form>
  );
}

/** "Log in for member prices" for site guests (edge case 23). */
export function LoginForMemberPrices({ locale, href }: { locale: Locale; href: string }) {
  const tr = translator(locale);
  return (
    <Link href={href as never} className="text-sm underline">
      {tr("commerce.checkout.login_for_member")}
    </Link>
  );
}

/**
 * The return page body shared by the portal and the site (section 5.2): the order reference,
 * the polling status region and the links. `payment=unavailable|failed` from the provider step
 * is announced first.
 */
export function OrderReturn({
  locale,
  reference,
  initial,
  payment,
  poll,
  retryAction,
  links,
  conversion,
}: {
  locale: Locale;
  reference: string;
  initial: ReturnPollStatus;
  payment: string | null;
  poll: () => Promise<{ ok: true; data: ReturnPollStatus } | { ok: false; error: { code: string; message: string } }>;
  retryAction: ((fd: FormData) => Promise<void>) | null;
  links: { href: string; label: string }[];
  /** site-P9: the purchase conversion reported once the order is paid (site's return page). */
  conversion?: PurchaseConversion | null;
}) {
  const tr = translator(locale);
  return (
    <section aria-labelledby="return-title" className="grid max-w-2xl gap-4">
      <h1 id="return-title" className="text-2xl font-semibold">
        {tr("commerce.return.title")}
      </h1>
      <p className="text-sm text-muted-foreground">{tr("commerce.pay_order.reference", { reference })}</p>
      {payment === "unavailable" ? <p className="rounded-md border p-3">{tr("commerce.return.unavailable")}</p> : null}
      <ReturnPoller
        initial={initial}
        poll={poll}
        retryAction={retryAction}
        conversion={conversion ?? null}
        labels={{
          checking: tr("commerce.return.checking"),
          paid: tr("commerce.return.paid"),
          granted: tr("commerce.return.granted"),
          failed: tr("commerce.return.failed"),
          pending: tr("commerce.return.pending"),
          expired: tr("commerce.return.expired"),
          retry: tr("commerce.return.retry"),
        }}
      />
      <ul className="flex flex-wrap gap-4">
        {links.map((l) => (
          <li key={l.href}>
            <a href={l.href} className="inline-flex min-h-11 items-center underline">
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
