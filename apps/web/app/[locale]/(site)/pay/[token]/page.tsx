import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { formatDate, formatMoney, localeFromSegment, t, URL_SEGMENT } from "@beam/core/i18n";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { payByToken } from "@/modules/commerce/actions";
import { getPayOrderByToken } from "@/modules/commerce/queries";
import { termsUrlFor } from "@/modules/commerce/ui/basket";

/**
 * `/[locale]/pay/[token]` (commerce spec 5.3, rules 26a and 41, rule 56): the BEAM-hosted payment
 * link page of one order: reference, lines and total, the terms checkbox for link orders, then the
 * provider redirect. Opened after expiry, payment or cancellation it shows that state, never a
 * payment form. Credits' renewal links and dunning reminders use the same page. Works without
 * client script; the status line is announced politely.
 */
export default async function PayPage({ params, searchParams }: { params: Promise<{ locale: string; token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { locale: segment, token } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const sp = await searchParams;
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.pay.${k}`, p);
  const view = await getPayOrderByToken(await getAppDb(), token);
  const money = (v: number) => formatMoney(v, locale);
  const errorText = (code: string) => (t.has(locale, `commerce.errors.${code}`) ? tr(`commerce.errors.${code}`) : tr("commerce.common.error"));
  const here = `/${URL_SEGMENT[locale]}/pay/${token}`;

  async function onPay(form: FormData) {
    "use server";
    const key = form.get("clientKey");
    const r = await payByToken({ token, clientKey: typeof key === "string" ? key : randomUUID(), acceptTerms: form.get("acceptTerms") === "on" });
    if (r.ok) redirect(r.data.redirectUrl as never);
    redirect(`${here}?error=${encodeURIComponent(r.error.message)}` as never);
  }

  const state = (title: string, body: string) => (
    <div role="status" aria-live="polite" className="grid gap-2">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p>{body}</p>
    </div>
  );
  const termsUrl = view.state === "payable" && view.needsTerms ? await termsUrlFor(locale) : null;

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold">{c("title")}</h1>
      {view.reference ? <p className="text-sm">{c("reference", { reference: view.reference })}</p> : null}
      {view.state === "invalid" ? state(c("invalid_title"), c("invalid_body")) : null}
      {view.state === "expired" ? state(c("expired_title"), c("expired_body")) : null}
      {view.state === "cancelled" ? state(c("cancelled_title"), c("cancelled_body")) : null}
      {view.state === "paid" ? state(c("paid_title"), c("paid_body")) : null}
      {view.state === "payable" || view.state === "paid" ? (
        <section aria-labelledby="pay-lines" className="grid gap-2">
          <h2 id="pay-lines" className="text-lg font-semibold">
            {c("lines")}
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-2 pr-3 text-left font-medium">
                  {c("col_description")}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  {c("col_quantity")}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {c("col_amount")}
                </th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((l, i) => (
                <tr key={i} className="border-b">
                  <td className="py-2 pr-3">{l.description}</td>
                  <td className="py-2 pr-3 text-right">{l.quantity}</td>
                  <td className="py-2 text-right tabular-nums">{money(l.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="flex justify-between font-medium">
            <span>{c("total")}</span>
            <span className="tabular-nums">{money(view.totalCents)}</span>
          </p>
          {view.state === "payable" && view.dueCents !== view.totalCents ? (
            <p className="flex justify-between">
              <span>{c("due")}</span>
              <span className="tabular-nums">{money(view.dueCents)}</span>
            </p>
          ) : null}
        </section>
      ) : null}
      {view.state === "payable" ? (
        <form action={onPay} className="grid gap-4" aria-describedby={sp.error ? "pay-error" : undefined}>
          <input type="hidden" name="clientKey" value={randomUUID()} />
          {view.expiresAt ? <p className="text-sm text-muted-foreground">{c("valid_until", { date: formatDate(view.expiresAt, locale, "long") })}</p> : null}
          {view.needsTerms ? (
            <div className="grid gap-1">
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" name="acceptTerms" required className="size-5" />
                <span>{c("terms_label")}</span>
              </label>
              {termsUrl ? (
                <a href={termsUrl} className="text-sm underline" target="_blank" rel="noreferrer">
                  {c("terms_link")}
                </a>
              ) : null}
            </div>
          ) : null}
          <div role="status" aria-live="polite">
            {sp.error ? (
              <p id="pay-error" className="rounded-md border border-destructive p-3 text-sm">
                {c("error", { message: errorText(sp.error) })}
              </p>
            ) : null}
          </div>
          <button type="submit" className="min-h-11 justify-self-start rounded-md bg-primary px-5 py-2 font-medium text-primary-foreground">
            {c("submit", { amount: money(view.dueCents) })}
          </button>
        </form>
      ) : null}
    </div>
  );
}
