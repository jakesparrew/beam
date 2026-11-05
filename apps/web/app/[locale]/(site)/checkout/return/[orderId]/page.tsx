import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { checkOrderStatus, retryPayment } from "@/modules/commerce/actions";
import { getOrderForPayment, readViewer } from "@/modules/commerce/queries";
import { OrderReturn } from "@/modules/commerce/ui/basket";
import { trackMarketingConversion } from "@/modules/site/ui/public/analytics-loader";

/**
 * `/[locale]/checkout/return/[orderId]` (section 5.3): the guest's return page, the same polling
 * page as the portal. The order is identified by its id plus the signed viewer cookie set at
 * `placeOrder`; anyone else gets a 404. Once the order is paid, the purchase is reported to the
 * marketing tags (site's `trackMarketingConversion`, a no-op without marketing consent; site-P9).
 */
export default async function SiteCheckoutReturnPage({ params, searchParams }: { params: Promise<{ locale: string; orderId: string }>; searchParams: Promise<{ payment?: string }> }) {
  const { locale: segment, orderId } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const { payment } = await searchParams;
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const viewer = await readViewer(actorFromSession(await getSession()));
  const order = await getOrderForPayment(await getAppDb(), orderId, viewer, locale);
  if (!order) notFound();
  const id = order.orderId;
  const latest = order.payments.filter((p) => p.provider !== "credit_balance").at(-1) ?? null;

  async function poll() {
    "use server";
    return checkOrderStatus({ orderId: id });
  }
  async function retry() {
    "use server";
    const result = await retryPayment({ orderId: id, clientKey: randomUUID() });
    if (!result.ok) redirect(`/${seg}/checkout/return/${id}` as never);
    redirect(result.data.redirectUrl as never);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <OrderReturn
        locale={locale}
        reference={order.reference}
        initial={{ status: order.status, paymentStatus: latest?.status ?? null, dueCents: order.dueCents }}
        payment={payment ?? null}
        poll={poll}
        retryAction={order.status === "pending_payment" ? retry : null}
        conversion={{ track: trackMarketingConversion, valueCents: order.totalCents, key: id }}
        links={[
          { href: `/${seg}/account/login`, label: tr("commerce.return.go_orders") },
          { href: `/${seg}`, label: tr("commerce.return.go_home") },
        ]}
      />
      <p className="mt-4 text-sm text-muted-foreground">{tr("commerce.return.guest_access")}</p>
    </div>
  );
}
