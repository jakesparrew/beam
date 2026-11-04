import { notFound, redirect } from "next/navigation";
import { formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { startCheckout } from "@/modules/commerce/actions";
import { getShopCatalogue } from "@/modules/commerce/queries";
import { basketErrorFrom, ErrorSummary, errorQuery } from "@/modules/commerce/ui/basket";

type Search = { error?: string; field?: string };

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

function brusselsToday(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * `/[locale]/gift` (section 5.3, rule 45a): the voucher purchase page. The buyer picks a voucher
 * (or an amount for a custom-amount voucher), the recipient's name and email, a message and an
 * optional "Send on" date (today to 365 days ahead), then continues to `/[locale]/checkout` with
 * the checkout created (the buyer's email is the checkout's email step).
 */
export default async function GiftPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Search> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const sp = await searchParams;
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const actor = actorFromSession(await getSession());
  const signedIn = actor?.kind === "customer";
  const vouchers = (await getShopCatalogue(await getAppDb(), { personId: null, locale, channel: "site" })).filter((p) => p.kind === "voucher");
  const error = basketErrorFrom(sp);
  const fieldError = (name: string) => !!error?.field && (error.field === name || error.field.endsWith(`.${name}`));

  async function buy(fd: FormData) {
    "use server";
    const productId = str(fd, "productId");
    const product = vouchers.find((v) => v.productId === productId);
    const euros = Number(str(fd, "amount").replace(",", "."));
    const recipientEmail = str(fd, "recipientEmail");
    const message = str(fd, "message");
    const deliverOn = str(fd, "deliverOn");
    const email = str(fd, "email");
    const result = await startCheckout({
      channel: "site",
      locale,
      items: [
        {
          productId,
          quantity: 1,
          ...(product?.isCustomAmount && Number.isFinite(euros) ? { amountCents: Math.round(euros * 100) } : {}),
          voucher: {
            recipientName: str(fd, "recipientName"),
            ...(recipientEmail ? { recipientEmail } : {}),
            ...(message ? { message } : {}),
            ...(deliverOn ? { deliverOn } : {}),
          },
        },
      ],
      landingPath: `/${seg}/gift`,
      ...(email ? { email } : {}),
    });
    if (!result.ok) redirect(`/${seg}/gift?${errorQuery(result.error)}` as never);
    redirect(`/${seg}/checkout?checkout=${result.data.checkoutId}` as never);
  }

  const field = (id: string, label: string, input: React.ReactNode, hint?: string) => (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {input}
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {fieldError(id) ? (
        <p id={`${id}-error`} className="text-sm text-red-700 dark:text-red-300">
          {tr("commerce.errors.validation")}
        </p>
      ) : null}
    </div>
  );
  const describedBy = (id: string, hint: boolean) => [hint ? `${id}-hint` : null, fieldError(id) ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const inputClass = "h-11 rounded-md border px-3";
  const custom = vouchers.find((v) => v.isCustomAmount);

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6 px-4 py-10">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{tr("commerce.gift.title")}</h1>
        <p className="text-muted-foreground">{tr("commerce.gift.intro")}</p>
      </div>
      {vouchers.length === 0 ? (
        <p role="status">{tr("commerce.gift.unavailable")}</p>
      ) : (
        <form action={buy} className="grid gap-4">
          <ErrorSummary locale={locale} error={error} />
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">{tr("commerce.gift.voucher")}</legend>
            {vouchers.map((v, i) => (
              <div key={v.productId} className="flex min-h-11 items-center gap-3">
                <input id={`voucher-${v.productId}`} type="radio" name="productId" value={v.productId} defaultChecked={i === 0} required className="size-5" />
                <label htmlFor={`voucher-${v.productId}`}>
                  {v.name}
                  {v.unitCents !== null && !v.isCustomAmount ? <span className="ml-2 tabular-nums">{formatMoney(v.unitCents, locale)}</span> : null}
                </label>
              </div>
            ))}
          </fieldset>
          {custom
            ? field(
                "amount",
                tr("commerce.gift.amount"),
                <input id="amount" name="amount" type="number" inputMode="decimal" step="1" min={(custom.minAmountCents ?? 1000) / 100} max={(custom.maxAmountCents ?? 50000) / 100} className={inputClass} aria-describedby={describedBy("amount", true)} />,
                tr("commerce.gift.amount_hint", { min: formatMoney(custom.minAmountCents ?? 1000, locale), max: formatMoney(custom.maxAmountCents ?? 50000, locale) }),
              )
            : null}
          {field("recipientName", tr("commerce.gift.recipient_name"), <input id="recipientName" name="recipientName" required maxLength={120} className={inputClass} aria-describedby={describedBy("recipientName", false)} />)}
          {field(
            "recipientEmail",
            tr("commerce.gift.recipient_email"),
            <input id="recipientEmail" name="recipientEmail" type="email" maxLength={254} className={inputClass} aria-describedby={describedBy("recipientEmail", true)} />,
            tr("commerce.gift.recipient_hint"),
          )}
          {field("message", tr("commerce.gift.message"), <textarea id="message" name="message" maxLength={500} rows={3} className="rounded-md border px-3 py-2" aria-describedby={describedBy("message", false)} />)}
          {field(
            "deliverOn",
            tr("commerce.gift.deliver_on"),
            <input id="deliverOn" name="deliverOn" type="date" min={brusselsToday()} max={brusselsToday(365)} className={inputClass} aria-describedby={describedBy("deliverOn", true)} />,
            tr("commerce.gift.deliver_hint"),
          )}
          {signedIn
            ? null
            : field("email", tr("commerce.gift.buyer_email"), <input id="email" name="email" type="email" required autoComplete="email" maxLength={254} className={inputClass} aria-describedby={describedBy("email", false)} />)}
          <button type="submit" className="min-h-12 w-fit rounded-md bg-primary px-6 font-semibold text-primary-foreground">
            {tr("commerce.gift.buy")}
          </button>
        </form>
      )}
    </div>
  );
}
