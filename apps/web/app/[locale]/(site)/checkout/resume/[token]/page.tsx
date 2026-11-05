import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { findCheckoutByResumeToken, getCheckout, readViewer, resumeContinuePath } from "@/modules/commerce/queries";
import { rememberInViewer } from "@/modules/commerce/server/checkouts";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * `/[locale]/checkout/resume/[token]` (section 5.3, R2; rules 51 and 52): the link of the
 * recovery email. The token opens exactly one checkout (`resume_token_hash`); the basket is
 * re-quoted on open, so a price changed since the last save shows the new total. Continue adds
 * the checkout to this browser's signed viewer cookie and goes on to the site or portal
 * checkout of that checkout; the token never signs anyone in, so a guest sees public prices and
 * member prices need a login (edge case 23).
 */
export default async function CheckoutResumePage({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { locale: segment, token } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const db = await getAppDb();
  const target = await findCheckoutByResumeToken(db, token);

  const shell = (children: React.ReactNode) => (
    <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-10">
      <h1 id="resume-title" className="text-2xl font-semibold">
        {tr("commerce.resume.title")}
      </h1>
      {children}
    </div>
  );
  const notice = (key: string, href: string, label: string) =>
    shell(
      <>
        <p role="status">{tr(key)}</p>
        <a href={href} className="w-fit underline">
          {label}
        </a>
      </>,
    );

  if (!target) return notice("commerce.resume.not_found", `/${seg}`, tr("commerce.return.go_home"));
  if (target.status === "completed") return notice("commerce.resume.completed", `/${seg}/account/orders`, tr("commerce.resume.my_orders"));
  if (!target.isOpen) return notice("commerce.resume.expired", `/${seg}`, tr("commerce.return.go_home"));

  const viewer = await readViewer(actorFromSession(await getSession()));
  const view = await getCheckout(db, target.checkoutId, { ...viewer, checkoutIds: [target.checkoutId, ...(viewer.checkoutIds ?? [])] }, locale);
  if (!view || !view.lines.length) return notice("commerce.resume.empty", `/${seg}`, tr("commerce.return.go_home"));

  async function resume() {
    "use server";
    const again = await findCheckoutByResumeToken(await getAppDb(), token);
    if (!again?.isOpen) redirect(`/${seg}/checkout/resume/${token}` as never);
    await rememberInViewer("checkout", again.checkoutId);
    redirect(resumeContinuePath(again, locale!) as never);
  }

  return shell(
    <>
      <p>{tr("commerce.resume.intro")}</p>
      {view.priceChanged ? (
        <p role="status" className="rounded-md border border-amber-600 p-3">
          {tr("commerce.checkout.price_changed", { amount: formatMoney(view.quote.totalCents, locale) })}
        </p>
      ) : null}
      <section aria-labelledby="resume-basket" className="grid gap-3">
        <h2 id="resume-basket" className="text-lg font-semibold">
          {tr("commerce.checkout.basket")}
        </h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th scope="col" className="py-2">
                {tr("commerce.checkout.product")}
              </th>
              <th scope="col" className="py-2 text-right">
                {tr("commerce.checkout.quantity")}
              </th>
              <th scope="col" className="py-2 text-right">
                {tr("commerce.checkout.line_total")}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((line, i) => (
              <tr key={`${line.productId}-${i}`} className="border-t">
                <td className="py-2">{line.name}</td>
                <td className="py-2 text-right tabular-nums">{line.quantity}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(line.lineTotalCents, locale)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-semibold">
              <th scope="row" colSpan={2} className="py-2">
                {tr("commerce.checkout.total")}
              </th>
              <td className="py-2 text-right tabular-nums">{formatMoney(view.quote.totalCents, locale)}</td>
            </tr>
          </tfoot>
        </table>
      </section>
      <form action={resume}>
        <button type="submit" className="min-h-12 w-fit rounded-md bg-primary px-6 font-semibold text-primary-foreground">
          {tr("commerce.resume.continue")}
        </button>
      </form>
    </>,
  );
}
